// index-lag.test.mjs — unit tests for the non-mutating index/records drift
// warning (#889, design A9, spec.md "local-checks warns on index lag, never
// fails").
//
// RED: these imports fail until index-lag.mjs is created (task B2.1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildRecord } from './lib/format.mjs';
import { appendRecord, rebuildIndex } from './lib/store.mjs';
import { testTmp } from '../lib/test-tmp.mjs';
import { compareIndexToRecords, main } from './index-lag.mjs';

const base = {
  ts: '2026-07-04T12:00:00Z',
  actor: '@crinaldi',
  actorKind: 'human',
  type: 'decision',
  project: 'brain',
};

function tmpMemoryDir() {
  const root = testTmp('brain-memory-index-lag-');
  return { root, recordsDir: join(root, 'records'), indexPath: join(root, 'index.jsonl') };
}

/**
 * Snapshot a flat directory by NAME + bytes + mtime, keyed by filename. A
 * "before/after index.jsonl only" comparison would miss a writer that touches
 * `.memory/records/` instead (adds/removes/rewrites a record file) — this walks
 * the whole directory listing so a stray write anywhere under it is caught, not
 * just a rewrite of the one file this check happens to read.
 *
 * @param {string} dir
 * @returns {Record<string, {bytes: string, mtime: number}>}
 */
function snapshotDir(dir) {
  if (!existsSync(dir)) return {};
  const snapshot = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    snapshot[name] = { bytes: readFileSync(full, 'utf8'), mtime: statSync(full).mtimeMs };
  }
  return snapshot;
}

// ── compareIndexToRecords (pure) ───────────────────────────────────────────

// #1127: the corrupt-line `continue` inside compareIndexToRecords is marked
// `surfaced:` in the source. This pins the claim: a line that cannot be parsed
// is not silently dropped from the picture — its id reads as missing.
test('compareIndexToRecords (#1127): a corrupt index line is not indexed, so its record reads as missing from the index', () => {
  const result = compareIndexToRecords({
    indexLines: ['{ not json'],
    records: [{ id: 'rec-aaaaaaaaaaaaaaaa' }],
  });
  assert.equal(result.lagged, true);
  assert.deepEqual(result.missingFromIndex, ['rec-aaaaaaaaaaaaaaaa']);
});

test('compareIndexToRecords: a committed index whose id set differs from the rebuilt set reports lagged:true with both counts', () => {
  const indexLines = [JSON.stringify({ id: 'rec-aaaaaaaaaaaaaaaa', ts: base.ts, actor: base.actor, type: base.type, project: base.project })];
  const records = [
    { id: 'rec-aaaaaaaaaaaaaaaa' },
    { id: 'rec-bbbbbbbbbbbbbbbb' },
  ];
  const result = compareIndexToRecords({ indexLines, records });
  assert.equal(result.lagged, true);
  assert.equal(result.indexed, 1);
  assert.equal(result.rebuilt, 2);
  assert.deepEqual(result.missingFromIndex, ['rec-bbbbbbbbbbbbbbbb']);
  assert.deepEqual(result.staleInIndex, []);
});

test('compareIndexToRecords: an index entry with no backing record reports staleInIndex, not missingFromIndex', () => {
  const indexLines = [
    JSON.stringify({ id: 'rec-aaaaaaaaaaaaaaaa' }),
    JSON.stringify({ id: 'rec-cccccccccccccccc' }),
  ];
  const records = [{ id: 'rec-aaaaaaaaaaaaaaaa' }];
  const result = compareIndexToRecords({ indexLines, records });
  assert.equal(result.lagged, true);
  assert.deepEqual(result.missingFromIndex, []);
  assert.deepEqual(result.staleInIndex, ['rec-cccccccccccccccc']);
});

test('compareIndexToRecords: matching id sets report lagged:false — key order and formatting never matter (ID SETS, not bytes)', () => {
  const indexLines = [
    JSON.stringify({ id: 'rec-bbbbbbbbbbbbbbbb', extra: 'field order differs' }),
    JSON.stringify({ id: 'rec-aaaaaaaaaaaaaaaa' }),
  ];
  const records = [{ id: 'rec-aaaaaaaaaaaaaaaa' }, { id: 'rec-bbbbbbbbbbbbbbbb' }];
  const result = compareIndexToRecords({ indexLines, records });
  assert.equal(result.lagged, false);
  assert.equal(result.indexed, 2);
  assert.equal(result.rebuilt, 2);
});

test('compareIndexToRecords: empty index and empty records is not lagged', () => {
  const result = compareIndexToRecords({});
  assert.equal(result.lagged, false);
  assert.equal(result.indexed, 0);
  assert.equal(result.rebuilt, 0);
});

// ── main() — the loud half ──────────────────────────────────────────────────

