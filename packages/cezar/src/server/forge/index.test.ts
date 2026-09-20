import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RepoInfo } from '../git.ts';
import { forgeKindOfRemote, forgeWebRoot, parseRemote, resolveForge, type ParsedRemote } from './index.ts';
import { __clearRefStatusCacheForTests } from './github.ts';

/** Forge resolution (spec §"Forge-driver seam"): remote host → driver | null. */

const info = (remote?: string): RepoInfo => ({ root: '/repo', branch: 'main', remote });

describe('parseRemote', () => {
  const gh = (extra: Partial<ParsedRemote> = {}): ParsedRemote => ({
    host: 'github.com',
    projectPath: 'acme/demo',
    owner: 'acme',
    repo: 'demo',
    ...extra,
  });

  it.each([
    ['https://github.com/acme/demo.git', gh()],
    ['https://github.com/acme/demo', gh()],
    ['https://user:token@github.com/acme/demo.git', gh()],
    ['git@github.com:acme/demo.git', gh()],
    ['ssh://git@github.com/acme/demo.git', gh()],
    ['ssh://git@github.com:2222/acme/demo.git', gh()],
    ['git://github.com/acme/demo.git', gh()],
    ['https://GitHub.com/acme/demo.git', gh()],
    ['https://github.com/acme/demo/', gh()],
  ])('parses %s', (remote, expected) => {
    expect(parseRemote(remote)).toEqual(expected);
  });

  /**
   * The subgroup half (GitLab spec Architecture §2). `owner`/`repo` stay the LAST TWO segments —
   * byte-identical to what they have always been, because the GitHub driver passes them to
   * `gh --repo` — and `projectPath` is the whole path, which is the only thing a nested GitLab
   * URL can be built from. Three levels because GitLab nests arbitrarily and two-deep would pass
   * against a `parts.slice(-3)` that is still wrong.
   */
  it.each([
    [
      'https://gitlab.com/group/subgroup/project.git',
      { host: 'gitlab.com', projectPath: 'group/subgroup/project', owner: 'subgroup', repo: 'project' },
    ],
    [
      'git@gitlab.com:group/sub/project.git',
      { host: 'gitlab.com', projectPath: 'group/sub/project', owner: 'sub', repo: 'project' },
    ],
    [
      'ssh://git@gitlab.example.com:2222/grp/a/b/proj.git',
      { host: 'gitlab.example.com', projectPath: 'grp/a/b/proj', owner: 'b', repo: 'proj' },
    ],
    [
      'https://oauth2:glpat-xxx@git.acme.internal/team/platform/cezar.git',
      { host: 'git.acme.internal', projectPath: 'team/platform/cezar', owner: 'platform', repo: 'cezar' },
    ],
  ])('keeps the whole path of %s', (remote, expected) => {
    expect(parseRemote(remote)).toEqual(expected);
  });

  it.each([
    ['/srv/git/demo.git'], // local bare path — not a forge
    ['../relative/path'],
    ['https://github.com/only-owner'],
    [''],
  ])('rejects %s', (remote) => {
    expect(parseRemote(remote)).toBeNull();
  });
});

describe('forgeWebRoot', () => {
  it('rebuilds a github.com root exactly as it always did', () => {
    expect(forgeWebRoot('https://tok3n:x@github.com/acme/demo.git')).toBe('https://github.com/acme/demo');
  });

  it('is null for a host no forge claims', () => {
    expect(forgeWebRoot('https://git.example.com/acme/demo.git')).toBeNull();
  });
});

describe('forgeKindOfRemote', () => {
  // The registry probe's classification (#698) — same host table as resolveForge,
  // but string-only: no driver, no repo root, no `gh`.
  it.each([
    ['https://github.com/acme/demo.git', 'github'],
    ['git@github.com:acme/demo.git', 'github'],
    ['git@gitlab.com:acme/demo.git', null],
    ['https://git.example.com/acme/demo.git', null],
    ['/srv/git/demo.git', null],
    [undefined, null],
  ])('classifies %s as %s', (remote, expected) => {
    expect(forgeKindOfRemote(remote)).toBe(expected);
  });
});

