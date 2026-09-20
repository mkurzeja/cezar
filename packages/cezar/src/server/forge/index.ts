import type { RepoInfo } from '../git.ts';
import { createGithubDriver } from './github.ts';
import { knownGlabHosts } from './glab-hosts.ts';
import type { ForgeDriver, ForgeKind } from './types.ts';

/**
 * Forge resolution (cockpit-ui redesign spec §"Forge-driver seam"): map the
 * repo's origin remote to a driver — github.com → the GitHub driver, anything
 * else (GitLab, self-hosted, no remote, not a repo) → null. The health route
 * serializes the result as `forge: {kind, available, reason?} | null`; a null
 * forge means plain-git features only (diffs, commit, push, branches).
 */

export interface ParsedRemote {
  host: string;
  /**
   * The WHOLE project path — `owner/repo` on GitHub, `group/subgroup/project` on a GitLab that
   * nests (GitLab spec Architecture §2). This is what every URL is built from.
   *
   * It exists because `owner`/`repo` below cannot express a nested path and silently truncate it:
   * `gitlab.com/group/subgroup/project` used to yield `owner: 'subgroup'`, dropping `group/`. That
   * was latent while GitLab hosts classified as "no forge" — nothing was ever built from the
   * mangled parts — and the phase that classifies them is the phase that would otherwise start
   * rendering `https://gitlab.com/subgroup/project`, which 404s. Subgroups are ubiquitous on
   * self-hosted GitLab, so the two changes belong together.
   */
  projectPath: string;
  /**
   * The last two path segments, unchanged and deliberately so: they are what the GitHub driver
   * passes to `gh --repo owner/repo`, where a path is exactly two segments and these are correct.
   * Prefer `projectPath` for anything URL-shaped.
   */
  owner: string;
  repo: string;
}

/**
 * Parse a git remote URL into host/owner/repo. Handles the scheme forms
 * (`https://`, `ssh://`, `git://`, with optional credentials and port) and the
 * scp-like form (`git@host:owner/repo.git`). Null for local paths and anything
 * else that doesn't look like a forge remote.
 */
export function parseRemote(remote: string): ParsedRemote | null {
  const r = remote.trim().replace(/\/+$/, '');
  let host: string | undefined;
  let path: string | undefined;
  const url = /^(?:https?|ssh|git|git\+ssh):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(r);
  if (url) {
    [, host, path] = url;
  } else {
    // scp-like: [user@]host:owner/repo(.git) — a leading '/' (local path)
    // can't match the host group, so plain directories fall through to null.
    const scp = /^(?:[^@/:]+@)?([^:/]+):(.+)$/.exec(r);
    if (!scp) return null;
    [, host, path] = scp;
  }
  if (!host || !path) return null;
  const parts = path.replace(/\.git$/i, '').split('/').filter(Boolean);
  const owner = parts[parts.length - 2];
  const repo = parts[parts.length - 1];
  if (!owner || !repo) return null;
  return { host: host.toLowerCase(), projectPath: parts.join('/'), owner, repo };
}

/** The hosts every cezar knows without being told. Two SaaS forges and nothing else: a
 *  self-hosted instance cannot be enumerated, which is what `classifyRemote` exists to handle. */
const FORGE_HOSTS: Record<string, ForgeKind> = { 'github.com': 'github', 'gitlab.com': 'gitlab' };

/**
 * Which forge a remote URL belongs to, without building a driver (#698): the static table above,
 * ∪ the GitLab instances `glab` is already authenticated against (GitLab spec Architecture §1).
 *
 * The union is the whole design. A host table can classify `github.com` and `gitlab.com` forever,
 * and can never classify `git.acme.internal` — which is precisely the deployment a local-first,
 * no-account cockpit is most attractive to. So the second half is DISCOVERED from glab's own
 * config rather than configured (see `glab-hosts.ts`, which also documents why it never reads a
 * value out of that file). The static table wins, so a `glab` that somehow listed `github.com`
 * cannot reclassify it.
 *
 * This is what the registry's per-project probe runs against every root, so the sidebar can gate
 * each project's forge tab on that project's own remote — and it is documented there as costing no
 * `gh` shell-out. It still costs none: the discovered half is a file read and a YAML parse,
 * mtime-cached, never `glab auth status`.
 *
 * `repoRoot` is optional and only widens what can be found — glab layers a per-repo config on top
 * of the global one. Callers that have a root in hand pass it; the rest lose nothing they had.
 *
 * (Named `forgeKindOfRemote` until this phase. One authority, one name: the spec calls it
 * `classifyRemote` because it is no longer a table lookup.)
 */
