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
