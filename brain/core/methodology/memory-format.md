# Durable Memory Record Format (`.memory/records/`)

> **status:** current | **last-reviewed:** 2026-08-05 (issue #404: the `**Fuente:**` line is
> declared the shared wire slot for `issue` + `source`; `source` is one line) | **owner:** @crinaldi
> **governed by:** ADR-0017
> (brain owns the durable format) · ADR-0002
> (two-layer durable/live memory) · ADR-0004
> (memory-backend adapter)

## Purpose

Define the **normative, tool-independent** on-disk format of brain's *durable* memory layer,
so that team knowledge is recoverable with nothing but `git clone` and a text editor — the
literal promise of ADR-0002.
This format is owned by brain and is **independent of engram's gzip chunk transport**. The
format library, its validator, and the engram↔record migration are out of scope here (slices
C1–C4); this document is the contract they implement.

## Layout

```
.memory/
  records/
    2026-07-rec-0004371da1717b3d.jsonl   # one record, one file, one line
    2026-07-rec-00599b20655216d6.jsonl
    2026-06-rec-02301d83082c52e8.jsonl
  index.jsonl            # derived, regenerable, committed — a query accelerator, never authoritative
```

- **`records/<yyyy-mm>-<id>.jsonl`** — the **source of truth**. **One record per file** since
  #677: the content-addressed `id` IS the filename, with the month kept as a prefix so the log
  still sorts and greps by month. Append-only: a record is never edited or deleted in place;
  corrections are new records with `supersedes`. A record MUST occupy **exactly one physical
  line**: because `content` is Markdown and may contain newlines, those newlines MUST be escaped
  (`\n`). This is a hard requirement — it is what keeps a record recoverable line-by-line, and
  what keeps the union driver safe on the one case it still resolves; the validator rejects any
  multi-line record.

  **Readers accept both layouts, and always have.** Every reader globs `*.jsonl` under
  `records/` and parses line by line, so a store still holding `<yyyy-mm>.jsonl` month files, a
  store split into per-record files, and any mixture of the two read identically. `.memory/**`
  is consumer-owned, so brain never rewrites it on upgrade: a repository moves to the new layout
  by running `brain:memory:split-records`, and one that does not keeps working exactly as before —
  it just keeps the merge conflict the split removes.
- **`index.jsonl`** — **derived** from the records and regenerable via a future `brain:memory:reindex`.
  It is committed for zero-tool querying and as the materialized dedup surface, but it is never
  the truth. If it is lost, deleted, or conflicts, it is rebuilt from `records/`.

## The record schema (normative)

Each line of a `records/<yyyy-mm>-<id>.jsonl` file — one line, since #677 — is exactly one JSON
object:

| Field | Type | Req | Meaning |
|-------|------|-----|---------|
| `id` | string | ✅ | `"rec-" + sha256(canonicalJson(hashInput))[:16]` — a **content hash**. See "Identity". |
| `ts` | string | ✅ | ISO-8601 UTC, `YYYY-MM-DDTHH:MM:SSZ`. Must carry the `Z` (UTC) — no naive local timestamps. |
| `actor` | string | ✅ | Stable handle of the author (`@crinaldi`, `@claude-sonnet-4-6`). **A handle, never PII.** |
| `actorKind` | string | ✅ | `"human"` \| `"agent"`. |
| `type` | string | ✅ | One of `decision` \| `architecture` \| `pattern` \| `bugfix` \| `config` \| `discovery` \| `session_summary`. |
| `project` | string | ✅ | Owning project (`brain`). |
| `issue` | number | ⬜ | Issue/MR number the record originates from. |
| `supersedes` | string | ⬜ | `id` of a record this one replaces (see [consolidation-protocol](consolidation-protocol.md) §4). |
| `content` | string | ✅ | The memory body, Markdown. |
| `source` | string | ⬜ | Free-form provenance, **one trimmed line** (`"PR #405"`). See the warning below. |

Provenance fields (`actor`, `actorKind`, `issue`, `supersedes`, `source`) are the structured
form of the [consolidation-protocol](consolidation-protocol.md) §4 Actor / Source / Supersede
convention — the same meaning, promoted from prose inside `content` to first-class fields.

