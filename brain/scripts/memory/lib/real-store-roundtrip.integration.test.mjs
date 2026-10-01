// real-store-roundtrip.integration.test.mjs — REQ-C4-1 (D1, issue #229 C4):
// the round-trip id-equality contract pinned against the REAL committed
// `.memory/records/*.jsonl` store, not a fixture.
//
// HERMETICITY NOTE (finding-#10 doctrine): reading the real `.memory/records/`
// tree here is a DELIBERATE, DOCUMENTED exception — inject/mock everything
// EXCEPT the one thing this test exists to prove. This test exists to prove
// the round-trip contract holds on the ACTUAL migrated data (135 `@legacy`
// records in 2026-06.jsonl + the rest in 2026-07.jsonl), so reading that real
// tree IS the point, not a hermeticity violation. A future reader must NOT
// "fix" this into a fixture-only test — that would silently stop covering the
// real store and defeat REQ-C4-1 (spec.md, scenario "id-equality over every
// real committed record").
//
// C2a pin (format.mjs:66-82): equality here is `id`/`hashInput` equality, NOT
// byte/field equality. `source` is EXCLUDED from the hash — an `issue`
// record with no `source` still round-trips by id even though re-export
// synthesizes a `**Fuente:** issue #N` line (see the existing synthetic pin
// in engram-import.test.mjs:46-60, extended in spirit here for the real
// store's dominant @legacy shape, which carries `source` but no `issue`).
//
// Degenerate-state contract: an empty/missing `.memory/records/` tree SKIPS
// with an explicit, honest message — never a false green that silently hides
// zero coverage (readRecordObservations() already returns `[]` rather than
// throwing on an absent directory, per store.mjs's contract).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readRecordObservations } from './store.mjs';
import { importRecord } from './engram-import.mjs';
import { exportObservation } from './engram-export.mjs';
import { buildRecord, computeRecordId, validateRecord, validateWritableRecord } from './format.mjs';

// Same depth as engram.mjs's repoRoot (brain/scripts/axes/memory/adapters/engram.mjs):
// this file lives at brain/scripts/memory/lib/, a sibling directory at the
// same depth — four levels up reaches the repo root.
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');
const recordsDir = join(repoRoot, '.memory', 'records');

test('REQ-C4-1: round-trip id-equality holds for every record in the REAL .memory/records/ store', (t) => {
  const records = readRecordObservations({ recordsDir });

  if (records.length === 0) {
    // Real skip, not a false pass — an early `return` is reported as ok/pass by
    // node:test, masking zero coverage. t.skip() makes the gap visible in output.
    t.skip(
      'REQ-C4-1: .memory/records/ is empty or missing — 0 real records exercised. ' +
        'This is a coverage GAP, not a pass.',
    );
    return;
  }

  // #738: a real record whose OWN stored `actor` is branch-shaped now gets a
  // documented A5 soft-reject on re-export (W3, #738) — this is the exact
  // historical population (~183 records, design.md's measured audit) #738
  // exists to stop GROWING, not to backfill (Non-Goals: no `HANDLE_RE`
  // grammar change, no backfill of legacy shapes). Counted and reported
  // separately from a genuine round-trip failure, never silently dropped.
  const failures = [];
  const branchShapeRejections = [];
  for (const record of records) {
    const observation = importRecord(record);
    const { record: exported, rejected, skipped } = exportObservation(observation);
    if (rejected?.reason?.includes('branch-shaped')) {
      branchShapeRejections.push(record.id);
      continue;
    }
    if (rejected || skipped) {
      failures.push(
        `${record.id ?? '(missing id)'}: round-trip was ${rejected ? 'REJECTED' : 'SKIPPED'} — ${JSON.stringify(rejected ?? skipped)}`,
      );
      continue;
    }
    const recomputedId = computeRecordId(exported);
    if (recomputedId !== record.id) {
      failures.push(
        `${record.id ?? '(missing id)'}: recomputed id '${recomputedId}' does not match the stored id`,
      );
    }
  }

  console.log(
    `REQ-C4-1: round-trip id-equality exercised over ${records.length} real records from .memory/records/ ` +
      `(${branchShapeRejections.length} pre-existing branch-shaped-actor records excluded, #738 A5)`,
  );
  // Bound the exclusion bucket (fresh-context review NIT): a regression that
  // widens the "branch-shaped" classification to swallow every record would
  // silently EMPTY `failures` above instead of failing loudly — this pin
  // makes that regression visible instead of quietly turning the test vacuous.
  assert.ok(
    branchShapeRejections.length < records.length,
    `every one of ${records.length} records was classified as branch-shaped-actor and excluded — ` +
      'this empties the failure set silently; the exclusion classifier is almost certainly over-matching',
  );
  assert.deepEqual(
    failures,
    [],
    `${failures.length}/${records.length} real records failed round-trip id-equality:\n${failures.join('\n')}`,
  );
});

