# Forge-neutral API and contract naming

**Status:** decided, not scheduled. Split out of `2026-09-20-gitlab-forge-support.md` by that
spec's scope-cohesion review.
**Depends on:** nothing. **Blocks:** nothing. Can land before or after GitLab support — which is
precisely why it is its own spec.

## 📝 TLDR

Cezar's forge HTTP family and its contract symbols are named after GitHub (`/api/v1/github/*`,
`githubItemSchema`, `GithubItem`, `contract/src/github.ts`) although the shapes they carry are
already forge-neutral — normalizing them is exactly what the `ForgeDriver` seam did. Once a second
forge exists, the names describe the vendor that happened to be first rather than what the routes
serve.

**Proposed:** rename the family to `/api/v1/forge/*`, keep `/api/v1/github/*` as a **permanent
alias**, and rename the contract *symbols* to `forge*` — while never renaming a wire key or a
persisted value.

**This is a cosmetic change to the most depended-on surface in the application.** It buys no
capability. It is written down so the decision is not re-litigated, and kept separate so it is
reviewed on its own merits against its own risk.

## 📝 Problem Statement

Two concrete irritants, neither of them urgent:

1. **One shape, two names.** The server calls it `ForgeItem`; the contract calls the identical shape
   `githubItemSchema` — and the contract file literally annotates it as "(`ForgeItem` server-side)".
   The inconsistency already exists and predates any GitLab work.
2. **The path lies about its content** once a GitLab project serves data from `/api/v1/github/*`.

Worth noting honestly: cezar has *already* made the neutral-naming call everywhere else. Draft-PR
creation posts to `/runs/:id/pr`; `/health` and `/projects` report `forge.kind` as data. The vendor
name survives only on the tab family, which predates the seam. So this change makes the codebase
self-consistent rather than introducing a new convention.

## 📝 Proposed Solution

### D1 — One neutral family, aliased forever

Rename to `/api/v1/forge/*`; keep `/api/v1/github/*` as a permanent alias. Purely additive, so
BACKWARD_COMPATIBILITY.md §2 is satisfied.

**Rejected: separate `/api/v1/gitlab/*` routes.** The payloads are already forge-neutral, so
per-forge routes would serve byte-identical shapes under a second name, and would either duplicate
contract schemas (banned — one zod definition per shape) or share one schema across two families,
which disproves the split. **Divergence between forges belongs in the payload, never the path.**

### D2 — Rename symbols; never rename wire keys or persisted values

| Category | Examples | Verdict |
| --- | --- | --- |
| **Symbols** (schema consts, types, filenames) | `githubItemSchema`, `GithubItem`, `contract/src/github.ts` | **Rename.** 21 files, compile-time only; `contract` and `api-client` are both `private`, so no external consumer exists and `tsc --noEmit` catches every miss. |
| **Wire keys** | `githubView` (`workspace.ts:169`), `githubNumber`/`githubTitle`/`githubUrl` (`automations.ts:200-202`), `githubUrl` (`runs.ts:184`) | **Keep.** |
| **Persisted values** | `automationKind.default('github')`, `runs.json` `automation.githubUrl` (required), `projects.forge: 'github'` | **Keep.** `projects.forge: 'github'` is not a misnomer. |

Corollary: `githubTimelineEventKindSchema` → `forgeTimelineEventKindSchema`, but its 11 values keep
their GitHub spellings (`head_ref_force_pushed`, `cross-referenced`, …) **forever** — those are wire
values. Tolerable because the enum is documented as an *allowlist*: a driver that cannot fill a kind
does not emit it. A deliberate wart, not a defect.

## 📝 Risks & Impact Review

1. **Permanent obligation.** 8 routes × 2 mounts = 16 becomes **32**, forever, each needing a
   route-parity pair and a `bc-route-inventory` entry — purchased for a naming reason on the surface
   the GitLab spec risk-rates as the most depended-on in the app. This is the strongest argument for
   simply **not doing this**, and it should be weighed before scheduling.
2. **Zero functional benefit.** Nothing works that did not work before. The change is justified by
   consistency alone.
3. **Blast radius vs. payoff.** 21 files for the symbol rename, all compile-checked, plus the route
   family. Low *risk*, non-trivial *churn*.
4. **Review criteria differ from feature work.** This is reviewed against "did any byte change on
   the wire?" and BACKWARD_COMPATIBILITY.md — not against "does it talk to a forge correctly?"
   Different reviewer, different failure mode, different rollback. That difference is the reason
   this is a separate spec.

## 📋 Implementation Plan

1. Rename contract symbols `github* → forge*` and `contract/src/github.ts → forge.ts`. No
   back-compat aliases (both packages are `private`). *Test:* `npm run typecheck`.
2. Add the `/api/v1/forge/*` family from the same chained family builder; keep `/api/v1/github/*`
   as an alias. *Test:* route-parity asserts **four** spellings — `/api/v1/{github,forge}/x` and
   both `/p/:projectId` twins — answer byte-identically.
3. Inventory both spellings in BACKWARD_COMPATIBILITY.md §2. *Test:* `bc-route-inventory` passes.
4. Neutralize user-facing "GitHub" strings on forge-generic paths. *Test:* payload snapshots.
5. *(Optional, lowest value)* Rename `packages/web/src/routes/github/` and its helpers. Cockpit-
   internal; no contract benefit.

## 📝 Open question for whoever schedules this

Is a permanent 32-mount alias family worth a more honest name? A defensible answer is **no** — keep
`/api/v1/github/*` as the wire spelling, treat it as a historical name the way many APIs do, and
take only the cheap half (step 1, the symbol rename, which removes a real inconsistency for free).
