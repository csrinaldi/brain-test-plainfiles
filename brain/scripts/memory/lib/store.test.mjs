// store.test.mjs — unit tests for the thin I/O layer over .memory/records/ +
// .memory/index.jsonl (REQ-MF-3, REQ-MF-4, and the degenerate-state contract).
//
// RED: these imports fail until store.mjs is created (task C1a.2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { buildRecord } from './format.mjs';
import { appendRecord, rebuildIndex, readRecordIds, readRecordObservations } from './store.mjs';
import { testTmp } from '../../lib/test-tmp.mjs';

function tmpMemoryDir() {
  const root = testTmp('brain-memory-store-');
  return { root, recordsDir: join(root, 'records'), indexPath: join(root, 'index.jsonl') };
}

const base = {
  ts: '2026-07-04T12:00:00Z',
  actor: '@crinaldi',
  actorKind: 'human',
  type: 'decision',
  project: 'brain',
};

// ── appendRecord ──────────────────────────────────────────────────────────────

test('appendRecord: writes exactly one physical JSONL line to the record\'s OWN file (#677)', () => {
  const { recordsDir } = tmpMemoryDir();
  const rec = buildRecord({ ...base, content: 'first record' });
  const { file, filename, written } = appendRecord(rec, { recordsDir });
  assert.equal(filename, `2026-07-${rec.id}.jsonl`, 'the id IS the filename');
  assert.equal(written, true);
  const raw = readFileSync(file, 'utf8');
  const lines = raw.split('\n').filter(Boolean);
  assert.equal(lines.length, 1);
  assert.deepEqual(JSON.parse(lines[0]), rec);
});

test('appendRecord: a second record of the same month gets its own file — two files, one line each (#677)', () => {
  const { recordsDir } = tmpMemoryDir();
  const recA = buildRecord({ ...base, content: 'A' });
  const recB = buildRecord({ ...base, content: 'B' });
  const a = appendRecord(recA, { recordsDir });
  const b = appendRecord(recB, { recordsDir });
  assert.notEqual(a.filename, b.filename);
  for (const { file } of [a, b]) {
    assert.equal(readFileSync(file, 'utf8').split('\n').filter(Boolean).length, 1);
  }
  assert.equal(existsSync(join(recordsDir, '2026-07.jsonl')), false, 'no month log is created any more');
});

test('appendRecord: re-appending the SAME record is idempotent and SAYS so — written:false, bytes untouched', () => {
  // Silence here would be `evidence-reader-empty-on-failure` in miniature: "the
  // record is present" and "I just wrote it" are different facts and the caller
  // must be able to tell them apart.
  const { recordsDir } = tmpMemoryDir();
  const rec = buildRecord({ ...base, content: 'said once' });
  const first = appendRecord(rec, { recordsDir });
  const bytes = readFileSync(first.file, 'utf8');

  const second = appendRecord(rec, { recordsDir });
  assert.equal(second.written, false);
  assert.equal(second.file, first.file);
  assert.equal(readFileSync(first.file, 'utf8'), bytes, 'byte-identical — never rewritten');
});

test('appendRecord: an existing file with DIVERGENT bytes is never overwritten — first-wins, as the readers resolve it', () => {
  const { recordsDir } = tmpMemoryDir();
  // `issue: 405` declared so the widened `source` below (citing 'issue #405')
  // satisfies format.mjs's W4 (#461) — `source` itself stays hash-excluded.
  const rec = buildRecord({ ...base, content: 'round-tripped', issue: 405, source: 'PR #405' });
  const widened = { ...rec, source: 'issue #405 / PR #405' }; // `source` is not hashed — same id
  appendRecord(widened, { recordsDir });

  const out = appendRecord(rec, { recordsDir });
  assert.equal(out.written, false);
  assert.equal(JSON.parse(readFileSync(out.file, 'utf8')).source, 'issue #405 / PR #405');
});

test('appendRecord: refuses to build a path out of an id it did not recognise (fails closed, writes nothing)', () => {
  const { recordsDir } = tmpMemoryDir();
  const rec = buildRecord({ ...base, content: 'x' });
  for (const id of ['../../escape', 'rec-NOTHEX0000000', 'rec-short', '']) {
    assert.throws(() => appendRecord({ ...rec, id }, { recordsDir }), /recordFilename: refusing/, `id ${JSON.stringify(id)}`);
  }
  assert.equal(existsSync(recordsDir), false, 'and nothing was created on the way');
});

test('appendRecord: rejects an invalid record (fails closed, does not write)', () => {
  const { recordsDir } = tmpMemoryDir();
  const bad = { ...buildRecord({ ...base, content: 'x' }), type: 'manual' };
  assert.throws(() => appendRecord(bad, { recordsDir }));
  assert.equal(existsSync(recordsDir), false);
});