test('REQ-C4-1: the @legacy shape (source set, no issue) — the dominant real-store case — round-trips by id', (t) => {
  const records = readRecordObservations({ recordsDir });
  const legacyRecords = records.filter((r) => r.actor === '@legacy' && r.source !== undefined && r.issue === undefined);

  if (legacyRecords.length === 0) {
    // Same reader, same rule as the sibling above: `console.warn` + `return` is
    // reported ok/pass by node:test, and readRecordObservations() returns `[]`
    // for an UNREADABLE store as well as an empty one. (Pre-existing instance
    // of the evidence-reader-empty-on-failure class, found while fixing the two
    // below — the same file, the same reader, the same mistake.)
    t.skip(
      'REQ-C4-1: no @legacy source-without-issue records found in the real store — ' +
        '0 exercised. This is a coverage GAP, not a pass.',
    );
    return;
  }

  const sample = legacyRecords[0];
  const observation = importRecord(sample);
  const { record: exported, rejected, skipped } = exportObservation(observation);
  assert.equal(rejected, undefined, 'the @legacy sample must not be rejected on round-trip');
  assert.equal(skipped, undefined, 'the @legacy sample must not be skipped on round-trip');
  assert.equal(computeRecordId(exported), sample.id, '@legacy source-without-issue round-trips by id');
});

// ── issue #404 — the shape the real store cannot yet demonstrate ────────────
// The store is 0/2157 on `issue` (measured), which is exactly WHY the defect
// survived: the round-trip contract was green over a field no producer had
// ever populated, and the first record to carry it turned REQ-C4-1 red.
//
// The test above can therefore never cover the field from committed data
// alone, and waiting for a producer (#368) to appear would leave the contract
// unexercised in the one direction that broke. So this derives issue-carrying
// records FROM the real store's own records — real content bytes, real
// `source` prose, real timestamps — rather than from a fixture. It is the
// same deliberate real-tree read the header documents, not a second store.
//
// A future reader must NOT relax this to fixtures: a fixture cannot prove the
// field survives the real store's actual `source` shapes (measured 2026-08-05:
// 2125/2157 records carry a `source`, of which 2070 are the `@legacy`
// migration prose, which cites no issue and so exercises exactly the render
// path that used to drop `issue`).

