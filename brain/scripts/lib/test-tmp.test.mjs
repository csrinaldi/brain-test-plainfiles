// #842 — fixture hygiene: every fixture dir lives under ONE per-run root that
// dies with the process, and roots from DEAD runs are swept before the suite.
// The 11G lesson: 6686 orphaned fixture dirs turned the suite red with ENOSPC
// and no diff explained it. Per-test after() hooks do not survive a killed
// run; the mechanism must not depend on the process dying politely.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, existsSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { testTmp, createRunRoot, sweepStaleRuns } from './test-tmp.mjs';

test('testTmp: fixture dirs land under one per-run brain-test-<pid>- root, real fs', () => {
  const a = testTmp('unit-a-');
  const b = testTmp('unit-b-');
  assert.ok(existsSync(a) && existsSync(b));
  const root = join(a, '..');
  assert.equal(join(b, '..'), root, 'both fixtures share ONE run root');
  const rootName = root.split('/').pop();
  assert.match(rootName, new RegExp(`^brain-test-${process.pid}-`), 'root is keyed to THIS pid — the sweeper\'s liveness probe depends on it');
});

test('createRunRoot: registers exactly one exit-time removal of the root', () => {
  const registered = [];
  const removed = [];
  const base = testTmp('unit-ttmp-');
  const root = createRunRoot({
    base,
    pid: 4242,
    _register: (fn) => registered.push(fn),
    _rm: (p, opts) => removed.push({ p, opts }),
  });
  assert.match(root.split('/').pop(), /^brain-test-4242-/);
  assert.equal(registered.length, 1, 'one hook, not one per fixture');
  registered[0]();
  assert.equal(removed.length, 1);
  assert.equal(removed[0].p, root);
  assert.deepEqual(removed[0].opts, { recursive: true, force: true });
});

test('createRunRoot: an exit hook that throws stays silent — teardown never masks the exit', () => {
  const registered = [];
  const base = testTmp('unit-ttmp-');
  createRunRoot({
    base,
    pid: 4242,
    _register: (fn) => registered.push(fn),
    _rm: () => { throw new Error('EBUSY'); },
  });
  assert.doesNotThrow(() => registered[0]());
});

test('sweepStaleRuns: dead-pid roots are removed, live-pid and own roots are kept', () => {
  const base = testTmp('unit-sweep-');
  for (const name of ['brain-test-111-abc', 'brain-test-222-def', `brain-test-${process.pid}-own`, 'unrelated-dir']) {
    mkdirSync(join(base, name));
  }
  const res = sweepStaleRuns({ base, _isAlive: (pid) => pid === 222 });
  assert.deepEqual(res.swept, ['brain-test-111-abc']);
  assert.ok(!existsSync(join(base, 'brain-test-111-abc')));
  assert.ok(existsSync(join(base, 'brain-test-222-def')), 'live run untouched');
  assert.ok(existsSync(join(base, `brain-test-${process.pid}-own`)), 'own run untouched even without the liveness seam');
  assert.ok(existsSync(join(base, 'unrelated-dir')), 'non-matching names are NEVER touched — the sweeper owns one namespace only');
});

test('sweepStaleRuns: a root that refuses removal is reported kept, not thrown', () => {
  const base = testTmp('unit-sweep-');
  mkdirSync(join(base, 'brain-test-111-abc'));
  const res = sweepStaleRuns({ base, _isAlive: () => false, _rm: () => { throw new Error('EACCES'); } });
  assert.deepEqual(res.swept, []);
  assert.deepEqual(res.kept, ['brain-test-111-abc']);
});

test('sweepStaleRuns: an unreadable base degrades to a no-op result, never a crash', () => {
  const res = sweepStaleRuns({ base: join(testTmp('unit-sweep-'), 'DOES-NOT-EXIST') });
  assert.deepEqual(res, { swept: [], kept: [] });
});

test('sweepStaleRuns: real fs end-to-end — dead root with nested content is fully removed', () => {
  const base = testTmp('unit-sweep-');
  const dead = join(base, 'brain-test-999999-x');
  mkdirSync(join(dead, 'repo', '.git'), { recursive: true });
  writeFileSync(join(dead, 'repo', '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const res = sweepStaleRuns({ base, _isAlive: () => false });
  assert.deepEqual(res.swept, ['brain-test-999999-x']);
  assert.equal(readdirSync(base).length, 0);
});

test('#843: a live pid with an ANCIENT root is swept — pid reuse must not immortalize an orphan', () => {
  const base = testTmp('unit-sweep-');
  mkdirSync(join(base, 'brain-test-111-old'));
  mkdirSync(join(base, 'brain-test-222-fresh'));
  const DAY = 24 * 60 * 60 * 1000;
  const res = sweepStaleRuns({
    base,
    _isAlive: () => true,
    _now: () => 1_000_000_000_000,
    _stat: (p) => ({ mtimeMs: p.endsWith('-old') ? 1_000_000_000_000 - DAY - 1 : 1_000_000_000_000 - 60_000 }),
  });
  assert.deepEqual(res.swept, ['brain-test-111-old'], 'alive-but-ancient means the pid was reused');
  assert.ok(existsSync(join(base, 'brain-test-222-fresh')), 'a fresh live run is untouched');
});

test('#843: an unstatable root under a live pid stays kept — doubt favors the living', () => {
  const base = testTmp('unit-sweep-');
  mkdirSync(join(base, 'brain-test-333-x'));
  const res = sweepStaleRuns({ base, _isAlive: () => true, _stat: () => { throw new Error('EACCES'); } });
  assert.deepEqual(res.swept, []);
  assert.deepEqual(res.kept, ['brain-test-333-x']);
});
