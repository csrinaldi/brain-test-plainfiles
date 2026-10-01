// git-branch.test.mjs — unit tests for currentBranch() (issue #138, PR1).
//
// Single source of truth for "current git branch" detection, de-duplicating
// the two implementations that used to disagree (day-start.mjs's
// `--show-current` vs engram.mjs's `rev-parse --abbrev-ref HEAD`).
//
// Contract: returns the branch name on a named branch; returns `null` on
// detached HEAD (literal "HEAD" sentinel), on non-zero git status, and on
// git-absent/non-git dirs (spawn throws). NEVER throws.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { currentBranch } from './git-branch.mjs';

test('currentBranch: named branch → branch name', () => {
  const _spawn = () => ({ status: 0, stdout: 'feature/issue-138-session-start\n' });
  assert.equal(currentBranch('/repo', { _spawn }), 'feature/issue-138-session-start');
});

test('currentBranch: detached HEAD ("HEAD" sentinel) → null', () => {
  const _spawn = () => ({ status: 0, stdout: 'HEAD\n' });
  assert.equal(currentBranch('/repo', { _spawn }), null);
});

test('currentBranch: non-zero git status → null', () => {
  const _spawn = () => ({ status: 128, stdout: '' });
  assert.equal(currentBranch('/repo', { _spawn }), null);
});

test('currentBranch: spawn throws (git absent / non-git dir) → null', () => {
  const _spawn = () => { throw new Error('spawn git ENOENT'); };
  assert.equal(currentBranch('/repo', { _spawn }), null);
});

test('currentBranch: empty stdout on status 0 → null', () => {
  const _spawn = () => ({ status: 0, stdout: '' });
  assert.equal(currentBranch('/repo', { _spawn }), null);
});

test('currentBranch: uses spawn with cwd + encoding:utf8, no stdio:inherit', () => {
  let captured = null;
  const _spawn = (cmd, args, opts) => {
    captured = { cmd, args, opts };
    return { status: 0, stdout: 'main\n' };
  };
  currentBranch('/repo', { _spawn });
  assert.equal(captured.cmd, 'git');
  assert.deepEqual(captured.args, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(captured.opts.cwd, '/repo');
  assert.equal(captured.opts.encoding, 'utf8');
  assert.equal(captured.opts.stdio, undefined);
});

test('currentBranch: never throws even on malformed spy result', () => {
  const _spawn = () => undefined;
  assert.doesNotThrow(() => currentBranch('/repo', { _spawn }));
});
