# Feature-Scoped Working Memory Contract

> **status:** current | **last-reviewed:** 2026-06-26 | **owner:** @crinaldi

> **Purpose:** documents the backend-agnostic `resume.md` schema and the
> `feature-checkpoint` / `feature-resume` verb contract. Establishes what
> MUST and MUST NOT appear in `resume.md`. Referenced by the feature-scoped working memory ADR.

Feature working memory is the second memory layer in brain's two-layer model
(the two-layer durable memory ADR + the feature-scoped working memory ADR). It carries the in-flight state of a multi-slice feature
across machines and sessions. The contract is intentionally backend-agnostic:
the source of truth is a plain committed file (`openspec/changes/<feature>/resume.md`)
that is readable with `git clone` and a text editor — no engram, no Node.js, no
YAML parser, and no network access required.

---

## `resume.md` — the committed source of truth

Lives at `openspec/changes/<feature>/resume.md`, committed on the feature branch.
Format: YAML frontmatter (machine-parseable thin pointer) + free prose body
(human narrative). Example:

```markdown
---
feature: feature-working-memory
checkpointed_at: 2026-06-26T20:55:00Z
checkpointed_from: hostname-A/feat/s1-working-memory-contract
current_slice: "Slice 2 — engram backend impl"
next_action: "Write the featureResume() projection-loop test (TDD red first)"
blockers:
  - "engram sync --export project-scoping unconfirmed — validate before relying on it"
in_flight_decisions:
  - "resume.md is primary; apply-progress engram obs is best-effort enrichment only"
  - "active feature resolved from the single openspec/changes/<X>/ dir, not the branch name"
---

## Where I am

Free prose. The 'pick up where I left off' narrative a human or agent reads first.

## Notes

Anything that does not fit a frontmatter field.
```

### Frontmatter fields

| Field | Type | Required | Semantics |
|-------|------|:--------:|-----------|
| `feature` | string | recommended | Change-folder name; the identity key. Matches the directory name under `openspec/changes/` (e.g. `feature-working-memory`). |
| `checkpointed_at` | string (ISO-8601 UTC) | — | Timestamp stamped by `feature-checkpoint`. Do not edit manually — it will be overwritten on the next checkpoint. |
| `checkpointed_from` | string | — | `hostname/branch-name` at checkpoint time. Provenance for tracing which machine last committed the resume. |
| `current_slice` | string | **yes** | Free-text label of the slice currently in progress (e.g. `"Slice 2 — engram backend impl"`). Updated by the working agent when the slice changes. |
| `next_action` | string | **yes** | The single most important thing to do next. Imperative, one sentence. Updated by the working agent at session close or when the intent changes. |
| `blockers` | string[] | **yes** | Ordered list of blockers. An empty array (`[]`) means unblocked. Must be an array — validated by `scripts/memory/lib/resume-schema.mjs`. |
| `in_flight_decisions` | string[] | optional | Decisions made mid-flight that have not yet been distilled into an ADR. Omit or use `[]` when none are pending. |

All seven fields may coexist. Only `current_slice`, `next_action`, and `blockers` are
validated at checkpoint time. The remaining fields are informational.

### Minimal valid skeleton

```yaml
---
feature: <change-folder-name>
current_slice: "Slice N — <description>"
next_action: "<imperative description of the single next step>"
blockers: []
---
```

### Zero-tooling read guarantee

A `git clone` + any text editor is sufficient to recover the full resume point.
No engram, no Node.js, no YAML parser, and no network access are required.
The YAML is plain enough to skim by eye. This is the recovery path when
the local engram store is absent (fresh clone, new machine, CI environment).

---

## What MUST NOT appear in `resume.md`

- **Per-task or per-slice progress** (checkboxes, completion percentages, done/not-done
  flags). That state has one source of truth: `openspec/changes/<feature>/tasks.md`
  checkboxes. Duplicating it in `resume.md` creates a second, drifting copy.

- **Secrets, keys, credentials, or PII.** `resume.md` is committed to the feature
  branch and pushed to remote. Treat it as public-readable content.

