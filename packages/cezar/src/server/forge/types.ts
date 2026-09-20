import type { RunRecord } from '../../runs/store.ts';

/**
 * Forge-driver seam (cockpit-ui redesign spec §"Forge-driver seam"): every
 * code-forge integration (GitHub today, GitLab later) implements `ForgeDriver`.
 * The interface is shaped strictly around what the cockpit already does via
 * `gh` — issue/PR listing for the GitHub tab, draft-PR creation for the review
 * gate, a per-branch PR probe, and web-URL building. Adding a forge = one new
 * driver file behind `resolveForge`, no route or UI changes.
 */

/**
 * Which forge a project's remote belongs to (GitLab spec Phase 2, step 4).
 *
 * Widening this is additive and value-level: no route, response shape or wire key changes, and a
 * consumer that ignores `'gitlab'` sees exactly what it saw before. It is mirrored — never
 * re-derived — by `health.forge.kind` and `projects.forge?` in `packages/contract`; the three must
 * widen together or `contract-parity*.test.ts` fails, which is the point of asserting both
 * directions.
 *
 * `'gitlab'` covers gitlab.com AND an arbitrary self-hosted instance. There is deliberately no
 * separate kind for self-hosted: the hostname is not the forge, and a `gitlab-selfhosted` value
 * would push every consumer into a two-value check for one product.
 */
export type ForgeKind = 'github' | 'gitlab';

/** Availability probe result — mirrors the tab's quiet degradation contract:
 *  no CLI, no remote, offline all land on `available:false` + a human hint. */
export interface ForgeAvailability {
  available: boolean;
  /** Human-readable hint when unavailable (`gh` missing, no remote, offline…). */
  reason?: string;
}

/** One issue or pull request, flattened for the cockpit. `/api/github` serves
 *  exactly this shape (BACKWARD_COMPATIBILITY.md §2 — do not reshape). */
export interface ForgeItem {
  kind: 'issue' | 'pr';
  number: number;
  title: string;
  author: string;
  createdAt: string;
  labels: string[];
  body: string;
  url: string;
  comments: number;
  /** PRs only. */
  isDraft?: boolean;
  additions?: number;
  deletions?: number;
  checks?: 'passing' | 'failing' | 'pending' | null;
}

/** The `GET /api/github` list payload — one answer carrying the whole tab: availability, the open
 *  issues and pull requests, and the repo-wide label colors. Shaped exactly as the route has always
 *  served it (BACKWARD_COMPATIBILITY.md §2 — do not reshape); `GithubData` in the GitHub driver is
 *  an alias of this, so the seam gained a name without the wire gaining a change. */
export interface ForgeListData {
  available: boolean;
  /** Human-readable hint when unavailable (CLI missing, no remote, offline…). */
  reason?: string;
  /** owner/name, when known. */
  repo?: string;
  syncedAt?: string;
  issues: ForgeItem[];
  prs: ForgeItem[];
  /** Repo-wide map of label name → 6-hex color (no `#`), so the UI can tint chips the way the
   *  forge does. Additive: absent on old payloads, chips fall back to neutral. */
  labelColors?: Record<string, string>;
}

/** A rolled-up CI verdict. `null` is "no CI configured here", which is a different answer from
 *  `'pending'` and from the glyph being absent altogether. */
export type ForgeChecksGlyph = 'passing' | 'failing' | 'pending' | null;

/** The `GET /api/github/checks` payload (#664) — the CI glyph for the PR rows currently on screen,
 *  hydrated lazily because rolling up every open PR's checks was the list's dominant cost. */
export type ForgeChecksData =
  | { available: true; checks: Record<number, ForgeChecksGlyph> }
  | { available: false; reason: string };

/** One comment (or PR review summary) in an issue/PR conversation thread (#499). Served by the
 *  new `GET /api/github/comments/:kind/:number` endpoint; additive, no impact on `ForgeItem`. */
export interface ForgeComment {
  id: number;
  /** Author login, `'?'` fallback when gh omits the user. */
  author: string;
  /** https://avatars.githubusercontent.com/…, when known. */
  avatarUrl?: string;
  /** ISO timestamp. */
  createdAt: string;
  /** Markdown body, sliced to the same 8 000-char cap as item bodies. */
  body: string;
  /** `review` = a submitted PR review summary; `comment` = a conversation comment. */
  kind: 'comment' | 'review';
  /** For reviews only — drives the state chip. */
  reviewState?: 'approved' | 'changes_requested' | 'commented' | 'dismissed';
  /** html_url deep link back to the comment/review on GitHub. */
  url: string;
}

/** The timeline event kinds the thread renders (#525). An allowlist, not a denylist: a new
 *  GitHub event type is dropped rather than rendered, so it can never crash or clutter the
 *  thread. `reviewed` is deliberately absent — reviews stay sourced from `/pulls/{n}/reviews`,
 *  which is already normalized and chipped; sourcing both would render each review twice. */
