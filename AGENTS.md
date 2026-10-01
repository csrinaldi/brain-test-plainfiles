<!-- generated from brain/HOME.md, brain/core/methodology/agent-authorities.md, brain/core/methodology/harness-contract.md, brain/core/methodology/sdd-layout.md, brain/core/methodology/workflow-governance.md — do not edit.
     Regenerate: AGENT_PLATFORM=antigravity npm run brain:env:init
     Drift-guarded by antigravity.drift.test.mjs — hand-edits fail CI. -->

---

<!-- source: brain/HOME.md -->



---

<!-- source: brain/core/methodology/agent-authorities.md -->

# AI Agent Authorities

> **status:** current | **last-reviewed:** 2026-06-24 | **owner:** @crinaldi

> **Purpose:** defines what an agent can do autonomously, what requires
> human confirmation, and what is prohibited. Companion to `consolidation-protocol.md`
> and `anti-patterns/ia-escribe-brain-sin-gate.md`.
>
> **This document is human-authored.** Changes to tiers require an MR
> with human review — they are covered by CODEOWNERS.

---

## Authority tiers

### Tier 1 — Autonomous

The agent may execute without asking for permission:

- Read any file in the repo (`brain/`, `openspec/`, code, scripts)
- Create/modify files in `openspec/changes/**` (in-flight SDD artifacts)
- Capture memory as records: `npm run brain:memory:save` writes a record under `.memory/records/` first (`memory-backend-contract.md` rule 2); the active backend picks it up on the next hydration (`session:start`, `cli.mjs import`) until #874 adds direct hydration. The backend's own MCP write (`mem_save`) is working memory for the change in flight, non-durable by definition: nothing exports it.
- Write to `scratch/{agent-id}.md` within an active change
- Run `npm run brain:repo:check`, `npm run backend:build`, `npm run brain:change:verify`
- Create issues in GitLab (`/gitlab-issue`)
- Propose commits for human review (but not push or merge without confirmation)
- Save observations in Engram (`mem_save`, `mem_session_summary`)
- Refresh the skill registry (`gentle-ai skill-registry refresh`)

### Tier 2 — Confirm before executing

The agent proposes and waits for explicit human approval:

- **Push to any branch** — the human approves each push
- **Create an MR** — the human authorizes it; **merging** follows the declared autonomy
  mode (ADR-0037): in mode A the human reviews the MR and merges it; in modes B and C the
  agent does not merge, the platform does (see Tier 3)
- **Modify files in `brain/`** — the agent drafts the artifact in
  `openspec/changes/{iid}/brain-drafts/`; the human moves it to `brain/`
- **Modify `.gitlab-ci.yml`, `settings.xml`, `CODEOWNERS`** — infrastructure changes
  that affect the whole team
- **Delete branches or committed files** — irreversible destructive actions
- **Resolve semantic conflicts of type `architecture`/`decision`** in Engram
  (see `consolidation-protocol.md §4`)
- **Publish to the package registry** — affects artefacts shared by all consumers

### Tier 3 — Prohibited

The agent must never do this, even if explicitly asked:

- Commit directly to `brain/core/**` or `brain/project/**` — the knowledge half,
  whatever its subdirectories are called
- Approve or merge a change it produced, **in any autonomy mode** (ADR-0037). The producing
  identity (a commit author or the PR/MR author) is never the approver or the merger:
  - **mode A** — a human approves the intent and a human merges;
  - **mode B** (the default) — a human approves the intent; the platform merges, under the
    automation identity, only when every required gate passes and the cold review, posted by
    an identity other than the producer, approves; anything else escalates to the human;
  - **mode C** — an agent identity other than the producer may approve the intent, and the
    platform merges as in B; refused at tier `regulated`.

  No agent holds a merge verb in any mode, and the reviewer gains no approve or merge
  authority. The only exception is the solo maintainer at `lite` in mode A, who may merge a
  change produced under their own credential; it is reported as such, never as independent
- Modify git history (`--force`, `--amend` of published commits,
  `rebase` of branches others use)
