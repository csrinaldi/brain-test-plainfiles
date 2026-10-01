// hydration-guard.test.mjs — the machine-scoped, non-blocking guard around the
// engram adapter's import window (#820, memory 2.0 task 0.1). Real fs on a tmp
// path; only pid liveness and the clock are seams. Every case in spec.md of
// openspec/changes/issue-820-import-hydration-guard is pinned here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { testTmp } from '../../lib/test-tmp.mjs';
import { acquireHydrationGuard, withHydrationGuard, DEFAULT_LOCK_PATH, DEFAULT_STALE_MS } from './hydration-guard.mjs';

const lockIn = () => join(testTmp('hydration-guard-'), 'brain-memory-hydration.lock');
const alive = () => true;
const dead = () => false;

test('acquire: creates the lock with an owner record; release removes it', () => {
  const lockPath = lockIn();
  const g = acquireHydrationGuard({ lockPath, _pidAlive: alive, _now: () => 1000, _pid: 4242 });
  assert.equal(g.held, true);
  assert.equal(existsSync(lockPath), true);
  assert.deepEqual(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')), { pid: 4242, startedAt: 1000 });
  g.release();
  assert.equal(existsSync(lockPath), false);
});

test('contended: a live, young holder → held:false with the owner, lock untouched', () => {
  const lockPath = lockIn();
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 99, startedAt: 5000 }));
  const g = acquireHydrationGuard({ lockPath, _pidAlive: alive, _now: () => 5000 + 60_000 });
  assert.equal(g.held, false);
  assert.equal(g.owner.pid, 99);
  assert.equal(g.owner.ageMs, 60_000);
  assert.equal(existsSync(join(lockPath, 'owner.json')), true);
});

test('stale by dead pid: reclaimed, then held', () => {
  const lockPath = lockIn();
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 99, startedAt: 5000 }));
  const g = acquireHydrationGuard({ lockPath, _pidAlive: dead, _now: () => 6000, _pid: 1 });
  assert.equal(g.held, true);
  assert.equal(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')).pid, 1);
  g.release();
});

test('stale by age: a live holder older than staleMs is reclaimed', () => {
  const lockPath = lockIn();
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 99, startedAt: 0 }));
  const g = acquireHydrationGuard({ lockPath, staleMs: 1000, _pidAlive: alive, _now: () => 5000, _pid: 1 });
  assert.equal(g.held, true);
  g.release();
});

// ── rev-1 cold review of PR #872, cold-1: acquisition must be ONE atomic step ──

test('acquire is a single atomic rename — there is never a lock directory without its owner record', () => {
  const lockPath = lockIn();
  const g = acquireHydrationGuard({ lockPath, _pidAlive: alive, _now: () => 1000, _pid: 4242 });
  assert.equal(g.held, true);
  // No staging leftovers beside the lock, and the owner is inside the lock the moment it exists.
  const siblings = readdirSync(dirname(lockPath));
  assert.deepEqual(siblings, ['brain-memory-hydration.lock']);
  g.release();
});

test('a foreign owner-less directory at the lock path is NOT reclaimed while it is fresh — unknown is not stale', () => {
  const lockPath = lockIn();
  mkdirSync(lockPath); // no owner.json: not something this module ever creates
  writeFileSync(join(lockPath, 'something-else'), 'x'); // non-empty, so rename cannot replace it
  const g = acquireHydrationGuard({ lockPath, staleMs: 600_000, _pidAlive: alive, _now: () => Date.now(), _pid: 1 });
  assert.equal(g.held, false);
  assert.equal(g.owner.pid, -1);
});

test('a foreign owner-less directory older than staleMs IS reclaimed', () => {
  const lockPath = lockIn();
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'something-else'), 'x');
  const g = acquireHydrationGuard({ lockPath, staleMs: 1, _pidAlive: alive, _now: () => Date.now() + 60_000, _pid: 1 });
  assert.equal(g.held, true);
  g.release();
});

test('reclaim verifies the owner did not change under it — a fresh lock installed meanwhile is left alone', () => {
  const lockPath = lockIn();
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 99, startedAt: 5000 }));
  // The liveness probe is the last thing that runs before the reclaim decision; use it to
  // simulate another process replacing the stale lock with its own, fresh one.
  const pidAlive = (pid) => {
    if (pid === 99) {
      writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 77, startedAt: 6000 }));
      return false;
    }
    return true;
  };
  const g = acquireHydrationGuard({ lockPath, _pidAlive: pidAlive, _now: () => 6001, _pid: 1 });
  assert.equal(g.held, false, 'must not steal the fresh lock');
  assert.equal(g.owner.pid, 77);
  assert.deepEqual(JSON.parse(readFileSync(join(lockPath, 'owner.json'), 'utf8')), { pid: 77, startedAt: 6000 }, 'the fresh lock is back in place');
});

test('withHydrationGuard: runs fn when held and releases; a throw inside still releases', () => {
  const lockPath = lockIn();
  const ok = withHydrationGuard(() => 'ran', { lockPath, _pidAlive: alive });
  assert.deepEqual(ok, { held: true, result: 'ran' });
  assert.equal(existsSync(lockPath), false);
  assert.throws(() => withHydrationGuard(() => { throw new Error('boom'); }, { lockPath, _pidAlive: alive }), /boom/);
  assert.equal(existsSync(lockPath), false, 'released on throw');
});

test('withHydrationGuard: contended → fn is NOT called', () => {
  const lockPath = lockIn();
  mkdirSync(lockPath);
  writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 99, startedAt: 5000 }));
  let calls = 0;
  const r = withHydrationGuard(() => { calls++; }, { lockPath, _pidAlive: alive, _now: () => 5001 });
  assert.equal(r.held, false);
  assert.equal(calls, 0);
});

// ── rev-2 cold review of PR #872, cold-1: orphaned private dirs are swept ──

test('a CONTENDED acquire sweeps orphaned staging/tombstone siblings older than staleMs, and leaves fresh ones alone', () => {
  // (the uncontended fast path pays no readdir — see sweepOrphans)
  const lockPath = lockIn();
  const old = `${lockPath}.staging-1-abc`;
  const fresh = `${lockPath}.released-2-def`;
  mkdirSync(old); writeFileSync(join(old, 'owner.json'), '{}');
  mkdirSync(fresh); writeFileSync(join(fresh, 'owner.json'), '{}');
  const past = new Date(Date.now() - 3_600_000);
  utimesSync(old, past, past);
  // The sweep runs on the CONTENDED path only: make this acquire contend with a dead holder.
  mkdirSync(lockPath); writeFileSync(join(lockPath, 'owner.json'), JSON.stringify({ pid: 99, startedAt: 0 }));
  const g = acquireHydrationGuard({ lockPath, staleMs: 600_000, _pidAlive: dead, _pid: 3 });
  assert.equal(g.held, true);
  assert.equal(existsSync(old), false, 'old orphan swept');
  assert.equal(existsSync(fresh), true, 'fresh sibling untouched — it may be mid-rename');
  g.release();
});

test('defaults: machine-scoped path under tmpdir, not the repo; 10-minute staleness', () => {
  assert.match(DEFAULT_LOCK_PATH, /brain-memory-hydration\.lock$/);
  assert.doesNotMatch(DEFAULT_LOCK_PATH, /\.memory/);
  assert.equal(DEFAULT_STALE_MS, 600_000);
});