test('main: a lagged index prints a WARNING naming both counts and exits 0', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  const recA = buildRecord({ ...base, content: 'A' });
  const recB = buildRecord({ ...base, content: 'B' });
  appendRecord(recA, { recordsDir });
  appendRecord(recB, { recordsDir });
  // Index only recA directly — recB is a genuine lag, never routed through
  // rebuildIndex (this fixture must not depend on the mutating path).
  writeFileSync(indexPath, JSON.stringify({ id: recA.id, ts: recA.ts, actor: recA.actor, type: recA.type, project: recA.project }) + '\n');

  const logs = [];
  const exitCode = main({ recordsDir, indexPath, log: (msg) => logs.push(msg) });

  assert.equal(exitCode, 0, 'a lag never fails the check');
  assert.equal(logs.length, 1, `expected exactly one WARNING line:\n${logs.join('\n')}`);
  assert.match(logs[0], /WARNING/);
  assert.match(logs[0], /indexed 1/);
  assert.match(logs[0], /rebuilt 2/);
  // "indexed 1, rebuilt 2" alone can read as in-sync-but-off-by-one; it must not be
  // mistaken for "indexed 1, rebuilt 1" plus a stale swap. Name the actual missing/stale
  // counts so the reader knows which direction the lag runs, without listing raw ids.
  assert.match(logs[0], /\(1 missing from the index, 0 stale in it\)/,
    `the warning must break "indexed N, rebuilt M" down into missing/stale counts:\n${logs[0]}`);
});

test('main: a WARNING names missing AND stale counts separately when the index lags in both directions', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  const recA = buildRecord({ ...base, content: 'kept' });
  const recB = buildRecord({ ...base, content: 'added, never indexed' });
  appendRecord(recA, { recordsDir });
  appendRecord(recB, { recordsDir });
  // Index recA (kept) plus a stale id with no backing record at all — recB stays
  // unindexed. This is the triangulating case: "indexed 2, rebuilt 2" would read as
  // in-sync if the counts alone were trusted, but one direction is missing and the
  // other is stale.
  writeFileSync(indexPath, [
    JSON.stringify({ id: recA.id, ts: recA.ts, actor: recA.actor, type: recA.type, project: recA.project }),
    JSON.stringify({ id: 'rec-stalestalestalestale', ts: base.ts, actor: base.actor, type: base.type, project: base.project }),
  ].join('\n') + '\n');

  const logs = [];
  const exitCode = main({ recordsDir, indexPath, log: (msg) => logs.push(msg) });

  assert.equal(exitCode, 0);
  assert.equal(logs.length, 1, `expected exactly one WARNING line:\n${logs.join('\n')}`);
  assert.match(logs[0], /indexed 2/);
  assert.match(logs[0], /rebuilt 2/);
  assert.match(logs[0], /\(1 missing from the index, 1 stale in it\)/,
    `equal indexed/rebuilt counts must not hide that a real missing+stale lag exists:\n${logs[0]}`);
});

test('main: an index in sync with records/ is silent and exits 0', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  const rec = buildRecord({ ...base, content: 'in sync' });
  appendRecord(rec, { recordsDir });
  rebuildIndex({ recordsDir, indexPath });

  const logs = [];
  const exitCode = main({ recordsDir, indexPath, log: (msg) => logs.push(msg) });

  assert.equal(exitCode, 0);
  assert.deepEqual(logs, [], `an in-sync index must stay silent:\n${logs.join('\n')}`);
});

test('main: a missing index.jsonl reads as an empty index — warns, exits 0, never throws', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  const rec = buildRecord({ ...base, content: 'no index yet' });
  appendRecord(rec, { recordsDir });
  assert.equal(existsSync(indexPath), false, 'the fixture never wrote an index.jsonl');

  const logs = [];
  assert.doesNotThrow(() => {
    const exitCode = main({ recordsDir, indexPath, log: (msg) => logs.push(msg) });
    assert.equal(exitCode, 0);
  });
  assert.equal(logs.length, 1, `a missing index against a non-empty records/ is a lag, and must warn:\n${logs.join('\n')}`);
  assert.match(logs[0], /indexed 0/);
});

test('main: NO FILE IS WRITTEN — index.jsonl and every record file are byte- and mtime-identical before and after', () => {
  const { recordsDir, indexPath } = tmpMemoryDir();
  const rec = buildRecord({ ...base, content: 'never touched' });
  appendRecord(rec, { recordsDir });
  rebuildIndex({ recordsDir, indexPath });

  const before = {
    index: { bytes: readFileSync(indexPath, 'utf8'), mtime: statSync(indexPath).mtimeMs },
    records: snapshotDir(recordsDir),
  };
  // Fixture invariant: the snapshot must actually see the record file appendRecord
  // just wrote — an empty snapshot would make the "untouched" assertion below vacuous.
  assert.ok(Object.keys(before.records).length > 0,
    'fixture invariant: recordsDir must contain at least one record file to snapshot');

  main({ recordsDir, indexPath, log: () => {} });

  const after = {
    index: { bytes: readFileSync(indexPath, 'utf8'), mtime: statSync(indexPath).mtimeMs },
    records: snapshotDir(recordsDir),
  };

  assert.equal(after.index.bytes, before.index.bytes, 'index.jsonl bytes must be untouched');
  assert.equal(after.index.mtime, before.index.mtime, 'index.jsonl mtime must be untouched — nothing rewrote it');
  assert.deepEqual(Object.keys(after.records).sort(), Object.keys(before.records).sort(),
    'no record file may be added or removed under .memory/records/');
  assert.deepEqual(after.records, before.records,
    'every record file\'s bytes AND mtime must be untouched — main() only reads');
});