> ⚠️ **A `source` that cites `issue #N` while `issue` is absent is ambiguous on the wire.**
> `issue` and `source` share one `**Fuente:**` line (below), so `{source: "issue #201 / PR #204"}`
> — the shape earlier revisions of this document used as the `source` example — emits a line
> byte-identical to the one `{issue: 201}` emits, and re-imports carrying an `issue` it never
> had, under a different `id`. Nothing rejects it today. Resolving it needs either a new §4
> marker or a validation rule, i.e. a decision: tracked in **issue #461**. Until then, set
> `issue` explicitly whenever `source` cites one.

## Identity — the content hash

`id = "rec-" + sha256(canonicalJson(hashInput))[:16]`, where `hashInput` is the record's
**semantic** fields in a canonical JSON encoding:

```
hashInput = { type, actor, actorKind, ts, project, issue?, supersedes?, content }
```

- **Canonical form is pinned to RFC 8785 (JSON Canonicalization Scheme, JCS).** Stable key
  ordering is only one axis; whitespace, number encoding, string escaping, and Unicode/UTF-8
  encoding all change the hashed bytes. `canonicalJson` MUST be **RFC 8785 JCS**: keys sorted by
  UTF-16 code-unit order, no insignificant whitespace, minimal number encoding, JCS string
  escaping, UTF-8 serialization. This is normative — canonicalization is not left to the
  implementation's choice.
- **Deterministic across machines — and its `ts` dependency.** The same semantic record
  materialized on two branches / two machines produces the **same** `id`, which is what lets a
  re-imported duplicate collapse (below). Because `id` includes `ts`, this holds only if `ts` is
  itself deterministic. Engram's timestamps are timezone-less, so the migration MUST apply **one
  canonical rule: engram's timezone-less timestamps are treated as UTC.** Under that rule, `ts`
  taken from the source observation's `created_at` is stable across machines that materialize the
  same source, so the hash is stable too. (Records **authored fresh** on two branches take
  different wall-clock `ts` and correctly get different `id`s — they are distinct memories, not a
  duplicate.)
- **Random ids are forbidden.** A UUID would make a record that both branches wrote an
  *invisible* duplicate after a union merge. The content hash makes it a *detectable,
  collapsible* one.
- **Uniqueness = semantic identity.** Two records with an identical `hashInput` are, by
  definition, the same record and share an `id`. `index.jsonl` is keyed by `id`.
- `source` is **excluded** from the hash: it is incidental provenance and must not split one
  logical record into two ids when two writers cite it slightly differently.
- **Absent optionals are omitted, never `null`.** Optional fields (`issue`, `supersedes`,
  `source`) that are absent MUST be omitted from the record **and** from `hashInput`, NEVER
  serialized as `null`. RFC 8785 canonicalizes `{}` and `{"issue":null}` to **different** bytes →
  a different `id` → a silent dedup break, so the validator MUST reject a record carrying a
  `null` optional field.
