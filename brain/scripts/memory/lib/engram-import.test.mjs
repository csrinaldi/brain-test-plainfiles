// engram-import.test.mjs — unit tests for the brain record → engram
// observation import transform (REQ-C2B1-1, issue #221 C2b-1).
//
// Acceptance is the id-equality round-trip (design.md Decision 2,
// sdd/memory-format/c4-roundtrip-equality): exportObservation(importRecord(r))
// must reproduce computeRecordId(r) — NOT byte equality (the source/issue
// render asymmetry is inert, `source` is hash-excluded).
//
// RED: these imports fail until engram-import.mjs is created.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importRecord, toEngramNaive } from './engram-import.mjs';
import { exportObservation } from './engram-export.mjs';
import { buildRecord, computeRecordId, validateRecord } from './format.mjs';

function roundTripId(record) {
  const observation = importRecord(record);
  const { record: exported, rejected, skipped } = exportObservation(observation);
  assert.equal(rejected, undefined, 'round-trip must not be rejected');
  assert.equal(skipped, undefined, 'round-trip must not be skipped');
  return computeRecordId(exported);
}

const base = {
  ts: '2026-07-01T01:19:12Z',
  actor: '@crinaldi',
  actorKind: 'human',
  type: 'decision',
  project: 'brain',
};

// ── id-equality round-trip — the C4-ready contract ───────────────────────────

test('importRecord: round-trip preserves id — a record with BOTH issue and source', () => {
  const record = buildRecord({
    ...base,
    content: 'A decision with recovered provenance.',
    issue: 201,
    source: 'issue #201',
    title: 'A real observation title',
  });
  assert.equal(roundTripId(record), record.id);
});

test('importRecord: round-trip preserves id — issue WITHOUT source (Fuente rendered from issue alone)', () => {
  const record = buildRecord({
    ...base,
    type: 'architecture',
    content: 'A decision keyed only by an issue number, no separate source text.',
    issue: 305,
    title: 'Issue-only provenance',
  });
  assert.equal(roundTripId(record), record.id);
  // the render/parse asymmetry: re-exporting adds a `source` the original
  // record never had — inert because `source` is excluded from the hash.
  const reExported = exportObservation(importRecord(record)).record;
  assert.equal(reExported.source, 'issue #305');
  assert.equal(record.source, undefined);
});

// ── issue #404 — the shapes that used to DROP or CORRUPT `issue` ────────────
// `issue` is in the hashInput and had no home in the engram observation shape
// (ADR-0017), so it travels inside the one `**Fuente:**` line — which `source`
// used to win outright.

test('importRecord: #404 — round-trip preserves id — issue + a source that does NOT cite it (the REQ-C4-1 breaker)', () => {
  const record = buildRecord({
    ...base,
    type: 'session_summary',
    content: 'A session summary scoped to an issue, sourced from the PR that closed it.',
    issue: 404,
    source: 'PR #405',
    title: 'Session summary',
  });
  assert.equal(record.issue, 404, 'precondition: the record carries the field');
  assert.equal(roundTripId(record), record.id);

  const reExported = exportObservation(importRecord(record)).record;
  assert.equal(reExported.issue, 404, 'the hashed field is recovered, not dropped');
  // `source` widens to carry the citation — inert, it is hash-excluded.
  assert.equal(reExported.source, 'issue #404 / PR #405');
});

test('importRecord: #404 — round-trip preserves id — issue + a source citing a DIFFERENT issue', () => {
  const record = buildRecord({
    ...base,
    type: 'bugfix',
    content: 'A fix for one issue, whose provenance prose cites another.',
    issue: 404,
    source: 'regression from issue #999',
  });
  assert.equal(roundTripId(record), record.id);
  const reExported = exportObservation(importRecord(record)).record;
  assert.equal(reExported.issue, 404, 'the record its OWN issue wins over the prose citation');
});

test('importRecord: #404 — a MULTI-LINE source no longer drifts the id (the shape a consumer store may already hold)', () => {
  // `validateRecord` admits this (deliberately — a read-path rejection would
  // brick a consumer store), and `appendRecord` refuses to create it (W1). It
  // must still round-trip: renderFuente() narrows `source` to its first line,
  // so neither the citation nor the hashed `content` is displaced.
  const record = { ...buildRecord({ ...base, content: 'Body.', issue: 404 }), source: '\n\nissue #404' };
  assert.equal(validateRecord(record).valid, true, 'precondition: the read gate admits it');
  const reExported = exportObservation(importRecord(record)).record;
  assert.equal(reExported.issue, 404, 'the hashed field survives a multi-line source');
  assert.equal(reExported.content, 'Body.', 'the hashed content does not gain the source tail');
  assert.equal(computeRecordId(reExported), record.id, 'no id drift');
});

