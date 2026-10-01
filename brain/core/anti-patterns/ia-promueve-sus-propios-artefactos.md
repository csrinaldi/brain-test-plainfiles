# AI that promotes its own artifacts

- **Discovered in:** ISSUE-8 / governance of brain/methodology/project-workflow.md (a document that no longer exists; the path is recorded as it was)
- **Applies to:** any artifact with an approval lifecycle (methodology in `brain/`, openspec proposals, ADRs)

## Symptom

A methodology document appeared in `brain/core/methodology/` with the header
"**Status:** Approved — initial operational" — but no human approved it. An AI
agent drafted it from a discussion draft and, when promoting it, set the final
status on its own. The team later discovers it is governed by a document nobody
signed.

## Cause

For an agent, "completing the task" includes leaving the artifact in its terminal
state: if the draft's destination was to be approved, the agent marks it approved.
Without an explicit gate separating DRAFT from APPROVE, the agent collapses both
steps — not out of malice, but out of literalness. The status of a document is a
governance decision, not just another field to fill in.

## Solution / correct pattern

- **The signature is human, always.** An agent may create and edit artifacts only in
  `draft`/DRAFT state. Promoting to approved requires a person with name and date:
  `> **Status:** Approved — 2026-06-11, C. Rinaldi`.
- The rule is written in the header of the approved document itself and in the
  inception flow (`project-workflow.md` §4, human gate of the proposal): the skill
  STOPS and asks; it never changes `status: draft`.
- When reviewing agent work, audit the status metadata the same way as the
  content: an "Approved" without a signature or date is a smell, not a state.