describe('resolveForge', () => {
  it('maps a github.com https remote to the GitHub driver', () => {
    expect(resolveForge(info('https://github.com/acme/demo.git'))?.kind).toBe('github');
  });

  it('maps a github.com scp-like remote to the GitHub driver', () => {
    expect(resolveForge(info('git@github.com:acme/demo.git'))?.kind).toBe('github');
  });

  it('returns null for an unknown forge host (GitLab lands here later)', () => {
    expect(resolveForge(info('git@gitlab.com:acme/demo.git'))).toBeNull();
  });

  it('returns null for a self-hosted host', () => {
    expect(resolveForge(info('https://git.example.com/acme/demo.git'))).toBeNull();
  });

  it('returns null when the repo has no remote', () => {
    expect(resolveForge(info(undefined))).toBeNull();
  });

  it('returns null when not in a git repo at all', () => {
    expect(resolveForge(null)).toBeNull();
  });

  it('returns null for a local-path remote', () => {
    expect(resolveForge(info('/srv/git/demo.git'))).toBeNull();
  });
});

/**
 * The read tier on the seam (GitLab spec Phase 1, step 1). Four methods the interface now NAMES,
 * so a route can be served by "whatever driver this project resolved to" instead of by a
 * `fetchGithub*` import that only one forge can ever satisfy.
 *
 * Driven through `CEZ_DRY_RUN=1`: what is under test is that the driver delegates each method to
 * the function that already implemented it, not the `gh` shelling those functions do — that has
 * its own suite in `github.test.ts`.
 */
describe('GitHub driver read tier', () => {
  const previousDryRun = process.env.CEZ_DRY_RUN;
  const driver = () => resolveForge(info('git@github.com:acme/demo.git'))!;

  beforeAll(() => {
    process.env.CEZ_DRY_RUN = '1';
  });

  afterAll(() => {
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
    __clearRefStatusCacheForTests();
  });

  it('answers the whole list payload, not just the two item arrays', async () => {
    const data = await driver().listItems();
    expect(data.available).toBe(true);
    expect(data.issues.length).toBeGreaterThan(0);
    expect(data.prs.length).toBeGreaterThan(0);
    // The fields an `issues`/`prs` pair structurally cannot carry, which is why `listItems` is not
    // `listIssues` + `listPRs`.
    expect(data).toHaveProperty('repo');
    expect(data).toHaveProperty('labelColors');
  });

  it('answers a comment thread for either kind', async () => {
    for (const kind of ['issue', 'pr'] as const) {
      const thread = await driver().comments(kind, 128);
      expect(thread.available).toBe(true);
      expect(Array.isArray(thread.comments)).toBe(true);
    }
  });

  it('answers a glyph per requested PR number', async () => {
    const checks = await driver().prChecks([128, 124]);
    expect(checks.available).toBe(true);
    if (!checks.available) throw new Error('expected available');
    expect(checks.checks[128]).toBe('passing');
    expect(checks.checks[124]).toBe('failing');
  });

  it('answers batched reference status filed by what each number turned out to be', async () => {
    const status = await driver().refStatus({ prs: [128], issues: [142] });
    expect(status.available).toBe(true);
    if (!status.available) throw new Error('expected available');
    expect(status.prs[128]).toBeDefined();
    expect(status.issues[142]).toBeDefined();
    expect(status).toHaveProperty('recheckAfterMs');
  });
});

describe('GitHub driver viewUrl', () => {
  const driver = resolveForge(info('git@github.com:acme/demo.git'))!;

  it.each([
    ['repo', 'x', 'https://github.com/acme/demo'],
    ['issue', 142, 'https://github.com/acme/demo/issues/142'],
    ['pr', 128, 'https://github.com/acme/demo/pull/128'],
    ['branch', 'feat/cockpit ui', 'https://github.com/acme/demo/tree/feat/cockpit%20ui'],
    ['commit', 'abc1234', 'https://github.com/acme/demo/commit/abc1234'],
  ] as const)('%s → %s', (kind, ref, expected) => {
    expect(driver.viewUrl(kind, ref)).toBe(expected);
  });
});
