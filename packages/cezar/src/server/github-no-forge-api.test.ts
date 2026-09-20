import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * What the `/api/v1/github/*` family answers for a project cezar cannot read a forge from.
 *
 * This is the branch the seam refactor introduced (GitLab spec Phase 1, step 3): the routes used
 * to import `fetchGithub*` directly and would shell out to `gh` in any checkout, degrading with
 * whatever `gh` said; they now resolve a driver first and answer for themselves when there is
 * none. Six new branches, and until this file none of them had a test.
 *
 * Deliberately **not** `CEZ_DRY_RUN=1` — that is the one mode where a driver is always resolved
 * (`resolveReadForge`), so it could never reach this code. The env var is cleared for the whole
 * file so a stray outer setting cannot silently turn these cases into the mock catalog.
 *
 * The fixture is a real git repository with a GitLab origin, which today classifies as no forge
 * at all. Phase 2 makes that host classify and Phase 3 gives it a driver — at which point these
 * cases must move to a remote that is genuinely unsupported (the `no-remote` case below already
 * is one, permanently). The `reason` assertions are what makes that visible instead of silent:
 * they are only producible WITHOUT asking `gh`, so they double as the proof that a project on an
 * unreadable forge costs no subprocess.
 */
describe('the github API for a project with no readable forge', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  const previousDryRun = process.env.CEZ_DRY_RUN;
  const NO_FORGE = 'this project’s origin is not a forge cezar can read';

  beforeAll(() => {
    delete process.env.CEZ_DRY_RUN;
  });
  afterAll(() => {
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
  });

  const openApp = (remote?: string) => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-noforge-'));
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    execFileSync('git', ['init', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: repoRoot });
    execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: repoRoot });
    if (remote) execFileSync('git', ['remote', 'add', 'origin', remote], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test' });
  };

  beforeEach(() => {
    openApp('git@gitlab.com:acme/demo.git');
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** Every read route, with the key that carries its "nothing here" value beside `available`.
   *  Each answers 200 with an in-payload degrade — never a 5xx, never a bare empty success. */
  it.each([
    ['/api/v1/github', 'issues'],
    ['/api/v1/github/comments/pr/128', 'comments'],
    ['/api/v1/github/checks?prs=128', undefined],
    ['/api/v1/github/search?kind=pr&q=demo', 'items'],
    ['/api/v1/github/ref-status?prs=128', undefined],
    ['/api/v1/github/prs/128/changes', undefined],
  ] as const)('degrades %s in the payload with an honest reason', async (path, emptyKey) => {
    const res = await apiRequest(app, path);

    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.available).toBe(false);
    expect(body.reason).toBe(NO_FORGE);
    // The empty collection stays present where the payload has always carried one, so a client
    // can read it without a guard — absence of data, not absence of a field.
    if (emptyKey) expect(body[emptyKey]).toEqual([]);
  });

  it('keeps ref-status answering the cadence key, so a client never schedules on undefined', async () => {
    const res = await apiRequest(app, '/api/v1/github/ref-status?prs=128&issues=7');

    // `null` is the contract's "nothing in this answer can change; do not schedule anything"
    // (BACKWARD_COMPATIBILITY.md §2) — the right answer for a project with no forge to ask.
    expect(await res.json()).toEqual({ available: false, reason: NO_FORGE, recheckAfterMs: null });
  });

  it('answers the same way for a repository with no remote at all', async () => {
    rmSync(repoRoot, { recursive: true, force: true });
    openApp();

    const res = await apiRequest(app, '/api/v1/github');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ available: false, reason: NO_FORGE, issues: [], prs: [] });
  });

  it('still validates its inputs before it looks for a forge', async () => {
    // The 400s are the route's own contract and must not become "unavailable" just because this
    // project has no forge — a malformed request is malformed either way.
    expect((await apiRequest(app, '/api/v1/github/checks?prs=nope')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/ref-status')).status).toBe(400);
    expect((await apiRequest(app, '/api/v1/github/comments/nope/1')).status).toBe(400);
  });
});
