# GitLab support (gitlab.com and self-hosted)

**Status:** gate cleared 2026-09-20. Ready for implementation review.
**Goal (user's own framing):** *"anything I need to start using cezar with my self-hosted GitLab."*

## 📝 TLDR

Cezar speaks exactly one code forge. `ForgeKind` is the literal `'github'`, `FORGE_HOSTS` is a
one-row table keyed on `github.com`, and every forge call shells out to `gh`. A user whose repo
lives on GitLab gets the tab gated off, no MR chip on a task, and no draft-MR at the review gate;
plain-git features still work, which is `resolveForge(...) === null` behaving as designed.

**Future behavior:** a GitLab-remote project — gitlab.com *or* an arbitrary self-hosted hostname —
gets the same tab, chips, and review-gate draft MR a GitHub project gets, discovered from the
`glab` CLI the user has already authenticated, with no cezar config file to author.

The `ForgeDriver` seam was built for this (`forge/types.ts`: *"GitHub today, GitLab later"*). The
work is therefore **less about inventing an abstraction than finishing one** — plus three things
the original seam did not anticipate: an arbitrary hostname cannot be classified by a host table,
a GitLab project path can be **nested in subgroups** (which the current remote parser silently
mangles), and the ref-status cache has a context-free reader that a naive refactor would break.

---

## ✅ Decisions taken

**D1 — Self-hosted recognition: read `glab`'s own hosts config.** Verified precedence:
`$GLAB_CONFIG_DIR/config.yml` → `~/.config/glab-cli/config.yml` (legacy) →
`$XDG_CONFIG_HOME/glab-cli/config.yml` → `$XDG_CONFIG_DIRS/glab-cli/config.yml`
(default `/etc/xdg/glab-cli/config.yml`), plus a per-repo `.git/glab-cli/config.yml`. Authenticated
instances live under a `hosts:` map. Discovered, not configured — AGENTS.md §Zero config — and
symmetric with how `gh` is discovered. A host `glab` does not know stays `null`: today's plain-git
cockpit, unchanged.

**D2 — Transport: require the `glab` CLI.** Cezar inherits the user's auth and host config and
never touches tokens, TLS or certificates. `glab api graphql` gives the full REST+GraphQL surface
on the same session. Absence degrades in-payload (`available: false` + "install it and run
`glab auth login`"), never a 5xx, never a boot failure.

**D3/D4 — Forge-neutral API and contract naming: DECIDED, but split to its own spec.**
The direction is settled — rename the family to `/api/v1/forge/*` keeping `/api/v1/github/*` as a
permanent alias, and rename `github*` contract symbols to `forge*` while never renaming wire keys
or persisted values. It is **not in this spec**: it is a cosmetic change to the most depended-on
surface in the app, it buys GitLab nothing (the payloads are already forge-neutral, which is exactly
why a GitLab driver works fine behind the existing spelling), and it creates a permanent 32-mount
alias obligation. Full rationale and plan: **`.ai/specs/2026-09-20-forge-neutral-api-naming.md`**.
That spec may land before or after this one — which is what makes it separable.

**D5 (Q5) — Keep `'pr'` on the wire, relabel to "MR" in the UI** when the project's forge is
`gitlab`. Widening the protected `'issue' | 'pr'` union would break every client narrowing on it.

**D6 (Q6) — Target current GitLab CE and degrade.** Premium/Ultimate-only signals (approval rules,
merge trains) resolve to the existing `'unknown'` values rather than gating the feature. No version
floor to police.

**D7 (Q8) — `'gitlab'` becomes a third automation `kind`** when automations land (deferred below).
Additive; the protected `'github'` default is untouched.

**D8 (Q7) — Mixed-forge workspaces are supported.** Per-project `forge?` classification is the only
thing that widens; nothing becomes workspace-global.

---

## 📝 Problem Statement

GitLab — especially self-hosted — is the common home for the on-prem repositories a local-first,
no-account, no-cloud cockpit is most attractive to. Today such a user can register the project, run
tasks in worktrees, and review diffs (all plain git), but the loop does not close: **there is no way
to push the finished work as a draft MR**, which AGENTS.md names as a core promise of the product
("ends at a review gate, and can be pushed as a draft PR through `gh`"), and no way to browse or
pick up issues and MRs from inside the cockpit.

The degradation is silent by design, so the user sees a cockpit that simply has fewer features and
no indication that anything could be done about it.

## 📝 Scope

Derived from the user's goal — what is needed to *start using* cezar against self-hosted GitLab:

**In scope**
1. **Finish the seam** — promote the read tier onto `ForgeDriver` and repoint the eight routes.
   Everything else depends on it. Routes keep their current `/api/v1/github/*` spelling.
2. **Classify a forge on an arbitrary hostname** (D1), including subgroup-nested project paths.
3. **GitLab driver, read tier** — tab, issues, MRs, chips, threads, PR diff.
4. **Draft-MR creation at the review gate** — this is the loop closing, so it is *not* deferred
   even though it sits in the "write tier".
5. **Gating the GitHub automation kind on forge KIND, not availability** — see Risks §7. Without
   it, shipping Phase 3 silently regresses the automations surface for every GitLab user.

**Deferred, with reason**
- **Merge / merge-state from the cockpit.** `prMergeState?` and `mergePR?` are already **optional**
  driver methods and the routes already answer `available: false` when absent — the seam degrades
  here *by design*. A GitLab user merges in GitLab. Follow-up spec.
- **GitLab automations** (D7 records the shape). Not needed to start; largest new surface.
- **Renaming `packages/web/src/routes/github/`.** Contract-free churn; belongs with the naming spec.
- **The whole forge-neutral naming layer** (D3/D4) — its own spec, per the scope-cohesion review.

## 📝 Architecture

### 1. Classification without a host table

`FORGE_HOSTS` is an exact-hostname map read by `forgeKindOfRemote` (the registry's per-project
probe) and `resolveForge`. `git.acme.internal` matches nothing.

Replace with `classifyRemote(remote)`:

```
static table ({github.com, gitlab.com})  ∪  glab-known hosts (cached)
```

The glab-hosts half is a **file read plus a YAML parse**, not a shell-out — which preserves the
probe's documented cost profile ("plain string parsing, no `gh` shell-out"). `yaml@^2.5.0` is
already a dependency of `packages/cezar`; no new dep. Cached and invalidated on mtime; an absent,
unreadable or corrupt config degrades to "no GitLab hosts known", never an error.

> **Security rule: parse the `hosts:` KEYS, discard everything else.** That file contains tokens.
> The loader must never return, log, cache or surface a value — only hostnames. (`secret-redaction`
> already covers `glpat-`, but the correct defense is never reading the value.)

### 2. Nested project paths — a real defect the GitLab work exposes

`parseRemote` returns `{host, owner, repo}` from the **last two** path segments:

```ts
const owner = parts[parts.length - 2];
const repo  = parts[parts.length - 1];
```

For `gitlab.com/group/subgroup/project` that yields `owner: 'subgroup', repo: 'project'` — the
`group/` prefix is **silently dropped**. Verified against the current code:

```
https://gitlab.com/group/subgroup/project.git       => owner=subgroup  repo=project  webRoot=null
ssh://git@gitlab.example.com:2222/grp/sub/proj.git  => owner=sub       repo=proj     webRoot=null
https://github.com/owner/repo.git                   => owner=owner     repo=repo     webRoot=https://github.com/owner/repo
```

This is a **latent** defect, not a live one: `forgeWebRoot` returns `null` for GitLab hosts today
precisely because they are absent from `FORGE_HOSTS`, so the mangled parts are never rendered.
**Phase 2 activates it** — the moment a GitLab host classifies, `forgeWebRoot` starts building
`https://host/subgroup/project` and the protected `repoUrl?` field in `GET /projects` carries a
URL that 404s. Subgroups are ubiquitous on self-hosted GitLab, so this must be fixed in the same
phase that adds the classification, never after it.

`ParsedRemote` therefore gains `projectPath` — the full `group/subgroup/project`. `owner`/`repo`
stay for the GitHub driver (where they are correct and used); every URL is rebuilt from
`projectPath`. Still rebuilt from parsed parts, never by string-editing the raw remote, so a
credentialed remote cannot leak.

### 3. The seam refactor, and the one cache that must not move

Eight routes currently import 13 GitHub-specific functions directly from `server/github.ts`; only
four call sites resolve a driver. The refactor promotes the read tier onto `ForgeDriver` and
repoints the routes. **No route is renamed here** — the spelling stays `/api/v1/github/*`.

> **⚠ The ref-status cache is load-bearing for something not stated at its definition.**
> `readCachedRefStatuses` is read by `GET /api/v1/workspace/runs-index`, whose contract
> (BACKWARD_COMPATIBILITY.md §2) says it is **side-effect free**: it must never touch the forge and
> must never build a project context, because building one prunes worktrees and resumes interrupted
> runs — *a search box must not restart agents.* Moving the cache behind a per-project driver
> instance would force that route to build contexts, breaking the contract invisibly (the route
> would still return data). **The cache stays module-level and context-free readable**; the driver
> becomes one more reader, not its owner. A regression test pins this.

This is the AGENTS.md §"Changing a mechanism that already works" case: name what the old mechanism
was load-bearing *for*, not what it was for.

### 4. Transport

`glab`, invoked with an explicit `--hostname` for determinism (glab would otherwise infer from the
worktree's remote). JSON via `-F json`; batch queries via `glab api graphql`.

**Every JSON payload is zod-validated at the boundary**, as AGENTS.md already mandates for
`gh --json`. Extra motivation: glab's per-command JSON output quality is uneven
(`gitlab-org/cli#8127` is an open case of a wrong `--output json`), so the validator is the contract,
not a formality. `CEZ_DRY_RUN=1` must keep working: bundled mock, no real CLI, no network.

### 5. Identifiers

GitLab addresses merge requests and issues by **IID** (per-project) — the number in the URL — not
the global `id`. `ForgeItem.number` carries the IID, and every round-trip (chips, ref-status,
diff, `viewUrl`) must use it consistently. URL shapes are `/-/merge_requests/<iid>` and
`/-/issues/<iid>`; `run-header.tsx:758` already anticipates that a forge's PR URLs may not end in a
plain number (#847).

## 📝 API Contracts

**No new endpoints, and no renamed endpoints.** The existing eight-route family keeps its spelling
and every response shape; what widens is additive and value-level:

| Surface | Change |
| --- | --- |
| `ForgeKind` | `'github'` → `'github' \| 'gitlab'` |
| `projects.forge?` | same widening; `'gitlab'` joins `'github'` (already additive per §2) |
| `health.forge.kind` | same widening |
| The eight `/api/v1/github/*` routes | shapes unchanged; a GitLab project simply gets real data instead of `available: false` |
| `/api/v1/github/prs/:n/merge-state`, `POST …/merge` | stay `available: false` on GitLab (merge deferred), with an **actionable** reason — see Edge Cases |

An old consumer that ignores the new `'gitlab'` value sees no change; one that switches on
`forge.kind` must treat an unknown value as "some forge", which the existing docs already require.

Routes stay registered by chaining into the family builder; validation stays route middleware.

## 📝 UI/UX

- The tab, chips and review panel render **"MR" / "Merge Request"** when the project's forge is
  `gitlab`, while the wire keeps `'pr'` (D5). The cockpit already knows the forge per project from
  `projects.forge?` and `/health`.
- Unavailability reads as an actionable hint — *"install the GitLab CLI and run `glab auth login`"*
  — matching the existing `gh` wording, not a generic error.
- Everything else is unchanged; this feature adds no new screen.

## 📝 Edge Cases & Failure Scenarios

| Scenario | Behavior |
| --- | --- |
| `glab` not installed | `available: false` + install hint. Tab shows the hint; plain-git features unaffected. |
| `glab` installed, host not authenticated | `available: false` + `glab auth login --hostname <host>` hint. |
| Self-signed / internal CA on the instance | glab's own failure, surfaced verbatim as `reason`. Cezar does not manage TLS. |
| glab config missing / corrupt YAML / unreadable | Degrade to the static table (gitlab.com only). One warning, never a boot failure. |
| Remote host is a GitLab, but user never ran `glab auth` | Classified `null` → plain-git cockpit. Acceptable: the hint surfaces once glab knows the host. |
| Subgroup-nested project | Handled via `projectPath`; explicitly fixture-tested at three levels. |
| Mixed workspace (GitHub + GitLab projects) | Per-project classification; each tab independent (D8). |
| Premium-only signal on CE | Resolves to `'unknown'`, never a blocked feature (D6). |
| `CEZ_DRY_RUN=1` | Mocked driver, fake MR URL, no CLI, no network. |
| GitLab project opens merge-state / merge | `available: false` with an **actionable** reason ("merging from the cockpit isn't supported for GitLab yet — merge in GitLab"), not a bare "unavailable". D2's degradation standard applies to deferred features too. |
| GitLab project opens the automations editor | The "When GitHub changes" kind is **disabled with a reason**, gated on `forge.kind === 'github'` (Risks §7). |

## 📝 Risks & Impact Review

1. **The refactor touches the most depended-on surfaces in the app** (`/api/v1/github/*`,
   `githubItemSchema`, `projects`, `health`). Mitigation: Phase 1 is behavior-identical and lands
   with *no* GitLab code, so it is reviewable as a pure refactor and green suites mean something.
2. **The ref-status cache / `runs-index` invariant** (Architecture §3) — the highest-risk item here,
   because breaking it still returns data. Pinned by a regression test that asserts no context is
   built and no forge call is made.
3. **`parseRemote` change affects GitHub too.** `owner`/`repo` semantics must stay byte-identical
   for github.com; table-driven tests cover scp form, credentials, ports, `.git`, and local paths.
4. **A new required binary.** `glab` is a real install step for self-hosted shops. Accepted per D2,
   because the alternative is cezar owning tokens and TLS. Quality of the degradation message is the
   mitigation, and it is a shipped requirement, not an afterthought.
5. **Zero-config compliance.** No new `CEZ_*` var is proposed. If one becomes unavoidable it must
   land in `.env.example` in the same commit (and `docs/reference.md` if user-facing).
6. **Default-path diff for existing GitHub users** (AGENTS.md): with every change at its shipped
   default, a github.com user must see byte-identical behavior. Phase 1's per-route tests passing
   **unchanged** is the evidence.
7. **⚠ The automations kind-gate — a regression this spec would otherwise CAUSE.** Verified in
   code: `packages/web/src/routes/automations/editor.tsx:105` computes
   `const githubAvailable = data?.available !== false` and feeds it to `KindSegment`'s `disabled`
   (line 362); `automations-table.tsx` passes the same `data.available` as the row's
   paused-by-capability flag; and `automations/github-poller.ts` shells out to `gh` unconditionally
   (lines 169, 300, 310) with no forge check anywhere in it.
   The GitHub automation kind is therefore gated on forge **availability**, never on forge **kind**.
   Today that holds only by accident: a GitLab project is `forge: null`, so `available` is false and
   the segment is disabled. **The moment Phase 3 makes `detect()` return `available: true` for
   GitLab, the segment enables and a user can create an automation that polls `gh` against a GitLab
   repo.** D7's "additive, the `'github'` default is untouched" is true of the schema and false of
   the behavior.
   This is the same failure mode as Architecture §3 and as AGENTS.md §"Changing a mechanism that
   already works": the availability flag was load-bearing for a *kind* gate nobody wrote down.
   **Mitigation is in scope and lands in Phase 3** (step 17), not in the deferred automations spec.

## 📋 Phasing

| Phase | Ships | Visible to user |
| --- | --- | --- |
| 1 | Seam completion (routes keep their names) | No |
| 2 | Arbitrary-host classification + subgroup-safe remote parsing | No (fixes a latent URL bug) |
| 3 | GitLab driver read tier + automations kind-gate | Yes — the tab works |
| 4 | Draft-MR creation | Yes — the loop closes |

Each phase is independently shippable and leaves the app working.

## 📋 Implementation Plan

### Phase 1 — Finish the seam (no renames, no behavior change)
1. Add the read-tier methods to `ForgeDriver`; the GitHub driver implements them by delegating to
   its existing functions. No route changes yet. *Test:* driver unit tests; all suites green.
2. Extract the ref-status cache so it stays module-level and readable **without** building a project
   context. *Test:* regression test asserting `GET /workspace/runs-index` builds no context and
   makes no forge call. **Prove it fails without the fix** (`git stash push` the source files,
   confirm red, pop) — a test written after the diagnosis passes against the bug more often than
   anyone expects.
3. Repoint all eight routes from the direct `fetchGithub*` imports to `resolveForge(...)` + driver
   methods. *Test:* the existing per-route API tests pass **unchanged** — that is the whole
   assertion.

### Phase 2 — Classify a forge on any host
4. Widen `ForgeKind` to `'github' | 'gitlab'`; widen `projects.forge?` and `health.forge.kind`.
   *Test:* contract parity, both directions.
5. Add `projectPath` to `ParsedRemote`; rebuild `forgeWebRoot` and all URL building from it, leaving
   `owner`/`repo` byte-identical for github.com. *Test:* table-driven remotes incl. three-level
   subgroups, scp form, credentials-in-URL, port, `.git`, local paths.
6. Add the glab-hosts loader: documented precedence, `hosts:` **keys only**, mtime cache, silent
   degrade. *Test:* fixtures for valid/corrupt/missing/unreadable; **assert no token value is ever
   returned or logged**.
7. Implement `classifyRemote` = static table ∪ glab hosts; repoint `forgeKindOfRemote` and
   `resolveForge`. *Test:* `git.acme.internal` in a fixture config classifies as gitlab; absent
   classifies as null; github.com unchanged.

### Phase 3 — GitLab driver, read tier
8. `createGitlabDriver` + `detect()`/`detectCached()` via `glab` presence and auth, with matching
   degradation strings; `CEZ_DRY_RUN=1` mock. *Test:* golden fixtures; degradation cases.
9. `listIssues`/`listPRs` via `glab issue list -F json` / `glab mr list -F json`, zod-validated,
   mapped to `ForgeItem` with **IID** as `number`.
10. `viewUrl` for `/-/merge_requests/<iid>` and `/-/issues/<iid>`, built from `projectPath`.
11. `prStatus(branch)`, batched `refStatus`, and `prChecks` from pipeline state.
12. Comments + timeline: notes and resource events mapped onto the existing allowlist; unmappable
    kinds dropped rather than rendered.
13. `prDiff` with the same caps the GitHub driver applies.
14. UI relabels PR → MR for `forge === 'gitlab'` (D5). *Test:* component tests for both forges.
15. Make the deferred merge surface degrade **actionably** on GitLab rather than with a bare
    "unavailable". *Test:* payload snapshot.
16. **Gate the automations GitHub kind on `forge.kind === 'github'`, not on availability**
    (Risks §7) — in `editor.tsx`'s `KindSegment` and the table's paused-by-capability flag, with a
    reason string naming why. *Test:* a GitLab project with an AVAILABLE forge still shows the
    GitHub automation kind disabled. **This test must be written to fail without the gate** — it is
    the regression this phase would otherwise ship.

### Phase 4 — Close the loop
17. `createPR` via `glab mr create --draft --fill --yes` (title/body from the run's `handoff.md`),
    returning `DraftPrOutcome`, never throwing; dry-run fakes the URL. *Test:* success, auth
    failure, no-remote, dry-run.
18. Wire the already-neutral `POST /runs/:id/pr` through the resolved driver. *Test:* the review
    gate completes on a GitLab fixture project.
19. Review panel reads "Create draft MR" on GitLab projects. *Test:* component test.

## 📝 Follow-ups (explicitly out of scope)

- **Forge-neutral API and contract naming** — `.ai/specs/2026-09-20-forge-neutral-api-naming.md`
  (D3/D4; decided, independently landable).
- **Merge / merge-state for GitLab** — the seam already degrades correctly; step 15 makes the
  degradation actionable in the meantime.
- **GitLab automations** — third `kind` per D7. Note step 16 is the *gate*, not the feature: it
  keeps the deferral honest.
- **Renaming `packages/web/src/routes/github/`** — belongs with the naming spec.
