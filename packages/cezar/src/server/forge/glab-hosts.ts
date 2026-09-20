import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseYaml } from 'yaml';

/**
 * Which GitLab instances this machine is already authenticated against — read out of `glab`'s own
 * config (GitLab spec D1, step 6).
 *
 * The problem it solves: a self-hosted GitLab has an arbitrary hostname. `git.acme.internal` is
 * not on any table cezar could ship, so a host table can never classify it, and asking the user to
 * name it in a config file is the thing AGENTS.md § Zero config forbids. But the user has already
 * told `glab` about that host — that is what `glab auth login` writes — so cezar discovers it the
 * same way it discovers everything else, and a host `glab` does not know simply stays `null`:
 * today's plain-git cockpit, unchanged.
 *
 * ## Security rule: parse the `hosts:` KEYS, discard everything else
 *
 * This file holds API tokens (`glpat-…`). Nothing here returns, logs or caches a VALUE — only
 * hostnames — because the correct defense is never reading the value, not redacting it afterwards.
 * Two consequences that look like over-caution and are not:
 *
 *   - the parse result is narrowed to `Object.keys(hosts)` immediately, never passed around;
 *   - a parse failure is reported WITHOUT the parser's message. `yaml` quotes the offending source
 *     line in its errors, and on this file the offending line is as likely as not the token.
 *
 * ## Cost
 *
 * `classifyRemote` is documented as "plain string parsing, no `gh` shell-out" — the registry
 * probe runs it per project. This must not regress that into a subprocess, so it is a file read
 * and a YAML parse, never `glab auth status`. The parse is cached and invalidated on mtime, so the
 * steady-state cost is one `stat` per candidate path.
 */

/** A `hosts:` key, normalized to what `parseRemote` produces for a remote's host. */
function normalizeHost(raw: string): string | null {
  // glab stores bare hostnames, but a hand-edited config may carry a scheme or a trailing slash,
  // and a host entered as `GitLab.Example.COM` must still match a lowercased parsed remote.
  //
  // The PORT is dropped for the same reason: `parseRemote` never puts one in `host`
  // (`ssh://git@gitlab.internal:2222/g/p` parses to `gitlab.internal`), so a `hosts:` entry that
  // kept its port could never match anything and would be a silently dead row. An instance is
  // identified by its hostname here, not by the port a particular remote reaches it on.
  const host = raw
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, '')
    .replace(/\/.*$/, '')
    .replace(/:\d+$/, '')
    .toLowerCase();
  // Deliberately strict: this value is compared against a parsed remote host and nothing else, so
  // anything that cannot BE a hostname is a malformed row to skip rather than a value to sanitize.
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/.test(host) ? host : null;
}

/**
 * The config files `glab` reads, in its own precedence order (verified 2026-09-20):
 * `$GLAB_CONFIG_DIR` → the legacy `~/.config/glab-cli` → `$XDG_CONFIG_HOME/glab-cli` →
 * each `$XDG_CONFIG_DIRS` entry (default `/etc/xdg`). Exported for the tests that pin the order.
 *
 * `repoRoot` adds the per-repo `.git/glab-cli/config.yml` at the END, because it is not part of
 * that chain: glab LAYERS it on top of whichever global file won rather than replacing it, so
 * `knownGlabHosts` unions it in instead of letting it terminate the search.
 */
export function glabHostConfigPaths(
  env: NodeJS.ProcessEnv = process.env,
  repoRoot?: string,
): { global: string[]; local: string[] } {
  const home = env.HOME || env.USERPROFILE || homedir();
  const configDir = env.GLAB_CONFIG_DIR?.trim();
  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  const xdgConfigDirs = (env.XDG_CONFIG_DIRS?.trim() || '/etc/xdg').split(':').filter(Boolean);
  const global = [
    ...(configDir ? [join(configDir, 'config.yml')] : []),
    join(home, '.config', 'glab-cli', 'config.yml'),
    ...(xdgConfigHome ? [join(xdgConfigHome, 'glab-cli', 'config.yml')] : []),
    ...xdgConfigDirs.map((dir) => join(dir, 'glab-cli', 'config.yml')),
  ];
  return {
    // `~/.config` IS the XDG default, so an unset `XDG_CONFIG_HOME` makes entries 2 and 3 the same
    // file. Deduped so the precedence walk does not read it twice.
    global: [...new Set(global)],
    local: repoRoot ? [join(repoRoot, '.git', 'glab-cli', 'config.yml')] : [],
  };
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  hosts: readonly string[];
}

const cache = new Map<string, CacheEntry>();
/** One warning per path per process. A config cezar cannot read is worth saying once; saying it on
 *  every registry probe would bury the cockpit's real output. */
const warned = new Set<string>();

/**
 * The hosts named in one config file, or `null` when the file does not exist (which is the common
 * case and is not a failure — it is how the precedence walk knows to keep looking).
 *
 * An existing-but-broken file answers `[]`, not `null`: it participates in precedence (glab would
 * have used it) and contributes nothing.
 */
function hostsInFile(path: string): readonly string[] | null {
  let stats;
  try {
    stats = statSync(path);
  } catch {
    return null; // absent, or a directory component that is not readable — both mean "not here".
  }
  if (!stats.isFile()) return null;
  const cached = cache.get(path);
  if (cached && cached.mtimeMs === stats.mtimeMs && cached.size === stats.size) return cached.hosts;
  const hosts = readHostKeys(path);
  cache.set(path, { mtimeMs: stats.mtimeMs, size: stats.size, hosts });
  return hosts;
}

/** The one place the file's bytes are touched. Everything it returns is a hostname. */
function readHostKeys(path: string): readonly string[] {
  try {
    const doc: unknown = parseYaml(readFileSync(path, 'utf8'));
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return [];
    const hosts = (doc as Record<string, unknown>).hosts;
    if (!hosts || typeof hosts !== 'object' || Array.isArray(hosts)) return [];
    return Object.keys(hosts)
      .map(normalizeHost)
      .filter((host): host is string => host !== null);
  } catch {
    // No `err.message`: see the security rule above — the parser quotes the offending line, and on
    // this file that line may be a token. The path is enough for a user to go look.
    if (!warned.has(path)) {
      warned.add(path);
      console.warn(`[cez] could not read glab's config at ${path} — self-hosted GitLab hosts stay undiscovered`);
    }
    return [];
  }
}

/**
 * Every GitLab hostname this machine knows, lowercased. Empty when `glab` was never configured,
 * when its config is unreadable, and when it is corrupt — all three degrade to "no GitLab hosts
 * known", which leaves `gitlab.com` (the static half of `classifyRemote`) still working and every
 * other host classified `null`, exactly as before this existed. Never throws.
 */
export function knownGlabHosts(opts: { env?: NodeJS.ProcessEnv; repoRoot?: string } = {}): readonly string[] {
  const { global, local } = glabHostConfigPaths(opts.env ?? process.env, opts.repoRoot);
  const hosts = new Set<string>();
  for (const path of global) {
    const found = hostsInFile(path);
    // First file that EXISTS wins the global tier, even when it names no hosts — that is what
    // precedence means, and a user who points `$GLAB_CONFIG_DIR` at an empty config has said
    // something.
    if (found !== null) {
      for (const host of found) hosts.add(host);
      break;
    }
  }
  for (const path of local) for (const host of hostsInFile(path) ?? []) hosts.add(host);
  return [...hosts];
}

/** Test seam: the mtime cache would otherwise survive a fixture being rewritten within the same
 *  millisecond, which is exactly what a test that writes two configs in a row does. */
export function __clearGlabHostCacheForTests(): void {
  cache.clear();
  warned.clear();
}