// issue #404 — appendRecord is the ONE chokepoint every in-tree producer goes
// through (plainfiles#save, engram#dualWriteRecords, migrate-v1), so it is
// where the Fuente-line shape rules are enforced. They are NOT on the read
// path: `.memory/**` is consumer-owned, so a read-path rejection would make a
// pre-existing line brick a store brain cannot migrate. rebuildIndex() below
// must therefore still read a record appendRecord would have refused.

test('appendRecord: refuses a multi-line `source` (W1) — it would spill off the Fuente line', () => {
  const { recordsDir } = tmpMemoryDir();
  const bad = { ...buildRecord({ ...base, content: 'x' }), source: 'see the tracker\n(context: issue #999)' };
  assert.throws(() => appendRecord(bad, { recordsDir }), /W1/);
  assert.equal(existsSync(recordsDir), false);
});

test('appendRecord: refuses a non-number `issue` (W2) — it re-imports under a different id', () => {
  const { recordsDir } = tmpMemoryDir();
  const bad = { ...buildRecord({ ...base, content: 'x' }), issue: '404' };
  assert.throws(() => appendRecord(bad, { recordsDir }), /W2/);
  assert.equal(existsSync(recordsDir), false);
});

test('rebuildIndex: still READS a record appendRecord would have refused (no store-wide brick)', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  // Hand-written line, as a consumer store predating the W1 rule would hold.
  const legacy = { ...buildRecord({ ...base, content: 'x' }), source: 'see the tracker\n(context: issue #999)' };
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, '2026-07.jsonl'), JSON.stringify(legacy) + '\n', 'utf8');
  const { count } = rebuildIndex({ recordsDir, indexPath });
  assert.equal(count, 1, 'a pre-existing multi-line source must not make the store unreadable');
});

// ── rebuildIndex — degenerate states (2b) ────────────────────────────────────

test('rebuildIndex: absent records/ → empty index, no throw (exit-0 contract)', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  const { count } = rebuildIndex({ recordsDir, indexPath });
  assert.equal(count, 0);
  assert.equal(readFileSync(indexPath, 'utf8'), '');
});

test('rebuildIndex: empty records/ (no .jsonl files) → empty index', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  mkdirSync(recordsDir, { recursive: true });
  const { count } = rebuildIndex({ recordsDir, indexPath });
  assert.equal(count, 0);
});

test('rebuildIndex: does not touch a legacy .memory/chunks/*.jsonl.gz sibling', () => {
  const { root, recordsDir, indexPath } = tmpMemoryDir();
  const chunksDir = join(root, 'chunks');
  mkdirSync(chunksDir, { recursive: true });
  const chunkFile = join(chunksDir, 'legacy.jsonl.gz');
  writeFileSync(chunkFile, 'not touched');
  rebuildIndex({ recordsDir, indexPath });
  assert.equal(readFileSync(chunkFile, 'utf8'), 'not touched');
});

test('rebuildIndex: a corrupt line fails closed with file + line number in the error', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, '2026-07.jsonl'), '{"valid":"json but not a record"}\n{not valid json\n');
  assert.throws(() => rebuildIndex({ recordsDir, indexPath }), /2026-07\.jsonl:1/);
});

test('rebuildIndex: an invalid (schema-violating) record fails closed with file + line number', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  mkdirSync(recordsDir, { recursive: true });
  const bad = { ...buildRecord({ ...base, content: 'x' }), type: 'manual' };
  writeFileSync(join(recordsDir, '2026-07.jsonl'), JSON.stringify(bad) + '\n');
  assert.throws(() => rebuildIndex({ recordsDir, indexPath }), /2026-07\.jsonl:1/);
});

// ── rebuildIndex — id-integrity hardening (issue #214, C1b) ──────────────────
// Recompute each record's id via the ONE shared computeRecordId (never a second
// hasher) and fail closed on a mismatch, same file:line policy as the corrupt-line path.

test('rebuildIndex: a tampered id fails closed with file + line number in the error', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  mkdirSync(recordsDir, { recursive: true });
  const rec = buildRecord({ ...base, content: 'legitimate content' });
  const tampered = { ...rec, id: 'rec-0000000000000000' };
  writeFileSync(join(recordsDir, '2026-07.jsonl'), JSON.stringify(tampered) + '\n');
  assert.throws(() => rebuildIndex({ recordsDir, indexPath }), /2026-07\.jsonl:1/);
});

test('rebuildIndex: a legitimate record (title folded, optionals omitted) never produces a false id mismatch', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  const rec = buildRecord({ ...base, title: 'A Title', content: 'body text', issue: 214 });
  appendRecord(rec, { recordsDir });
  const { count } = rebuildIndex({ recordsDir, indexPath }); // must not throw
  assert.equal(count, 1);
});

// ── rebuildIndex — normal + property behavior (REQ-MF-4, R1) ─────────────────

