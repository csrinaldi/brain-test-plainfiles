// delivery.test.mjs — unit tests for contentDelivery() (#936, D3), the
// shared fail-closed helper extracted from ship.mjs's surveyDelivery (a pure
// extraction — no behavior change; see delivery.mjs's own doc comment).
// Every injected `git` is a fake — no filesystem, no subprocess, no network.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { contentDelivery } from './delivery.mjs';

const ROOT = '/repo';
const REV = 'deadbeef';

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = 'boom', status = 1) => ({ status, stdout: '', stderr });

/** A router-based fake `git`, matching ship.test.mjs's own style: `rules` is
 * an array of `{ match(argv) => bool, result }`, first match wins. Every
 * call is recorded in `calls`. */
function fakeGit(rules) {
  const calls = [];
  const git = (argv, opts) => {
    calls.push(argv);
    for (const rule of rules) {
      if (rule.match(argv)) return typeof rule.result === 'function' ? rule.result(argv, opts) : rule.result;
    }
    throw new Error(`fakeGit: no rule matched argv ${JSON.stringify(argv)}`);
  };
  return { git, calls };
}

test('baseFetched:false returns unknown/baseStale without reading git at all', () => {
  const { git, calls } = fakeGit([]);
  const result = contentDelivery({ git, root: ROOT, rev: REV, baseFetched: false });
  assert.deepEqual(result, { status: 'unknown', reason: 'baseStale' });
  assert.equal(calls.length, 0, 'a stale base must short-circuit before any git call');
});

test('the first diff failing (origin/main unresolvable) returns unknown/diffFailed', () => {
  const { git } = fakeGit([
    { match: (a) => a[0] === 'diff' && a[2] === `origin/main...${REV}`, result: fail('unknown revision') },
  ]);
  const result = contentDelivery({ git, root: ROOT, rev: REV, baseFetched: true });
  assert.deepEqual(result, { status: 'unknown', reason: 'diffFailed' });
});

test('an empty three-dot diff (the lane added nothing) returns delivered — vacuously true', () => {
  const { git } = fakeGit([
    { match: (a) => a[0] === 'diff' && a[2] === `origin/main...${REV}`, result: ok('') },
  ]);
  const result = contentDelivery({ git, root: ROOT, rev: REV, baseFetched: true });
  assert.deepEqual(result, { status: 'delivered', reason: null });
});

test('every lane path already present in origin/main (second diff empty) returns delivered', () => {
  const { git } = fakeGit([
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: ok('') },
    { match: (a) => a[0] === 'diff' && a[2] === `origin/main...${REV}`, result: ok('.memory/records/2026-09-rec-1.jsonl') },
  ]);
  const result = contentDelivery({ git, root: ROOT, rev: REV, baseFetched: true });
  assert.deepEqual(result, { status: 'delivered', reason: null });
});

test('some lane paths still undelivered (second diff non-empty) returns pending, never delivered', () => {
  const { git } = fakeGit([
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: ok('.memory/records/2026-09-rec-1.jsonl') },
    { match: (a) => a[0] === 'diff' && a[2] === `origin/main...${REV}`, result: ok('.memory/records/2026-09-rec-1.jsonl\n.memory/records/2026-09-rec-2.jsonl') },
  ]);
  const result = contentDelivery({ git, root: ROOT, rev: REV, baseFetched: true });
  assert.deepEqual(result, { status: 'pending', reason: null });
});

test('the second diff failing returns unknown/diffFailed, never delivered', () => {
  const { git } = fakeGit([
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: fail('exhausted') },
    { match: (a) => a[0] === 'diff' && a[2] === `origin/main...${REV}`, result: ok('.memory/records/2026-09-rec-1.jsonl') },
  ]);
  const result = contentDelivery({ git, root: ROOT, rev: REV, baseFetched: true });
  assert.deepEqual(result, { status: 'unknown', reason: 'diffFailed' });
});

test("argv is byte-identical to surveyDelivery's own pair: three-dot diff first, then the pathspec-scoped diff", () => {
  const paths = ['.memory/records/2026-09-rec-1.jsonl'];
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: ok('') },
    { match: (a) => a[0] === 'diff' && a[2] === `origin/main...${REV}`, result: ok(paths.join('\n')) },
  ]);
  contentDelivery({ git, root: ROOT, rev: REV, baseFetched: true });
  assert.deepEqual(calls[0], ['diff', '--name-only', `origin/main...${REV}`]);
  assert.deepEqual(calls[1], ['diff', '--name-only', REV, 'origin/main', '--', ...paths]);
});
