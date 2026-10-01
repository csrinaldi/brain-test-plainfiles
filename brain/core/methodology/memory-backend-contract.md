# Memory Backend Contract

> **status:** current | **last-reviewed:** 2026-09-08 | **owner:** @crinaldi

> **Purpose:** defines what any memory backend must do so that the durable layer —
> `.memory/records/` — stays the truth and the backend stays a derived index (ADR-0002,
> ADR-0017:13, ADR-0004 Amendment 1). Referenced by ADR-0004 and by the memory 2.0 epic (#864,
> ruling #863). Sibling of `vcs-contract.md`.

The active backend is the team's declaration in `brain.config.json` `memory.backend`, overridable
per machine by `.env` and per run by the process env, both `MEMORY_BACKEND` (`engram` and
`plainfiles`, the second inhabitant #246, are the closed set). There is NO default: with nothing
declared a reader refuses and names the fix (#1165). The ONE resolver is
`brain/scripts/memory/lib/backend-resolve.mjs`. The dispatcher `brain/scripts/memory/cli.mjs` reads that key
and delegates to `brain/scripts/axes/memory/adapters/<backend>.mjs`. Verbs that are
backend-agnostic by nature — `reindex`, `resolve-index`, `audit`, `split-records` — are
dispatched directly and never reach a backend.

---

## The agnosticism test

> **Does it hold under `MEMORY_BACKEND=plainfiles`?**

If a property of memory holds only because one backend's store happens to be shared,
machine-global, or fast, it is not a property of memory; it is a leak of that implementation
into the concept. Same-machine "instant sharing" through engram's global store is the
canonical example: it fails the test, so no doctrine, gate, or slice may rely on it. Under
`plainfiles` the records ARE the backend, and some scenarios pass by vacuity; the memory 2.0
spec's vacuity table names which, and a scenario passes by vacuity out loud, never by being
skipped.

## The three rules

1. **Hydration is idempotent by record id.** Driving the backend's hydration twice through the
   same snapshot of its state yields exactly one row per record id. The arbiter is the test
   *"two hydrations, one snapshot"* (memory 2.0 spec). A backend whose native import inserts
   (engram, v1.17) satisfies the rule by computing its delta against its own state **under
   the hydration guard** (`lib/hydration-guard.mjs`, #820) — that is the adapter's
   implementation of the rule, not a mitigation of a missing one. An upstream upsert mode is
   welcome and not required.
2. **The backend is never the first home of a capture.** A capture is a record before it is
   anything else: built through the format library (`buildRecord`, provenance included),
   appended through the store (`appendRecord` + reindex), and only then projected into the
   active backend. Anything that writes to the backend without first writing a record is a
   **working-memory writer**, not a producer, and its writes are non-durable by definition:
   `share` never exports them.
3. **The backend owns no artifact the durable layer needs.** `session:start`, `brain:memory:share`,
   `brain:memory:pull` and `cli.mjs import` complete, and hydrate the active backend from
   `.memory/records/` alone, when every backend-private file is absent. What a backend needs
   for its own transport — a manifest, a chunk directory, a symlink, a merge driver — lives
   under the adapter's control, is created by the adapter's `setup`, and is never load-bearing
   for a reader of the durable layer. (engram's manifest, chunks, symlink and driver: ADR-0002
   Amendment 1; retirement #864 task 2.4.)

## Required verbs

Each backend exports one function per verb. **Return shapes are normalized**; the dispatcher
never sees a backend-specific field.

| Verb | Signature | Normalized return | Required |
|------|-----------|-------------------|----------|
| `setup` | `({ root }) -> void` | Prepares whatever the backend privately needs (engram: the `.engram → .memory` symlink, the merge driver — both retiring). Idempotent, non-clobbering. Never throws on an already-set-up tree. | **yes** |
| `share` | `({ root }) -> { indexCount, duplicates, ... }` | Materializes what the durable layer does not yet hold and rebuilds `index.jsonl`; returns the accounting (#574) so the caller can say it. Under record-first (#864 task 3.2, `engram` since #874) this commits what is already true: it exports nothing from the backend. | **yes** |
| `hydrate` | `({ root, recordId? }) -> { written, skipped, deferred?, contended? }` | Projects `.memory/records/` into the backend, idempotently (rule 1). With `recordId`, projects that one record — a producer's fast path after its own write. `deferred: true` when hydration could not run (store unreadable, guard contended) with the reason on stderr — never a throw, never a zero that reads as "nothing to do". The single-record form, `hydrate({recordId})`, exists on `engram` as of #874 (3.2); the bulk form is still spelled `pull` (with `git pull`) and `cli.mjs import` (without) — the contract names the operation, those verbs keep their names until #862 settles the lane. | **yes** |
| `save` | `(title, content, { type, project, issue?, supersedes? }) -> { id, file, written }` | The producer path: a record on disk, then `hydrate({recordId})`. **Required on every backend** — a backend without `save` has no record-first capture (D2). **Today**: `engram.save()` mirrors `plainfiles.save()` (provenance #738, `--supersedes` #805) and calls `hydrate({recordId})` as its terminal step, deferring rather than throwing when the backend cannot be reached (#874, 3.2); `brain:memory:save`'s `package.json` pin is removed. `search` stays `unsupportedOp` (R14 scope, unchanged). | **yes** |
| `search` | `(query, opts) -> [{ id, title, ts, ... }]` | Over the durable layer or the backend's index. | no |
| `index` | `({ root }) -> void` | Re-projects `brain/` doctrine into the backend. `plainfiles`: `unsupportedOp` by design (obs #578) — it projects doctrine, not captures. | no |
| `featureCheckpoint` / `featureResume` | see `feature-working-memory-contract.md` | Working memory for a change (`resume.md` and the `brain-feature-*` projection). Non-durable by rule 2. | no |

**Failure discipline** (shared with `vcs-contract.md`): an optional verb a backend does not
implement calls `unsupportedOp(verb, backend)` — loud, named, never silent. A required verb
that cannot run returns `deferred`/`{measured: false, reason}`-shaped results and says why on
stderr; it never returns a zero that a reader could mistake for "done" (the
`evidence-reader-empty-on-failure` class).

## Producers

A **producer** is anything that turns knowledge into a record. The set is open; every
producer is listed here with the four things it declares. A writer that skips the record
(rule 2) is not a producer.

| Producer | Trigger | Provenance from | Write target | Lane | Hydration |
|----------|---------|-----------------|--------------|------|-----------|
| memory CLI — `brain:memory:save` | an agent or human, in session | flags (`--issue`; `--supersedes` with #805), `actor` from `git config brain.actor` (#738, delivered — a configured handle, never a branch; refused when unset) | the invoking checkout's `.memory/records/` | #862 memory lane (until it exists: the slice PR, as today) | `hydrate({recordId})` (#874) |
| cold-review poster — `brain/scripts/review/poster.mjs` (#851 slice 1) | each posted review round | the reviewer identity; `issue`, `pr`, `rev`, `head_sha`, `verdict`; `supersedes` = the previous round's record | the **invoking** checkout's `.memory/records/`, never the cold `/tmp/brain-review-<sha>` tree | #862 memory lane, never the PR head (a verdict pins `head_sha`, ADR-0026 Amendment 5); ships after #864 task 3.1a | next hydration today; `hydrate({recordId})` with #874 |

Adding a producer is a row here and a slice ticket under #864 — never a new write path into
the backend. The `type` a producer emits is owned by `memory-format.md`'s enum; a producer
whose type is not in the enum is refused by `validateRecord` until the enum is promoted
(Tier 2).

## Deletion

Rows in the backend are a derived index: removing one is not removing memory. The adapter
MAY delete its own rows for reconciliation (a duplicated key, a working-namespace reset).
**Records are never deleted.** A wrong record is corrected by a new record carrying
`supersedes` (#805) — the only correction the durable layer admits.

The correction is record-first, in this order: (1) `brain:memory:save --supersedes <id>` writes the
correcting record; (2) the lane ships it — `brain:memory:share` or the record-first save path
materializes it into the active backend; (3) the stale record is left untouched in
`.memory/records/` — nothing is edited or removed; (4) `brain:memory:reindex` regenerates
`.memory/index.jsonl` from records alone, so the correction is visible to every reader that
walks the index.

## Conformance

| backend | rule 1 | rule 2 | rule 3 | `save` |
|---------|--------|--------|--------|--------|
| `plainfiles` | by construction (`hydrate` is `rebuildIndex`) | by construction | by construction | yes |
| `engram` | delta under guard (#820) — three pre-guard rows await the one-time heal (#864 task 1.2a) | yes — `share()` no longer exports; closed by #864 task 3.2 (#874, split B) | **not yet** — manifest, chunks, symlink, driver; closes with #864 tasks 2.3/2.4 | yes |

The exit of memory 2.0 (#864 task 6.1) re-runs the spec's scenarios under both backends;
this table is updated by the slice that turns a "not yet" into a "yes".

## How to add a backend

1. Create `brain/scripts/axes/memory/adapters/<name>.mjs` exporting the four required verbs and
   `unsupportedOp` for the optional ones you do not implement.
2. Add the `case` in `brain/scripts/memory/cli.mjs`.
3. Add its row to *Conformance* and prove rules 1–3 with the memory 2.0 spec's scenarios
   under `MEMORY_BACKEND=<name>` — the agnosticism test is the acceptance filter.
4. If the backend needs a private artifact in the tree, its `setup` creates it, `.gitignore`
   hides it, and no reader of `.memory/records/` ever depends on it.

## Amendment 1 — `save` column flip: engram.save() is a record-first producer (issue #874, split A)

**Signed**: 11/09/2026 — Cristian Rinaldi

### What this does NOT change

Rule 2 ("a capture becomes a durable record before the backend is touched")
stays `not yet` for `engram` — `share()` still runs `engram sync --export` →
read the chunks it just wrote → scrub → dual-write until split B (`#874`,
`Closes #874`) reshapes it into the `plainfiles.share()` mirror. Rule 3 (the
backend's binary/private files may be absent) is untouched by this amendment
too. This amendment closes exactly ONE cell: the `save` column's `unsupportedOp`
→ `yes`, because `save` is a standalone verb whose own requirement (D2: "a
backend without `save` has no record-first capture") is now satisfied on
`engram` independently of rule 2's `share()`-side gap.

### What landed (split A)

- `engram.save()` (`brain/scripts/axes/memory/adapters/engram.mjs`) is no longer
  `unsupportedOp` — it mirrors `plainfiles.save()`'s gate order (caller-mistake
  refusals → actor/provenance #738 → `--supersedes` #805 → `buildRecord` →
  secret scan → `appendRecord` → `rebuildIndex`) and adds ONE new terminal
  step: `hydrate({root, recordId, record})`.
- `hydrate({recordId})` (new export on `engram.mjs`) projects exactly one
  record into the active engram store via ONE `engram save --topic <id>` call,
  under the `#820` hydration guard, non-blocking. Binary absent, a non-zero
  exit, or a contended guard all **defer** (`{deferred: true, reason}`,
  reported on stderr) rather than throw — the record is already durable by the
  time `hydrate` runs, so a backend failure here can never read as a lost
  capture.
- `package.json`'s `memory:save` script no longer pins `MEMORY_BACKEND=plainfiles`
  — `save` is reachable, and durable, under every backend now.
- `search` is UNCHANGED — still `unsupportedOp` on `engram` (R14 scope; engram
  already has a native `mem_search`).

### Measured (R7 probe, split A)

`engram save --topic <id>` **upserts** by `topic_key` (measured against the
installed binary, v1.20.0, in an isolated temp store — see this change's
`apply-progress.md`). Re-hydrating one record therefore leaves exactly one row,
which is what makes `hydrate({recordId})`'s idempotence claim (rule 1) provable
rather than assumed.

## Amendment 2 — rule 2 flip: engram.share() no longer produces (issue #874, split B)

**Signed**: 11/09/2026 — Cristian Rinaldi

### What this does NOT change

Rule 1 (hydration idempotent by record id) and rule 3 (no backend artifact is
load-bearing for the durable layer) are untouched by this amendment. Rule 3
stays `not yet` for `engram`: the `.engram → .memory` symlink, the manifest,
the chunk directory and the merge driver are all still present and still
matter to `setup()`/`pull()` — their retirement is epic task 2.4, not this
change. The `save` column (Amendment 1) is untouched here too.

### What landed (split B)

- `engram.share()` (`brain/scripts/axes/memory/adapters/engram.mjs`) is now the
  `plainfiles.share()` mirror: `_ensureSymlink(root)` → `rebuildIndex()` →
  `{indexCount, duplicates}`. It no longer calls `requireEngram()`, runs
  `engram sync --export`, reads observations from chunks, scans chunks for
  secrets, or dual-writes candidate records — every one of those surfaces
  (ledger rows 1, 2 and 4) is deleted.
- `dualWriteRecords()` — the function rule 2 used to route observations
  through — is UNCHANGED in shape and still exported (ratified O1,
  2026-09-11): `share()` simply no longer calls it. Its disposition (keep,
  reshape, or delete) is handed to epic task 2.4, alongside the rest of the
  chunk estate, unless task 1.2a claims it first as its one-shot heal tool.
- `engram.share.test.mjs` (ledger row 5) is replaced with a ~90-line suite
  modelled on `plainfiles.share.test.mjs`, including a source guard asserting
  `share()`'s own body names none of the retired seams
  (`requireEngram`/`_export`/`_readObservations`/`dualWriteRecords`).
- Completes with the `engram` binary ABSENT (rule 3's own "may be absent"
  clause, now also true of rule 2's producer path): there is nothing left in
  `share()` that touches the binary at all.
