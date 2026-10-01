# Knowledge Consolidation Protocol (Moment 3)

> **status:** current | **last-reviewed:** 2026-06-24 | **owner:** @crinaldi

> **Purpose:** Force design micro-decisions, technical tricks, or anti-patterns discovered in a branch chat to scale up into the global brain at zero capture cost for the small team.

## 1. Hot Capture (During the Agent Chat)

- The human programmer or the main orchestrator agent must dump session technical agreements directly into the `## Micro-decisiones en caliente` section of the `tasks.md` for the corresponding change in `./openspec/changes/[change-id]/`. No floating micro-decisions are allowed in the chat history.
- If the direct change does not require SDD/OpenSpec, micro-decisions that must persist are documented in the commit/MR and promoted to `brain/` only if they apply to more than one module, resolve a recurring risk, or change a working rule.

### Concurrent writes — scratch-per-agent pattern

When multiple agents work on subtasks in parallel within the same change, **they must not write directly to `tasks.md`**. Concurrent writes to a shared mutable file produce conflicts and silent context loss.

Mandatory pattern for changes with parallel sub-agents:

- Each agent writes its local context to `openspec/changes/{iid}/scratch/{agent-id}.md` (ignored by git during the change flight).
- The orchestrator consolidates the scratch files into `tasks.md` when closing each batch.
- `openspec/changes/{iid}/scratch/` is in `.gitignore` — it is not committed or persisted.
- **The orchestrator is the only writer of `tasks.md`.** Sub-agents only write their own scratch file.

## 1b. HOME.md maintenance rule

Every time a new ADR is created or a file is added under `brain/core/**` or
`brain/project/**`, the corresponding MR **must** update `brain/HOME.md` to
include the new link in the corresponding section. Without this update the MR
is not complete.

## 1c. Amending a signed ADR

An ADR that has been signed is never edited silently and never rewritten in place. Amending one
is **three acts in one commit**:

1. **Mark the Status line.** `**Status**: Accepted · **amended DD/MM/YYYY** (Amendment N — see below)`.
2. **Amend the original body in place.** Every line the amendment supersedes is rewritten, or
   annotated `**[Amended by Amendment N (#issue) — <what changed>]**`. A reader who never scrolls
   to the amendment must not be left with the superseded rule.
3. **Append a signed section.** `## Amendment N — <title> (issue #N)`, opening with
   `**Signed**: DD/MM/YYYY — <Name>`, recording what changed, why, the measurement, and the
   accepted losses.

The `brain/HOME.md` entry for that ADR is updated in the same commit to carry the amendment
marker. **Nothing enforces this. You are the enforcement.**

