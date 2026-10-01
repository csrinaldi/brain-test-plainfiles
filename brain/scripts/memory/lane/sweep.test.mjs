// sweep.test.mjs — unit tests for sweepLanes() (#936). Every injected fn
// (`git`, `vcs`, `ship`) is a fake — no filesystem, no subprocess, no
// network, no real repo. See openspec/changes/issue-936-lane-branch-
// reconcile/{spec,design}.md for the requirements and decisions this file
// proves (D5, D7, the sweep table).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sweepLanes, noCollect } from './sweep.mjs';
import { emptyDuplicates } from '../lib/duplicates.mjs';

const ROOT = '/repo';
const TODAY = '2026-09-09';

const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const fail = (stderr = 'fail', status = 1) => ({ status, stdout: '', stderr });

/** A router-based fake `git`, mirroring ship.test.mjs's own pattern. Every
 * call is recorded with its `cwd`, so a single assertion can prove EVERY
 * call in a run passed `{ cwd: root }` (design's own guard). */
function fakeGit(rules) {
  const calls = [];
  const git = (argv, opts = {}) => {
    calls.push({ argv, cwd: opts.cwd });
    for (const rule of rules) {
      if (rule.match(argv)) return typeof rule.result === 'function' ? rule.result(argv, opts) : rule.result;
    }
    throw new Error(`fakeGit: no rule matched argv ${JSON.stringify(argv)}`);
  };
  return { git, calls };
}

const noVcs = { mrList: async () => { throw new Error('vcs must never be called directly by sweepLanes — only through the injected ship()'); } };

test('noCollect(): the injected collect seam never absorbs new records — commit:null, collected:0', () => {
  const result = noCollect('refs/heads/memory/host-2026-09-01', true);
  assert.deepEqual(result, {
    ref: 'refs/heads/memory/host-2026-09-01',
    commit: null,
    collected: 0,
    skipped: [],
    duplicates: emptyDuplicates(),
    baseFetched: true,
    skippedWorktrees: [],
  });
});

// ── Requirement: the sweep enumerates only THIS host's refs, never today's ──

test('filters: an exact host-slug match survives; a longer slug collision, a suffixed name, today\'s ref, and another host are all excluded', async () => {
  const refs = [
    'refs/heads/memory/gandalf-2026-09-01',              // survives
    'refs/heads/memory/gandalf-rog-zephyrus-2026-09-02', // D-sweep step 3: NOT a prefix match
    'refs/heads/memory/gandalf-2026-09-01-2',            // suffixed — no grammar match at all
    `refs/heads/memory/gandalf-${TODAY}`,                // today — excluded (D5)
    'refs/heads/memory/other-host-2026-09-03',           // another host entirely
  ].join('\n');

  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'fetch' && a[2] === 'main', result: fail('offline') }, // baseFetched:false, short-circuits contentDelivery
    { match: (a) => a[0] === 'for-each-ref', result: ok(refs) },
    { match: (a) => a[0] === 'ls-remote', result: ok('') },
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
  ]);

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs });

  assert.equal(result.branches.length, 1, `exactly one branch must survive every filter — got ${JSON.stringify(result.branches)}`);
  assert.equal(result.branches[0].branch, 'memory/gandalf-2026-09-01');
  assert.equal(result.branches[0].action, 'unknown');
  assert.equal(result.branches[0].reason, 'baseStale');

  assert.ok(calls.length > 0);
  for (const c of calls) assert.equal(c.cwd, ROOT, `every git call must pass cwd:root — got argv ${JSON.stringify(c.argv)} with cwd ${c.cwd}`);
});

test('remoteListed:false when ls-remote fails — the run still classifies local refs, never aborts', async () => {
  const { git } = fakeGit([
    { match: (a) => a[0] === 'fetch' && a[2] === 'main', result: ok() },
    { match: (a) => a[0] === 'for-each-ref', result: ok('') },
    { match: (a) => a[0] === 'ls-remote', result: fail('could not read from remote') },
  ]);

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs });
  assert.equal(result.remoteListed, false);
  assert.deepEqual(result.branches, []);
});

test('ascending date order: an older ref is processed before a newer one', async () => {
  const refs = [
    'refs/heads/memory/gandalf-2026-09-05',
    'refs/heads/memory/gandalf-2026-09-01',
  ].join('\n');
  const { git } = fakeGit([
    { match: (a) => a[0] === 'fetch' && a[2] === 'main', result: fail('offline') },
    { match: (a) => a[0] === 'for-each-ref', result: ok(refs) },
    { match: (a) => a[0] === 'ls-remote', result: ok('') },
    { match: (a) => a[0] === 'rev-parse', result: ok('deadbeef') },
  ]);

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs });
  assert.deepEqual(result.branches.map((b) => b.date), ['2026-09-01', '2026-09-05']);
});