export type ForgeTimelineEventKind =
  | 'committed'
  | 'labeled'
  | 'unlabeled'
  | 'assigned'
  | 'unassigned'
  | 'merged'
  | 'closed'
  | 'reopened'
  | 'head_ref_force_pushed'
  | 'cross-referenced'
  | 'renamed';

/** One non-comment row in an issue/PR timeline (#525) — a commit, label change, assignment,
 *  merge, force-push, cross-reference or rename. Additive: `ForgeComment` is untouched and its
 *  `kind` deliberately does NOT widen to cover these (widening breaks client narrowing). */
export interface ForgeTimelineEvent {
  /** `evt-${id ?? sha ?? node_id ?? index}`. Prefixed so it cannot collide with the thread's
   *  `${kind}-${id}` comment keys. `sha` sits ahead of `node_id` because `committed` rows carry
   *  both and the SHA is the natural, debuggable identifier — it is also the rollup key. */
  id: string;
  kind: ForgeTimelineEventKind;
  /** Login — or the git author name for `committed`, which carries no GitHub actor. */
  actor: string;
  /** Absent for `committed` (a git author has no avatar). */
  avatarUrl?: string;
  /** ISO-8601. Resolved per kind: `committed` reads `author.date`, everything else
   *  `created_at` — `committed` rows return `created_at: null`, and mapping it naively
   *  string-sorts every commit to the top of the thread. */
  createdAt: string;
  url?: string;
  /** `committed` — full 40-char SHA (the rollup query rejects abbreviated ones). */
  sha?: string;
  /** `committed` — first line of the message, capped at 120 chars. */
  message?: string;
  /** `committed` — rolled-up CI state. **Absent** (query failed or skipped) and **`null`** (no CI
   *  configured) both render no glyph but stay distinct values for diagnosis. */
  checks?: 'passing' | 'failing' | 'pending' | null;
  /** `labeled` / `unlabeled`. */
  label?: { name: string; color?: string };
  /** `assigned`/`unassigned` login, or the new title for `renamed`. */
  subject?: string;
  /** `cross-referenced`. */
  refNumber?: number;
  refTitle?: string;
  refIsPr?: boolean;
}

/** The `GET /api/github/comments/:kind/:number` payload — mirrors the tab's quiet-degrade
 *  contract (`available: false` + a hint, never a 5xx). */
export interface ForgeCommentsData {
  available: boolean;
  /** Human-readable hint when unavailable. */
  reason?: string;
  /** Chronological, oldest first. */
  comments: ForgeComment[];
  /** True when either stream hit its cap, or the timeline fetch stopped short. Means "not
   *  showing you everything" — not specifically "comments were cut". */
  truncated?: boolean;
  /** Timeline events (#525) — additive and optional; absent when the timeline fetch degraded to
   *  the legacy comments-only call. Capped independently of `comments`, which keeps its exact
   *  pre-#525 shape, contents and cap (BACKWARD_COMPATIBILITY.md §2). */
  events?: ForgeTimelineEvent[];
}

export interface ForgeListOptions {
  /** Bypass the driver's short cache. */
  refresh?: boolean;
  /** Max items to fetch (driver-capped). */
  limit?: number;
}

/** The `GET /api/github/search` payload (#730). The list tier (`listIssues`/`listPRs`) only ever
 *  returns OPEN items, so the tab's in-memory filter structurally cannot find a closed or merged
 *  item — this is the seam that asks the forge instead of re-filtering what we already have.
 *  Mirrors the tab's quiet-degrade contract (`available: false` + a hint, never a throw/5xx). */
export interface ForgeSearchData {
  available: boolean;
  /** Human-readable hint when unavailable. */
  reason?: string;
  /** Hits in forge order, each flattened to the exact `ForgeItem` shape rows already render.
   *  `checks` is `null` and `additions`/`deletions` may be absent — the search tier does not pay
   *  for CI rollups or diffstats (same rationale as the list tier since #664). */
  items: ForgeItem[];
  /** True when the hit list hit the driver's cap, so the caller can say "showing the first N". */
  truncated?: boolean;
  /** `label name → 6-hex color` for the labels these hits carry. A closed PR often wears labels
   *  that no open item does, so its chips would otherwise render neutral; absent when the search
   *  degraded or the forge reports no colors. */
  labelColors?: Record<string, string>;
}

/** Where an existing branch's PR stands — feeds the Create PR → View PR flip. */
export interface ForgePrStatus {
  number: number;
  url: string;
  state: 'open' | 'merged' | 'closed';
  isDraft: boolean;
  checks: 'passing' | 'failing' | 'pending' | null;
}

