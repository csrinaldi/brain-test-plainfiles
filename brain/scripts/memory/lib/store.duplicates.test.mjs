// store.duplicates.test.mjs — issue #574. The duplicate-line RULE:
//
//   a repeated `id` → deduplicated AND reported, first-wins, never refused
//   lines that DISAGREE → counted separately as `divergent`, same resolution
//
// The tamper path (a line whose bytes do not hash to its id) has been refused
// since #214 and has its own tests in store.test.mjs. These pin the OTHER
// failure mode, which used to be answered by silence.
//
// The divergence tests below are load-bearing in a specific way: an earlier
// draft of this rule REFUSED a disagreeing pair, and `roundtrip-divergence`
// (bottom of this file) is the case that killed it — brain's own
// export→import→export widens `source`, which is hash-excluded, so the refusal
// fired on records brain itself writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildRecord, serializeRecord } from './format.mjs';
import { importRecord } from './engram-import.mjs';
import { exportObservation } from './engram-export.mjs';
import { rebuildIndex, readRecords, readRecordObservations } from './store.mjs';

const base = {
  ts: '2026-07-04T12:00:00Z',
  actor: '@crinaldi',
  actorKind: 'human',
  type: 'decision',
  project: 'brain',
};

function fixture(t, lines, filename = '2026-07.jsonl') {
  const root = mkdtempSync(join(tmpdir(), 'brain-memory-dup-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const recordsDir = join(root, 'records');
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, filename), lines.map((l) => l + '\n').join(''), 'utf8');
  return { root, recordsDir, indexPath: join(root, 'index.jsonl'), recordsFile: join(recordsDir, filename) };
}

// ── the reported half ────────────────────────────────────────────────────────

test('rebuildIndex: a clean store reports zero duplicates (the accounting is always present)', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const b = buildRecord({ ...base, content: 'B' });
  const { recordsDir, indexPath } = fixture(t, [serializeRecord(a), serializeRecord(b)]);

  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 2);
  assert.deepEqual(duplicates, { ids: 0, lines: 0, divergent: 0, groups: [] });
});

test('rebuildIndex: an identical repeated line is COLLAPSED, not refused — the index stays one entry per id', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const b = buildRecord({ ...base, content: 'B' });
  const { recordsDir, indexPath } = fixture(t, [serializeRecord(a), serializeRecord(b), serializeRecord(a)]);

  const { count } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 2, 'the repeated id contributes one index entry');
  const indexed = readFileSync(indexPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  assert.deepEqual([...indexed].sort(), [a.id, b.id].sort());
});

test('rebuildIndex: the collapse is REPORTED — ids, excess lines, and every location', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const b = buildRecord({ ...base, content: 'B' });
  const { recordsDir, indexPath } = fixture(t, [
    serializeRecord(a), serializeRecord(b), serializeRecord(a), serializeRecord(a),
  ]);

  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 2);
  assert.equal(duplicates.ids, 1, 'one id repeats');
  assert.equal(duplicates.lines, 2, 'the store is 2 physical lines longer than the index');
  assert.deepEqual(duplicates.groups, [
    { id: a.id, occurrences: ['2026-07.jsonl:1', '2026-07.jsonl:3', '2026-07.jsonl:4'], divergent: false },
  ]);
});

test('rebuildIndex: duplicates are counted ACROSS month files, with each location named', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const { root, recordsDir, indexPath } = fixture(t, [serializeRecord(a)], '2026-06.jsonl');
  writeFileSync(join(recordsDir, '2026-07.jsonl'), serializeRecord(a) + '\n', 'utf8');
  assert.ok(root);

  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 1);
  assert.equal(duplicates.lines, 1);
  assert.deepEqual(duplicates.groups[0].occurrences, ['2026-06.jsonl:1', '2026-07.jsonl:1']);
});

test('rebuildIndex: duplicate reporting survives blank lines — line numbers are PHYSICAL, 1-based', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const { recordsDir, indexPath } = fixture(t, [serializeRecord(a), '', serializeRecord(a)]);

  const { duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.deepEqual(duplicates.groups[0].occurrences, ['2026-07.jsonl:1', '2026-07.jsonl:3']);
});