// ── Requirement: row mapping (the sweep table) ──────────────────────────────

test('row: delivered by content ⇒ deleted, the local ref only, CAS\'d with the observed sha', async () => {
  const branch = 'memory/gandalf-2026-09-01';
  const ref = `refs/heads/${branch}`;
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'fetch' && a[2] === 'main', result: ok() },
    { match: (a) => a[0] === 'for-each-ref', result: ok(ref) },
    { match: (a) => a[0] === 'ls-remote', result: ok('') },
    { match: (a) => a[0] === 'rev-parse', result: ok('observedsha1') },
    { match: (a) => a[0] === 'diff', result: ok('') }, // empty three-dot diff -> delivered, no second diff needed
    { match: (a) => a[0] === 'update-ref' && a[1] === '-d', result: ok() },
  ]);

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs });

  assert.equal(result.branches.length, 1);
  assert.deepEqual(result.branches[0], { branch, date: '2026-09-01', where: 'local', action: 'deleted', delivered: true, pr: null, reason: null });
  const deleteCall = calls.find((c) => c.argv[0] === 'update-ref');
  assert.deepEqual(deleteCall.argv, ['update-ref', '-d', ref, 'observedsha1']);
});

test('row: unknown delivery (second diff fails) ⇒ kept and reported, never deleted or re-shipped', async () => {
  const branch = 'memory/gandalf-2026-09-01';
  const ref = `refs/heads/${branch}`;
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'fetch' && a[2] === 'main', result: ok() },
    { match: (a) => a[0] === 'for-each-ref', result: ok(ref) },
    { match: (a) => a[0] === 'ls-remote', result: ok('') },
    { match: (a) => a[0] === 'rev-parse', result: ok('sha1') },
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: fail('ambiguous') },
    { match: (a) => a[0] === 'diff', result: ok('.memory/records/2026-09-rec-1.jsonl') },
  ]);

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs });

  assert.deepEqual(result.branches[0], { branch, date: '2026-09-01', where: 'local', action: 'unknown', delivered: null, pr: null, reason: 'diffFailed' });
  assert.ok(!calls.some((c) => c.argv[0] === 'update-ref'), 'an unknown state must never delete the ref');
});

function pendingGitRules(ref) {
  return [
    { match: (a) => a[0] === 'fetch' && a[2] === 'main', result: ok() },
    { match: (a) => a[0] === 'for-each-ref', result: ok(ref) },
    { match: (a) => a[0] === 'ls-remote', result: ok('') },
    { match: (a) => a[0] === 'rev-parse', result: ok('sha1') },
    { match: (a) => a[0] === 'diff' && a.includes('--'), result: ok('.memory/records/2026-09-rec-1.jsonl') },
    { match: (a) => a[0] === 'diff', result: ok('.memory/records/2026-09-rec-1.jsonl') },
  ];
}

test('row: pending, ship() pushes ⇒ shipped; the injected collect seam is noCollect (never absorbs new records)', async () => {
  const branch = 'memory/gandalf-2026-09-01';
  const ref = `refs/heads/${branch}`;
  const { git } = fakeGit(pendingGitRules(ref));
  let shipArgs;
  const fakeShip = async (args) => {
    shipArgs = args;
    return { pushed: true, reconciled: true, closedUnmerged: false, delivered: false, deliveredReason: null, pr: { number: 5, url: null } };
  };

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs, ship: fakeShip });

  assert.deepEqual(result.branches[0], { branch, date: '2026-09-01', where: 'local', action: 'shipped', delivered: false, pr: { number: 5, url: null }, reason: null });
  assert.equal(shipArgs.date, '2026-09-01', 'the branch\'s OWN date is threaded to ship(), never today\'s');
  assert.deepEqual(shipArgs.collect(), noCollect(ref, true), 'the injected collect seam must be noCollect, bound to this branch\'s own ref');
});

test('row: pending, ship() reconciles without a push ⇒ reconciled', async () => {
  const branch = 'memory/gandalf-2026-09-01';
  const ref = `refs/heads/${branch}`;
  const { git } = fakeGit(pendingGitRules(ref));
  const fakeShip = async () => ({ pushed: false, reconciled: true, closedUnmerged: false, delivered: false, deliveredReason: null, pr: { number: 5, url: null } });

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs, ship: fakeShip });
  assert.equal(result.branches[0].action, 'reconciled');
});