// ---- reference status (task chips) -----------------------------------------
// The task tables paint a PR/issue chip per row and, until this seam existed, had nothing to
// paint it WITH: `RunRecord` stores the number and the URL, never the state, so a merged PR and
// an abandoned one looked identical. These are the shapes behind those chips.

/** Where a referenced PR or issue stands. Mirrored by `referenceStatusSchema` in the contract —
 *  see there for why PR `closed` and issue `completed` are separate words. */
export type ReferenceStatus =
  | 'draft'
  | 'review-required'
  | 'changes-requested'
  | 'checks-pending'
  | 'checks-failing'
  | 'ready'
  | 'merged'
  | 'closed'
  | 'open'
  | 'completed'
  | 'not-planned';

/**
 * Whether this pull request's branch merges into its base — the OTHER axis, kept out of
 * `ReferenceStatus` on purpose (see `conflicts` in the contract).
 *
 * Three values, and the third is the one that matters. GitHub does not store mergeability; it
 * COMPUTES it when asked, and answers `UNKNOWN` while the background job runs — which is the
 * normal answer for the first seconds after every push, and therefore for exactly the moment a
 * cockpit is most likely to be looking. `UNKNOWN` means *we were not told*, never *it is clean*,
 * and the caller must be able to tell those apart: it is what decides how soon to ask again
 * (`refStatusTtl`), and answering it as "not conflicting" with a one-minute TTL is precisely how a
 * conflicting pull request came to sit there wearing "Ready to merge".
 *
 * `undefined` for anything the question does not apply to: an issue, and a merged or closed pull
 * request (GitHub says `UNKNOWN` for those too, forever, and a terminal PR has no conflict left to
 * resolve — a merged PR wearing a conflict chip is a lie the state alone rules out).
 */
export type Mergeability = 'mergeable' | 'conflicting' | 'unknown';

/** What one number turned out to BE, and where it stands. Resolved by the forge rather than
 *  asserted by the caller, which is why a chip whose kind the cockpit guessed wrong still gets the
 *  right status. */
export interface ResolvedReference {
  kind: 'pr' | 'issue';
  status: ReferenceStatus;
  /** Absent when the question does not apply; see `Mergeability` and `conflicts` in the contract. */
  mergeable?: Mergeability;
}

/** The two number lists one `GET /api/github/ref-status` request may ask about. Both optional — a
 *  table may hold only issues — but a request naming neither asks for nothing. */
export interface ForgeRefStatusInput {
  prs?: number[];
  issues?: number[];
}

/** What the cache already holds for a set of numbers, filed by what each number turned out to be.
 *  Absent means "nothing is known", never "no such reference". */
export interface CachedRefStatuses {
  prs: Record<number, ReferenceStatus>;
  issues: Record<number, ReferenceStatus>;
}

/** The `GET /api/github/ref-status` payload. `recheckAfterMs` is answered by the SERVER because
 *  only it knows how changeable each status in the batch is. */
export type ForgeRefStatusData =
  | {
      available: true;
      prs: Record<number, ReferenceStatus>;
      issues: Record<number, ReferenceStatus>;
      /** The OPEN pull requests among them that do not merge into their base — the second axis,
       *  never folded into a status. Optional on the wire, and absent means "nothing is known"
       *  rather than "no conflicts"; see `conflicts` in the contract. */
      conflicts?: number[];
      /** When to ask again, or `null` when nothing here can change. See `recheckAfterMs` in the
       *  contract for why the SERVER answers this. */
      recheckAfterMs: number | null;
    }
  | { available: false; reason: string; recheckAfterMs: number | null };

export type ForgeMergeMethod = 'merge' | 'squash' | 'rebase';

export interface ForgePrCheck {
  name: string;
  state: 'passing' | 'failing' | 'pending' | 'unknown';
  required: boolean | null;
  url?: string;
}

export interface ForgePrMergeState {
  number: number;
  title: string;
  url: string;
  state: 'open' | 'closed' | 'merged';
  isDraft: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  mergeable: 'mergeable' | 'conflicting' | 'unknown';
  reviewDecision: 'approved' | 'changes-requested' | 'review-required' | 'unknown';
  checks: ForgePrCheck[];
  methods: ForgeMergeMethod[];
  defaultMethod: ForgeMergeMethod | null;
  eligibility: 'ready' | 'blocked' | 'pending' | 'unauthorized' | 'terminal' | 'unknown';
  blockers: Array<{ code: string; message: string }>;
  canMerge: boolean;
  canOverride: boolean;
}

export type ForgePrMergeStateResult =
  | { available: true; mergeState: ForgePrMergeState }
  | { available: false; reason: string };

export interface ForgeMergeInput {
  method: ForgeMergeMethod;
  expectedHeadSha: string;
  overrideRules?: boolean;
}

