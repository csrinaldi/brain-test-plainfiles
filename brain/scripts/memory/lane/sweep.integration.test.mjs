// sweep.integration.test.mjs — sweepLanes() against a REAL temp repo, a
// REAL local bare `origin`, and REAL git (#936). One test per sweep-table
// row, plus remote-only, a diverged remote, and the "prior-day re-ship never
// absorbs today's newly collected records" scenario spec.md itself names.
// The VCS port is still a fake (no network) — mirrors ship.integration.test
// .mjs's own testing-strategy row. Never the real `.git`, never a live CLI
// spawn (#1012/#1024 guards) — `sweepLanes()` is called directly, as a
// function, against a `testTmp()` fixture root.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { testTmp } from '../../lib/test-tmp.mjs';
import { sweepLanes } from './sweep.mjs';
import { collectLane, defaultGit } from './collect.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'brain-test',
  GIT_AUTHOR_EMAIL: 'brain-test@example.com',
  GIT_COMMITTER_NAME: 'brain-test',
  GIT_COMMITTER_EMAIL: 'brain-test@example.com',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed: ${r.stderr}`);
  return r.stdout;
}

function recordJson(id, content) {
  return JSON.stringify({
    id, ts: '2026-09-01T00:00:00Z', actor: '@brain-test', actorKind: 'agent',
    type: 'discovery', project: 'brain', content,
  }) + '\n';
}

function addCandidate(mainDir, filename, content) {
  const dir = join(mainDir, '.memory', 'records');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf8');
  return join(dir, filename);
}

/** A bare `origin` and a `main` checkout pushed to it — mirrors
 * ship.integration.test.mjs's own fixture. */
function buildFixtureRepo() {
  const base = testTmp('brain-lane-sweep-');
  const originDir = join(base, 'origin.git');
  const mainDir = join(base, 'main');
  git(base, 'init', '--bare', '-q', originDir);
  git(base, 'init', '-q', '-b', 'main', mainDir);
  git(mainDir, 'remote', 'add', 'origin', originDir);
  git(mainDir, 'config', 'user.email', 'test@example.invalid');
  git(mainDir, 'config', 'user.name', 'brain-test');
  git(mainDir, 'commit', '-q', '--allow-empty', '-m', 'root');
  git(mainDir, 'push', '-q', '-u', 'origin', 'main');
  git(mainDir, 'fetch', '-q', 'origin');
  return { base, originDir, mainDir };
}

/** A recording, in-memory, NO-NETWORK vcs port fake, WITH mutable
 * `state`/`merged` per PR (#930/#936, D4) — a test can reach into `prs` and
 * simulate a human closing a PR between two sweep runs. */
function recordingVcs() {
  const calls = { mrList: 0, mrCreate: 0, mrAutoMerge: 0 };
  const prs = [];
  let nextNumber = 300;
  const vcs = {
    mrList: async () => {
      calls.mrList++;
      return prs.map((p) => ({ number: p.number, title: p.title, headBranch: p.headBranch, state: p.state, merged: p.merged }));
    },
    mrCreate: async ({ head, title }) => {
      calls.mrCreate++;
      const number = nextNumber++;
      prs.push({ number, headBranch: head, title, state: 'open', merged: false });
      return { url: `https://example.invalid/pull/${number}` };
    },
    mrAutoMerge: async () => {
      calls.mrAutoMerge++;
      return { enabled: true, url: null };
    },
  };
  return { vcs, calls, prs };
}

/** Squash-merges `commit`'s own tree into `main` — same plumbing as
 * ship.integration.test.mjs's own "R3 under a real squash" fixture — so the
 * merged content shares no commit ancestry with the lane ref at all. */
function squashMergeIntoMain(mainDir, originDir, commit) {
  const mainHead = git(mainDir, 'rev-parse', 'main').trim();
  const tree = git(mainDir, 'rev-parse', `${commit}^{tree}`).trim();
  const squashCommit = git(mainDir, 'commit-tree', tree, '-p', mainHead, '-m', 'squash merge lane').trim();
  git(mainDir, 'update-ref', 'refs/heads/main', squashCommit);
  git(mainDir, 'push', 'origin', 'main');
}

