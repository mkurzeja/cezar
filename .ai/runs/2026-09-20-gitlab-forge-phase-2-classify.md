# Execution plan — GitLab forge support, Phase 2: classify a forge on any host

Source doc: `.ai/specs/2026-09-20-gitlab-forge-support.md` (Implementation Plan → Phase 2, steps 4–7)
Engine: om-auto-create-pr (steps: 12, --loop: no)
Base branch: `feat/gitlab-forge-phase-1-seam` (PR #2, **not yet merged**) — this is a stacked PR, on
the user's explicit instruction. It retargets to `main` by itself once #2 lands.

## 🎯 Goal

Make cezar able to tell that a repository lives on GitLab — gitlab.com *or* an arbitrary self-hosted
hostname — without a cezar config file, and make every URL it builds from a remote correct for the
nested project paths self-hosted GitLab actually uses.

Still **no GitLab driver and no working tab** (spec Phase 3). What changes for a GitLab user after
this phase is that `GET /projects` reports `forge: 'gitlab'` and a correct `repoUrl` for the
project; `/health` keeps reporting `forge: null`, because that field says which forge cezar can
*serve*, and no driver exists yet. What changes for a GitHub user is nothing at all.

## 📋 Scope

In scope — spec Phase 2 steps 4, 5, 6 and 7:

1. **Step 4** — widen `ForgeKind` to `'github' | 'gitlab'`, and with it `projects.forge?` and
   `health.forge.kind` in `packages/contract`.
2. **Step 5** — add `projectPath` to `ParsedRemote` and rebuild every URL from it, leaving
   `owner`/`repo` byte-identical for github.com.
3. **Step 6** — the glab-hosts loader: documented precedence, `hosts:` **keys only**, mtime cache,
   silent degrade.
4. **Step 7** — `classifyRemote` = static table ∪ glab hosts; `forgeKindOfRemote`, `forgeWebRoot`
   and `resolveForge` repointed onto it.

Plus one thing the spec's phase list does not name but its own §2 argument requires — see
**Phase 5** below, and ⚠️ Risks.

**Non-goals** (each belongs to a later phase or another spec):

- Any GitLab driver: `detect`, `listIssues`/`listPRs`, `viewUrl`, `prStatus`, comments, `prDiff`
  — spec Phase 3, steps 8–13. `resolveForge` therefore still answers `null` for a GitLab remote,
  and the tab stays hidden.
- UI relabel PR → MR (D5), the actionable merge degrade, the automations kind-gate — spec Phase 3,
  steps 14–16.
- Draft-MR creation — spec Phase 4.
- Renaming routes, contract symbols or `packages/web/src/routes/github/` — that is
  `.ai/specs/2026-09-20-forge-neutral-api-naming.md` (spec D3/D4).
- Shelling out to `glab` for anything. The classifier reads a file and parses YAML; that is the
  documented cost profile of the registry probe ("plain string parsing, no `gh` shell-out") and it
  must not regress into a subprocess.

## 📋 Implementation Plan

### Phase 1 — Widen the forge kind (spec step 4)

`ForgeKind` is `'github'` in `forge/types.ts` and mirrored as `z.literal('github')` twice in the
contract (`health.forge.kind`, `projects.forge?`). All three widen to the same two-value union.
Additive and value-level: an old consumer that ignores `'gitlab'` sees no change.

### Phase 2 — Subgroup-safe remote parsing (spec step 5)

`parseRemote` takes the **last two** path segments, so `gitlab.com/group/subgroup/project` yields
`owner: 'subgroup'` and the `group/` prefix is silently dropped. It is latent today only because
`forgeWebRoot` returns `null` for every GitLab host — and **Phase 1 of this plan activates it**.

`ParsedRemote` gains `projectPath` (the full `group/subgroup/project`); `owner`/`repo` stay exactly
as they are, because the GitHub driver uses them and they are correct there. Every URL is rebuilt
from `projectPath` — still from parsed parts, never by string-editing the raw remote, so a
credentialed remote still cannot leak.

### Phase 3 — The glab-hosts loader (spec step 6)

A new `forge/glab-hosts.ts`. Precedence per spec D1: `$GLAB_CONFIG_DIR/config.yml` →
`~/.config/glab-cli/config.yml` → `$XDG_CONFIG_HOME/glab-cli/config.yml` →
`$XDG_CONFIG_DIRS/glab-cli/config.yml` (default `/etc/xdg/glab-cli/config.yml`), plus the per-repo
`.git/glab-cli/config.yml` when a repo root is known.

> **Security rule, from the spec: parse the `hosts:` KEYS and discard everything else.** That file
> contains tokens. The loader never returns, logs or caches a value — only hostnames. The correct
> defense is never reading the value, not redacting it afterwards.

Absent, unreadable or corrupt config degrades to "no GitLab hosts known", never an error, never a
boot failure. Cached per file and invalidated on mtime, so the hot path is a `stat`, not a parse.

### Phase 4 — Classification without a host table (spec step 7)

`classifyRemote(remote, {repoRoot})` = the static table (`github.com` → github, `gitlab.com` →
gitlab) ∪ the glab-known hosts (gitlab). The static table wins, so a `glab` that somehow knows
`github.com` cannot reclassify it. `forgeKindOfRemote`, `forgeWebRoot` and `resolveForge` all read
it; `FORGE_HOSTS` stops being the classification authority.

`repoRoot` is optional and plumbed only where a root is already in hand (the registry probe and
`resolveForge`'s `RepoInfo`), so no caller grows a dependency it did not have.

### Phase 5 — Do not activate a 404 in the cockpit

Not in the spec's step list, and in scope for exactly the reason the spec gives in Architecture §2
for `projectPath`: *"this must be fixed in the same phase that adds the classification, never after
it."*

The cockpit synthesizes a link for a reference it knows only by NUMBER, from the project's own
`repoUrl` (`tasks-table.ts` `synthesizeUrl`/`taskIssueUrl`). The shapes are hard-coded GitHub:
`${base}/pull/${n}` and `${base}/issues/${n}`. Today a GitLab project has no `repoUrl`, so nothing
is ever synthesized; the moment Phase 1–4 classify it, every such chip becomes a link — and
`/pull/N` has **never** existed on GitLab, so it is a hard 404, not a redirect.

So the two synthesizers take the project's forge and spell `/-/merge_requests/<n>` and
`/-/issues/<n>` on GitLab. The parameter is optional and defaults to the GitHub shape, so every
existing call site is byte-identical.

This is deliberately the whole of the cockpit change: no relabel, no wording, nothing D5 owns.

### Phase 6 — Validation and review

Full gate, then the authoritative review pass.

## 🧪 Validation notes

Two environment artifacts recorded on the Phase 1 run apply here too and are not findings:

- `TMPDIR` must point outside the repository (`TMPDIR=/tmp`), or every `mkdtempSync(tmpdir())`
  fixture lands inside a git checkout and the "a tmp dir — not a git repo" assertions fail.
- The `CEZ_*` variables this session runs with must be cleared for `npm test`; two `workflows/`
  tests assert their absence.

## ⚠️ Risks

- **`parseRemote` is shared with GitHub.** `owner`/`repo` must stay byte-identical for github.com.
  Mitigated by leaving that computation untouched (it still takes the last two segments) and adding
  `projectPath` beside it, plus table-driven fixtures for scp form, credentials, ports, `.git` and
  local paths.
- **`forgeWebRoot` now builds from `projectPath`, not `owner/repo`.** For every real github.com
  remote the two are the same string (a GitHub path is exactly two segments). It differs only for a
  >2-segment github.com path, which is not a repository URL. Pinned by fixtures.
- **The classifier reads the filesystem on a path that used to be pure string parsing.** Kept to a
  `stat` per candidate on the hot path (the parse is mtime-cached), and the registry probe that
  calls it is itself TTL-cached. If a profile ever shows it, the fix is to memoize the resolved host
  set per `(env, repoRoot)` rather than to re-introduce a static table.
- **Token exposure.** `~/.config/glab-cli/config.yml` holds `glpat-` tokens. The loader is written
  to return `string[]` of hostnames and nothing else, and a test asserts no token value appears in
  the returned value or in anything logged.
- **A user with `glab` authenticated against a host cezar has never seen.** That host now
  classifies as `gitlab`, so `/projects` starts reporting `forge: 'gitlab'` and a `repoUrl` for it.
  The tab still does not open (no driver until Phase 3) because `project.forge === 'github'` gates
  the nav item; that gate is Phase 3's to widen, and is deliberately left alone here so Phase 2
  stays invisible as the spec's phasing table promises.
- **Stacked on an unmerged PR.** The diff below is against `feat/gitlab-forge-phase-1-seam`, so a
  reviewer reading it against `main` sees Phase 1's changes too. If #2 changes under review, this
  branch rebases.

## Progress

PR: #3

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Widen the forge kind

- [x] 1.1 Widen `ForgeKind` and both contract mirrors to `'github' | 'gitlab'` — fde1e77f
- [x] 1.2 Cover the widened value in the contract/health/projects suites — 5a696f4d

### Phase 2: Subgroup-safe remote parsing

- [x] 2.1 Add `projectPath` to `ParsedRemote` and rebuild `forgeWebRoot` from it — 60b148e4
- [x] 2.2 Table-driven remote fixtures incl. three-level subgroups — 60b148e4

### Phase 3: The glab-hosts loader

- [x] 3.1 `forge/glab-hosts.ts` — precedence, `hosts:` keys only, mtime cache, silent degrade — 16f6b3e2
- [x] 3.2 Fixture tests incl. the assertion that no token value is ever returned or logged — 16f6b3e2

### Phase 4: Classification without a host table

- [x] 4.1 `classifyRemote` = static table ∪ glab hosts; repoint the three readers — 5a696f4d
- [x] 4.2 Classification tests: self-hosted fixture host, absent host, github.com unchanged — 5a696f4d

### Phase 5: Do not activate a 404 in the cockpit

- [x] 5.1 Forge-aware reference-URL synthesis, defaulting to today's GitHub shape — 6dd94d00 (merged a66a0d26)
- [x] 5.2 Cockpit tests for both forges — 6dd94d00, proven red without the fix

### Phase 6: Validation

- [ ] 6.1 Full validation gate green
- [ ] 6.2 Authoritative review pass applied
