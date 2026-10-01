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
