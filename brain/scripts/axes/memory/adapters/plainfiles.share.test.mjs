// plainfiles.share.test.mjs — unit tests for axes/memory/adapters/plainfiles.mjs#share
// (C3, issue #246, REQ-C3-4). share() is a self-check rebuildIndex() ONLY —
// no data movement, since records already ARE the store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// RED: share is not exported from plainfiles.mjs yet.
import { share } from './plainfiles.mjs';
import { buildRecord } from '../../../memory/lib/format.mjs';
import { appendRecord } from '../../../memory/lib/store.mjs';
import { testTmp } from '../../../lib/test-tmp.mjs';

test('share: calls rebuildIndex() only — no export, no data movement, no git call', async () => {
  const calls = [];
  const result = await share(
    { root: '/fake/root' },
    {
      _rebuildIndex: (opts) => { calls.push(['rebuildIndex', opts]); return { count: 3 }; },
    },
  );

  assert.deepEqual(calls.map((c) => c[0]), ['rebuildIndex']);
  assert.equal(calls[0][1].recordsDir, '/fake/root/.memory/records');
  assert.equal(calls[0][1].indexPath, '/fake/root/.memory/index.jsonl');
  assert.deepEqual(result, { indexCount: 3, duplicates: { ids: 0, lines: 0, divergent: 0, groups: [] } });
});

// ── #574 — the self-check has to SAY what it collapsed ───────────────────────

test('share: carries the duplicate accounting out to the caller — a silent self-check is not one', async () => {
  const duplicates = { ids: 2, lines: 5, divergent: 0, groups: [{ id: 'rec-a', occurrences: ['2026-07.jsonl:1', '2026-07.jsonl:9'] }] };
  const result = await share(
    { root: '/fake/root' },
    { _rebuildIndex: () => ({ count: 2038, duplicates }) },
  );

  assert.equal(result.indexCount, 2038);
  assert.deepEqual(result.duplicates, duplicates, 'cli.mjs prints this — it must survive the backend boundary');
});

// ── #247 — real deps over a real temp store: share() writes no chunk file ───

function walk(dir, base = '') {
  const out = [];
  for (const entry of readdirSync(dir).sort()) {
    const full = join(dir, entry);
    const rel = base ? `${base}/${entry}` : entry;
    out.push(rel);
    if (statSync(full).isDirectory()) out.push(...walk(full, rel));
  }
  return out;
}

test('share: over a real temp store, the .memory/ tree is exactly index.jsonl + records/ — no chunks/ (D4 guard 3, A6)', async () => {
  const root = testTmp('plainfiles-share-');
  const recordsDir = join(root, '.memory', 'records');
  const rec = buildRecord({
    ts: '2026-07-04T12:00:00Z',
    actor: '@crinaldi',
    actorKind: 'human',
    type: 'decision',
    project: 'brain',
    content: 'seed record',
  });
  const { filename } = appendRecord(rec, { recordsDir });

  await share({ root });

  const tree = walk(join(root, '.memory'));
  // Measured live (tasks.md 0.2) over a real mkdtempSync store — not
  // assumed: `rebuildIndex` (store.mjs) mkdirs the index's parent and
  // writes it; that is the entire expected footprint. `records/<filename>`
  // is the seeded record `appendRecord` wrote above.
  assert.deepEqual(
    tree,
    ['index.jsonl', 'records', `records/${filename}`],
    'exhaustive enumeration, not !includes(chunks) — absence proved by naming everything present',
  );
});