test('importRecord: #404 — an EMPTY source round-trips by id and reaches its fixed point in one pass', () => {
  const record = { ...buildRecord({ ...base, content: 'Body.', issue: 404 }), source: '' };
  const reExported = exportObservation(importRecord(record)).record;
  // An empty source is treated as ABSENT, so the line is the bare citation —
  // identical to the `issue`-only shape, and already the fixed point. It used
  // to render `issue #404 / `, converging only on the second pass.
  assert.equal(reExported.source, 'issue #404');
  assert.equal(computeRecordId(reExported), record.id);
  const again = exportObservation(importRecord({ ...reExported, id: record.id })).record;
  assert.equal(computeRecordId(again), record.id);
});

test('importRecord: #404 — a record with NEITHER issue nor source is unchanged by the fix', () => {
  const record = buildRecord({ ...base, type: 'discovery', content: 'No provenance optionals at all.' });
  assert.equal(record.issue, undefined);
  assert.equal(record.source, undefined);
  assert.equal(roundTripId(record), record.id);
  const reExported = exportObservation(importRecord(record)).record;
  assert.equal(reExported.issue, undefined, 'no issue may be fabricated');
  assert.equal(reExported.source, undefined, 'no source may be fabricated');
});

test('importRecord: round-trip preserves id — the @legacy fallback shape (arbitrary source prose, no issue/supersedes)', () => {
  const record = buildRecord({
    ...base,
    actor: '@legacy',
    type: 'discovery',
    content: 'Some migrated content, no recoverable provenance at export time.',
    source: 'provenance unknown — migrated from engram chunk obs-1034b42dcca30459',
  });
  assert.equal(roundTripId(record), record.id);
});

test('importRecord: round-trip preserves id — a record with supersedes', () => {
  const record = buildRecord({
    ...base,
    actor: 'claude-sonnet-4-6',
    actorKind: 'agent',
    type: 'pattern',
    content: 'Supersedes an older observation.',
    supersedes: 'obs-old-id',
    title: 'Pattern update',
  });
  assert.equal(roundTripId(record), record.id);
});

test('importRecord: round-trip preserves id — no title (R2 no-op), no optionals at all', () => {
  const record = buildRecord({ ...base, content: 'Plain content, nothing folded.' });
  assert.equal(roundTripId(record), record.id);
});

// ── Structural contract ──────────────────────────────────────────────────────

test('importRecord: undoes the R2 title fold — separates title from content', () => {
  const record = buildRecord({ ...base, content: 'body text', title: 'My Title' });
  const observation = importRecord(record);
  assert.equal(observation.title, 'My Title');
  assert.match(observation.content, /body text$/);
});

test('importRecord: renders provenance as leading §4 prose in content', () => {
  const record = buildRecord({ ...base, content: 'body text', title: 'My Title' });
  const observation = importRecord(record);
  assert.match(observation.content, /^\*\*Actor:\*\* @crinaldi \(humano\)/);
});

test('importRecord: carries type and project through unchanged', () => {
  const record = buildRecord({ ...base, type: 'config', project: 'brain', content: 'x' });
  const observation = importRecord(record);
  assert.equal(observation.type, 'config');
  assert.equal(observation.project, 'brain');
});

// ── ts mapping — the inverse of engram-export.mjs's toUtcSeconds() ───────────

test('toEngramNaive: maps ISO-8601 UTC seconds back to engram naive form', () => {
  assert.equal(toEngramNaive('2026-07-01T01:19:12Z'), '2026-07-01 01:19:12');
});

test('toEngramNaive: throws on a malformed timestamp (fails closed)', () => {
  assert.throws(() => toEngramNaive('not-a-timestamp'), /invalid/);
});

test('importRecord: created_at is the engram-naive mapping of the record ts', () => {
  const record = buildRecord({ ...base, content: 'x' });
  const observation = importRecord(record);
  assert.equal(observation.created_at, '2026-07-01 01:19:12');
});