- Add AI attribution to commits — an agent co-author trailer, a session URL or a
  "generated with" footer, whatever the tool is called. Provenance is not
  authorship: it is evidence when a runner attests to it, and a claim when the
  producer asserts it about itself (ADR-0031). Enforced by `hooks/commit-msg`
  and `hooks/pre-receive`; the agent vocabulary is `git config brain.aiAgents`,
  so a consumer governs their own tooling without waiting for a brain release
- Publish release artefacts to the package registry without explicit human
  instruction — whatever the ecosystem's artefact is
- Escalate decisions to other agents without the human's knowledge

---

## Escalation rule

If the agent is unclear which tier an action belongs to: **pause and ask**.
Doubt about the tier is already sufficient reason to escalate to the human.

---

## Review

This document must be reviewed when:
- A new tool type or capability is added to the harness
- A Tier 2 action proves to be routine and low-risk (candidate for Tier 1)
- A Tier 1 action produces an incident (candidate for Tier 2 or 3)

Changes to this document require an MR reviewed by `@crinaldi`.

## Autonomy modes (issue #1123)

**Signed**: 25/09/2026 — Cristian Rinaldi

### What changed

Tier 3's "approve or merge its own MR" becomes a rule per autonomy mode, and Tier 2's "the human
reviews the MR before merging" holds in mode A only. The invariant under both is unchanged in
substance and now stated for every mode: the identity that produced a change never approves or
merges it.

### Why

The flat rule asked an agent to remember it, and at `lite` the forge requires no approving
review, so nothing stopped an agent that held a merge path. It also named no way to run
automatically without the agent merging its own work. ADR-0037 separates who approves the
intent from who executes the merge, and makes the merger the platform, not the producer.

### What this does NOT close, said plainly

