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
