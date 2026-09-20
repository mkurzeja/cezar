import type { CachedRefStatuses, ResolvedReference } from './types.ts';

/**
 * The per-reference status cache — module-level, and deliberately NOT owned by a driver.
 *
 * ⚠ This module is load-bearing for something no line of the cache itself states.
 * `readCachedRefStatuses` is read by `GET /api/v1/workspace/runs-index`, whose contract
 * (BACKWARD_COMPATIBILITY.md §2) is that reading it is **side-effect free**: it must never touch
 * the forge, and it must never build a project context, because building one prunes worktrees and
 * `recover()`s interrupted runs — *typing in a search box must not restart agents.*
 *
 * A per-project driver instance is exactly what that route cannot have. So when the read tier moved
 * onto `ForgeDriver`, the cache did not move with it: it lives here, anyone may read it with
 * nothing but a repo root, and the driver became one more reader rather than its owner. A future
 * forge driver caches through these functions; it does not bring its own map.
 *
 * `runs-index-api.test.ts` pins both halves — no context built, no forge call made.
 *
 * Keyed by repo root and NUMBER, not by kind, because the kind is something the forge answers
 * rather than something the caller asserts. `null` is a cached "this repository has no such
 * number", so a transcript-scraped number from another repo is not re-queried on every repaint.
 *
 * `unknownSince` is when a reference FIRST came back with its mergeability still being computed,
 * carried across refreshes so the fast recheck below is bounded to that first window rather than
 * restarting on every answer that is still `unknown`.
 */

interface RefStatusEntry {
  at: number;
  resolved: ResolvedReference | null;
  unknownSince?: number;
}

const refStatusCache = new Map<string, RefStatusEntry>();
const REF_STATUS_CACHE_MAX = 500;

/** NUL separator, as everywhere else in this package: two projects each having a #42 must not
 *  collide. */
function refStatusKey(repoRoot: string, number: number): string {
  return `${repoRoot}\0#${number}`;
}

/** The ordinary freshness window for a status that can still move. Its own constant rather than
 *  the package-wide `CACHE_MS`: the other three TTLs below are derived from what a status IS, and
 *  this cache is free to diverge from the list/checks/detect caches without dragging them along. */
export const REF_STATUS_TTL_MS = 60_000;

/** A closed issue or an abandoned PR can be REOPENED, so this is long rather than forever — but
 *  it is the rare event, and re-asking a hundred settled references every minute to catch it is
 *  the wrong trade. */
const REF_STATUS_CLOSED_TTL = 10 * 60_000;

/** A merged pull request is merged forever: GitHub has no un-merge. Capped at a day only so a
 *  long-lived server eventually re-reads rather than trusting a value from another era. */
const REF_STATUS_MERGED_TTL = 24 * 60 * 60_000;

/**
 * How long a still-computing mergeability holds, and for how long that fast cadence applies.
 *
 * Five seconds because that is the shape of the thing being waited for: GitHub kicks off the
 * merge-base computation when asked and usually has it by the next request. Bounded to a minute
 * because a value that is STILL unknown after that is not a computation in flight any more — it is
 * a repository that will not answer, and re-asking it every five seconds forever costs a `gh`
 * subprocess a second for nothing.
 */
const MERGEABILITY_UNKNOWN_TTL_MS = 5_000;
const MERGEABILITY_UNKNOWN_WINDOW_MS = 60_000;

/**
 * How long a cached answer stays fresh — by how changeable that answer IS.
 *
 * One TTL for everything gets both ends wrong: it re-asks about a merged PR (which cannot change)
 * every minute, and it is the only thing standing between a running CI job and a stale chip. What
 * a reader wants rechecked is precisely what is still moving.
 *
 * A number the repository does not have keeps the short TTL: it is usually a wrong number, but it
 * is also what a reference to a not-yet-created PR looks like, and re-asking is cheap.
 */
function refStatusTtl(entry: ResolvedReference | null, unknownSince?: number, now = Date.now()): number {
  if (!entry) return REF_STATUS_TTL_MS;
  // Mergeability GitHub has not finished computing is not an answer to cache for a minute. It is
  // the normal reply for the first seconds after a push, and holding it that long is what let a
  // conflicting pull request read "Ready to merge" until the page was reloaded. Ask again in
  // seconds instead — and only while it is still plausibly being computed, so a repository that
  // answers `UNKNOWN` indefinitely settles back to the ordinary cadence rather than spawning `gh`
  // every few seconds forever.
  if (
    entry.mergeable === 'unknown' &&
    unknownSince !== undefined &&
    now - unknownSince < MERGEABILITY_UNKNOWN_WINDOW_MS
  ) {
    return MERGEABILITY_UNKNOWN_TTL_MS;
  }
  switch (entry.status) {
    case 'merged':
      return REF_STATUS_MERGED_TTL;
    case 'closed':
    case 'completed':
    case 'not-planned':
      return REF_STATUS_CLOSED_TTL;
    default:
      return REF_STATUS_TTL_MS;
  }
}

/** How long a status can be trusted to stay put — `null` when it can never change again. The
 *  cadence half of `refStatusTtl`, and deliberately the same function: a value the cache would
 *  still be serving is a value there is no point asking for, and a value it would NOT serve —
 *  mergeability still being computed — is one the cockpit should come back for just as soon. */
