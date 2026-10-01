// plainfiles.pull.test.mjs — unit tests for axes/memory/adapters/plainfiles.mjs#pull
// (C3, issue #246, REQ-C3-4). `pull()` = `_gitPull(root)` then
// `rebuildIndex()`, records-only, NO manifest-dirty-discard logic (Decision 4
// — plainfiles never materializes, git is the only writer, so a dirty tree
// is real work and must NEVER be auto-discarded).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED: pull is not exported from plainfiles.mjs yet.
import { pull } from './plainfiles.mjs';

// ── 2.10 — clean tree: _gitPull(root) then rebuildIndex(), no importMemory ──

test('pull: on a clean tree, runs _gitPull(root) then rebuildIndex() — records-only, no import call', async () => {
  const calls = [];
  const result = await pull(
    { root: '/fake/root' },
    {
      _gitPull: (root) => { calls.push(['gitPull', root]); },
      _rebuildIndex: (opts) => { calls.push(['rebuildIndex', opts]); return { count: 5 }; },
    },
  );

  assert.deepEqual(calls.map((c) => c[0]), ['gitPull', 'rebuildIndex'], 'gitPull must run BEFORE rebuildIndex');
  assert.equal(calls[0][1], '/fake/root');
  assert.deepEqual(result, { indexCount: 5, duplicates: { ids: 0, lines: 0, divergent: 0, groups: [] } });
});

// ── #574 — pull is where `merge=union` mints the duplicate ───────────────────

test('pull: reports the duplicates the just-merged records/ carries — the pull is what creates them', async () => {
  const duplicates = { ids: 1, lines: 1, divergent: 0, groups: [{ id: 'rec-a', occurrences: ['2026-07.jsonl:2', '2026-07.jsonl:7'] }] };
  const result = await pull(
    { root: '/fake/root' },
    {
      _gitPull: () => {},
      _rebuildIndex: () => ({ count: 4, duplicates }),
    },
  );

  assert.deepEqual(result.duplicates, duplicates);
});

// ── 2.11 — dirty tree: the underlying git error propagates unmodified ──────

test('pull: a dirty-tree git error propagates unmodified — no record discarded, no rebuildIndex call', async () => {
  let rebuildCalled = false;

  await assert.rejects(
    () =>
      pull(
        { root: '/fake/root' },
        {
          _gitPull: () => { throw new Error('Your local changes to the following files would be overwritten by merge'); },
          _rebuildIndex: () => { rebuildCalled = true; return { count: 0 }; },
        },
      ),
    (err) => {
      assert.ok(
        err.message.includes('would be overwritten by merge'),
        `the underlying git error message must propagate unmodified: ${err.message}`,
      );
      return true;
    },
  );

  assert.equal(rebuildCalled, false, 'rebuildIndex() must NOT run when git pull fails (dirty tree)');
});
