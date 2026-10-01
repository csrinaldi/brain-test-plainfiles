# Knowledge Base

Entry point for the living documentation of this project.
Start here and follow the links to reach every durable document.

---

## Generic core (`brain/core/`)

Reusable documentation distributed by brain — applies to any project that adopts
this system. `brain/core/` is upstream and treated as read-only here.

### Methodology

- [Consolidation protocol](core/methodology/consolidation-protocol.md) — how generic improvements flow upstream
- [Agent authorities](core/methodology/agent-authorities.md) — what AI agents can and cannot do
- [Harness contract](core/methodology/harness-contract.md) — abstract SDD verbs any harness must implement
- [SDD canonical layout](core/methodology/sdd-layout.md) — normative openspec/changes/** layout: naming, required artifacts, operational artifacts, single-source accessor
- [VCS contract](core/methodology/vcs-contract.md) — abstract VCS verbs any provider must implement
- [Memory backend contract](core/methodology/memory-backend-contract.md) — the four required verbs, three rules and the agnosticism test any memory backend must satisfy
- [Feature-working-memory contract](core/methodology/feature-working-memory-contract.md) — resume.md schema + checkpoint/resume verbs
- [Memory record format](core/methodology/memory-format.md) — the brain-owned durable .memory/ record format
- [Workflow governance](core/methodology/workflow-governance.md) — invariants, CI gates, lockout recovery
- [Reviewer protocol](core/methodology/reviewer-protocol.md) — the cold external reviewer as doctrine: three structural locks, the reviewActors/approvalActors split, COMMENT-only port verbs, brain-review/1 verdicts

### Anti-patterns (generic)

- [Anti-patterns index](core/anti-patterns/README.md) — indexes every generic anti-pattern

---

## Project knowledge (`brain/project/`)

Decisions and domain knowledge specific to this project, added as it grows.

### Architecture decisions

---

> Active changes → `openspec/changes/`
> Durable decisions → `brain/project/decisions/`
