// memory-coverage.duplicates.test.mjs — issue #634.
//
// #598 changed the shared reader from one-per-physical-line to one-per-`id`.
// The new number is the RIGHT one and it fixed a real leak. What was missing is
// that six consumers read through that function, their totals all moved on the
// same commit, and not one of them could tell anybody why. On this repo's
// corpus the coverage denominator dropped from 2185 to 2046 — 139 lines — and
// "it got more correct" was not an answer the output could give.
//
// Both directions are asserted here, because a report that fires on every store
// is as uninformative as one that never fires: a store WITH duplicates must
// say so, and a clean store must stay silent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeMemoryCoverage } from './memory-coverage.mjs';
import { renderMarkdown, renderJson } from '../brain-metrics.mjs';
import { buildRecord, serializeRecord } from '../memory/lib/format.mjs';

/**
 * A store with `copies` physical lines of ONE valid record.
 *
 * Real `buildRecord`/`serializeRecord`, not hand-written JSON: `readRecords`
 * dedups on the content-addressed `id`, and a fixture whose ids were invented
 * would collapse (or fail to) for reasons unrelated to the code under test.
 */
function storeWith(t, { copies }) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-634-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recordsDir = join(dir, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });

  const record = buildRecord({
    ts: '2026-07-01T10:00:00Z',
    actor: '@x',
    actorKind: 'human',
    type: 'session_summary',
    project: 'brain',
    issue: 634,
    content: 'one record, appended more than once by a union merge',
  });
  writeFileSync(join(recordsDir, '2026-07.jsonl'), (serializeRecord(record) + '\n').repeat(copies), 'utf8');
  return dir;
}

const metricsArgs = (memCoverage) => ({
  rows: [],
  memGate: { pass: true },
  memCoverage,
  range: 'origin/main..HEAD',
  period: 'month',
});

// ── the accounting reaches the consumer ─────────────────────────────────────

test('#634 computeMemoryCoverage: carries the duplicate accounting, and total + lines = the store', (t) => {
  const cov = computeMemoryCoverage(storeWith(t, { copies: 3 }));

  assert.equal(cov.total, 1, 'the deduped count is what gets printed');
  assert.equal(cov.duplicates.ids, 1);
  assert.equal(cov.duplicates.lines, 2, 'three physical lines of one record = two excess');
  assert.equal(
    cov.total + cov.duplicates.lines,
    3,
    'the two numbers must reconstruct the store, or the report cannot state the gap',
  );
});

test('#634 computeMemoryCoverage: a CLEAN store reports zero duplicates — not undefined', (t) => {
  const cov = computeMemoryCoverage(storeWith(t, { copies: 1 }));

  assert.equal(cov.total, 1);
  assert.deepStrictEqual(cov.duplicates, { ids: 0, lines: 0, divergent: 0, groups: [] });
});