export function refStatusRecheckAfter(
  entry: ResolvedReference | null,
  unknownSince?: number,
  now = Date.now(),
): number | null {
  if (entry?.status === 'merged') return null; // GitHub has no un-merge
  return refStatusTtl(entry, unknownSince, now);
}

/** How long the WHOLE answer holds — the soonest any single reference in it could differ. `null`
 *  only when every one of them is immutable, which is what tells the cockpit to stop scheduling.
 *  Taking the per-reference values rather than the entries, because one of them may be on the fast
 *  mergeability cadence and the batch has to travel at the speed of its most impatient member. */
export function batchRecheckAfter(rechecks: (number | null)[]): number | null {
  let soonest: number | null = null;
  for (const after of rechecks) {
    if (after === null) continue;
    soonest = soonest === null ? after : Math.min(soonest, after);
  }
  return soonest;
}

/**
 * Everything the cache ALREADY knows about these numbers. Never spawns `gh`, never awaits, never
 * needs a driver or a project context — see this module's header for why that last one is a
 * contract rather than a convenience.
 *
 * This is what lets a status ride along with the rows that carry the references, instead of the
 * cockpit fetching it separately a moment later: the run index reads whatever is warm and ships
 * it, and a cold entry is simply absent — the lazy `/github/ref-status` route stays the thing that
 * actually goes and asks.
 *
 * Because it cannot cost anything, the caller may pass a SUPERSET of the numbers it will really
 * display. That matters: deciding which of a run's references a chip shows is the cockpit's rule
 * (#407, #526), deliberately not duplicated server-side, and a cache read does not need to know —
 * it can look up every number a run mentions and let the client pick.
 */
export function readCachedRefStatuses(repoRoot: string, numbers: Iterable<number>): CachedRefStatuses {
  const out: CachedRefStatuses = { prs: {}, issues: {} };
  const now = Date.now();
  for (const number of new Set(numbers)) {
    const hit = refStatusCache.get(refStatusKey(repoRoot, number));
    if (!hit || !hit.resolved || now - hit.at >= refStatusTtl(hit.resolved, hit.unknownSince, now)) continue;
    out[hit.resolved.kind === 'pr' ? 'prs' : 'issues'][number] = hit.resolved.status;
  }
  return out;
}

/** The entry for one number when it is still FRESH, or `null` — the lookup the fetching tier does
 *  before deciding a number is a miss. */
export function peekFreshRefStatus(
  repoRoot: string,
  number: number,
  now = Date.now(),
): RefStatusEntry | null {
  const hit = refStatusCache.get(refStatusKey(repoRoot, number));
  if (!hit || now - hit.at >= refStatusTtl(hit.resolved, hit.unknownSince, now)) return null;
  return hit;
}

/** When this reference FIRST answered with its mergeability still computing, fresh or stale. Read
 *  on the way back from a query so the fast cadence stays bounded to that first window instead of
 *  restarting every time the forge says `UNKNOWN` again. */
export function peekRefStatusUnknownSince(repoRoot: string, number: number): number | undefined {
  return refStatusCache.get(refStatusKey(repoRoot, number))?.unknownSince;
}

/** Record what the forge just answered, and keep the map bounded. `at` is the caller's, not
 *  `Date.now()`: an answer must be dated when it ARRIVED, and dating it by when the request was
 *  assembled would age a slow query's results by its own duration — shortening the TTL of exactly
 *  the answers that cost the most to get. */
export function storeRefStatus(repoRoot: string, number: number, entry: RefStatusEntry): void {
  refStatusCache.set(refStatusKey(repoRoot, number), {
    at: entry.at,
    resolved: entry.resolved,
    ...(entry.unknownSince === undefined ? {} : { unknownSince: entry.unknownSince }),
  });
  while (refStatusCache.size > REF_STATUS_CACHE_MAX) {
    const oldest = refStatusCache.keys().next().value;
    if (oldest === undefined) break;
    refStatusCache.delete(oldest);
  }
}

/**
 * Forget what we knew about one reference, so the next read asks the forge again.
 *
 * Called where cezar itself CHANGES a pull request — it merges one, it opens one — because those
 * are the only forge changes this process can know about without asking. Everything else has to
 * be polled (GitHub cannot push to a cockpit with no public endpoint), but waiting out a TTL to
 * notice our own merge is a self-inflicted staleness: for up to a minute every chip would keep
 * showing the pre-merge status of a pull request the user watched this server merge.
 *
 * Deleting rather than overwriting with a guessed `merged`: the forge is the authority on what a
 * reference is, and a mutation that reports success is still not the same as having read the
 * result. The next reader pays one query and gets the truth — after which the answer is `merged`,
 * `recheckAfterMs` goes null, and the cockpit stops polling that batch entirely. Invalidating here
 * therefore REDUCES long-run traffic rather than adding to it.
 */
export function forgetRefStatus(repoRoot: string, number: number): void {
  refStatusCache.delete(refStatusKey(repoRoot, number));
}

/** Test-only: drop the cache so cases don't leak state into each other. */
export function __clearRefStatusCacheForTests(): void {
  refStatusCache.clear();
}

/** Test-only: warm the cache the way the lazy route would have, so a reader can be tested
 *  without a forge behind it. */
export function __seedRefStatusCacheForTests(
  repoRoot: string,
  entries: Array<[number, ResolvedReference]>,
): void {
  for (const [number, resolved] of entries) {
    refStatusCache.set(refStatusKey(repoRoot, number), { at: Date.now(), resolved });
  }
}