- **Content that belongs in an ADR.** Distill decisions into your project's decisions folder at close time via `sdd-archive`. `resume.md` is ephemeral;
  it never merges to `main`.

---

## Verb contract

Two symmetric verbs dispatched via `scripts/memory/cli.mjs`, alongside the existing
`index` / `share` / `pull` / `setup` verbs:

```
feature-checkpoint [feature]   # dehydrate: stamp + validate + ensure resume.md is committed before push
feature-resume     [feature]   # hydrate:   project openspec/changes/<feature>/* into the LOCAL backend store
```

npm aliases (mirrors the `memory:*` pattern):

```json
"feature:checkpoint": "node ./scripts/memory/cli.mjs feature-checkpoint",
"feature:resume":     "node ./scripts/memory/cli.mjs feature-resume"
```

### Active-feature resolution (deterministic precedence)

1. **Explicit `[feature]` argument** — validate `openspec/changes/<feature>/` exists; error if not.
2. **No argument, exactly one** `openspec/changes/*/` directory (excluding `archive/`) — use it.
3. **No argument, more than one** directory — inspect each for `resume.md`:
   - **Exactly one** dir has `resume.md` → use it (the actively-worked feature).
   - **More than one** dir has `resume.md` → error: `"ambiguous active feature, pass [feature]"` + list of dirs with `resume.md`.
   - **Zero** dirs have `resume.md` → error: `"ambiguous active feature, pass [feature]"` + list of all dirs.
4. **No argument, zero** directories — informational message, exit 0. Never crash.

The `resume.md` file serves double duty: it is the checkpoint payload AND the signal that a
feature directory is the currently active one when multiple changes coexist. Only the
directory the agent is actively working on should have a `resume.md` at any given time.

Branch names are NOT used for resolution. `feat/issue-12-working-memory` is a branch name;
`feature-working-memory` is a change-folder name. They are structurally different and must
not be coupled.

### `feature-checkpoint` guarantees

- Reads the current `resume.md`, or creates a skeleton if absent.
- Re-stamps `checkpointed_at` (now, UTC ISO-8601) and `checkpointed_from` (`hostname/branch`).
- Validates the frontmatter shape via `validateResume()` from `scripts/memory/lib/resume-schema.mjs`.
- **Does not** call `engram save`, `engram sync`, or any child process. Pure filesystem write.
- Best-effort engram enrichment (folding `sdd/<feature>/apply-progress` into empty fields)
  is wrapped in `try/catch` — never fatal; never required.
- With no resolvable feature: informational message, exit 0. Must never break the pre-push path.

### `feature-resume` guarantees

- Projects `openspec/changes/<feature>/*.md` into the **local** backend store (one save per file).
- Feature observations are stored under a **distinct project namespace** (not the durable
  `brain` project) to prevent leakage into the export that `brain:memory:share` writes to `.memory/`.
- If `resume.md` is absent: prints "no resume point", exit 0.
- Projection is a session-start ritual; it is **never called** from the pre-push hook.
- If the backend binary is absent: degrades to printing `resume.md` content directly; exit 0.

---

## Schema validation module

`scripts/memory/lib/resume-schema.mjs` provides the backend-agnostic validator:

| Export | Type | Description |
|--------|------|-------------|
| `REQUIRED_FIELDS` | `string[]` | `['next_action', 'current_slice', 'blockers']` |
| `validateResume(frontmatter)` | `(object) => void` | Throws with the offending field name on violation. Pure function — no IO, no side effects. |

Callers wrap `validateResume()` in `try/catch` to degrade gracefully on a malformed file.
A YAML parse error upstream should also degrade to prose-only treatment, never a crash.

---

## References

- The feature-scoped working memory ADR — the architectural decision this contract documents.
- The two-layer durable memory ADR — the durable layer this is separated from.
- The memory adapter ADR — the backend-agnostic dispatch discipline this mirrors.
- `scripts/memory/lib/resume-schema.mjs` — validator implementation (Slice 1).
- `scripts/axes/memory/adapters/engram.mjs` — engram implementation of the verbs (Slice 2).