test('row: a delivered prior-day ref is deleted — no push, no PR lookup, no re-ship attempted', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  const file = addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1', 'x'));
  const collected = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-01' });
  rmSync(file);
  squashMergeIntoMain(mainDir, originDir, collected.commit);

  const { vcs, calls } = recordingVcs();
  const result = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });

  assert.equal(result.branches.length, 1);
  assert.equal(result.branches[0].action, 'deleted');
  assert.equal(result.branches[0].delivered, true);
  assert.deepEqual(calls, { mrList: 0, mrCreate: 0, mrAutoMerge: 0 }, 'a delivered ref must never reach the vcs port at all');

  const refCheck = spawnSync('git', ['rev-parse', '--verify', '--quiet', collected.ref], { cwd: mainDir, encoding: 'utf8' });
  assert.notEqual(refCheck.status, 0, 'the local ref must be gone after the sweep deletes it');
});

test('row: a pending prior-day ref (no PR yet) is re-shipped — pushed, PR created', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1', 'x'));
  const collected = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-01' });
  assert.ok(collected.commit);

  const { vcs, calls } = recordingVcs();
  const result = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });

  assert.equal(result.branches[0].action, 'shipped');
  assert.equal(calls.mrCreate, 1);
  const remoteSha = git(originDir, 'rev-parse', `refs/heads/${result.branches[0].branch}`).trim();
  assert.equal(remoteSha, collected.commit, 'the sweep-driven push must land the branch\'s own existing tip, unmodified');
});

test('row: a pending prior-day ref already pushed, PR still open ⇒ reconciled (no second push)', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1', 'x'));
  const collected = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-01' });

  const { vcs, calls } = recordingVcs();
  const first = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });
  assert.equal(first.branches[0].action, 'shipped');
  const shaAfterFirst = git(originDir, 'rev-parse', `refs/heads/${first.branches[0].branch}`).trim();

  const second = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });
  assert.equal(second.branches[0].action, 'reconciled');
  assert.equal(calls.mrCreate, 1, 'the second run must reuse the existing open PR, never create a second one');
  const shaAfterSecond = git(originDir, 'rev-parse', `refs/heads/${second.branches[0].branch}`).trim();
  assert.equal(shaAfterSecond, shaAfterFirst, 'nothing new to push on the reconcile-only run');
  assert.equal(collected.commit, shaAfterFirst);
});

test('row: pending, PR closed unmerged ⇒ closedUnmerged, never re-pushed, never reopened, on every subsequent run', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1', 'x'));
  collectLane({ root: mainDir, host: 'test-host', date: '2026-09-01' });

  const { vcs, prs } = recordingVcs();
  const first = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });
  assert.equal(first.branches[0].action, 'shipped');
  const branch = first.branches[0].branch;
  const shaAfterFirst = git(originDir, 'rev-parse', `refs/heads/${branch}`).trim();

  // A human closes the PR without merging it.
  prs[0].state = 'closed';
  prs[0].merged = false;

  const second = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });
  assert.equal(second.branches[0].action, 'closedUnmerged');
  assert.equal(second.branches[0].pr.number, prs[0].number);
  const shaAfterSecond = git(originDir, 'rev-parse', `refs/heads/${branch}`).trim();
  assert.equal(shaAfterSecond, shaAfterFirst, 'a closed-unmerged branch must never be re-pushed');

  // And it stays that way on a THIRD run — reported every time, never once.
  const third = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });
  assert.equal(third.branches[0].action, 'closedUnmerged');
});

test('row: unknown delivery state (origin/main unfetchable) is kept, never deleted, never re-shipped', async () => {
  const { mainDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1', 'x'));
  const collected = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-01' });

  // A real-git wrapper that fakes exactly one call — the initial `fetch
  // origin main` sweepLanes makes for baseFetched — and delegates every
  // other argv to the real git binary. Never touches the real `.git`: this
  // is still the same testTmp() bare-origin fixture as every other test
  // here, only ONE specific network-shaped call is short-circuited.
  const flakyGit = (argv, opts) => {
    if (argv[0] === 'fetch' && argv[2] === 'main') return { status: 1, stdout: '', stderr: 'fake offline' };
    return defaultGit(argv, opts);
  };

  const { vcs, calls } = recordingVcs();
  const result = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: flakyGit, vcs });

  assert.equal(result.branches[0].action, 'unknown');
  assert.equal(result.branches[0].delivered, null);
  assert.deepEqual(calls, { mrList: 0, mrCreate: 0, mrAutoMerge: 0 });
  const refCheck = spawnSync('git', ['rev-parse', '--verify', '--quiet', collected.ref], { cwd: mainDir, encoding: 'utf8' });
  assert.equal(refCheck.status, 0, 'an unknown-state ref must survive the sweep, untouched');
});