- **`source` is ONE trimmed line** (issue #404). It shares the single `**Fuente:**` line with
  `issue` (below), so a newline in `source` pushes its tail into the body: the issue citation
  falls off the Fuente line **and** the hashed `content` gains bytes — two silent `id` drifts.
  Brain refuses to write a multi-line or untrimmed `source`; on read it uses the first trimmed
  line, so a store that already holds one still round-trips rather than becoming unreadable.

## The `**Fuente:**` line — how `issue` and `source` share one wire slot

The engram backend has no field for `issue`, and no free-form metadata slot to put one in
(ADR-0017's 2026-07 finding; re-checked against engram v1.20.0's `observations` schema on
2026-08-05 — 23 columns, all typed and none free-form). Note this is an **engram**
statement: the `plainfiles` backend stores `issue` as a first-class JSON field in
`.memory/records/*.jsonl` and carries it into `index.jsonl`. So on the engram wire `issue`
travels the way `actor` and `supersedes` do: as
[consolidation-protocol](consolidation-protocol.md) §4 prose inside `content`, on the single
`**Fuente:**` line, which carries **both** `issue` and `source`.

That shared slot is normative, and the rule that makes it safe is:

> The rendered Fuente line MUST parse back to the record's own `issue`.

Concretely (`provenance.mjs#renderFuente`): `issue #N` is prepended to `source`'s first
trimmed line unless that line already cites exactly `N` — so ADR-0017's canonical
`"issue #201 / PR #204"` shape is emitted untouched, and re-rendering is a fixed point.

**What that buys, stated with its bound:** `issue` round-trips exactly for every record whose
`issue` is a `number`, which is the type this schema declares. It is worth naming why the
qualifier is there rather than dropped: the read-path validator does not type-check `issue`,
so a hand-edited `issue: "404"` is admitted and returns as the number `404`, a different `id`.
Brain never writes that shape. `source` may widen (it gains the citation) or narrow (a
multi-line one is cut to its first line) — free, because `source` is hash-excluded.

> **Why this is written down.** The original design recorded the belief that "the source/issue
> render asymmetry is inert, since `source` is excluded from the hash". That was true of
> `source` and false of `issue`, and the renderer let `source` win the line outright — so every
> record carrying both fields silently lost its `issue` and re-hashed to a different `id`. The
> round-trip contract was green only because no producer had ever populated the field
> (0/2157 records at the time of the fix).

## Concurrent-append merge policy

Two branches (or two actors) capturing memory in parallel used to collide on the trailing region
of the same `records/<yyyy-mm>.jsonl` — a textual conflict on every merge after the first, and
the reincarnation of the ADR-0002 manifest problem. It is resolved structurally, and since #677
by the LAYOUT rather than by a merge driver:

1. **One record per file** (#677). A record is written to `records/<yyyy-mm>-<id>.jsonl`, so two
   branches capturing different records write two different paths and git merges them with no
   driver, no attribute and no configuration. There is nothing to union.

   `records/*.jsonl` still carries git's built-in `merge=union` in `.gitattributes`, **demoted
   to a convenience**: a `.gitattributes` merge driver is a LOCAL mechanism, and the merge that
   lands work in this repository is performed by the forge's merge button, which does not apply
   it. The old policy was therefore conflict-free everywhere except where it was needed. What
   the attribute still earns is the one residual case below — a same-`id` pair whose bytes
   diverge — which it turns into a two-line file the reindex deduplicates and reports instead of
   a conflict. It must not be cited as making the log conflict-free.

   **The residual conflict, named:** two branches writing the same `id` with divergent bytes are
   the same filename with different content, and that conflicts where the driver is absent. It
   is confined to one file holding one record, and both sides of it are the same record by
   construction — `id` hashes the meaning. The month layout put every record in the file at the
   mercy of the same resolution.
2. **Content-hash `id`** (above) makes the same record identical across branches.
3. **Dedup at reindex.** Union's one failure mode is a duplicated physical line when both
   branches wrote the same record. Repeated lines share an `id`, so `index.jsonl` (keyed by
   `id`) collapses them — **first-wins**, the earliest line of the earliest month file, which is
   what the read path already resolved to — and the collapse is **REPORTED**, never silent
   (#574/#598).

   They are **not necessarily byte-identical**. `id` hashes the record's meaning and excludes
   `source` as incidental provenance, so brain's own export→import→export returns the same `id`
   with widened bytes. Such a pair is **divergent**: counted on its own channel and resolved
   first-wins, never refused — refusing it would refuse records brain itself writes. See
   `store.duplicates.test.mjs::roundtrip-divergence`.

   Refusal is reserved for a line whose bytes do not hash to its own `id` (tampered or stale);
   that gate is unchanged and fail-closed. The JSONL stays **strictly append-only** — never
   rewritten — which preserves union safety and a clean `git log .memory/records/`. The index,
   not the log, is the dedup authority.

> A rare duplicate physical line survives in the JSONL until the next reindex. This is
> deliberate: queries read through the index (deduped), and rewriting the log to remove a
> duplicate would break append-only and union safety. `wc -l` over-counting is the accepted
> price.

**Rejected alternatives.** *Per-actor sharding* (`records/<yyyy-mm>-<actor>.jsonl`) avoids
distinct-actor conflicts but fragments the layout, complicates reindex/query with a merge-sort,
still conflicts on same-actor-two-branches, and leaks actor identities into filenames (a
public-repo concern). *Manual conflict resolution* reintroduces the ADR-0002 pain on a
machine-generated log and does not scale to parallel agents.

**Adopted instead (#677):** *one file per record* — the shape sharding was reaching for, keyed
by the content hash rather than by the actor. It answers every objection above: the filename is
a hash, so no identity leaks; no merge-sort is needed, because the ids ARE the filenames and the
index is already stable-ordered by `id`; and same-actor-two-branches does not conflict, because
two different records are two different files. See ADR-0017 Amendment 2 for the full comparison
and the measurements.

## `index.jsonl` — derived, regenerable, low-churn

`index.jsonl` maps each `id` to its lookup metadata (`ts`, `actor`, `type`, `project`, `issue`,
`supersedes`, and the `records/<yyyy-mm>-<id>.jsonl` file it lives in). It is:

- **Derived** — the inverse of ADR-0002's *authoritative* manifest. The records are the truth;
  the index is rebuilt from them by `brain:memory:reindex`. Losing or conflicting on the index is a
  no-op — regenerate it.
- **Serialized one entry per physical line, sorted by `id`, deterministically.** This is
  normative. Because `id`s are content hashes, parallel insertions distribute **uniformly**
  across the sorted file, so git's ordinary 3-way merge auto-resolves most parallel appends
  cleanly and a true conflict is reduced to the occasional adjacent-line insertion — not the
  common case. A compact single-line `JSON.stringify` would instead conflict on every parallel
  merge, making the discard+reindex fallback routine rather than rare. The conflict ergonomics
  MAY be a helper or a post-merge hook, but MUST NOT require a **custom merge driver for
  `index.jsonl`** (a per-clone `.git/config` registration — the engram-driver friction this format
  eliminates). `records/*.jsonl` still declares the built-in `merge=union` and it needs no
  per-clone registration — but since #677 that is not why the records log is safe: a merge
  driver, built-in or custom, is applied by the git that performs the merge, and the forge's
  merge button applies neither. The answer for `index.jsonl` is regeneration; the answer for
  `records/` is the layout. That helper is **`npm run brain:memory:resolve-index`** (issue #330), and it is layered
  in exactly that order: the command is the unit of truth and works in every clone with **zero
  installation**, while the `post-merge` hook is a thin, non-blocking caller of the same command
  and holds no resolution logic of its own.
- **Excluded from the union driver.** The `merge=union` policy is scoped to `records/*.jsonl`
  ONLY; the `.gitattributes` glob deliberately EXCLUDES `index.jsonl`. **Corrected rationale
  (C1b, issue #214 — the original "single JSON object" framing (now removed) was stale the
  moment R1 fixed the index as one-entry-per-line JSONL):** a reindex REPLACES and REORDERS the index's
  lines on every run (stable-sorted by `id`), so a line-based union of two independently
  regenerated indexes would concatenate both sides' now-superseded snapshots — producing
  duplicate and stale entries, not a clean merge. The index is fully regenerable from
  `records/`, so a git merge conflict on `index.jsonl` is resolved by **discarding both sides and
  regenerating from `records/`** — it is NEVER hand-merged and NEVER union-merged.
  `npm run brain:memory:resolve-index` is that resolution as one command: it discards the conflicted
  working-tree file, regenerates the index (the same `rebuildIndex()` that `brain:memory:reindex` runs),
  and `git add`s the path **only if** git still reports it unmerged — so the operator finishes the
  merge with `git commit` and no judgment call, and a hook-triggered call on an already-clean tree
  normalizes the file while staging nothing.

  It fails **closed**: if any `records/*.jsonl` carries conflict markers it refuses and leaves the
  index untouched, because the index is derived from that log and regenerating over a conflicted
  one would bake the markers in and report success.
- **Low-churn** — `brain:memory:reindex` / `brain:memory:share` **MUST NOT produce whole-file churn in the
  index**. Entries are stable-ordered by `id`; a reindex adds/updates only entries for newly
  appended records and leaves every other entry byte-identical, so `git diff index.jsonl` is
  proportional to the new records, not to the store size. This is the direct lesson of the
  ADR-0002 manifest churn that rewrote the full file each `brain:memory:share` and blocked a raw
  `git pull`.

  **The rule is about the DIFF, not the write.** `rebuildIndex` regenerates the whole file from
  `records/` rather than patching it, and always has, so a literal reading of "rewrite" was never
  satisfied by any implementation. What stays proportional is what `git diff` shows — and it
  does, because the regenerated bytes are identical wherever the records are. The proportionality
  holds while duplicate groups are *intra-file*: a duplicate spanning two month files moves the
  winning entry's `file` field and produces exactly the churn this rule forbids, on a `share`
  that appended nothing. See ADR-0017, Amendment 1 (#635).

## Public-repo exposure — stance

`.memory/records/*.jsonl` is committed plaintext, deliberately readable — that *is* the
durability guarantee. Therefore:

- Actor is a **stable handle**, never an email, legal name, or other PII. `actorKind` is the
  coarse `human|agent` only.
- **`plainfiles.save` capture (#738):** `actor` comes from `git config brain.actor` — a fresh
  clone's first `memory save` is refused, naming the remedy, until you run
  `git config --local brain.actor @<handle>` once. An **agent-driven** capture still carries the
  OPERATOR's handle, never an agent identity (`@claude-code`, `@gemini-cli`, …) — only
  `actorKind: agent` changes, measured from the session's agent-marker environment variable
  (`AI_AGENT` by default, configurable via `git config brain.agentEnv`). The branch a capture ran
  from is never the actor — see `issue`, which derives from it when `--issue` is not given.
- **Only `scope: project` durable knowledge becomes a record.** Engram `scope: personal`
  memories are never promoted — they have no brain home and no place in a shared repo.
- Records hold **development knowledge** (decisions, patterns, discoveries), never secrets,
  tokens, or clinical/patient data. Records are public-by-construction; keeping secrets out is
  the writer's burden. A pre-commit secret-scrubbing hook is a follow-up (slice C1); this
  document fixes the stance that makes it required.
- **Enforcement is partial, not full.** The stance is convention-backed plus a *partial*
  email-shaped `actor` heuristic — the validator can flag `someone@example.com`, but a bare legal
  name as `actor` passes. The enforcing gate is the **C1 secret-scrubbing hook**, not the schema
  validator; full PII/secret enforceability is not claimed for the validator.

## What engram export cannot supply (and what the record drops)

Migrating an engram chunk (see the real shape in
ADR-0017) into a brain
record is lossy in both directions. This enumeration is the migration contract for slice C4.

**Brain fields engram export cannot supply structurally** — they exist only as
[consolidation-protocol](consolidation-protocol.md) §4 prose inside `content`, or not at all:

1. `actor` — no engram field; only the `**Actor:**` prose line. (`session_id` /
   chunk-level `created_by` are not the record author.)
2. `actorKind` — only the `(humano)/(agente)` text; not a field.
3. `issue` — no field; only the `**Fuente:** issue #N` prose (see "The `**Fuente:**` line"
   above — that prose IS the transport, and it carries a `number` `issue` losslessly; the two
   shapes it does not are named there and in issue #461).
4. `supersedes` — no field; only the `**Supersede:**` prose (harness `mem_judge` relations are
   not present in the exported chunk).
5. `source` — same `**Fuente:**` prose.
6. `id` (content hash) — engram's `id` is a **local autoincrement integer** (non-portable across
   machines); `sync_id` is a hash of engram's own shape, not brain's `hashInput`.
7. `ts` (ISO-8601 UTC) — engram timestamps are `"YYYY-MM-DD HH:MM:SS"` (space, no `T`, **no
   `Z`/offset**); the timezone is lost, so a claimed-UTC `ts` is a conversion guess.

**Engram fields with no brain equivalent** — dropped on import:

8. `title` — the record has no title slot. The C4 migration **folds** a non-empty `title` into
   `content` as a bold prefix (`content = "**" + title + "**\n\n" + content`; an empty `title`
   leaves `content` unchanged) — deterministic, so the folded bytes feed the `id` hash
   identically across machines.
9. `scope: personal` — no brain home; must **not** be imported (public-repo stance).
10. `session_id`, chunk-level `sessions[]` / `prompts` — session/prompt grouping is not modeled.
11. `sync_id`, `revision_count`, `duplicate_count`, `last_seen_at`, `updated_at` — engram
    bookkeeping, no equivalent.
12. `type: manual` (and any non-enum type, e.g. the observed `"manual"` "temp search" record) —
    no brain type; must be mapped or rejected by the C4 migration, never silently coerced.
13. `topic_key` — engram's internal upsert/evolution key (e.g. `sdd/x/proposal`) for deduping and
    versioning observations inside engram. No record equivalent: the C4 migration **drops it**
    (it may optionally inform the `supersedes` chain), never coerces it into a record field.

## Relationship to the live layer

Per ADR-0002 /
ADR-0004, the live backend
(engram) remains a *derived index* for semantic search. This format governs the **durable**
layer only. `brain:memory:share` materializes durable knowledge into `records/`; `memory:import`
projects `records/` into the active backend. The gzip chunks are engram's private transport and
are no longer the durable truth.