test('row: pending, ship() reports closedUnmerged ⇒ closedUnmerged, never re-shipped, never reopened', async () => {
  const branch = 'memory/gandalf-2026-09-01';
  const ref = `refs/heads/${branch}`;
  const { git } = fakeGit(pendingGitRules(ref));
  const fakeShip = async () => ({ pushed: false, reconciled: false, closedUnmerged: true, delivered: false, deliveredReason: null, pr: { number: 11, url: null } });

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs, ship: fakeShip });
  assert.deepEqual(result.branches[0], { branch, date: '2026-09-01', where: 'local', action: 'closedUnmerged', delivered: false, pr: { number: 11, url: null }, reason: null });
});

test('row: pending, ship() throws diverged ⇒ diverged, never force, remains unresolved', async () => {
  const branch = 'memory/gandalf-2026-09-01';
  const ref = `refs/heads/${branch}`;
  const { git } = fakeGit(pendingGitRules(ref));
  const fakeShip = async () => { const e = new Error('memory.ship.diverged: refused'); e.diverged = true; throw e; };

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs, ship: fakeShip });
  assert.equal(result.branches[0].action, 'diverged');
  assert.match(result.branches[0].reason, /diverged/);
});

test('row: pending, ship() throws prLookupFailed (an mrList outage or an uncomputable state/merged field) ⇒ unknown, per spec\'s own scenario', async () => {
  const branch = 'memory/gandalf-2026-09-01';
  const ref = `refs/heads/${branch}`;
  const { git } = fakeGit(pendingGitRules(ref));
  const fakeShip = async () => { const e = new Error('memory.ship.prLookupFailed: mrList failed'); e.prLookupFailed = true; throw e; };

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs, ship: fakeShip });
  assert.equal(result.branches[0].action, 'unknown');
});

test('row: pending, ship() throws any other failure (e.g. pushFailed) ⇒ failed, never crashes the whole sweep', async () => {
  const refs = ['memory/gandalf-2026-09-01', 'memory/gandalf-2026-09-02'].map((b) => `refs/heads/${b}`).join('\n');
  const { git } = fakeGit(pendingGitRules(refs));
  let calls = 0;
  const fakeShip = async () => { calls++; const e = new Error('memory.ship.pushFailed: exited 1'); e.pushFailed = true; throw e; };

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs, ship: fakeShip });
  assert.equal(result.branches.length, 2, 'a failure on one branch must not stop the sweep from processing the next');
  for (const row of result.branches) assert.equal(row.action, 'failed');
  assert.equal(calls, 2);
});

test('row: remote-only ⇒ remoteOnly, nothing local is created, nothing is deleted, nothing is pushed', async () => {
  const branch = 'memory/gandalf-2026-09-01';
  const { git, calls } = fakeGit([
    { match: (a) => a[0] === 'fetch' && a[2] === 'main', result: ok() },
    { match: (a) => a[0] === 'for-each-ref', result: ok('') },
    { match: (a) => a[0] === 'ls-remote', result: ok(`deadbeef\trefs/heads/${branch}`) },
    { match: (a) => a[0] === 'fetch' && a[1] === 'origin' && a[2] === `+refs/heads/${branch}:refs/remotes/origin/${branch}`, result: ok() },
    { match: (a) => a[0] === 'diff', result: ok('') },
  ]);

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs });

  assert.deepEqual(result.branches[0], { branch, date: '2026-09-01', where: 'remote', action: 'remoteOnly', delivered: true, pr: null, reason: null });
  assert.ok(!calls.some((c) => c.argv[0] === 'update-ref'), 'a remote-only ref must never be mutated');
  assert.ok(!calls.some((c) => c.argv[0] === 'push'), 'a remote-only ref must never be pushed');
});

test('where:\'both\' — a branch present locally AND on the remote is still processed once, through the local classification path', async () => {
  const branch = 'memory/gandalf-2026-09-01';
  const ref = `refs/heads/${branch}`;
  const { git } = fakeGit([
    { match: (a) => a[0] === 'fetch' && a[2] === 'main', result: ok() },
    { match: (a) => a[0] === 'for-each-ref', result: ok(ref) },
    { match: (a) => a[0] === 'ls-remote', result: ok(`deadbeef\t${ref}`) },
    { match: (a) => a[0] === 'rev-parse', result: ok('sha1') },
    { match: (a) => a[0] === 'diff', result: ok('') },
    { match: (a) => a[0] === 'update-ref', result: ok() },
  ]);

  const result = await sweepLanes({ root: ROOT, project: 'x/y', tier: 'lite', host: 'gandalf', today: TODAY, git, vcs: noVcs });
  assert.equal(result.branches.length, 1, 'a branch present in both listings must produce exactly one row, never two');
  assert.equal(result.branches[0].where, 'both');
  assert.equal(result.branches[0].action, 'deleted');
});
