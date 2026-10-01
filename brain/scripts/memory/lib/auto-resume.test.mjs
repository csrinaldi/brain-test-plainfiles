// scripts/memory/lib/auto-resume.test.mjs — unit tests for tryFeatureResume().
//
// Acceptance criteria (task 3.1 / REQ-S3-1 failure-isolated scenario):
//
//   (a) When spawned cli exits 0          → returns stdout string.
//   (b) When cli exits non-zero           → returns null, does NOT throw.
//   (c) When runner throws                → returns null, does NOT throw
//                                           (isolation proof: surrounding checkout
//                                           flow is unaffected by any resume failure).
//   (d) Exact stdout is returned          → triangulation with different values.
//   (e) Root is forwarded to the runner   → wiring verification.
//
// Notes:
//   - All tests use injectable _runner seam; no real subprocess spawned.
//   - Tests (b) and (c) together prove the isolation contract: tryFeatureResume
//     is fully isolated — it NEVER throws regardless of failure mode.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED: this import fails until auto-resume.mjs is created.
import { tryFeatureResume } from './auto-resume.mjs';

// ---------------------------------------------------------------------------
// (a) exits 0 → returns stdout string
// ---------------------------------------------------------------------------

test('tryFeatureResume: returns stdout string when cli exits 0', () => {
  const output = '  Feature:      my-feature\n  Next action:  implement the thing\n';
  const fakeRunner = () => ({ status: 0, stdout: output, stderr: '' });

  const result = tryFeatureResume('/fake/root', { _runner: fakeRunner });

  assert.equal(result, output, 'should return the stdout on exit 0');
});

// ---------------------------------------------------------------------------
// (b) exits non-zero → returns null, never throws
// ---------------------------------------------------------------------------

test('tryFeatureResume: returns null when cli exits non-zero', () => {
  const fakeRunner = () => ({ status: 1, stdout: '', stderr: 'error: ambiguous feature' });

  const result = tryFeatureResume('/fake/root', { _runner: fakeRunner });

  assert.equal(result, null, 'non-zero exit must return null');
});

// ---------------------------------------------------------------------------
// (c) runner throws → returns null, never throws (isolation proof)
// ---------------------------------------------------------------------------

test('tryFeatureResume: returns null when runner throws, never re-throws', () => {
  const fakeRunner = () => { throw new Error('node not found'); };

  let threw = false;
  let result;
  try {
    result = tryFeatureResume('/fake/root', { _runner: fakeRunner });
  } catch {
    threw = true;
  }

  assert.ok(!threw, 'tryFeatureResume must NOT throw even when runner throws');
  assert.equal(result, null, 'must return null when runner throws');
});

// ---------------------------------------------------------------------------
// (d) Triangulation — different stdout value and different root
// ---------------------------------------------------------------------------

test('tryFeatureResume: returns the exact stdout string on exit 0 (triangulation)', () => {
  const expected = 'slice: Slice-3\nnext_action: implement task 3.2\nblockers: none\n';
  const fakeRunner = () => ({ status: 0, stdout: expected, stderr: '' });

  const result = tryFeatureResume('/some/other/repo', { _runner: fakeRunner });

  assert.equal(result, expected, 'returned string must match stdout exactly');
});

// ---------------------------------------------------------------------------
// (e) Root is forwarded to the runner (wiring verification)
// ---------------------------------------------------------------------------

test('tryFeatureResume: passes root to the runner as first argument', () => {
  const capturedRoots = [];
  const fakeRunner = (root) => {
    capturedRoots.push(root);
    return { status: 0, stdout: 'ok', stderr: '' };
  };

  tryFeatureResume('/my/specific/root', { _runner: fakeRunner });

  assert.equal(capturedRoots.length, 1, 'runner should be called exactly once');
  assert.equal(capturedRoots[0], '/my/specific/root', 'runner must receive the root');
});

// #1127: feature-resume now exits 1 on a partial projection. The summary it
// printed BEFORE failing is still the operator's resume point — keep it, and say
// the projection was incomplete.
test('tryFeatureResume (#1127): a non-zero exit that printed a summary keeps it and names the incomplete projection', () => {
  const runner = () => ({
    status: 1,
    stdout: '\n  Feature:      my-feature\n  Next action:  do-the-thing\n',
    stderr: 'memory/cli: engram.featureResume() failed — featureResume: 1 of 2 file(s) were not projected into engram — proposal.md: engram exploded\n',
  });
  const out = tryFeatureResume('/fake/root', { _runner: runner });
  assert.match(out, /Next action:  do-the-thing/);
  assert.match(out, /projection incomplete: .*proposal\.md/);
});

test('tryFeatureResume (#1127): a non-zero exit WITHOUT the projection message is not labelled "projection incomplete"', () => {
  const runner = () => ({ status: 2, stdout: '\n  Feature: my-feature\n', stderr: 'memory/cli: something else entirely\n' }); // not 3/4: those are the declaration refusal (#1165)
  const out = tryFeatureResume('/fake/root', { _runner: runner });
  assert.match(out, /Feature: my-feature/);
  assert.doesNotMatch(out, /projection incomplete/);
  assert.match(out, /feature-resume exited 2/);
});

// #1165 S2: an undeclared-backend refusal must not read as "no resume point".
test('#1165 tryFeatureResume: exit 3 (backend undeclared) returns a line naming the cause and the fix, not null', () => {
  const out = tryFeatureResume('/r', { _runner: () => ({ status: 3, stdout: '', stderr: 'memory/cli: no memory backend is declared' }) });
  assert.match(out, /memory backend not declared/);
  assert.match(out, /brain:config -- set memory\.backend/);
});

test('#1165 tryFeatureResume: exit 4 (backend invalid) is named as invalid; other failures stay null', () => {
  assert.match(tryFeatureResume('/r', { _runner: () => ({ status: 4, stdout: '', stderr: '' }) }), /memory backend invalid/);
  assert.equal(tryFeatureResume('/r', { _runner: () => ({ status: 1, stdout: '', stderr: '' }) }), null);
});
