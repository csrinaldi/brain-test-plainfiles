## Linked issue (required)

<!--
Every merge request must reference an approved issue — `issue-link` is a required gate
and fails closed without one.

  · Targeting the default branch: use a CLOSING reference, followed by the issue
    number — the line below is already in that form.
    Accepted closing keywords (case-insensitive): `Close`, `Closed`, `Closes`, `Fix`, `Fixed`, `Fixes`, `Resolve`, `Resolved`, `Resolves`.
  · Targeting any other branch (a chained slice): "Part of #N" is accepted too.
    It is NOT accepted on the default branch — the integration MR must close.

The referenced issue MUST carry the approved label — `status::approved` unless this
repo sets `governance.approvedLabel`, which the gate honors and this text cannot see.
An unapproved issue fails the gate exactly as a missing reference does.
-->

Closes #

## Merge request type

<!--
Check exactly ONE box and add the matching `type:*` label.

This is the set brain ships. It is NOT read from your project — check it against your
own labels, because a `type:*` value your project does not define cannot satisfy the
"exactly one `type:*` label" item no matter which box is ticked.
-->

- [ ] New feature (`type:feature`)
- [ ] Bug fix (`type:bug`)
- [ ] Documentation only (`type:docs`)
- [ ] Code refactoring (`type:refactor`)
- [ ] Maintenance / tooling (`type:chore`)
- [ ] Governance / process (`type:governance`)

## Summary

<!-- 1–3 bullet points describing what this merge request does. -->

-

## Changes

| File | Change |
|------|--------|
| `path/to/file` | what changed |

## Diff size budget

<!--
The budget is resolved from the repo's declared governance tier, NOT a flat number
(#496): 1000 changed lines at `lite`, 400 at `standard`, 200 at `regulated`.
Additions + deletions, excluding whatever `governance.ignoreList` in this repo's
brain.config.json lists (test files, fixtures and lock files are the usual
entries — the list varies per repo, so read it rather than assuming).

If this merge request exceeds the budget, add the `size:exception` label and explain why
splitting was not feasible. CI will block merges over budget without it.

`regulated` does NOT honor `size:exception` — at that tier the label is refused
and the only way through is a smaller diff. Run `npm run brain:governance-status`
if you are unsure which tier this repo declares.
-->

- [ ] Diff is under the tier's budget (or `size:exception` label added with justification — not available at `regulated`)

## Decision / ADR

<!--
What `decision-gate` actually does (ADR-0026 Amendment 4, #516; added-only since #510):
it takes the changed-file list and the added-file list. It reads no labels. It fails
in exactly two cases —

  · an ADR is ADDED under `brain/project/decisions/` and `brain/HOME.md` is not in
    the diff;
  · `brain/HOME.md` is in the diff and no ADR path is touched at all.

Everything else passes, including MODIFYING an existing ADR on its own: correcting a
line in an ADR from months ago does not force a re-index.

So if this merge request introduces an architectural or process decision:
  1. Add an `adr-NNNN-<slug>.md` under `brain/project/decisions/`
  2. Index it in `brain/HOME.md` — this is the half the gate checks
  3. Add the `decision` label

Step 3 is a HUMAN signal that a decision was made. No gate reads it, and no gate
verifies that an ADR was OWED — "is this a decision?" is judgment, deliberately left
outside the machine.
-->

- [ ] No architectural decision involved
- [ ] ADR added (`brain/project/decisions/adr-NNNN-*.md`) and indexed in `brain/HOME.md`

## What the gates check

<!--
The governance jobs that run on this merge request. Which of them BLOCK the merge is a
property of YOUR pipeline, not of this list: the tier this repo declares and what the
platform can enforce both feed it, and a pipeline may simply run every job as
blocking regardless of tier. `npm run brain:governance-status` prints the
tier-resolved set — compare it against your pipeline definition rather than assuming
they agree.
-->

| Gate | What it verifies |
|------|------------------|
| `issue-link` | The merge request description references an issue carrying the approved label. Fails closed. |
| `diff-size` | Changed lines are within the declared tier's budget, excluding the configured ignore list. |
| `local-checks` | The structural repo checks — reference check, navigation check — run in CI too, not only in your local hook. |
| `memory-gate` | Session memory was captured. The gate reads the merge request description (#1024 — both GitHub and GitLab now hand it, unioning the merge request tree with the default branch) and requires a memory record scoped to the linked issue; when no issue is detectable it degrades to "this repository has ever recorded a session summary". |
| `decision-gate` | An ADDED ADR is indexed in `brain/HOME.md`, and `brain/HOME.md` is not touched without an ADR. Reads no labels. |
| `phase-order` | The change's SDD artifacts progressed in order. A real violation fails at every tier; only an UNCOMPUTABLE diff is downgraded to a warning at the lightest one. |
| `actor-check` | The approval is not self-approval. At the lightest tier that means a distinct ACT (approving after your own last commit is enough); above it, a distinct ACTOR — approving your own merge request or your own issue fails — and at the strictest tier the approver must also have authored no commit on the branch. |
| `brain-writes-reviewed` | Writes to the knowledge half are not agent-authored — that half never tiers. Above the lightest tier an approving review from someone other than the author is also required, though a merge request with NO reviews yet warns and passes rather than failing on absent evidence. |
| `lane-paths` | Runs on every merge request, not only a memory lane one. On the lane branch it verifies every changed path under `.memory/records/` is an ADDED file and nothing else changed; on any other merge request it passes with nothing to check. Never tiers. |
| `lane-scrub` | Runs on every merge request, lane or not. Every record file added under `.memory/records/` is scanned for a committed secret and fails closed on a match, naming only the pattern and line number — never the matched text. Not softened at any tier. |
| `base-branch` | A merge request whose linked issue names a parent that declares a tracker must base on that tracker while the epic is in flight; a merge request with no linked issue, no parent, or an epic with no tracker passes untouched. Required at every tier, including the lightest. |

## Test plan

<!-- Run these locally. Do not assume CI repeats all of them: which checks a
     consumer's pipeline actually executes varies — see the gate table above. -->

- [ ] `npm test` passes (all unit tests green)
- [ ] `npm run brain:repo:check` passes
- [ ] `npm run brain:nav` passes (no orphans, no broken links)
- [ ] Manually verified the changed functionality

## Contributor checklist

- [ ] Linked an approved issue on the reference line above
- [ ] Exactly one `type:*` label added, from the list above
- [ ] Diff size within the tier's budget (or `size:exception` labelled and justified)
- [ ] Conventional commit format (`type(scope): description`, no AI-attribution trailers)
- [ ] Session memory captured as a record (`brain:memory:save --issue N`); it reaches `main`
      on the lane. Where the pipeline hands `memory-gate` this description, an unscoped
      record does NOT satisfy it — though a record already on `main` from its own lane MR
      does, with no rebase needed. `skip:memory-gate` is honored at the "standard" tier
      when applied by someone other than the MR author; "regulated" refuses it; "lite"
      does not consult it.

<!-- Emitted from brain/scripts/vcs/contributor-scaffold.mjs — edit the source, not
     .gitlab/merge_request_templates/Default.md. A hand-edit here is refused by contributor-scaffold.test.mjs. -->
