// reindex-parity.test.mjs — issue #361: `share()` and the `pull` path MUST
// reindex the SAME WAY on both backends — unconditionally, never gated on
// "did anything change" — so the asymmetry the ticket named cannot silently
// come back.
//
// At the time #361 was filed (2026-07-29) this held for neither verb:
// `engram.share()` only reindexed when `dualWriteRecords()` had appended at
// least one record, and `engram.pull()` (then a thin `engram sync --import`
// wrapper) never reindexed at all. Both gaps have since closed independently
// — `pull`'s reindex step landed with #574 (a029ed0a, 2026-08-13, this
// file's sibling `engram.pull.test.mjs`(f)/(g)); `share`'s unconditional
// reindex landed with #874 split B (56de7408, 2026-09-11,
// `engram.share.test.mjs`). Each backend already has its own unit coverage
// for its own unconditional behavior; what was still missing — and what this
// file adds — is a test that puts BOTH backends side by side so a future
// change to either one is caught by the SAME assertion, not by two
// independently-maintained files that could drift without either one
// noticing (the "two backends drift apart silently" failure mode the
// ticket's Acceptance section named, matching the M10/#335 pattern).
//
// Calling convention differs by backend (plainfiles.share/pull take
// `(opts, seams)`; engram.share/pullMemory take one merged opts object) —
// each call below uses its own backend's real signature; the assertion is on
// the OUTCOME shape, not the call shape.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { share as plainfilesShare, pull as plainfilesPull } from './adapters/plainfiles.mjs';
import { share as engramShare, pullMemory as engramPullMemory } from './adapters/engram.mjs';

// ── share() — both backends reindex unconditionally, even with 0 records ───

test('reindex-parity: share() reindexes unconditionally on BOTH backends, even when there is nothing to append', async () => {
  const calls = { plainfiles: 0, engram: 0 };

  const plainResult = await plainfilesShare(
    { root: '/fake/plain-root' },
    { _rebuildIndex: () => { calls.plainfiles += 1; return { count: 0 }; } },
  );
  const engramResult = await engramShare({
    root: '/fake/engram-root',
    _rebuildIndex: () => { calls.engram += 1; return { count: 0 }; },
  });

  assert.equal(calls.plainfiles, 1, 'plainfiles.share() must call _rebuildIndex even with 0 records');
  assert.equal(calls.engram, 1, 'engram.share() must call _rebuildIndex even with 0 records — no conditional gate on "≥1 record appended"');
  assert.deepEqual(plainResult, { indexCount: 0, duplicates: { ids: 0, lines: 0, divergent: 0, groups: [] } });
  assert.deepEqual(engramResult, { indexCount: 0, duplicates: { ids: 0, lines: 0, divergent: 0, groups: [] } });
});

// ── pull path — both backends reindex, unconditionally, right after the git
//    pull step and BEFORE any hydrate/import ─────────────────────────────

test('reindex-parity: the pull path reindexes unconditionally on BOTH backends, right after git pull', async () => {
  const plainCalls = [];
  const plainResult = await plainfilesPull(
    { root: '/fake/plain-root' },
    {
      _gitPull: () => { plainCalls.push('gitPull'); },
      _rebuildIndex: (opts) => { plainCalls.push('rebuildIndex'); return { count: 0, opts }; },
    },
  );

  const engramCalls = [];
  const engramResult = await engramPullMemory({
    root: '/fake/engram-root',
    _gitPull: () => { engramCalls.push('gitPull'); },
    _rebuildIndex: (opts) => { engramCalls.push('rebuildIndex'); return { count: 0, opts }; },
    _import: () => { engramCalls.push('import'); },
  });

  assert.deepEqual(plainCalls, ['gitPull', 'rebuildIndex'], 'plainfiles.pull() must reindex right after git pull');
  assert.deepEqual(
    engramCalls,
    ['gitPull', 'rebuildIndex', 'import'],
    'engram pullMemory() must reindex right after git pull and BEFORE import — never gated on import having written anything',
  );
  assert.equal(plainResult.indexCount, 0);
  assert.equal(engramResult.indexCount, 0);
});

// ── the contract's own claim, pinned so the doc and the code cannot drift ──

test('reindex-parity: both backends derive the SAME recordsDir/indexPath shape from root, for both share() and the pull path', async () => {
  const shapes = [];

  await plainfilesShare(
    { root: '/r' },
    { _rebuildIndex: (opts) => { shapes.push(['plainfiles.share', opts]); return { count: 0 }; } },
  );
  await engramShare({
    root: '/r',
    _rebuildIndex: (opts) => { shapes.push(['engram.share', opts]); return { count: 0 }; },
  });
  await plainfilesPull(
    { root: '/r' },
    {
      _gitPull: () => {},
      _rebuildIndex: (opts) => { shapes.push(['plainfiles.pull', opts]); return { count: 0 }; },
    },
  );
  await engramPullMemory({
    root: '/r',
    _gitPull: () => {},
    _rebuildIndex: (opts) => { shapes.push(['engram.pullMemory', opts]); return { count: 0 }; },
    _import: () => {},
  });

  for (const [label, opts] of shapes) {
    assert.equal(opts.recordsDir, '/r/.memory/records', `${label} must derive recordsDir from root the same way`);
    assert.equal(opts.indexPath, '/r/.memory/index.jsonl', `${label} must derive indexPath from root the same way`);
  }
});