test('REQ-C4-1 / #404: real records re-stamped with an `issue` still round-trip by id', (t) => {
  const records = readRecordObservations({ recordsDir });

  if (records.length === 0) {
    // Real skip, not a false pass. readRecordObservations() returns `[]` for an
    // absent OR unreadable records/ (store.mjs: "NEVER throws"), so an early
    // `return` here would report ok/pass and make "the store is clean" and "the
    // store could not be read" indistinguishable — the
    // evidence-reader-empty-on-failure anti-pattern. Matches the sibling above.
    t.skip(
      'REQ-C4-1/#404: .memory/records/ is empty or missing — 0 issue-carrying derivations ' +
        'exercised. This is a coverage GAP, not a pass.',
    );
    return;
  }

  // Sampled in directory order: the first 25 with a `source` and the first 25
  // without. NOT a spread of shapes — the store holds only 3 distinct `source`
  // shapes in total and this slice sees 1 of them. What it does exercise is the
  // render branch that used to drop `issue` (a `source` citing no issue), over
  // real content bytes and real timestamps.
  const withSource = records.filter((r) => r.source !== undefined).slice(0, 25);
  const withoutSource = records.filter((r) => r.source === undefined).slice(0, 25);
  const samples = [...withSource, ...withoutSource];
  assert.ok(samples.length > 0, 'the real store must yield at least one sample record');

  // #738 (A5): a sampled record whose OWN stored `actor` is already
  // branch-shaped gets a documented soft-reject on re-export — excluded from
  // `failures` the same way the sibling test above excludes it, not silently
  // dropped from the count.
  const failures = [];
  const branchShapeRejections = [];
  for (const sample of samples) {
    // Rebuild through buildRecord() so the id is the one this record WOULD
    // have carried had its author populated `issue` — never a hand-computed
    // hash, and never a second hasher.
    const issued = buildRecord({
      ts: sample.ts,
      actor: sample.actor,
      actorKind: sample.actorKind,
      type: sample.type,
      project: sample.project,
      content: sample.content,
      issue: 404,
      ...(sample.source !== undefined ? { source: sample.source } : {}),
    });
    assert.equal(issued.issue, 404, 'precondition: the derived record carries the field');

    const { valid, errors } = validateRecord(issued);
    if (!valid) {
      failures.push(`${sample.id}: derived record failed validation — ${errors.join('; ')}`);
      continue;
    }

    const { record: exported, rejected, skipped } = exportObservation(importRecord(issued));
    if (rejected?.reason?.includes('branch-shaped')) {
      branchShapeRejections.push(sample.id);
      continue;
    }
    if (rejected || skipped) {
      failures.push(`${sample.id}: round-trip was ${rejected ? 'REJECTED' : 'SKIPPED'}`);
      continue;
    }
    if (exported.issue !== 404) {
      failures.push(`${sample.id}: issue came back as ${JSON.stringify(exported.issue)}, not 404`);
      continue;
    }
    const recomputedId = computeRecordId(exported);
    if (recomputedId !== issued.id) {
      failures.push(`${sample.id}: recomputed id '${recomputedId}' !== derived id '${issued.id}'`);
    }
  }

  console.log(
    `REQ-C4-1/#404: issue-carrying round-trip exercised over ${samples.length} records derived from the real store ` +
      `(${branchShapeRejections.length} pre-existing branch-shaped-actor records excluded, #738 A5)`,
  );
  // Same exclusion-bucket bound as the sibling test above (fresh-context review NIT).
  assert.ok(
    branchShapeRejections.length < samples.length,
    `every one of ${samples.length} sampled records was classified as branch-shaped-actor and excluded — ` +
      'this empties the failure set silently; the exclusion classifier is almost certainly over-matching',
  );
  assert.deepEqual(failures, [], `${failures.length}/${samples.length} issue-carrying records failed:\n${failures.join('\n')}`);
});

test('W1 (#404): every record in the REAL store already satisfies the write-path `source` rule', (t) => {
  // The single-line/trimmed `source` rule (format.mjs W1) is enforced at WRITE
  // time precisely so it can never make an existing store unreadable. This
  // measures the claim on the one store we can measure: if brain's own history
  // already violated it, the rule would be retroactively wrong.
  //
  // Honest about its reach: this is THIS repo. A consumer's `.memory/**` is
  // consumer-owned (managed-paths.mjs's `local` array) and is not covered by
  // any test here — which is the reason the rule is not on the read path.
  //
  // W3 (#738) is EXCLUDED from this measurement, on purpose: it is a NEW,
  // forward-only rule — the whole reason #738 exists is that ~183 of this
  // repo's own historical records carry a branch-shaped `actor` (design.md's
  // measured audit). Backfilling them is explicitly a Non-Goal (#864 task
  // 1.2a / #368); W1/W2 (measured here) are the rules this pin still owns.
  const records = readRecordObservations({ recordsDir });
  if (records.length === 0) {
    t.skip(
      'W1: .memory/records/ is empty or missing — 0 real records measured. ' +
        'This is a coverage GAP, not a pass.',
    );
    return;
  }
  const nonW3Errors = (r) => validateWritableRecord(r).errors.filter((e) => !e.includes('W3'));
  const offenders = records
    .filter((r) => nonW3Errors(r).length > 0)
    .map((r) => `${r.id}: ${nonW3Errors(r).join('; ')}`);
  console.log(`W1/#404: write-path rules measured over ${records.length} real records`);
  // Bound the W3 exclusion bucket (fresh-context review NIT): the known
  // ~183-record branch-shaped-actor population (design.md's measured audit)
  // must actually PRODUCE a W3 error for this filter to be doing anything. A
  // regression that stops `classifyActor` from ever returning 'branch' would
  // make `nonW3Errors` a no-op filter over an already-empty set, and
  // `offenders` would stay silently empty for the wrong reason.
  const w3Count = records.filter((r) => validateWritableRecord(r).errors.some((e) => e.includes('W3'))).length;
  assert.ok(
    w3Count > 0,
    'expected at least one real record to trip the W3 branch-shaped-actor rule (the known historical population) — ' +
      'zero means the W3 exclusion below is filtering nothing, not that the store is clean',
  );
  assert.deepEqual(offenders, [], `${offenders.length}/${records.length} real records violate a write-path rule:\n${offenders.join('\n')}`);
});