test('rebuildIndex: indexes appended records, one entry per id, sorted', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  const recA = buildRecord({ ...base, content: 'A' });
  const recB = buildRecord({ ...base, content: 'B' });
  appendRecord(recA, { recordsDir });
  appendRecord(recB, { recordsDir });
  const { count } = rebuildIndex({ recordsDir, indexPath });
  assert.equal(count, 2);
  const lines = readFileSync(indexPath, 'utf8').split('\n').filter(Boolean);
  const ids = lines.map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, [...ids].sort());
});

test('rebuildIndex: a duplicate physical line (same id) collapses to one index entry', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  const rec = buildRecord({ ...base, content: 'same' });
  appendRecord(rec, { recordsDir });
  appendRecord(rec, { recordsDir }); // union-merge duplicate simulation
  const { count } = rebuildIndex({ recordsDir, indexPath });
  assert.equal(count, 1);
});

test('rebuildIndex: property — delete index, reindex, byte-identical to the original', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  appendRecord(buildRecord({ ...base, content: 'A' }), { recordsDir });
  appendRecord(buildRecord({ ...base, content: 'B' }), { recordsDir });
  appendRecord(buildRecord({ ...base, ts: '2026-06-01T00:00:00Z', content: 'C' }), { recordsDir });
  rebuildIndex({ recordsDir, indexPath });
  const before = readFileSync(indexPath, 'utf8');
  rmSync(indexPath);
  rebuildIndex({ recordsDir, indexPath });
  const after = readFileSync(indexPath, 'utf8');
  assert.equal(after, before);
});

// ── readRecordIds — dedup input for dualWriteRecords (issue #221 fix pass, BLOCKER) ──
// records/ is the authoritative dedup source (not the derived index.jsonl).

test('readRecordIds: absent records/ → empty Set, no throw', () => {
  const { recordsDir } = tmpMemoryDir();
  const ids = readRecordIds({ recordsDir });
  assert.ok(ids instanceof Set);
  assert.equal(ids.size, 0);
});

test('readRecordIds: empty records/ (no .jsonl files) → empty Set', () => {
  const { recordsDir } = tmpMemoryDir();
  mkdirSync(recordsDir, { recursive: true });
  const ids = readRecordIds({ recordsDir });
  assert.equal(ids.size, 0);
});

test('readRecordIds: collects ids across every month file under records/', () => {
  const { recordsDir } = tmpMemoryDir();
  const recA = buildRecord({ ...base, content: 'A' });
  const recB = buildRecord({ ...base, ts: '2026-06-01T00:00:00Z', content: 'B' });
  appendRecord(recA, { recordsDir });
  appendRecord(recB, { recordsDir });
  const ids = readRecordIds({ recordsDir });
  assert.deepEqual([...ids].sort(), [recA.id, recB.id].sort());
});

test('readRecordIds: a corrupt physical line is skipped (not this function\'s fail-closed gate — rebuildIndex owns that)', () => {
  const { recordsDir } = tmpMemoryDir();
  mkdirSync(recordsDir, { recursive: true });
  const recA = buildRecord({ ...base, content: 'A' });
  writeFileSync(
    join(recordsDir, '2026-07.jsonl'),
    `${JSON.stringify(recA)}\nnot valid json\n`,
  );
  const ids = readRecordIds({ recordsDir });
  assert.deepEqual([...ids], [recA.id]);
});

// ── readRecordObservations — transitional reader for the governance memory-gate ──
// (issue #222 gap fix). Best-effort, mirrors readChunkObservations's contract:
// an absent/unreadable records/ or a corrupt line yields fewer (or zero)
// records, never throws. Returns the full parsed record (incl. `.type`) so
// memoryPresence() can inspect it, same shape readChunkObservations returns.

test('readRecordObservations: returns full parsed records (incl. type) from records/', () => {
  const { recordsDir } = tmpMemoryDir();
  const rec = buildRecord({ ...base, type: 'session_summary', content: 'session recap' });
  appendRecord(rec, { recordsDir });
  const observations = readRecordObservations({ recordsDir });
  assert.deepEqual(observations, [rec]);
  assert.equal(observations[0].type, 'session_summary');
});

test('readRecordObservations: absent records/ → empty array, no throw', () => {
  const { recordsDir } = tmpMemoryDir();
  const observations = readRecordObservations({ recordsDir });
  assert.deepEqual(observations, []);
});

test('readRecordObservations: a corrupt physical line is skipped — other records still returned, no throw', () => {
  const { recordsDir } = tmpMemoryDir();
  mkdirSync(recordsDir, { recursive: true });
  const rec = buildRecord({ ...base, type: 'session_summary', content: 'good record' });
  writeFileSync(
    join(recordsDir, '2026-07.jsonl'),
    `${JSON.stringify(rec)}\nnot valid json\n`,
  );
  const observations = readRecordObservations({ recordsDir });
  assert.deepEqual(observations, [rec]);
});