test('rebuildIndex: key order is not divergence — the same record serialized differently is ONE record', (t) => {
  const a = buildRecord({ ...base, content: 'A', source: 'issue #574' });
  const reordered = JSON.stringify(
    Object.fromEntries(Object.entries(a).reverse()),
  );
  const { recordsDir, indexPath } = fixture(t, [serializeRecord(a), reordered]);

  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 1);
  assert.equal(duplicates.lines, 1, 'collapsed and counted, never refused — the bytes differ, the record does not');
});

// ── the divergent half: reported, resolved first-wins, NEVER refused ─────────

test('rebuildIndex: two lines sharing an id but DISAGREEING are REPORTED as divergent, not refused', (t) => {
  // Both lines pass the id-integrity check on their own: `source` is excluded
  // from the hash (format.mjs#computeRecordId), so this is reachable with no
  // tampering at all — and the old Map-keyed collapse resolved it last-wins,
  // silently.
  const a = buildRecord({ ...base, content: 'A', source: 'issue #574' });
  const b = { ...a, source: 'issue #999' };
  const { recordsDir, indexPath } = fixture(t, [serializeRecord(a), serializeRecord(b)]);

  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 1);
  assert.equal(duplicates.divergent, 1, 'counted on its own channel — a different fact than a plain repeat');
  assert.equal(duplicates.groups[0].divergent, true);
  assert.deepEqual(duplicates.groups[0].occurrences, ['2026-07.jsonl:1', '2026-07.jsonl:2']);
});

test('rebuildIndex: a divergent duplicate resolves FIRST-WINS, and the index is still written', (t) => {
  // Cross-month, so the winner is observable in the index's `file` field —
  // within one file the projection drops `source` and both entries are equal.
  const a = buildRecord({ ...base, content: 'A', source: 'first' });
  const b = { ...a, source: 'second' };
  const { recordsDir, indexPath } = fixture(t, [serializeRecord(a)], '2026-06.jsonl');
  writeFileSync(join(recordsDir, '2026-07.jsonl'), serializeRecord(b) + '\n', 'utf8');

  const { duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(duplicates.divergent, 1);
  assert.deepEqual(duplicates.groups[0].occurrences, ['2026-06.jsonl:1', '2026-07.jsonl:1']);
  const entry = JSON.parse(readFileSync(indexPath, 'utf8').split('\n').filter(Boolean)[0]);
  assert.equal(entry.file, '2026-06.jsonl', 'the earliest month wins — the same line readRecords keeps');
  assert.equal(readRecords({ recordsDir }).records[0].source, 'first', 'and the reader agrees, by construction');
});

test('rebuildIndex: an unknown extra key on one of two same-id lines is divergence — still not a refusal', (t) => {
  // `validateRecord` accepts unknown keys on purpose (forward compatibility in
  // a consumer-owned format). A fork or a newer brain adding a field on one
  // branch must not brick the store on merge.
  const a = buildRecord({ ...base, content: 'A' });
  const b = { ...a, note: 'hand-edited' };
  const { recordsDir, indexPath } = fixture(t, [serializeRecord(a), serializeRecord(b)]);

  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 1);
  assert.equal(duplicates.divergent, 1);
});

test('rebuildIndex: an identical repeat is NOT flagged divergent — the two channels stay distinct', (t) => {
  const a = buildRecord({ ...base, content: 'A', source: 'issue #574' });
  const { recordsDir, indexPath } = fixture(t, [serializeRecord(a), serializeRecord(a)]);

  const { duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(duplicates.ids, 1);
  assert.equal(duplicates.divergent, 0);
  assert.equal(duplicates.groups[0].divergent, false);
});

test('roundtrip-divergence: brain\'s OWN export→import→export widens `source`, so refusing this pair would refuse brain', (t) => {
  // The case that overturned the first draft of this rule. `renderFuente`
  // prepends `issue #N` to a `source` that does not already cite the issue —
  // documented as free BECAUSE `source` is hash-excluded. So a record that
  // round-trips through engram comes back with the same id and different bytes,
  // and a union merge can land both copies. This must never brick the store.
  const original = buildRecord({ ...base, issue: 405, source: 'PR #405', content: 'A decision.' });
  const roundTripped = exportObservation({
    ...importRecord(original), created_at: '2026-07-04 12:00:00', scope: 'project',
  }).record;

  assert.equal(roundTripped.id, original.id, 'same id — `issue` is hashed and survives');
  assert.notEqual(roundTripped.source, original.source, 'different bytes — `source` is not hashed and widens');

  const { recordsDir, indexPath } = fixture(t, [serializeRecord(original), serializeRecord(roundTripped)]);
  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 1, 'indexed, not refused');
  assert.equal(duplicates.divergent, 1, 'and reported, so nobody has to discover it by reading 2000 records');
});

