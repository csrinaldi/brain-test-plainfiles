// engram.share.test.mjs — unit tests for axes/memory/adapters/engram.mjs#share (#874
// split B, row 5). share() is now the plainfiles.share() mirror (R11, D6):
// a bare rebuildIndex() self-check. It no longer exports, reads
// observations, scans chunks, dual-writes records, or touches the `.engram`
// symlink (#955, R7 confines that to `setup()` alone) — those surfaces are
// retired or in the process of retiring; see
// openspec/changes/issue-874-record-first/{design,tasks}.md.
//
// Modelled on plainfiles.share.test.mjs (82 lines) — the twin this function
// now mirrors.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { share } from './engram.mjs';
import { buildRecord } from '../../../memory/lib/format.mjs';
import { appendRecord } from '../../../memory/lib/store.mjs';
import { testTmp } from '../../../lib/test-tmp.mjs';

test('share: calls _rebuildIndex — no export, no observation read, no engram binary, no .engram symlink required (R11, #955 R7)', async () => {
  const calls = [];
  const result = await share({
    root: '/fake/root',
    _rebuildIndex: (opts) => { calls.push(['rebuildIndex', opts]); return { count: 3 }; },
  });

  assert.deepEqual(calls.map((c) => c[0]), ['rebuildIndex']);
  assert.equal(calls[0][1].recordsDir, '/fake/root/.memory/records');
  assert.equal(calls[0][1].indexPath, '/fake/root/.memory/index.jsonl');
  assert.deepEqual(result, { indexCount: 3, duplicates: { ids: 0, lines: 0, divergent: 0, groups: [] } });
});

// ── #574 — the self-check has to SAY what it collapsed ───────────────────────

test('share: carries the duplicate accounting out to the caller — a silent self-check is not one', async () => {
  const duplicates = { ids: 2, lines: 5, divergent: 0, groups: [{ id: 'rec-a', occurrences: ['2026-07.jsonl:1', '2026-07.jsonl:9'] }] };
  const result = await share(
    { root: '/fake/root', _rebuildIndex: () => ({ count: 2038, duplicates }) },
  );

  assert.equal(result.indexCount, 2038);
  assert.deepEqual(result.duplicates, duplicates, 'cli.mjs prints this — it must survive the backend boundary');
});

// ── source guard (row 5) — the exporter's seams are GONE, not merely unused ──

test('share: the function body names none of the retired exporter seams — a source guard, not a behavioral one', () => {
  const src = share.toString();
  for (const retired of ['requireEngram', '_export', '_readObservations', 'dualWriteRecords']) {
    assert.doesNotMatch(
      src, new RegExp(retired),
      `share() must not reference ${retired} — it was retired by #874 split B, not merely left uncalled`,
    );
  }
  assert.doesNotMatch(
    src, /_ensureSymlink/,
    'share() must not reference _ensureSymlink — #958 confined the .engram symlink to setup()',
  );
});

// ── rule 3 (R11) — share completes with the engram binary ABSENT ─────────────

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

test('share: over a real temp store with no engram binary anywhere on PATH, share() still completes — the .memory/ tree is index.jsonl + records/, no chunks/ (rule 3, D4 guard 3)', async (t) => {
  const root = testTmp('engram-share-');
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

  // Genuinely scrub PATH, not merely claim to — an EMPTY temp dir, no `engram`
  // (or anything else) resolvable, restored on cleanup. Before this fix the
  // title's claim was true only BY CONSTRUCTION (share() never shells out at
  // all, per the source guard test above) and never actually measured.
  const emptyBin = testTmp('engram-share-empty-path-');
  const realPath = process.env.PATH;
  process.env.PATH = emptyBin;
  t.after(() => { process.env.PATH = realPath; });

  const result = await share({ root });

  assert.deepEqual(result, { indexCount: 1, duplicates: { ids: 0, lines: 0, divergent: 0, groups: [] } });
  const tree = walk(join(root, '.memory'));
  assert.deepEqual(
    tree,
    ['index.jsonl', 'records', `records/${filename}`],
    'no chunks/ was ever created — share() never touched the engram binary',
  );
});
