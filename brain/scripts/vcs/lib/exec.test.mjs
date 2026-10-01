// exec.test.mjs — the launch-failure contract (#604).
//
// `spawnSync` reports a binary that does not exist in `r.error`, with
// `status: null` and `stdout`/`stderr` BOTH null. `run` used to drop `r.error`
// on the floor, so every caller downstream — `runJson`'s
// `failed (status ${status}): ${stderr}` above all — rendered "the binary is
// not installed" as an empty reason.
//
// Measured on #604: `brain:review` in a container without `gh` refused with
//   `gh api /user failed (status null): `
// and nothing after the colon. That is the `evidence-reader-empty-on-failure`
// family this repo keeps finding: "could not run" came out indistinguishable
// from "ran and printed nothing". They are DIFFERENT answers and the operator
// needs to tell them apart — here the difference is a missing binary versus a
// silently rejected credential.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';

import { run, runJson, setSpawn } from './exec.mjs';

const spawnFailedToLaunch = () => ({
  status: null, signal: null, stdout: null, stderr: null,
  error: Object.assign(new Error('spawnSync gh ENOENT'), { code: 'ENOENT' }),
});

test('run: a failure to launch surfaces the spawn error instead of an empty stderr (#604)', () => {
  setSpawn(spawnFailedToLaunch);
  try {
    const r = run('gh', ['api', '/user']);
    assert.equal(r.ok, false);
    assert.equal(r.status, null);
    assert.match(r.stderr, /ENOENT/, 'the reason must survive — an empty stderr says "nothing to report"');
    assert.match(r.stderr, /^gh: /, 'and it must name the command that could not be launched');
    assert.equal(r.error?.code, 'ENOENT', 'the raw error stays available to callers that want to branch on it');
  } finally {
    setSpawn(spawnSync);
  }
});

test('runJson: the thrown message carries the launch failure, not a bare "(status null): " (#604)', () => {
  setSpawn(spawnFailedToLaunch);
  try {
    assert.throws(
      () => runJson('gh', ['api', '/user']),
      (err) => {
        assert.match(err.message, /ENOENT/);
        assert.doesNotMatch(err.message, /\(status null\): $/, 'the exact shape #604 measured must not come back');
        return true;
      },
    );
  } finally {
    setSpawn(spawnSync);
  }
});

test('run: a command that RAN and said nothing keeps an empty stderr — the two stay distinguishable', () => {
  // The other side of the contract: this fix must not invent a reason where
  // the process genuinely ran and reported none.
  setSpawn(() => ({ status: 0, signal: null, stdout: '{}', stderr: '', error: undefined }));
  try {
    const r = run('gh', ['api', '/user']);
    assert.equal(r.ok, true);
    assert.equal(r.stderr, '', 'a clean run reports no reason, because there is none');
    assert.equal(r.error, null);
  } finally {
    setSpawn(spawnSync);
  }
});
