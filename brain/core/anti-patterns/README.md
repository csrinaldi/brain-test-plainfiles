# Anti-patterns — Append-only team knowledge

> Promotion destination for **Moment 3** described in
> [`../methodology/consolidation-protocol.md`](../methodology/consolidation-protocol.md).

## What lives here

Technical anti-patterns discovered during development that apply to **multiple
microservices** or that resolve a critical compatibility bug (e.g.: Jakarta JSON
serialization). Not micro-decisions for a single feature — those live in the
corresponding sub-task in `openspec/changes/[change-id]/tasks.md` until they are
consolidated.

## Rules

1. **Append-only.** An existing file is never rewritten; a new one is added or an
   entry is appended. The history is the value.
2. **One anti-pattern per file.** Descriptive naming: `serializacion-jakarta-json.md`,
   `guice-singleton-eager.md`.
3. **Promoted in the MR**, within the same commit as the code that discovered it —
   before removing _Draft_ status.
4. **Indexed** with `npm run brain:memory:index` whenever the durable knowledge in `brain/`
   needs to be re-projected into engram.

## Suggested format per entry

```markdown
# <Anti-pattern name>

- **Discovered in:** ISSUE-<id> / <microservice>
- **Applies to:** <which modules/services>

## Symptom

<How it manifests — the observable error or behavior.>

## Cause

<Why it happens, technically.>

## Solution / correct pattern

<What to do instead, with a minimal example.>
```

## Registered

Navigable index — add an entry here when promoting a new anti-pattern
(required by the `brain:nav` check in CI: no doc may be left orphaned).

- [config.yaml mixes sequence and mapping (invalid YAML tolerated by the harness)](config-yaml-seq-map-mezclados.md)
- [git diff does not see untracked files](git-diff-no-ve-untracked.md)
- [AI writes to `brain/` without a human gate](ia-escribe-brain-sin-gate.md)
- [AI that promotes its own artifacts](ia-promueve-sus-propios-artefactos.md)
- [Self-updating installers are not innocuous](instaladores-autoactualizantes-no-inocuos.md)
- [Pre-v0.8.0 upgrader clobbers consumer identity and locks out future upgrades](pre-v0-8-0-upgrade-clobber-lockout.md)
- [Evidence reader returns empty on failure (fail-open in REQUIRED gates)](evidence-reader-empty-on-failure.md)
- [The red-proof is blind along an axis the mutation never varies](red-proof-blind-along-an-unvaried-axis.md)
- [A test spawns a live entrypoint and trusts configuration to keep it harmless](test-spawns-a-live-entrypoint.md)

> Only generic harness anti-patterns. Project-specific ones (stack, infra,
> domain) are indexed by the consuming project separately — `core/` does not reference `project/`,
> so it can be extracted autonomously.
