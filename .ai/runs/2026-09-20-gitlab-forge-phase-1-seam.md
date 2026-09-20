# Execution plan — GitLab forge support, Phase 1: finish the seam

Source doc: `.ai/specs/2026-09-20-gitlab-forge-support.md` (Implementation Plan → Phase 1, steps 1–3)
Engine: om-auto-create-pr (steps: 8, --loop: no)

## 🎯 Goal

Finish the `ForgeDriver` seam so a second forge can be added as one driver file: promote the read
tier onto the interface, extract the ref-status cache so it stays module-level and context-free
readable, and repoint the `/api/v1/github/*` routes off their direct `fetchGithub*` imports.

**No renames, no behavior change, no GitLab code.** Phase 1 is reviewable as a pure refactor, which
is what makes the green suites mean something (spec Risks §1 and §6).

## 📋 Scope

In scope — spec Phase 1 steps 1, 2 and 3 only:

1. Read-tier methods on `ForgeDriver`, implemented by the GitHub driver by delegating to its
   existing functions.
2. The ref-status cache extracted into its own module, still module-level and readable **without**
   building a project context.
3. The eight `/api/v1/github/*` routes served through `resolveForge(...)` + driver methods instead
   of direct `fetchGithub*` imports.

**Non-goals** (each belongs to a later phase or another spec):

- Widening `ForgeKind` to `'gitlab'`, `classifyRemote`, the glab-hosts loader, `projectPath` on
  `ParsedRemote` — spec Phase 2.
- Any GitLab driver, UI relabel, or automations kind-gate — spec Phases 3–4.
- Renaming routes, contract symbols, wire keys, or `packages/web/src/routes/github/` — that is
  `.ai/specs/2026-09-20-forge-neutral-api-naming.md`, explicitly split out (spec D3/D4).
- Making `prMergeState`/`mergePR` non-optional, or touching the merge degrade wording (spec step 15).

## 📋 Implementation Plan

### Phase 1 — Read tier on `ForgeDriver` (spec step 1)

The read tier is the four payloads the tab reads that the interface does not yet name: the list
payload, the comment thread, the lazy checks glyphs, and batched reference status. `searchItems`,
`prDiff`, `prStatus` and `viewUrl` are already on the interface and stay as they are.

Types move **by aliasing, never by renaming**: `forge/types.ts` gains the forge-neutral shape and
`forge/github.ts` keeps the existing `Github*` name as an alias of it — the pattern
`export type GithubItem = ForgeItem` already established in that file. Nothing on the wire, in the
contract package, or in an existing import changes.

### Phase 2 — Extract the ref-status cache (spec step 2)

The cache is load-bearing for something not stated at its definition: `GET /workspace/runs-index`
reads it and is **side-effect free by contract** (BACKWARD_COMPATIBILITY.md §2) — it must build no
project context, because building one prunes worktrees and resumes interrupted runs. A search box
must not restart agents. Moving the cache behind a per-project driver instance would force that
route to build contexts and break the contract invisibly, because the route would still return data.

So the cache moves **out** of the driver's file into its own module that anyone may read, and the
driver becomes one more reader rather than its owner. A regression test pins the invariant.

### Phase 3 — Repoint the routes (spec step 3)

One wrinkle the spec does not name: `fetchGithub*`'s `CEZ_DRY_RUN=1` mock branches never looked at
the remote, so the mocked forge is reachable today from a scratch directory with no git remote at
all — which is what the offline demo and the whole `/api/v1/github/*` test suite stand on, while
`resolveForge` answers `null` there. The read routes therefore resolve through a
`resolveReadForge` that falls back to the GitHub driver **under dry-run only**, documented at its
definition. `resolveForge` itself is untouched, so `/health` keeps reporting `forge: null` for a
remote-less checkout.

## 🧪 Validation notes

- `TMPDIR` in this run's sandbox pointed **inside** the repository, which put every
  `mkdtempSync(tmpdir())` fixture inside a git checkout and made six pre-existing health/projects
  assertions (`expect(body.repo).toBeNull()` for "a tmp dir — not a git repo") fail on code this
  branch does not touch. Re-running with `TMPDIR=/tmp` is green. An environment artifact, not a
  finding, but worth recording: those tests assume the system temp dir is outside any repository.
- One web test (`github.test.tsx`, "Custom prompt") failed once on a heavily loaded full-suite run
  and passes both in isolation and on a clean re-run of the whole web suite — a `waitFor` timeout
  under contention. This branch changes no cockpit code.

## ⚠️ Risks

- **The ref-status / `runs-index` invariant** — highest risk here, because breaking it still
  returns data. Mitigated by the extraction itself (the cache is never per-project state) plus a
  regression test proven red against a context-building route.
- **Behavior drift on the degrade path.** For a real (non-dry-run) checkout with no supported forge
  remote, a read route previously shelled out to `gh` and degraded with `gh`'s own message; it now
  degrades without spawning anything and says so in its own words. `available: false` either way —
  the field every consumer switches on — but the `reason` string differs. Recorded here rather than
  smoothed over.
- **Hono type inference.** A degrade written as a bare object literal widens `available: false` to
  `boolean` and erases the discriminant the contract narrows on (AGENTS.md § The HTTP API). Every
  degrade value is annotated with its payload type instead; `contract-parity*.test.ts` is the check.
- **One `getRepoInfo` per read request.** Resolving a driver costs 2–3 `git rev-parse` calls that
  the direct imports did not pay. Accepted, unmemoized: the cockpit's forge queries are not polled
  (`refetchInterval: false`, minute-scale `staleTime`), and a memo would trade a measured cost for
  a stale-remote bug. The two merge routes have paid it since they were written.

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Read tier on ForgeDriver

- [x] 1.1 Promote the read-tier payload types into `forge/types.ts`, aliasing the existing `Github*` names — 29d2b28c
- [x] 1.2 Add the read-tier methods to `ForgeDriver` and implement them on the GitHub driver by delegation — 29d2b28c

### Phase 2: Extract the ref-status cache

- [x] 2.1 Extract the cache into `forge/ref-status-cache.ts`, module-level and context-free — 52d65e86
- [x] 2.2 Regression test: `runs-index` builds no context and makes no forge call, proven red without the fix — 52d65e86

### Phase 3: Repoint the eight routes

- [x] 3.1 Add `resolveReadForge` and repoint the six directly-importing routes onto driver methods — 877b0bda
- [x] 3.2 Repoint server.ts's cache helpers at the extracted module and drop the dead imports — 877b0bda

### Phase 4: Validation

- [x] 4.1 Full validation gate green — `npm run typecheck` ✅ · `npm test` ✅ (server 1388/1388, web+api-client+contract 3876/3876) · `npm run test:unit` ✅ 36/36 · `npm run build` ✅ (`check:pack ok`) · `npm run test:package` ✅ 16/16
- [ ] 4.2 Authoritative review pass applied