The rule is still doctrine until the identity gate (#1134) and the port's merge verb (#1133)
land. Until then mode B cannot be claimed and the effective mode is A: a human approves the
intent and a human merges. Brain reports the declared and the effective mode separately rather
than letting the default read as enforced.


---

<!-- source: brain/core/methodology/harness-contract.md -->

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


---

<!-- source: brain/core/methodology/sdd-layout.md -->

# SDD Canonical Layout

> **status:** current | **last-reviewed:** 2026-07-12 | **owner:** @crinaldi

> **Purpose:** the normative, canonical `openspec/changes/**` layout — the change-dir
> naming pattern, the required artifact set, and the operational/ephemeral artifacts
> that sit outside it. The single accessor for this layout in code is
> `brain/scripts/lib/sdd-layout.mjs` (issue #250, slice B0). Referenced by ADR-0019
> (the `SDD_HARNESS` port draft) and `harness-contract.md`'s artifact contract.

## Change-dir naming

Every in-flight change lives at `openspec/changes/issue-<N>-<slug>/`, where `<N>` is
the GitHub issue number and `<slug>` is a short kebab-case description. **The slug is
MANDATORY** — a bare `openspec/changes/issue-<N>/` dir (no slug) is a naming violation
for NEW change dirs, even though it parses.

## Required artifacts (canonical, flat)

A NEW change dir MUST carry exactly these four files at its root:

```
proposal.md   — human-approved PRD
spec.md       — delta requirements
design.md     — technical decisions
tasks.md      — implementation checklist
```

This is the flat convention. A nested `specs/<capability>/spec.md` variant exists in
older change dirs — it is **LEGACY-ACCEPTED**: readers MUST tolerate it, but the
scaffold (`brain:project:feature`) MUST NEVER produce it. The nested form is not an
equal alternative to the flat one; it is a legacy shape kept readable, not repeated.

A change dir predating this convention that lacks a flat `spec.md` (whether or not it
has a nested one) may be **grandfathered** — see `LEGACY_GRANDFATHERED` in
`sdd-layout.mjs`. That allowlist is sealed at B0: exactly the 12 dirs measured then,
closed to new entries without an ADR-level justification. A NEW change dir must never
appear in it.

## Checked-task pattern

`tasks.md` tracks progress with markdown checkboxes: `- [ ]` (pending) and `- [x]`
(done), matched case-insensitively (`- [X]` also counts). Tooling that counts progress
(e.g. the L4 phase-order gate) counts `- [x]`/`- [X]` lines.

## Archive destination

When a change is archived, it moves under an archive path **owned by
`sdd-layout.mjs`** — call `archivePath(iid)` rather than hardcoding the location. The
concrete value is a design-time decision (see `sdd-layout.mjs`'s design notes), not
asserted here, so this doc never drifts out of sync with the accessor.

## Operational / ephemeral artifacts

`resume.md` is **not** a required artifact. It is machine-written by the memory
checkpoint/resume flow, used as a disambiguation signal when more than one change dir
is active, and explicitly outside `REQUIRED_ARTIFACTS` — staleness is expected, it is
freely discardable, and it is **never a gate condition**. Code represents it as its own
named export, `OPERATIONAL_ARTIFACTS`, so any future tooling that needs to
recognize-but-ignore `resume.md` reads it from the same single source rather than
re-declaring a fourth scattered literal.

## Single source of truth

`brain/scripts/lib/sdd-layout.mjs` is the ONE module exporting `REQUIRED_ARTIFACTS`,
`LIFECYCLE_STAGES`, `OPERATIONAL_ARTIFACTS`, `CHANGES_ROOT`, `LEGACY_GRANDFATHERED`,
`resolveStageSet`, and the layout path/parse helpers (`changeDir`, `artifactPaths`,
`archivePath`, `parseChangeId`, `isGrandfathered`, `hasSpec`,
`missingRequiredArtifacts`). Consumers import from this module rather than
re-deriving the layout inline.

Two drift-guard scans in `sdd-layout.test.mjs` hold that single-source claim,
and it takes two because the set has two notations. One scans for the
FILENAME form (`'proposal.md', 'spec.md', …`); the other for the BARE-NAME form
(`'proposal', 'spec', …`). Either alone leaves a hole: for as long as only the
filename scan existed, `stage-engine.mjs` and `phase-order-check.mjs` each
carried an independent bare-name declaration of the same four, invisible to a
guard whose doctrine already claimed to forbid them (#456).

The bare-name scan carries exactly one allowlist entry, and its written reason
is load-bearing: `governance-tiers.mjs`'s `TIER_PARAMS` names the same four as
the GATE set for the `standard` tier. That is REQ-L4-2′ — the tier scopes what
the GATE demands, never what the SCAFFOLD produces — so it is a different set
that happens to share members, not a rival declaration of this one.


---

<!-- source: brain/core/methodology/workflow-governance.md -->

# Workflow Governance — L3 Reference

> **Layer**: L3 (in-context guidance). See ADR-0014 (workflow-governance) in the brain project for the architecture. (Core docs reference project ADRs by name, not by path — `brain/project/**` is consumer-owned and varies per repo.)
> **Status**: current | **Introduced**: S3 (governance change)

This document is the in-context reference for the governance workflow that enforces
brain's four load-bearing process invariants at the server-side layer (L1). It maps
each invariant to its CI gate, states the enforce-outputs/guide-judgment boundary
explicitly, and documents the operational procedures for recovery and rollback.

---

## Four Invariants and Their Gates

Each invariant maps to one GitHub Actions job in `.github/workflows/governance.yml`.
Job names are **load-bearing**: they form the check context strings
(`governance / <job-name>`) that branch protection requires.

| # | Invariant | CI job (`name:`) | Skip label | Character |
|---|-----------|-----------------|------------|-----------|
| 1 | Every PR links an approved ticket — except a lane PR whose diff earns the exemption (ADR-0034, ADR-0035) | `issue-link` | _(none — no label bypasses it)_ | Hard, with two content-earned exemptions — see below |
| 2 | PR diff ≤ the declared tier's budget — **1000** `lite` · **400** `standard` · **200** `regulated` | `diff-size` | `size:exception` — **refused at `regulated`** | Hard with override — **none at `regulated`** |
| 3 | Repo-scoped when no issue is detectable; otherwise issue-scoped over the PR tree plus `origin/<default>` (#1024) | `memory-gate` _(S4)_ | `skip:memory-gate` — honored at `standard` by a non-author, refused at `regulated`, not consulted at `lite` (#1024) | Soft — see below |
| 4 | An ADDED ADR co-occurs with a `brain/HOME.md` entry | `decision-gate` _(S4)_ | _(none — the gate reads no labels)_ | Hard, in one direction — see below |

> **Invariant 2 is tier-resolved, and this text restates the numbers by hand** (#496). The
> authority is `TIER_PARAMS` in `brain/scripts/vcs/governance-tiers.mjs` — `diffBudget` and
> `honorSizeException` per tier. Doctrine restating a value the code owns is a drift risk
> accepted deliberately here rather than left implicit: a reader needs the numbers in front of
> them, and the alternative — a pointer with no values — is what let this row say a flat `400`
> for as long as it did. **Whichever tier YOUR repo declares is the denominator** a checkpoint
> report must cite — `npm run brain:governance-status` prints it. A report quoting a budget the
> repo does not operate under is itself a blocking finding (`parseBudgetClaim`, #472).
>
> Stated conditionally on purpose: this file is `STRATEGY.COPY` into every consumer, while
> `brain.config.json` is not managed at all. A sentence naming *this* repo's tier would travel
> and be false on arrival — the defect that got `AGENTS.md` removed from the managed set in
> #397, "a file describing the wrong repository".

### Invariant 1 scope — two content-earned exemptions, never a branch-name exemption

**"Not skippable" means no label bypasses `issue-link`.** Invariant 3 has `skip:memory-gate`;
invariant 1 has no `skip:issue-link`. That does not mean the check never yields. Two narrow lanes
are exempt from the closing-keyword requirement, and both follow one rule: **the branch name is a
claim, never the proof. The diff is recomputed and checked before the exemption is granted.**

| Lane | Branch claim | Content proof, recomputed from `BASE...HEAD` | Decision · predicate |
|---|---|---|---|
| Memory | `memory/<host>-<date>` | every changed path is an ADDED `.memory/records/*.jsonl` file | ADR-0034 L1 · `checks/lane.mjs#classifyLane` |
| Archive sweep | `auto-archive/<date>` | at least one exact-content (`-M100%`, `R100`) rename `openspec/changes/<name>/…` → `openspec/changes/archive/<iid>/…` with the same relative path. Otherwise only added files under `openspec/changes/archive/**`, and new or pure-addition (zero deleted lines) `openspec/specs/<capability>/spec.md` | ADR-0035 · `checks/archive-sweep.mjs#classifySweepDiff` |

Both are wired into `run-check.mjs#runIssueLinkCheck` in the same shape. The branch regex is
tested first, so a non-lane head never touches git. The diff predicate runs next, inside a
`try`. A pass is returned only when the predicate proves the lane. A head that claims a lane
but whose diff fails the proof falls through to the ordinary rule: a closing keyword on the
default branch. It is never exempted silently. An uncomputable diff also falls through, and is
never reported as `uncomputable`.

**Why not a label.** Both lanes are opened by unattended automation, a memory collector and a
post-merge sweep, with no human in the loop to apply one. A label that automation applies to
its own pull request is the spoofable shortcut this rule exists to prevent. Recomputing the
proof costs less than trusting the claim.

**Not exempt: `auto-revert/*`.** The post-merge auto-revert opens `auto-revert/<sha>` against
the default branch with `Part of #259.` and no closing keyword, so `issue-link` refuses it. A
revert has no fixed diff shape for a path predicate to check. ADR-0035 names this gap and leaves
it open.

### Invariant 3 scope — what `memory-gate` does and does not check

**It is repo-scoped only when no issue is detectable from the PR/MR description; otherwise it
is issue-scoped over the union of the PR tree and `origin/<default>` (#1024).** When
`ci-context.mjs`'s `loadContext()` can resolve an issue number, `memoryRetrieval()` requires a
record scoped to that issue in either tree — a record that reached the default branch on its
own lane PR (ADR-0034) satisfies a feature PR closing the same issue, with no rebase. Only when
no issue number can be resolved does the gate fall back to `memoryPresence`'s repo-wide
question — whether ANY `session_summary` observation exists anywhere in `.memory/records/`.

**Per-change capture is enforced when an issue is detectable.** The PR template's "Memory
materialized before closing" is now backed by the scoped check above whenever the pipeline can
resolve the issue; it remains an unenforced promise only in the repo-scoped fallback case (no
issue detectable).

Measured 2026-08-11 (issue #529): `.memory/records/` went **seven days** without a new record
while **34 merges** landed. `memory-gate` was green on all of them — correctly, by the definition
above. That is the gap this scope note exists to stop hiding.

**`skip:memory-gate` is real, per tier (#1024).** `memory-gate-override.mjs#decideMemoryGateOverride`
honors it ONLY at the `standard` tier (`TIER_PARAMS.honorSkipMemoryGate`), and only when the
applier — the latest `add` event's actor — differs from the PR author and is not listed in
`governance.reviewActors`/`governance.agentActors` (mirrors `actor-check`'s own distinct-actor
rule). At `regulated` the label is refused, consistent with `regulated` refusing
`size:exception`. At `lite` it is noted in the output and not consulted, because the gate is
detection-only there. `brain:metrics` reports it as `raw/honored`, not a raw count alone.

**This is a ruling, not a resting place** (issue #529). The sequence is: #530 makes capture a
mechanism rather than a habit → `skip:memory-gate` becomes real → invariant 3 tightens to
recency. Tightening it before the writer is reliable would block every PR with no override,
which is how a gate teaches people that gates are obstacles. **Step 2 done (#1024)**: the
tier-scoped override above and the union read that makes a strict scoped check safe without
forcing a rebase. Recency (the rest of step 3) remains — this change activates `GATE_MATRIX`'s
`required` evidence at `standard`/`regulated` but does not tighten the evidence form itself.

Check context format: `governance / <job-name>` (GitHub prefixes the workflow `name:` field).

The constant `GOVERNANCE_JOBS` in `scripts/vcs/governance-checks.mjs` is the single source
of truth for these names. A drift-guard unit test reads `governance.yml` and asserts the
YAML job names match the constant — fail-closed on any mismatch.

### Invariant 4 scope — what `decision-gate` does and does not check

**It reads no labels, and it runs on every PR.** `adrPresence` takes the changed-file list and
the added-file list; no call site passes labels and the workflow job carries no condition. The
`decision` label changes nothing about the verdict.

**It fails in exactly two cases** (measured 2026-08-11, issue #516):

| condition | verdict |
|---|---|
| an ADR is **added** and `brain/HOME.md` is not in the diff | fail |
| `brain/HOME.md` is in the diff and **no** ADR path is touched | fail |
| anything else, including a **modified** ADR alone | pass |

The two are keyed differently on purpose: the first reads the ADDED list, the second the
TOUCHED list. That asymmetry is #510's content — a PR correcting one line of an old ADR must
not be forced to re-index it (the previous behaviour blocked PR #507 for months) — and its
consequence is that **an amendment's `brain/HOME.md` marker has no gate behind it**
(`consolidation-protocol.md` §1c now says so; the net belongs in the amendment verb, #509).

**There is no step-2 heuristic.** This file described one — a scan of
`scripts/.*/providers/`, `brain/core/`, `config-migrations.mjs` and `package.json` emitting a
`::warning::` for changes without the `decision` label. Nothing scans those surfaces and
nothing emits that warning; the description was aspirational and read as shipped. An
architectural change carrying no ADR simply passes, in silence.

Both facts are pinned by test (`run-check.test.mjs`, #516), each proven a real detector by a
mutation that IMPLEMENTS the claim. If either is ever built, those tests fail and name this
section, so the doctrine cannot silently fall behind the code again.

---

## Enforce-Outputs / Guide-Judgment Boundary

L1 enforces **observable outputs** of each invariant. It does NOT enforce judgment.

| What L1 enforces | What L1 does NOT enforce |
|-----------------|--------------------------|
| A ticket link exists and has `status:approved`, unless the diff earns a lane exemption (invariant 1 scope) | Whether the ticket describes the right work |
| PR diff ≤ the tier's budget (excluding ignore-list) | Whether the PR is sliced coherently |
| `.memory/` changed (memory-gate proxy) | Capture quality or session completeness |
| An added ADR is indexed in `brain/HOME.md` | Whether the PR actually made a new decision |

This boundary is **not a gap to close** — it is the line between what a machine can verify
and what requires a human mind. *"Is this a decision?"* is judgment, and `decision-gate` does
not attempt it: it verifies a cascade (an added ADR is indexed) and says nothing about whether
an ADR was owed. Applying the `decision` label is a human act with no gate reading it.

---

## Lockout Recovery

If branch protection is active and a CI job is red, ALL merges to `main` are blocked.

**Recovery path 1 — fix the CI job:**

Address the underlying issue (fix the PR, update the issue label, add the ADR, etc.)
and push a new commit. The gate re-runs and unblocks automatically.

**Recovery path 2 — admin override (logged):**

`enforce_admins: false` allows repo admins to merge through a failing check without
disabling protection. This is logged in the GitHub audit trail.

**Recovery path 3 — emergency disable (use sparingly):**

```bash
# Admin-only: disable protection entirely to unblock an emergency merge.
gh api -X DELETE "repos/{owner}/{repo}/branches/main/protection"

# After the emergency fix is merged, re-enable idempotently:
npm run brain:protect
```

Verify current protection status at any time:
```bash
gh api "repos/{owner}/{repo}/branches/main/protection" | python3 -c "
import json, sys
p = json.load(sys.stdin)
print('checks:', [c['context'] for c in p['required_status_checks']['checks']])
print('reviews:', p['required_pull_request_reviews']['required_approving_review_count'])
print('force push allowed:', p['allow_force_pushes']['enabled'])
"
```

---

## S3 Dual-Surface Rollback

Branch protection is a **GitHub setting**, not a file. Rolling back S3 requires TWO
separate actions — doing only one leaves the system in a broken state.

**Surface 1 — revert the files** (normal `git revert`):

```bash
git revert <S3-commit-sha>
# Removes: governance-checks.mjs, brain-protect.mjs, the branchProtect verb,
# the vcs-contract.md update, workflow-governance.md (this file), and the
# package.json brain:protect script.
```

**Surface 2 — disable the protection setting**:

```bash
gh api -X DELETE "repos/{owner}/{repo}/branches/main/protection"
```

If you only do surface 1, protection stays active with orphaned check context
references. The checks no longer exist (no CI runs them) but protection still
requires them, which deadlocks `main` permanently. Always disable both.

---

## brain:protect — Operator Reference

`npm run brain:protect` activates branch protection on `main` using the current
governance check contexts from `scripts/vcs/governance-checks.mjs`.

**Who runs it**: a repo admin, once. Not a per-developer step.

**When to run it**: after S3 merges to the tracker branch (`feature/governance`),
after all open non-compliant branches have been:
- merged to main in their current state, OR
- rebased to comply with the governance gates, OR
- explicitly documented as exceptions in the S3 PR description (REQ-E-2).

Activating protection while a non-compliant branch is open means that branch cannot
merge until it complies — it does not affect `main` stability, but it creates work.

**Idempotent**: re-running `brain:protect` refreshes the protection settings safely.
It does not break anything or create duplicate checks.

---

## governance-metrics — `brain:metrics` Operator Reference

`brain:metrics` is a **read-only reporting verb**, introduced M9 (issue #324). It
re-derives governance-effectiveness signals from brain's own merged git history by
re-executing the SAME pure check functions `brain-audit` runs (shared via
`scripts/lib/merge-walk.mjs`) over the same first-parent merge walk — measurement
cannot drift from enforcement because it is the same code, not a re-derived copy.
It introduces **zero new gates, invariants, or CI-blocking behavior**: nothing it
reports can fail a merge, and it persists no state between runs (each report is
point-in-time only).

**Usage:**

```bash
npm run brain:metrics                                    # origin/main..HEAD, monthly, markdown
npm run brain:metrics -- <git-range>                     # e.g. HEAD~30..HEAD, origin/main..HEAD
npm run brain:metrics -- <git-range> --json               # flat JSON array, one object per period
npm run brain:metrics -- <git-range> --period=week         # ISO 8601 weekly buckets instead of monthly
npm run brain:metrics -- --help                            # usage text, exits 0
```

The range argument is **positional**, mirroring `brain:audit`'s own signature (never
a `--range=` flag) — `git log` already accepts range syntax like `HEAD~30..HEAD` or
`origin/main..HEAD` directly.

**What it measures, per period bucket:**

| Signal | What it is |
|---|---|
| Changes merged | Count of first-parent merges landing in the bucket |
| Median lead time | Median of: issue's **last** `status:approved` label-add at-or-before merge → merge date |
| `diff-size` / `issue-link` / `decision-gate` (raw / enforced) | `raw` = the check's real result, ignoring any exemption; `enforced` = `raw` minus `size:exception`-labeled and net-parity-exempted merges (the same exemption decisions `brain-audit` itself makes) |
| `size:exception` usage / `skip:memory-gate` usage (raw / honored) | `size:exception`: raw count of merges whose PR carries the label, by period. `skip:memory-gate`: raw count of merges whose PR carries the label, AND how many of those `decideMemoryGateOverride` actually honored (#1024) |
| `size:exception` usage by author | A separate "Exception usage by author" table: `size:exception` count per (period, label-adding actor) pair. The actor is read from the PR's own label-add events, not the linked issue's; unresolvable actors (VCS not configured, `labelEvents` fetch failure) are bucketed as `unknown` — never dropped |
| `phase-order` / `actor-check` / `brain-writes-reviewed` | Single pass/fail count column (DETECTION_JOBS never block merge, so there is no raw/enforced split). Supported on both providers — see the GitLab caveat below |
| Uncomputable | Merges where a per-merge git-plumbing read failed — counted visibly, never silently dropped or silently passed |

**Reported once, separately from the per-period table (repo-level, not a time series):**

- **`memory-gate` (memoryPresence) at HEAD** — whether a `session_summary` observation
  exists in `.memory/records/` right now. This check reads repo state ONCE per
  `brain-audit`/`brain-metrics` run, so its result is IDENTICAL for every merge in
  the window — a per-period column would be a constant masquerading as a series.
- **Memory-records coverage** — total records under `.memory/records/`, how many
  carry a populated `issue` field, and the resulting coverage %. Labeled **"adoption
  pending"** in every report: the `issue` field is not yet populated in practice
  across brain's own history, so this number is expected to read near 0% until
  memory-record tagging is adopted. Reports `Unavailable` (never a fabricated 0%
  passed off as measured) when `.memory/records/` is missing or unreadable.

**Caveats — read before trusting a number:**

- **Lead time is an issue-approval proxy, not PR-review-approval time.** It measures
  the gap between the referenced ISSUE's `status:approved` label and the merge —
  not how long the pull request itself sat in review. A short lead time can still
  reflect a long-considered issue approved well before the PR existed.
- **`memoryPresence`/`memory-gate` is repo-global, not per-merge.** See above — do
  not read it as "did this specific merge have memory captured".
- **`skip:memory-gate` is enforced at `standard` only (#1024).** `memory-gate` is not in
  `PER_PERIOD_GATES` (design D3 — it is a repo-level signal, not a per-period series), so there
  is no enforced-failure count to subtract an honored skip from. `brain:metrics` reports it as
  `raw/honored`: raw is every merge whose PR carried the label; honored is the subset
  `decideMemoryGateOverride` actually honored (a non-author applier, at the `standard` tier),
  with a by-author breakdown mirroring `size:exception`'s own table.
- **`decision-gate` counts are label-conditional.** Only PRs carrying the `decision`
  label contribute to its raw/enforced counts, matching its mixed (Step 1 hard /
  Step 2 heuristic) enforcement described above.
- **GitLab detection-job reporting uses a `status` fallback.** GitLab's
  `prStatusRollup` always normalizes `conclusion: null` (its commit-status model has
  no field distinct from the terminal `status`) — reading `conclusion` alone would
  silently report 0/0 for all three detection jobs on every GitLab repo forever.
  `detectionConclusion()` falls back to `status` when `conclusion` is `null`, mapping
  GitLab's own vocabulary (`success` → pass, `failed` → fail; anything else —
  `pending`/`running`/`canceled`/`skipped`/etc. — stays uncounted). This is verified
  against a GitLab-shaped fixture in `brain-metrics.test.mjs`, but has not yet been
  confirmed end-to-end against a live GitLab repo (GitHub is the only provider
  exercised in brain's own real-history integration run, Phase 8).

**Failure policy differs from `brain-audit` on purpose.** `brain-audit` is
fail-closed and exits 2 on an uncomputable merge (never a silent PASS on an
enforcement gate). `brain:metrics` is a reporting tool: a per-merge git-plumbing
failure is caught and counted in the `Uncomputable` column instead, and the run
still exits 0. It exits non-zero ONLY when the requested range itself cannot be
resolved (an invalid `<git-range>`), with an actionable error suggesting valid
range syntax — never as a verdict about governance health.

