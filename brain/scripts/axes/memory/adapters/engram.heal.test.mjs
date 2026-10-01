// engram.heal.test.mjs — the executor half of the engram duplicate heal
// (#1061, #864 task 1.2a), exercised through its seams: no real `engram`, no
// real fs beyond a tmp dir the seams control. Mirrors audit-io.test.mjs's own
// `_probe`/`_exec`/`_read` shape (`audit-io.test.mjs:85-91`).
//
// `_probe` here answers `engram version`'s stdout (or `null` on absence),
// NOT the `which`-based presence probe backend-selection.mjs already owns —
// this heal needs the VERSION, not just a binary path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { healDuplicates, HEAL_DELETE_ARGS } from './engram.mjs';

const V1_20 = () => 'engram 1.20.0\n';

/** Two live rows sharing one key — the minimal duplicate shape. */
const DUP_EXPORT = {
  version: '0.1.0',
  observations: [
    { id: 3089, topic_key: 'rec-abc', content: 'c', title: 't', type: 'decision' },
    { id: 3092, topic_key: 'rec-abc', content: 'c', title: 't', type: 'decision' },
  ],
};
/** The same shape with the duplicate already gone — what a post-apply
 *  re-export (or a second run) must see. */
const HEALED_EXPORT = {
  version: '0.1.0',
  observations: [{ id: 3089, topic_key: 'rec-abc', content: 'c', title: 't', type: 'decision' }],
};

/**
 * Builds `_exec`/`_read` seams over an IN-MEMORY export, so no real fs or
 * binary is ever touched. `exports` is consumed in order: the Nth `export`
 * call returns `exports[N]` (clamped to the last entry once exhausted, the
 * way a store settles after the last mutation actually applied).
 */
function fakeExec({ exports, onDelete } = {}) {
  const files = new Map();
  let exportCalls = 0;
  const _exec = (bin, args) => {
    assert.equal(bin, 'engram');
    if (args[0] === 'export') {
      const doc = exports[Math.min(exportCalls, exports.length - 1)];
      exportCalls += 1;
      files.set(args[1], JSON.stringify(doc));
      return `Exported to ${args[1]}\n  Observations: ${doc.observations?.length ?? 0}\n`;
    }
    if (args[0] === 'delete') {
      onDelete?.(Number(args[1]));
      return `Observation #${args[1]} hard-deleted\n`;
    }
    throw new Error(`fakeExec: unexpected args ${JSON.stringify(args)}`);
  };
  const _read = (p) => {
    if (String(p).includes('.memory')) throw new Error('_read must never touch .memory');
    return files.get(p);
  };
  return { _exec, _read, exportCallCount: () => exportCalls };
}

// ── version guard ────────────────────────────────────────────────────────────

test('healDuplicates: a version outside 1.20.x makes no export and no delete calls', () => {
  const { _exec, _read } = fakeExec({ exports: [DUP_EXPORT] });
  let execCalls = 0;
  const result = healDuplicates({
    _probe: () => 'engram 2.0.0\n',
    _exec: (...a) => { execCalls++; return _exec(...a); },
    _read,
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal, 'version');
  assert.equal(execCalls, 0);
});

test('healDuplicates: an absent probe (null) refuses version with no export calls', () => {
  const { _exec, _read } = fakeExec({ exports: [DUP_EXPORT] });
  let execCalls = 0;
  const result = healDuplicates({
    _probe: () => null,
    _exec: (...a) => { execCalls++; return _exec(...a); },
    _read,
  });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal, 'version');
  assert.equal(execCalls, 0);
});

// ── dry-run ──────────────────────────────────────────────────────────────────

test('healDuplicates: dry-run makes 0 delete calls and reports the plan', () => {
  const deletes = [];
  const { _exec, _read } = fakeExec({ exports: [DUP_EXPORT], onDelete: (id) => deletes.push(id) });
  const result = healDuplicates({ apply: false, _probe: V1_20, _exec, _read });
  assert.equal(result.outcome, 'planned');
  assert.deepEqual(result.groups, [{ key: 'rec-abc', keep: 3089, delete: [3092] }]);
  assert.deepEqual(deletes, []);
});

test('healDuplicates: dry-run on a store with nothing duplicated reports outcome "none"', () => {
  const { _exec, _read } = fakeExec({ exports: [HEALED_EXPORT] });
  const result = healDuplicates({ apply: false, _probe: V1_20, _exec, _read });
  assert.equal(result.outcome, 'none');
});

// ── apply ────────────────────────────────────────────────────────────────────

test('healDuplicates: apply deletes ascending, one id at a time, with HEAL_DELETE_ARGS, then verifies healed', () => {
  const deletes = [];
  const { _exec, _read } = fakeExec({
    exports: [DUP_EXPORT, HEALED_EXPORT], // export#1 (plan) → export#2 (verify)
    onDelete: (id) => deletes.push(id),
  });
  const result = healDuplicates({ apply: true, _probe: V1_20, _exec, _read });
  assert.equal(result.outcome, 'healed');
  assert.deepEqual(result.deleted, [3092]);
  assert.deepEqual(deletes, [3092]);
});

