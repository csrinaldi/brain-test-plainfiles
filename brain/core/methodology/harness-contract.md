# SDD Harness Contract

> **status:** current | **last-reviewed:** 2026-06-24 | **owner:** @crinaldi

> **Purpose:** defines the abstract verbs that any SDD harness must implement
> to be compatible with this project. Referenced in the brain project by ADR-0005 (harness
> adapter: `SDD_HARNESS` selector + verb contract, which names this file as its contract) and
> ADR-0001 (3-layer architecture with replaceable harness). Core docs reference project ADRs by
> name, not by path, because `brain/project/**` is consumer-owned.

The current harness is `gentle-ai`. Another harness may replace it as long as it implements
this contract — without changes to `project-workflow.md` or `developer-environment.md`.

---

## Required verbs

> **Naming note (v0.8.0+):** the `brain:*` prefix is now the canonical name for all
> brain-managed verbs. The short aliases (e.g. `env:init`, `repo:check`) remain as
> deprecated aliases pointing at the same targets — they will be removed in a future
> major release.
>
> **v0.8.1:** `brain:session:start` is the canonical form of `session:start` (added in v0.8.0
> but missed the prefix). The `session:start` alias continues to work.

| Canonical verb (npm) | Deprecated alias | Verb (Claude) | Responsibility |
|---|---|---|---|
| `npm run brain:env:init` | `env:init` | — | Environment bootstrap: installs tools, configures auth, imports memory, refreshes skill registry. Idempotent. |
| `npm run brain:day:start` | `day:start` | — | Daily startup: VCS auth, ecosystem updates, team memory, ticket board. |
| `npm run brain:session:start` | `session:start` | — | Session context loader: restores `.memory/manifest.json` churn (step 1 — required by `openspec/specs/session-start/spec.md` REQ-3 today; the manifest is the engram adapter's artifact per ADR-0002 Amendment 1, and #864 task 2.4 retires the step and amends REQ-3 together), hydrates the active memory backend from `.memory/records/`, resolves the active change and ticket memory, reports memory recency. Read-only, local-only, no network. |
| `npm run brain:ticket:start -- <id> [--base <tracker>]` | `ticket:start -- <id>` | `/ticket-start <id>` | Task start. Creates the branch `{type}/issue-{number}-{slug}` in an ISOLATED WORKTREE off `<tracker>` — **that is the DEFAULT, no flag required (#782)**. **Always an isolated worktree; NEVER a branch in the main checkout when parallel work is possible.** `--in-place` is the named opt-out, for strictly solo serial work only, and the verb says which mode it took. `<tracker>` is the integration base (e.g. `feature/v2.0.0`), not `main`, while an epic is in flight. |
| `npm run brain:project:feature -- --issue <id>` | `project:feature -- --issue <id>` | `/sdd-new <id>` | Starts an SDD change: creates `openspec/changes/issue-<id>-<slug>/` with `proposal.md`, `design.md`, `tasks.md`, `spec.md`. |
| `npm run brain:repo:check` | `repo:check` | — | Validates prohibited references across the entire tree. Minimum gate before any commit. |
| `npm run brain:change:verify` | `change:verify` | `/sdd-verify` | Validates the scope of the active change: classifies the diff, runs only the necessary verifications. |
| `npm run brain:memory:share` | — | — | Materializes what `.memory/records/` does not yet hold and rebuilds `index.jsonl`; reports the duplicate accounting. Under record-first (#864 task 3.2) it exports nothing from the backend. |
| `npm run brain:memory:pull` | — | — | `git pull`, then hydrates the active backend from `.memory/records/` (idempotent by record id — `memory-backend-contract.md` rule 1). Brings the team's memory. |
| `npm run brain:memory:index` | — | — | Re-projects `brain/` doctrine into the active backend, where the backend supports it (`plainfiles` does not, by design). Needed when ADRs or glossary change. |
| `npm run brain:memory:save` | — | — | The producer path: writes a record to `.memory/records/` first (provenance, `--issue`; `--supersedes` lands with #805). Today it is pinned to `plainfiles` and the active backend picks the record up on its next hydration (`session:start`, `cli.mjs import`); direct hydration lands with #874. `memory-backend-contract.md` rule 2. |
| `npm run brain:memory:audit` | — | — | The five numbers of memory 2.0 (#870) from records and `git log` alone; the backend row degrades to a stated reason. |

> **Worktree convention (load-bearing):** task start is
> `npm run brain:ticket:start -- <id> [--base <tracker>]`, and **the isolated worktree is what
> that does with no flags** (#782). It is mandatory whenever parallel work is possible — it
> gives one-branch-per-worktree isolation over a shared object store (single fetch, zero extra
> clone). A branch in the main checkout is only acceptable for strictly solo, serial work, and
> is reached by asking for it: `--in-place`. This rule prevents the whole team from colliding
> on one working tree.
>
> **The flag used to be required, and that was the defect (#782).** This row said *always* while
> the verb defaulted to the branch the row calls NEVER, so satisfying doctrine depended on
> remembering a flag. Measured: an agent session on 2026-08-27 created five branches in the main
> checkout with `AGENTS.md` loaded and this rule in it. `--worktree` still parses and still means
> what it meant; it is simply no longer load-bearing.
>
> **What still has no reader.** Nothing refuses `git checkout -b` in the main checkout. The
> default is the cheap half; #782's remaining slices are a guard that refuses, and the shape
> where the orchestrator owns isolation so an agent cannot express the wrong thing — which is
> what `cold-boot.mjs` already does for the cold-review producer.

## Optional verbs (recommended)

| Verb (Claude) | Responsibility |
|----------------|-----------------|
| `/sdd-explore <idea>` | Investigation prior to the proposal. Does not create artifacts. |
| `/sdd-continue` | Advances the next ready phase of the SDD cycle. |
| `/sdd-apply` | Implements the tasks of the active change. |
| `/sdd-archive` | Closes the change and consolidates artifacts. |
| `/retomar` | Recovers the context from the previous session from engram + the VCS board. |
| `/issue-create` | Creates an issue from a description or changeset. Provider-specific skill (e.g. `gitlab-issue`). |
| `/mr-create` | Opens a PR/MR linked to an issue. Provider-specific skill. |

> **`/sdd-archive` is human-optional, machine-guaranteed.** No human is required to run it, and no
> gate fails because a change is unarchived: staleness is never an audit failure class. On GitHub,
> the machine does the archiving. After every clean post-merge audit,
> `.github/workflows/governance-postmerge.yml` sweeps changes whose issue is CLOSED into
> `openspec/changes/archive/` through one `auto-archive/<date>` PR. "Optional" here means "not your
> job", not "nobody's job"; running it by hand only makes the next sweep a no-op. The GitLab
> governance fragment has no sweep step yet, so on GitLab archiving is still a manual act.

## Artifact contract

An SDD change produces exactly these artifacts under `openspec/changes/issue-<iid>-<slug>/`:

```
proposal.md   — PRD aprobado por humano (obligatorio)
spec.md       — requisitos delta del cambio
design.md     — decisiones técnicas y approach
tasks.md      — checklist de implementación
```

Artifacts live in `openspec/` during the change flight.
Only the durable residue (ADRs, anti-patterns, glossary) is promoted to `brain/` — see
`brain/core/methodology/consolidation-protocol.md`.

## Current implementation (gentle-ai)

`gentle-ai` implements this contract. Claude skills are installed with
`gentle-ai install` and maintained with `gentle-ai upgrade`. The local registry is
refreshed automatically on `brain:day:start` and `brain:env:init`.


## Implementation note — materialized memory layer

`.memory/records/` is the canonical, versioned record log — the durable truth (ADR-0017);
whatever `MEMORY_BACKEND` selects is a derived index hydrated from it
(`memory-backend-contract.md`). What the engram adapter needs privately in the tree is the
adapter's, not the layer's (rule 3; ADR-0002 Amendment 1): its `.engram → .memory` symlink and
its chunk directory are gitignored and created by `setup`/`share`; its manifest is **still
tracked today**, with its merge driver still registered in `.gitattributes`, and `session:start`
still restores it (REQ-3). Rule 3 forbids any reader of the records from depending on them;
#864 task 2.4 untracks the manifest, removes the driver, confines the symlink to `setup` and
amends REQ-3. ADR-0002 records the memory model.

## Worktree default (issue #782)

**Signed**: 28/08/2026 — Cristian Rinaldi

### What changed

The `brain:ticket:start` row and the worktree convention note stop prescribing `--worktree`.
The isolated worktree is what the verb does with no flags; `--in-place` is the named opt-out
for the strictly solo, serial case the convention already allowed.

### Why

The row said **always** and the verb defaulted to the opposite. `ticket-start.mjs:29` read
`argv.includes('--worktree')`, so the plain spelling — the one an operator or an agent types —
created a branch in the main checkout, which this same row calls NEVER. Doctrine and
implementation disagreed, and nothing compared them.

That is not hypothetical. An agent session on 2026-08-27 (PRs #777–#781) created **five**
branches in the main checkout with `AGENTS.md` loaded and this rule inside it. Nothing broke
because the work was serial and single-agent — luck, not correctness — and it still cost a
`git stash` mid-rebase, because the shared working tree carried local modifications a per-issue
worktree could not have collided with.

### What this does NOT close, said plainly

Nothing refuses a hand-rolled `git checkout -b` in the main checkout, which is what actually
happened. This amendment removes the requirement to REMEMBER; it does not make the wrong thing
unexpressible. #782's slices 2 and 3 own that — a guard that refuses, and the orchestrator
owning isolation the way `cold-boot.mjs` already does for the cold-review producer.

Recorded here rather than left implicit, because a doctrine row that reads as if the problem
were solved is the failure mode this ticket is an instance of.