export type ForgeMergeResult =
  | {
      merged: true;
      number: number;
      url: string;
      method: ForgeMergeMethod;
      mergeCommitSha?: string;
    }
  | {
      merged: false;
      status: 403 | 404 | 409 | 502;
      error: string;
      code?: string;
      current?: ForgePrMergeState;
    };

export interface ForgePrChange {
  path: string;
  previousPath?: string;
  status: 'added' | 'modified' | 'removed' | 'renamed' | 'copied' | 'changed';
  additions: number;
  deletions: number;
  patch?: string;
  patchUnavailableReason?: 'binary' | 'too-large' | 'not-provided';
  truncated?: boolean;
}

export type ForgePrDiffResult =
  | {
      available: true;
      number: number;
      headSha: string;
      files: ForgePrChange[];
      additions: number;
      deletions: number;
      truncated: boolean;
      reason?: string;
    }
  | { available: false; reason: string };
export type ForgeRefKind = 'repo' | 'issue' | 'pr' | 'branch' | 'commit';

export type DraftPrOutcome =
  | { ok: true; url: string; dryRun: boolean }
  | { ok: false; error: string };

export interface DraftPrInput {
  repoRoot: string;
  run: RunRecord;
  /** The task's handoff.md — becomes the PR body (goal + progress skim). */
  handoffText: string;
}

export interface ForgeDriver {
  readonly kind: ForgeKind;
  /** Cheap, cached availability probe. May shell out (used by the GitHub tab). */
  detect(): Promise<ForgeAvailability>;
  /** Non-blocking availability for the health path: cached result, or null while warming — never
   *  shells out on the read (keeps /api/health under the bookmarklet's latency budget). */
  detectCached(): ForgeAvailability | null;
  listIssues(opts?: ForgeListOptions): Promise<ForgeItem[]>;
  listPRs(opts?: ForgeListOptions): Promise<ForgeItem[]>;
  /** Both lists plus availability, the repo handle and the label colors, in ONE answer — what
   *  `GET /api/github` serves. Not `listIssues` + `listPRs` called twice: the forge fetches them
   *  together, and the payload's other fields have nowhere to live in an item array.
   *
   *  Required, unlike `searchItems`/`prDiff` below: this, the thread, the glyphs and the chip
   *  statuses are the four reads the cockpit's forge screens cannot render without, so a driver
   *  that cannot answer them cannot back a tab. The optional ones are enhancements whose routes
   *  already have a documented `available: false` degrade. */
  listItems(opts?: ForgeListOptions): Promise<ForgeListData>;
  /** The full comment + timeline thread for one issue or PR (#499, #525). Never throws; degrades
   *  in-payload. */
  comments(
    kind: 'issue' | 'pr',
    number: number,
    opts?: { refresh?: boolean },
  ): Promise<ForgeCommentsData>;
  /** Rolled-up CI glyphs for the PR rows on screen (#664) — the list tier deliberately does not
   *  pay for these. Never throws; degrades in-payload. */
  prChecks(numbers: number[]): Promise<ForgeChecksData>;
  /** Batched status for the chips a task table paints. Resolves each NUMBER to whatever it turned
   *  out to be, and answers when to ask again. Never throws; degrades in-payload.
   *
   *  Reads and writes the module-level ref-status cache (`ref-status-cache.ts`) rather than owning
   *  it — see that module for why the cache must stay readable without a driver. */
  refStatus(input: ForgeRefStatusInput): Promise<ForgeRefStatusData>;
  /** Search the forge for issues/PRs in ANY state (#730) — the escape hatch from the open-only
   *  list tier. Optional so the seam stays additive: a driver without it simply has no search
   *  fallback, and the route degrades to `available: false`. Never throws. */
  searchItems?(
    kind: 'issue' | 'pr',
    query: string,
    opts?: { limit?: number },
  ): Promise<ForgeSearchData>;
  /** Draft-PR creation for the review gate (spec 009). Never throws. */
  createPR(input: DraftPrInput): Promise<DraftPrOutcome>;
  /** The branch's open/merged PR, or null when none (or the forge is down). */
  prStatus(branch: string): Promise<ForgePrStatus | null>;
  prMergeState?(number: number, opts?: { refresh?: boolean }): Promise<ForgePrMergeStateResult>;
  mergePR?(number: number, input: ForgeMergeInput): Promise<ForgeMergeResult>;
  /** Bounded, read-only file changes for a pull request. */
  prDiff?(number: number, opts?: { refresh?: boolean }): Promise<ForgePrDiffResult>;
  /** Web URL for a ref on the forge, or null when the remote isn't parseable. */
  viewUrl(kind: ForgeRefKind, ref: string | number): string | null;
}