export function classifyRemote(remote: string | undefined, repoRoot?: string): ForgeKind | null {
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed) return null;
  const known = FORGE_HOSTS[parsed.host];
  if (known) return known;
  return knownGlabHosts({ repoRoot }).includes(parsed.host) ? 'gitlab' : null;
}

/**
 * A remote's web root — `https://github.com/owner/repo`, or `https://git.acme.internal/group/sub/p`
 * on a GitLab that nests — or null for anything not on a forge cezar recognizes.
 *
 * Built from the PARSED remote, never by string-editing the raw one, and that is the point: a
 * remote may carry credentials (`https://user:token@github.com/o/r.git`), and this is a value the
 * cockpit renders and links to. Rebuilding it from `{host, projectPath}` leaves nothing to leak.
 *
 * `projectPath` rather than `owner/repo`: for every real github.com remote the two are the same
 * string (a GitHub path is exactly two segments), and for a subgroup-nested GitLab project only
 * the former is a URL that resolves.
 */
export function forgeWebRoot(remote: string | undefined, repoRoot?: string): string | null {
  const parsed = remote ? parseRemote(remote) : null;
  if (!parsed || classifyRemote(remote, repoRoot) === null) return null;
  return `https://${parsed.host}/${parsed.projectPath}`;
}

/**
 * Remote → driver | null.
 *
 * A classified `'gitlab'` deliberately still answers `null` here: this phase teaches cezar to
 * RECOGNIZE GitLab, and the driver that can talk to it lands in the next one (spec Phase 3,
 * step 8). Until then a GitLab project reports `forge: 'gitlab'` in the registry — which is what
 * makes its `repoUrl` correct — while `/health` reports `forge: null` and the tab stays hidden,
 * because that field says which forge cezar can SERVE, not which one the remote is on.
 */
export function resolveForge(repoInfo: RepoInfo | null): ForgeDriver | null {
  if (!repoInfo?.remote) return null;
  const parsed = parseRemote(repoInfo.remote);
  if (!parsed) return null;
  if (classifyRemote(repoInfo.remote, repoInfo.root) === 'github') {
    return createGithubDriver(repoInfo.root, { owner: parsed.owner, repo: parsed.repo });
  }
  return null;
}

/**
 * The driver a forge READ route serves from — identical to `resolveForge` in every real
 * configuration, and different in exactly one: `CEZ_DRY_RUN=1`.
 *
 * The `/api/v1/github/*` routes used to import `fetchGithub*` directly, and every one of those
 * functions answers its mock catalog before it looks at anything else — remote included. So the
 * mocked forge has always been reachable from a scratch directory with no git remote at all, which
 * is what the offline demo (`CEZ_DRY_RUN=1 npm run dev`) and the whole `/api/v1/github/*` test
 * suite stand on, while `resolveForge` correctly answers `null` there. Routing those reads through
 * a driver has to keep that, or dry-run quietly loses the tab.
 *
 * Deliberately NOT folded into `resolveForge`: `/health` reports `forge: null` for a remote-less
 * checkout and must keep doing so. That field says which forge the project is ON, and mocking the
 * CLI does not put it on one.
 */
export function resolveReadForge(repoRoot: string, repoInfo: RepoInfo | null): ForgeDriver | null {
  const driver = resolveForge(repoInfo);
  if (driver) return driver;
  return process.env.CEZ_DRY_RUN === '1' ? createGithubDriver(repoRoot, null) : null;
}

export type { ForgeDriver, ForgeAvailability, ForgeItem, ForgeKind, ForgePrStatus, ForgeRefKind } from './types.ts';