test('rebuildIndex: a value canonicalJson cannot express does NOT become a new read-path refusal', (t) => {
  // Round-2 review finding. `JSON.parse('1e999')` is `Infinity`, and
  // `validateRecord` does not police fields outside the schema, so a record
  // could carry one in an unhashed/unknown field, pass the id check, and then
  // die in the bare `canonicalJson(record)` the duplicate rule added — a store
  // that indexed fine BEFORE #574 turned unindexable, which is precisely the
  // class duplicates.mjs argues must never happen.
  const rec = buildRecord({ ...base, content: 'A' });
  const overflowing = serializeRecord(rec).slice(0, -1) + ',"weight":1e999}';
  const { recordsDir, indexPath } = fixture(t, [overflowing]);

  assert.equal(JSON.parse(overflowing).weight, Infinity, 'the value really is non-finite after parsing');
  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 1, 'indexed, not refused');
  assert.equal(duplicates.ids, 0, 'and a single such line is no kind of duplicate');
});

test('rebuildIndex: two uncomparable same-id lines report as DIVERGENT rather than as agreeing', (t) => {
  // Failing to prove equality must not be reported as equality. The safe
  // direction is over-reporting a pair nothing could vouch for.
  const rec = buildRecord({ ...base, content: 'A' });
  const overflowing = serializeRecord(rec).slice(0, -1) + ',"weight":1e999}';
  const { recordsDir, indexPath } = fixture(t, [overflowing, overflowing]);

  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });

  assert.equal(count, 1);
  assert.equal(duplicates.ids, 1);
  assert.equal(duplicates.divergent, 1, 'uncomparable ⇒ divergent, never a silent "they agree"');
});

// ── the reader half (the hydration path) ─────────────────────────────────────

test('readRecords: an identical repeat is collapsed and reported — one record, accounting intact', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const b = buildRecord({ ...base, content: 'B' });
  const { recordsDir } = fixture(t, [serializeRecord(a), serializeRecord(b), serializeRecord(a)]);

  const { records, duplicates } = readRecords({ recordsDir });

  assert.deepEqual(records.map((r) => r.id), [a.id, b.id]);
  assert.equal(duplicates.ids, 1);
  assert.equal(duplicates.lines, 1);
});

test('readRecords: a DIVERGENT duplicate keeps the first line, counts it, and never throws', (t) => {
  // The reader and rebuildIndex resolve this IDENTICALLY — that agreement is
  // the point of first-wins, and it is why neither of them refuses.
  const a = buildRecord({ ...base, content: 'A', source: 'first' });
  const b = { ...a, source: 'second' };
  const { recordsDir, indexPath } = fixture(t, [serializeRecord(a), serializeRecord(b)]);

  const { records, duplicates } = readRecords({ recordsDir });

  assert.equal(records.length, 1);
  assert.equal(records[0].source, 'first');
  assert.equal(duplicates.lines, 1);
  assert.equal(duplicates.divergent, 1);
  assert.equal(rebuildIndex({ recordsDir, indexPath }).duplicates.divergent, 1, 'the gate agrees, and indexes it');
});

test('readRecords: a corrupt line is still skipped, and an id-less line still passes through', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const { recordsDir } = fixture(t, [serializeRecord(a), '{not json', JSON.stringify({ type: 'decision' })]);

  const { records } = readRecords({ recordsDir });

  assert.equal(records.length, 2, 'the corrupt line is skipped; the id-less one is not silently dropped');
});

test('readRecords: absent records/ → empty result, no throw', () => {
  const { records, duplicates } = readRecords({ recordsDir: join(tmpdir(), 'brain-memory-dup-absent-xyz') });
  assert.deepEqual(records, []);
  assert.deepEqual(duplicates, { ids: 0, lines: 0, divergent: 0, groups: [] });
});

test('readRecordObservations: the legacy array reader is now deduped by id (it wraps readRecords)', (t) => {
  const a = buildRecord({ ...base, content: 'A' });
  const { recordsDir } = fixture(t, [serializeRecord(a), serializeRecord(a)]);

  assert.equal(readRecordObservations({ recordsDir }).length, 1);
});