test('row: remote-only (no local ref) is reported as remoteOnly — nothing local is created, nothing is mutated', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1', 'x'));
  const collected = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-01' });
  git(mainDir, 'push', 'origin', `${collected.ref}:${collected.ref}`);
  git(mainDir, 'update-ref', '-d', collected.ref); // the LOCAL ref is gone — only origin has it now

  const { vcs, calls } = recordingVcs();
  const result = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });

  assert.equal(result.branches.length, 1);
  assert.equal(result.branches[0].where, 'remote');
  assert.equal(result.branches[0].action, 'remoteOnly');
  assert.deepEqual(calls, { mrList: 0, mrCreate: 0, mrAutoMerge: 0 }, 'a remote-only ref must never reach the vcs port');

  const localRefCheck = spawnSync('git', ['rev-parse', '--verify', '--quiet', collected.ref], { cwd: mainDir, encoding: 'utf8' });
  assert.notEqual(localRefCheck.status, 0, 'no local ref may be (re)created for a remote-only branch');
  const remoteSha = git(originDir, 'rev-parse', `refs/heads/${result.branches[0].branch}`).trim();
  assert.equal(remoteSha, collected.commit, 'the remote ref itself must be left exactly as it was');
});

test('row: a diverged remote leaves the remote sha unchanged, reports diverged, never force-pushes', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1', 'x'));
  const collected = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-01' });

  const { vcs } = recordingVcs();
  const first = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });
  assert.equal(first.branches[0].action, 'shipped');
  const branch = first.branches[0].branch;

  // A racing writer moves the remote ref to a commit sharing no history
  // with the local one — same technique as ship.integration.test.mjs's own
  // divergence fixture.
  const raceTree = git(mainDir, 'rev-parse', `${collected.commit}^{tree}`).trim();
  const raceCommit = git(mainDir, 'commit-tree', raceTree, '-m', 'racing writer').trim();
  git(mainDir, 'push', '--force', 'origin', `${raceCommit}:refs/heads/${branch}`);

  const second = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });
  assert.equal(second.branches[0].action, 'diverged');

  const remoteSha = git(originDir, 'rev-parse', `refs/heads/${branch}`).trim();
  assert.equal(remoteSha, raceCommit, 'the racing writer\'s ref move must survive — nothing was forced');
});

test('a re-shipped prior-day ref never absorbs today\'s newly collected records (spec.md\'s own scenario)', async () => {
  const { mainDir, originDir } = buildFixtureRepo();

  // Day 1 (prior day): collect its own record, then remove the candidate
  // file from disk — its bytes are now durable in day1's own lane ref,
  // mirroring the real operational flow where a collected candidate is not
  // re-collected forever.
  const day1File = addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-day1', 'day1'));
  const day1 = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-01' });
  rmSync(day1File);

  // Today: a DIFFERENT record, collected through today's own (separate)
  // lane ref — never touched by sweepLanes (D5, today is excluded).
  addCandidate(mainDir, '2026-09-rec-2222222222222222.jsonl', recordJson('rec-today', 'today'));
  const today = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-09' });
  assert.notEqual(today.ref, day1.ref);

  const { vcs } = recordingVcs();
  const result = await sweepLanes({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', today: '2026-09-09', git: defaultGit, vcs });

  assert.equal(result.branches.length, 1, 'today\'s own ref must never appear as a sweep row');
  assert.equal(result.branches[0].branch, day1.ref.replace(/^refs\/heads\//, ''));
  assert.equal(result.branches[0].action, 'shipped');

  const pushedTree = git(originDir, 'ls-tree', '-r', '--name-only', `refs/heads/${result.branches[0].branch}`);
  assert.match(pushedTree, /2026-09-rec-1111111111111111\.jsonl/);
  assert.doesNotMatch(pushedTree, /2026-09-rec-2222222222222222\.jsonl/, 'today\'s newly collected record must never enter the prior-day ref\'s tree');

  // And today's own ref, untouched by the sweep, must still exist locally,
  // never pushed or deleted by it.
  const todayRefCheck = spawnSync('git', ['rev-parse', '--verify', '--quiet', today.ref], { cwd: mainDir, encoding: 'utf8' });
  assert.equal(todayRefCheck.status, 0);
  const todayOnOrigin = spawnSync('git', ['ls-remote', '--heads', 'origin', today.ref], { cwd: originDir, encoding: 'utf8' });
  assert.equal(todayOnOrigin.stdout.trim(), '', 'today\'s own ref must never be pushed by the sweep');
});
