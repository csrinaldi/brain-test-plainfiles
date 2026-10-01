// engram.duplicates.test.mjs — issue #574 on the engram backend: the rule has
// to hold on `share()` AND on `pull()`, not just where the index happens to be
// rebuilt today.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { pullMemory, buildImportPayload, importMemory } from './engram.mjs';

// #820: a faked backend has no store to protect — never take the real machine guard from a test.
const noGuard = () => ({ held: true, release() {} });

// ── pull ─────────────────────────────────────────────────────────────────────

test('pullMemory: reindexes BETWEEN git pull and hydration, and reports what the merge duplicated', async () => {
  const order = [];
  const duplicates = { ids: 1, lines: 1, divergent: 0, groups: [{ id: 'rec-a', occurrences: ['2026-07.jsonl:2', '2026-07.jsonl:9'] }] };

  const result = await pullMemory({
    root: '/fake/root',
    _gitPull: () => { order.push('gitPull'); },
    _rebuildIndex: (opts) => {
      order.push('rebuildIndex');
      assert.equal(opts.recordsDir, '/fake/root/.memory/records');
      assert.equal(opts.indexPath, '/fake/root/.memory/index.jsonl');
      return { count: 4, duplicates };
    },
    _import: () => { order.push('import'); },
  });

  assert.deepEqual(order, ['gitPull', 'rebuildIndex', 'import']);
  assert.equal(result.indexCount, 4);
  assert.deepEqual(result.duplicates, duplicates);
});

test('pullMemory: a store the merge left unindexable REFUSES before engram is hydrated from it', async () => {
  // The throw stubbed here is the TAMPER refusal, which is the only refusal
  // rebuildIndex still has. A duplicate — divergent or not — never throws
  // (#574): it is reported. Using a message the code no longer emits would
  // make this test teach a rule that does not exist.
  let imported = false;

  await assert.rejects(
    () =>
      pullMemory({
        root: '/fake/root',
        _gitPull: () => {},
        _rebuildIndex: () => {
          throw new Error(
            "rebuildIndex: id mismatch at 2026-07.jsonl:9 — stored id 'rec-a' does not match the recomputed id 'rec-b' (tampered or stale record)",
          );
        },
        _import: () => { imported = true; },
      }),
    /id mismatch/,
  );

  assert.equal(imported, false, 'hydration must not run on a store the gate refuses — ordering is the guarantee');
});

// ── import ───────────────────────────────────────────────────────────────────

test('importMemory: a seam still returning a BARE ARRAY degrades to "no accounting", never a TypeError', async () => {
  // Round-2 review finding: #574 changed this seam's shape while the module
  // argued elsewhere (normalizeDuplicates) that an older seam must degrade
  // rather than crash. The asymmetry is the finding.
  const rec = { id: 'rec-aaa', ts: '2026-07-04T12:00:00Z', actor: '@crinaldi', actorKind: 'agent', type: 'decision', project: 'brain', content: 'x' };

  const result = await importMemory({
    _guard: noGuard,
    root: '/fake/root',
    _requireEngram: () => 'engram',
    _readRecords: () => [rec],                       // the OLD shape
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: () => {},
    _log: () => {},
    _now: () => '2026-07-04 12:00:00',
  });

  assert.equal(result.written, 1);
  assert.deepEqual(result.duplicates, { ids: 0, lines: 0, divergent: 0, groups: [] });
});

test('buildImportPayload: a repeated id in one batch is sent ONCE — `engram import` INSERTS, so this is permanent damage', () => {
  const rec = (id) => ({ id, ts: '2026-07-04T12:00:00Z', actor: '@crinaldi', actorKind: 'agent', type: 'decision', project: 'brain', content: 'x' });

  const { payload, written, skipped } = buildImportPayload({
    records: [rec('rec-aaa'), rec('rec-bbb'), rec('rec-aaa')],
    existingTopicKeys: new Set(),
    startedAt: '2026-07-04 12:00:00',
  });

  assert.equal(written, 2);
  assert.equal(skipped, 1);
  assert.deepEqual(payload.observations.map((o) => o.topic_key), ['rec-aaa', 'rec-bbb']);
});