test('HEAL_DELETE_ARGS: hard-deletes the numeric id', () => {
  assert.deepEqual(HEAL_DELETE_ARGS(3092), ['delete', '3092', '--hard']);
});

test('healDuplicates: a throw on the 2nd delete gives outcome "partial", stops immediately', () => {
  const threeWay = {
    version: '0.1.0',
    observations: [
      { id: 1, topic_key: 'rec-a', content: 'c', title: 't', type: 'decision' },
      { id: 2, topic_key: 'rec-a', content: 'c', title: 't', type: 'decision' },
    ],
  };
  // Two independent duplicate keys so there are two delete ids to walk: a then b.
  const twoGroups = {
    version: '0.1.0',
    observations: [
      { id: 10, topic_key: 'rec-a', content: 'c', title: 't', type: 'decision' },
      { id: 11, topic_key: 'rec-a', content: 'c', title: 't', type: 'decision' },
      { id: 20, topic_key: 'rec-b', content: 'c', title: 't', type: 'decision' },
      { id: 21, topic_key: 'rec-b', content: 'c', title: 't', type: 'decision' },
    ],
  };
  void threeWay;
  const { _exec, _read } = fakeExec({ exports: [twoGroups] });
  let deleteCalls = 0;
  const wrappedExec = (bin, args, opts) => {
    if (args[0] === 'delete') {
      deleteCalls += 1;
      if (deleteCalls === 2) throw new Error('engram: database is locked');
    }
    return _exec(bin, args, opts);
  };
  const result = healDuplicates({ apply: true, _probe: V1_20, _exec: wrappedExec, _read });
  assert.equal(result.outcome, 'partial');
  assert.deepEqual(result.deleted, [11]);
  assert.deepEqual(result.notDeleted, [21]);
  assert.equal(deleteCalls, 2, 'no further delete call after the throw');
});

test('healDuplicates: a post-apply re-export that still shows the duplicate gives "unverified"', () => {
  const { _exec, _read } = fakeExec({ exports: [DUP_EXPORT, DUP_EXPORT] }); // "delete" never actually removes it here
  const result = healDuplicates({ apply: true, _probe: V1_20, _exec, _read });
  assert.equal(result.outcome, 'unverified');
  assert.deepEqual(result.deleted, [3092]);
});

test('healDuplicates: a second apply run (already healed) makes 0 delete calls', () => {
  const deletes = [];
  const { _exec, _read } = fakeExec({ exports: [HEALED_EXPORT], onDelete: (id) => deletes.push(id) });
  const result = healDuplicates({ apply: true, _probe: V1_20, _exec, _read });
  assert.equal(result.outcome, 'none');
  assert.deepEqual(deletes, []);
});

// ── shape / refusal passthrough from the planner ────────────────────────────

test('healDuplicates: an export count mismatch (topicKeysFromExport throws) is a shape refusal, no delete calls', () => {
  const badExport = { version: '0.1.0', observations: [{ id: 1, topic_key: 'rec-a', content: 'c', title: 't', type: 'decision' }] };
  const files = new Map();
  let deleteCalls = 0;
  const _exec = (bin, args) => {
    if (args[0] === 'export') {
      files.set(args[1], JSON.stringify(badExport));
      return 'Exported\n  Observations: 99\n'; // disagrees with the 1 row in the file
    }
    if (args[0] === 'delete') deleteCalls += 1;
    return '';
  };
  const _read = (p) => files.get(p);
  const result = healDuplicates({ apply: true, _probe: V1_20, _exec, _read });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal, 'shape');
  assert.equal(deleteCalls, 0);
});

test('healDuplicates: a divergent group refuses, no delete calls', () => {
  const divergent = {
    version: '0.1.0',
    observations: [
      { id: 1, topic_key: 'rec-a', content: 'one', title: 't', type: 'decision' },
      { id: 2, topic_key: 'rec-a', content: 'two', title: 't', type: 'decision' },
    ],
  };
  const { _exec, _read } = fakeExec({ exports: [divergent] });
  let deleteCalls = 0;
  const wrapped = (bin, args, opts) => { if (args[0] === 'delete') deleteCalls += 1; return _exec(bin, args, opts); };
  const result = healDuplicates({ apply: true, _probe: V1_20, _exec: wrapped, _read });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal, 'divergent');
  assert.equal(deleteCalls, 0);
});

// ── isolation from `.memory` ─────────────────────────────────────────────────

test('healDuplicates: never reads a path under .memory', () => {
  const files = new Map();
  const _exec = (bin, args) => {
    files.set(args[1], JSON.stringify(HEALED_EXPORT));
    return 'Exported\n  Observations: 1\n';
  };
  const _read = (p) => {
    assert.doesNotMatch(String(p), /\.memory/, '_read must never be called on a .memory path');
    return files.get(p);
  };
  healDuplicates({ apply: false, _probe: V1_20, _exec, _read });
});