`decision-gate` requires an ADR and a `brain/HOME.md` change to co-occur only when the ADR is
**added**. An amendment MODIFIES an existing ADR, and since #510 a modified ADR without a
`HOME.md` change PASSES — deliberately, because the previous behaviour blocked every PR that
corrected a line in an old ADR (PR #507). The other two nets do not close it either:
`brain:nav` passes because `HOME.md` already links the ADR — it is the *marker* that goes
missing, not the link — and `phase-order` is detection-only at `lite`.

So an amendment can land with the index still describing the previous version, and no gate
will say so. That is still true of an amendment executed by hand.

What changed with #509 is that one path no longer lets you skip a step by accident:
`brain:promote` takes an amendment draft — a `*.draft.md` file carrying one `brain-amendment/1`
block naming its target and the passages it supersedes — and performs the three acts, this fourth
one and the §1d cascade in one run, then stages and stops. It derives the `brain/HOME.md` marker
from the same amendment number it writes into the Status line, so those two cannot disagree, and
it refuses outright when it finds the cascade half-applied rather than reporting success over the
missing acts. What it does NOT do is make a partial promotion impossible: it applies the whole
cascade or none of it, and anything already half-done is your repair, not its. Use it:

```
npm run brain:promote -- openspec/changes/<change-id>/brain-drafts/<name>.draft.md
```

**Off that path, you are still the enforcement.** A hand-run edit, or the next bespoke script,
is exactly as unguarded as it was before — no gate reads the marker.

Precedent: ADR-0026 Amendment 1 (`git show 0f54781`).

## 1d. The promotion cascade

Adding or amending any file under `brain/**` is not one edit. In this repo it is three:

1. the `brain/**` file itself;
2. the `brain/HOME.md` entry (§1b) — always required for `brain:nav` reachability, and
   enforced by `decision-gate` only when the ADR is **added**: `decision-gate` fails an added
   ADR with no `HOME.md` change, and fails a `HOME.md` change that touches no ADR at all, but
   passes a MODIFIED ADR alone (#510). On an amendment (§1c) this step therefore has no gate
   behind it;
3. **`AGENTS.md`, regenerated** — `brain/HOME.md` is one of the five `SOURCE_DOCS` the file is
   compiled from, so a `HOME.md` change without a regeneration leaves the compiled file every
   agent actually reads carrying stale content.

Regenerate with `AGENT_PLATFORM=antigravity npm run brain:env:init`. Never hand-edit `AGENTS.md`.
`brain:promote` does this step itself, for a new ADR (#378) and for an amendment (#509) alike —
a promoter written from THIS TEXT rather than from the verb is how the step gets lost, which is
what happened on #529 and failed the drift guard on the human's signing commit.

**Step 3 does fail a gate.** `antigravity.drift.test.mjs` asserts byte-equality between the
committed `AGENTS.md` and a fresh compile of the five sources, and it runs under `npm test`.
Measured on `main` @ `0401871`: appending one line to `brain/HOME.md` turns that test red. The
reason to automate step 3 is that it is a cascade nobody remembers, so forgetting it costs a red
CI round trip — not that nothing catches it.

## 2. Promotion in the Merge Request (GitLab)

> **Hard Rule — Mandatory human gate:**
> No AI agent may commit directly to `brain/core/**` or `brain/project/**`.
> Promotion works as follows:
>
> 1. The agent drafts the artifact (ADR, anti-pattern, glossary entry)
>    as a file under `openspec/changes/{iid}/brain-drafts/`.
> 2. The human reviews the draft in the MR, edits it if needed, and moves it to `brain/`
>    in a commit authored by them.
> 3. The MR description documents what was promoted and why.
>
> No agent promotes its own artifacts to `brain/`. That signature is human.
> See anti-pattern: `brain/core/anti-patterns/ia-escribe-brain-sin-gate.md`.

- Before removing the _Draft_ status from the MR in your self-hosted GitLab, the organization's closing skill will analytically process the micro-decisions accumulated in the branch.
- If the learning applies to multiple microservices or resolves a critical compatibility bug (e.g., Jakarta JSON serializations), the agent must draft the artifact in `openspec/changes/{iid}/brain-drafts/` for the human to review and promote.

## 3. Zone map — who can write what

| Zone                                 | Who writes        | Allowed operations     | Enforcement                                     |
| ------------------------------------ | ----------------- | ---------------------- | ----------------------------------------------- |
| `brain/**`                           | Human only        | create, update, delete | CODEOWNERS + human gate in MR                   |
| `openspec/changes/**`                | Agent or human    | create, update         | None — flight zone                              |
| `openspec/changes/*/brain-drafts/**` | Agent (draft)     | create, update         | None — proposal zone                            |
| `openspec/changes/archive/**`        | Agent or human    | create (on archive)    | None                                            |
| `openspec/specs/**`                  | Agent or human    | create, update         | `npm run brain:repo:check` validates references |
| `.memory/records/**`                 | Agent or human    | create (append-only)   | One content-addressed record per file (ADR-0017 A2); corrections are new records with `supersedes`; never edited, never deleted (`memory-backend-contract.md`) |
| `scripts/**`, `package.json`         | Agent or human    | create, update, delete | `npm run brain:repo:check`                      |
| `.gitlab-ci.yml`, `settings.xml`     | Human recommended | update                 | Requires issue + MR (not mechanical)            |

**Golden rule:** if the destination is `brain/`, the signature is human. Everything else may
originate from an agent, always with issue + MR as the delivery unit.

## 4. Semantic conflict protocol in Engram

Engram may accumulate contradictory observations across sessions — for example,
a "Spring prohibited" decision coexisting with "Spring Boot as target" before
ADR-0007 was formalized.

This protocol does not depend on proprietary harness APIs (confidence scores,
`judgment_id`, `mem_judge`). Authority is determined by **observation type**,
**declared authorship**, and **explicit supersession in the content** — all of it
readable without the harness active.

### Provenance convention in observations

Every observation saved in Engram must declare in its content:

| Field         | Format                                 | Example                                                                   |
| ------------- | -------------------------------------- | ------------------------------------------------------------------------- |
| **Actor**     | First line of body                     | `**Actor:** @crinaldi (humano)` / `**Actor:** claude-sonnet-4-6 (agente)` |
| **Source**    | Reference to issue/MR if applicable    | `**Fuente:** issue #78 / MR !72`                                          |
| **Supersede** | Only if it replaces something previous | `**Supersede:** observación anterior "Spring prohibido"`                  |

This convention lives in the content — it is portable to any harness.

### How to detect conflicts

```bash
# Listar observaciones candidatas a revisión
mem_review --action list --project <your-project>
```

Observations with `needs_review` status are candidates. If `mem_review` is not
available, look for observations with type `architecture` or `decision` whose content
contradicts the project's active ADRs.

### Resolution criteria

| Condition                                                                              | Action                                                                                       |
| -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Type `architecture`, `decision`, or `policy` in conflict                               | **The human decides** — the agent presents both versions and waits for explicit confirmation |
| One observation declares `**Supersede:**` pointing to the other                        | The previous one is marked `needs_review`; the agent continues without escalating            |
| Type `pattern`, `bugfix`, `config`, or `discovery` in conflict                         | The agent resolves by recency (newest wins) unless there is an obvious contradiction         |
| One observation is human-authored and the conflicting one is agent-authored, same type | The human one takes precedence                                                               |

### Resolution authority

The human is the final authority over conflicts of type `architecture`, `decision`, and
`policy`. The resolution is documented with:

1. An explicit `**Supersede:**` declaration in the winning observation
2. If the conflict changes a durable rule: new ADR or correction commit in `brain/`
3. If it is stale context: `mem_review --action mark_reviewed` after
   explicit human confirmation — never automatically

## 5. Memory Synchronization

`npm run brain:day:start` closes the cycle at the start of the workday:

1. **hydrate** (`brain:memory:pull` — `git pull`, then `cli.mjs import`) — `.memory/records/` → the active backend, idempotent by record id (`memory-backend-contract.md` rule 1)
2. **index** (`brain:memory:index`) — re-projects `brain/` doctrine into the active backend, where it supports it
3. **materialize** (`brain:memory:share`) — what the durable layer does not yet hold → `.memory/records/`, and `index.jsonl` rebuilt

A capture made in session is a record first (`npm run brain:memory:save --issue N`, rule 2). Since the feature-PR memory surfaces retired (issue #890, ADR-0034 Amendment 3), this repository sets `memory.lane.enabled: true` and a captured record reaches `main` on the lane's own pull request — never the feature branch, and with nothing to run by hand before pushing.

The **pre-push hook** (`brain/scripts/hooks/pre-push`) checkpoints feature working memory and runs the repository reference/prohibition checks; it no longer runs `brain:memory:share` and holds no `.memory/` check of any kind. `brain:memory:share` remains the backend's own materialization verb (`brain:day:start`'s cycle, or run by hand) — it is simply not invoked from `pre-push` anymore. The hook auto-installs via `core.hooksPath`; `git push --no-verify` remains the emergency escape.

On the memory lane (#862, ADR-0034), a captured record reaches `main` on its own pull request — `memory/<host>-<date>`, built by a collector that never checks out a worktree, merged by tier (`lite`: auto on green; `standard`/`regulated`: a human approval) — never the feature's. The team absorbs it with `npm run brain:memory:pull` or on the next `brain:day:start`, exactly as before; only the PR the record travels on changes. Measured cost of the pre-lane flow this replaces: p50 21.6 h, p90 399.7 h learn→main (#864 baseline, n=350); ratified targets on the lane: p50 ≤ 1 h, p90 ≤ 24 h at `lite` (ADR-0034 L9). The five surfaces that used to make a record ride the feature branch retired in 3.1d (issue #890, ADR-0034 Amendment 3): the caveat above now describes the lane as the only transport, not a pending transition.

The **durable** layer (decisions, anti-patterns) is promoted to `brain/` in Markdown, which is the source of truth; engram is the shared **live** layer. See the consuming project's two-layer memory ADR.