test('#634 computeMemoryCoverage: an UNAVAILABLE store still returns a normalized shape', (t) => {
  // A consumer that has to test whether the field exists before trusting it is
  // the shape this ticket is about. `available:false` is what says "I could not
  // look"; `duplicates` is never the thing carrying that.
  const dir = mkdtempSync(join(tmpdir(), 'brain-634-none-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const cov = computeMemoryCoverage(dir);
  assert.equal(cov.available, false);
  assert.deepStrictEqual(cov.duplicates, { ids: 0, lines: 0, divergent: 0, groups: [] });
});

// ── what brain:metrics prints, in both directions ───────────────────────────

test('#634 renderMarkdown: a store WITH duplicates states the gap and how to locate them', (t) => {
  const out = renderMarkdown(metricsArgs(computeMemoryCoverage(storeWith(t, { copies: 3 }))));

  assert.match(out, /1 indexed \+ 2 repeated = 3 record line\(s\) read/, 'the reconciliation the reader cannot otherwise do');
  assert.match(out, /repeats cover 1 id\(s\)/);
  assert.match(out, /collapsed into the count above/, 'and the link back to the number it printed');
  assert.match(out, /brain:memory:reindex/, 'and where the per-id locations live');
});

test('#634 renderMarkdown: the line accounts for what was READ, never claiming the file\'s line count', (t) => {
  // `readRecords` silently skips unparseable lines. The first wording said "the
  // store holds N physical line(s)", which asserts a number it never measured:
  // with one corrupt line it reported 2 where `wc -l` says 3. A message in a
  // ticket about readers that misreport must not misreport.
  const dir = mkdtempSync(join(tmpdir(), 'brain-634-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recordsDir = join(dir, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  const rec = buildRecord({
    ts: '2026-07-01T10:00:00Z', actor: '@x', actorKind: 'human',
    type: 'session_summary', project: 'brain', content: 'twice, plus a corrupt neighbour',
  });
  const line = serializeRecord(rec);
  writeFileSync(join(recordsDir, '2026-07.jsonl'), `${line}\n${line}\n{ not json\n`, 'utf8');

  const out = renderMarkdown(metricsArgs(computeMemoryCoverage(dir)));

  assert.match(out, /1 indexed \+ 1 repeated = 2 record line\(s\) read/, 'it may only speak for what it resolved');
  assert.doesNotMatch(out, /the store holds/, 'and must never assert a total for the file itself');
});

test('#634 renderMarkdown: a CLEAN store says nothing — a line that always fires informs nobody', (t) => {
  const out = renderMarkdown(metricsArgs(computeMemoryCoverage(storeWith(t, { copies: 1 }))));

  assert.match(out, /memory records coverage: 1\/1 tagged/, 'the coverage line itself is unchanged');
  assert.doesNotMatch(out, /physical line\(s\)/);
  assert.doesNotMatch(out, /repeat/);
});

test('#634 renderMarkdown: an UNAVAILABLE store keeps its existing wording, with no duplicate line', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'brain-634-none2-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const out = renderMarkdown(metricsArgs(computeMemoryCoverage(dir)));

  assert.match(out, /memory records coverage: Unavailable/);
  assert.doesNotMatch(out, /physical line\(s\)/);
});

// ── the JSON report carries counts, never the groups ────────────────────────

test('#634 renderJson: emits the duplicate COUNTS and drops `groups`', (t) => {
  // `memoryRecordsCoverage` is denormalized onto EVERY row, and `groups` holds
  // every repeated id with its file:line occurrences. Measured on this repo:
  // 6871 bytes per row with groups against 111 without — 62×, roughly 79 KiB of
  // byte-identical repetition on a 12-period run. The locations already have a
  // home: `brain:memory:reindex` prints them once.
  const memCoverage = computeMemoryCoverage(storeWith(t, { copies: 3 }));
  assert.ok(memCoverage.duplicates.groups.length > 0, 'precondition: the snapshot really does carry groups');

  const rows = [{
    period: '2026-07', changesMerged: 1, medianLeadTimeDays: 1,
    gates: {}, bypass: { sizeException: 0, skipMemoryGate: 0 },
    bypassByAuthor: {}, detection: {}, uncomputable: 0,
  }];
  const parsed = JSON.parse(renderJson({ rows, memGate: { pass: true }, memCoverage }));

  assert.deepStrictEqual(parsed[0].memoryRecordsCoverage.duplicates, { ids: 1, lines: 2, divergent: 0 });
  assert.equal(parsed[0].memoryRecordsCoverage.duplicates.groups, undefined, 'groups must not reach the JSON report');
  assert.equal(parsed[0].memoryRecordsCoverage.total, 1, 'the rest of the snapshot is untouched');
});

test('#634 renderJson: the caller\'s snapshot is not mutated — the markdown renderer still needs groups', (t) => {
  const memCoverage = computeMemoryCoverage(storeWith(t, { copies: 3 }));
  renderJson({ rows: [], memGate: { pass: true }, memCoverage });

  assert.ok(
    Array.isArray(memCoverage.duplicates.groups) && memCoverage.duplicates.groups.length > 0,
    'projecting for JSON must not strip the original — both renderers read the same object',
  );
});

// ── the existence-only consumers, proved rather than assumed ────────────────

test('#634 memoryPresence is invariant under dedup — which is WHY the three gates stay silent', async (t) => {
  // The claim recorded at `readRecordObservations`: dedup keeps the FIRST copy
  // of every repeated id, so `.some()` over the deduped list equals `.some()`
  // over the physical lines. Measured rather than asserted in prose, because
  // "no output needed" is only defensible if the verdict genuinely cannot move.
  const { memoryPresence } = await import('../governance/checks/memory-presence.mjs');
  const { readRecords, readRecordObservations } = await import('../memory/lib/store.mjs');

  const recordsDir = join(storeWith(t, { copies: 4 }), '.memory', 'records');
  const deduped = readRecordObservations({ recordsDir });
  const { duplicates } = readRecords({ recordsDir });

  assert.equal(deduped.length, 1, 'precondition: the reader really did collapse');
  assert.equal(duplicates.lines, 3, 'precondition: there really were repeats to collapse');
  assert.deepStrictEqual(
    memoryPresence(deduped),
    { pass: true },
    'the gate reads the same verdict off the collapsed list',
  );
});
