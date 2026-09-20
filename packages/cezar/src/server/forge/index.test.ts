import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { RepoInfo } from '../git.ts';
import { classifyRemote, forgeWebRoot, parseRemote, resolveForge, type ParsedRemote } from './index.ts';
import { __clearGlabHostCacheForTests } from './glab-hosts.ts';
import { __clearRefStatusCacheForTests } from './github.ts';

/** Forge resolution (spec §"Forge-driver seam"): remote host → driver | null. */

const info = (remote?: string): RepoInfo => ({ root: '/repo', branch: 'main', remote });

const restoreEnv = (name: string, saved: string | undefined) => {
  if (saved === undefined) delete process.env[name];
  else process.env[name] = saved;
};

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

  it('keeps every segment of a subgroup-nested project path', () => {
    expect(forgeWebRoot('git@gitlab.com:group/subgroup/project.git')).toBe(
      'https://gitlab.com/group/subgroup/project',
    );
  });

  it('is null for a host no forge claims', () => {
    expect(forgeWebRoot('https://git.example.com/acme/demo.git')).toBeNull();
  });
});

describe('classifyRemote', () => {
  // The registry probe's classification (#698): no driver, no `gh`, no subprocess of any kind.
  it.each([
    ['https://github.com/acme/demo.git', 'github'],
    ['git@github.com:acme/demo.git', 'github'],
    ['git@gitlab.com:acme/demo.git', 'gitlab'],
    ['https://gitlab.com/group/sub/project.git', 'gitlab'],
    ['https://git.example.com/acme/demo.git', null],
    ['/srv/git/demo.git', null],
    [undefined, null],
  ])('classifies %s as %s from the static table', (remote, expected) => {
    expect(classifyRemote(remote)).toBe(expected);
  });

  /**
   * The half a table cannot do (spec Architecture §1). `git.acme.internal` is not a host cezar
   * could ever ship, and the user is not asked to name it — it classifies because `glab` was
   * authenticated against it, which is a file on disk.
   */
  describe('against a glab config on disk', () => {
    const savedHome = process.env.HOME;
    const savedXdgHome = process.env.XDG_CONFIG_HOME;
    const savedXdgDirs = process.env.XDG_CONFIG_DIRS;
    const savedGlabDir = process.env.GLAB_CONFIG_DIR;
    let dir: string;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'cez-classify-'));
      // Pin every glab-relevant variable: a developer who really has `glab` configured must not
      // change what this suite sees.
      process.env.HOME = join(dir, 'home');
      process.env.XDG_CONFIG_DIRS = join(dir, 'etc-xdg');
      delete process.env.XDG_CONFIG_HOME;
      delete process.env.GLAB_CONFIG_DIR;
      __clearGlabHostCacheForTests();
    });

    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
      restoreEnv('HOME', savedHome);
      restoreEnv('XDG_CONFIG_HOME', savedXdgHome);
      restoreEnv('XDG_CONFIG_DIRS', savedXdgDirs);
      restoreEnv('GLAB_CONFIG_DIR', savedGlabDir);
      __clearGlabHostCacheForTests();
    });

    const authenticate = (host: string, root = join(dir, 'home/.config/glab-cli')) => {
      mkdirSync(root, { recursive: true });
      writeFileSync(join(root, 'config.yml'), `hosts:\n    ${host}:\n        token: glpat-xxxxxxxxxxxxxxxxxxxx\n`);
      __clearGlabHostCacheForTests();
    };

    it('classifies a self-hosted host glab knows', () => {
      authenticate('git.acme.internal');
      expect(classifyRemote('ssh://git@git.acme.internal:2222/team/platform/cezar.git')).toBe('gitlab');
    });

    it('leaves a self-hosted host glab does NOT know unclassified', () => {
      authenticate('git.acme.internal');
      expect(classifyRemote('https://git.other.internal/team/app.git')).toBeNull();
    });

    it('classifies nothing extra when glab was never configured', () => {
      expect(classifyRemote('https://git.acme.internal/team/app.git')).toBeNull();
    });

    it('never lets a discovered host reclassify github.com', () => {
      authenticate('github.com');
      expect(classifyRemote('git@github.com:acme/demo.git')).toBe('github');
    });

    it('sees a per-repo .git/glab-cli config when given the root', () => {
      const repoRoot = join(dir, 'repo');
      authenticate('git.repo-only.internal', join(repoRoot, '.git/glab-cli'));
      const remote = 'git@git.repo-only.internal:team/app.git';
      expect(classifyRemote(remote, repoRoot)).toBe('gitlab');
      expect(classifyRemote(remote)).toBeNull();
    });

    it('builds the web root of a discovered self-hosted project from the whole path', () => {
      authenticate('git.acme.internal');
      expect(forgeWebRoot('https://oauth2:glpat-x@git.acme.internal/team/platform/cezar.git')).toBe(
        'https://git.acme.internal/team/platform/cezar',
      );
    });
  });
});

describe('resolveForge', () => {
  it('maps a github.com https remote to the GitHub driver', () => {
    expect(resolveForge(info('https://github.com/acme/demo.git'))?.kind).toBe('github');
  });

  it('maps a github.com scp-like remote to the GitHub driver', () => {
    expect(resolveForge(info('git@github.com:acme/demo.git'))?.kind).toBe('github');
  });

  // Classified, but not yet servable: the GitLab driver is the next phase (spec step 8). Until it
  // exists, `/health` reporting `forge: null` for a GitLab project is correct — that field says
  // which forge cezar can SERVE, not which one the remote is on.
  it('returns null for a GitLab remote until its driver exists', () => {
    expect(classifyRemote('git@gitlab.com:acme/demo.git')).toBe('gitlab');
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
