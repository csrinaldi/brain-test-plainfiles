// ship.integration.test.mjs — shipLane() against a REAL temp repo, a REAL
// local bare remote as `origin`, and REAL git — proving the invariants a
// pure-fake unit suite cannot: the pushed ref actually lands on a remote
// object database, a divergence is refused by real git, and the main
// checkout's working tree is genuinely untouched. The VCS port is still a
// fake (no network) — see design.md's testing strategy row 3/3a.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { testTmp } from '../../lib/test-tmp.mjs';
import { shipLane } from './ship.mjs';
import { collectLane } from './collect.mjs';

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
    id, ts: '2026-09-09T00:00:00Z', actor: '@brain-test', actorKind: 'agent',
    type: 'discovery', project: 'brain', content,
  }) + '\n';
}

function addCandidate(mainDir, filename, content) {
  const dir = join(mainDir, '.memory', 'records');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), content, 'utf8');
}

/** A bare `origin` and a `main` checkout pushed to it — mirrors
 * collect.integration.test.mjs's fixture, scoped to what shipLane needs. */
function buildFixtureRepo() {
  const base = testTmp('brain-lane-ship-');
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

/** A recording, in-memory, NO-NETWORK vcs port fake — never the real
 * providers. `mrList`/`mrCreate`/`mrAutoMerge` behave like a real forge only
 * in shape: idempotent find-by-headBranch, a monotonic PR number, an
 * unconditional arm. `mrList` reports `state`/`merged` (#930/#936, D4) — every
 * PR this fake ever creates opens `state:'open'/merged:false`, matching a
 * real forge; nothing in this file ever closes one, so `state`/`merged`
 * never change past creation here. */
function recordingVcs() {
  const calls = { mrList: 0, mrCreate: 0, mrAutoMerge: 0 };
  const prs = [];
  let nextNumber = 100;
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

test('the pushed ref lands on the remote with the expected tree', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));
  const { vcs } = recordingVcs();

  const result = await shipLane({
    root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs,
  });

  assert.equal(result.pushed, true);
  assert.equal(result.pr.number, 100);
  const remoteSha = git(originDir, 'rev-parse', `refs/heads/${result.branch}`).trim();
  assert.equal(remoteSha, result.commit, 'the remote ref must land exactly on the collected commit');
  const remoteTree = git(originDir, 'ls-tree', '-r', '--name-only', remoteSha);
  assert.match(remoteTree, /2026-09-rec-1111111111111111\.jsonl/);
});

test('a second same-day run fast-forwards and opens no second PR', async () => {
  const { mainDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));
  const { vcs, calls } = recordingVcs();

  const first = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });
  assert.equal(calls.mrCreate, 1);

  addCandidate(mainDir, '2026-09-rec-2222222222222222.jsonl', recordJson('rec-2222222222222222', 'y'));
  const second = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });

  assert.equal(second.pushed, true);
  assert.notEqual(second.commit, first.commit);
  assert.equal(calls.mrCreate, 1, 'a same-day re-run must open no second PR');
  assert.equal(calls.mrAutoMerge, 2, 'the arm step is unconditional on every run (D2)');
});

test('a remote ref moved behind our back is refused as diverged, exit non-zero, the remote sha unchanged', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));
  const { vcs, calls } = recordingVcs();

  const first = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });
  assert.equal(first.pushed, true);

  // A racing writer moves the remote ref out from under us: a sibling
  // commit sharing no history with `first.commit` (same technique as
  // collect.integration.test.mjs's B1.5 race simulation), pushed directly —
  // never through shipLane.
  const raceTree = git(mainDir, 'rev-parse', `${first.commit}^{tree}`).trim();
  const raceCommit = git(mainDir, 'commit-tree', raceTree, '-m', 'racing writer').trim();
  git(mainDir, 'push', '--force', 'origin', `${raceCommit}:refs/heads/${first.branch}`);

  await assert.rejects(
    () => shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs }),
    (err) => { assert.equal(err.diverged, true); return true; },
  );

  assert.equal(calls.mrCreate, 1, 'no PR call on the diverged run');
  const remoteSha = git(originDir, 'rev-parse', `refs/heads/${first.branch}`).trim();
  assert.equal(remoteSha, raceCommit, 'the racing writer\'s ref move must survive — nothing was forced');
});

test('a killed push (remote ref absent, local ref ahead) recovers on re-run — A1\'s recovery case', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));

  // Simulate a run whose push never landed: collect (mints the local ref)
  // runs directly, shipLane is never called, so origin never receives it.
  const collected = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-09' });
  assert.ok(collected.commit);

  const { vcs } = recordingVcs();
  const result = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });

  assert.equal(result.commit, null, 'this run collects nothing new — recovery from a stalled prior push');
  assert.equal(result.pushed, true, 'the recovery push must still happen because the local ref is ahead');
  const remoteSha = git(originDir, 'rev-parse', `refs/heads/${result.branch}`).trim();
  assert.equal(remoteSha, collected.commit);
});

/** A `recordingVcs()` whose `mrList` throws on the FIRST call only —
 * reproduces the audit's M1 finding: a push that already landed, an
 * `mrList` outage on the same run, and a retry that collects zero new
 * records. */
function recordingVcsThrowOnce() {
  const calls = { mrList: 0, mrCreate: 0, mrAutoMerge: 0 };
  const prs = [];
  let nextNumber = 200;
  let mrListCallCount = 0;
  const vcs = {
    mrList: async () => {
      calls.mrList++;
      mrListCallCount++;
      if (mrListCallCount === 1) throw new Error('gh api pulls failed: rate limited');
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
  return { vcs, calls };
}

// D4 (#936) supersedes the pre-#936 M1 finding below: M1's audit finding was
// that a push could land durably even though a LATER mrList lookup then
// failed — a partial effect. D4 moves that same lookup BEFORE the push
// (needed so a closedUnmerged decision can forbid the push itself), which
// closes that exact gap for a first-time create: an mrList outage now means
// NOTHING pushes at all, not a push that landed anyway.
test('D4 (#936) supersedes M1: mrList now runs before the push, so an outage on the first run pushes nothing at all; the retry pushes, creates the PR, and arms it cleanly', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));
  const { vcs, calls } = recordingVcsThrowOnce();

  await assert.rejects(
    () => shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs }),
    (err) => { assert.equal(err.prLookupFailed, true); return true; },
  );
  assert.throws(
    () => git(originDir, 'rev-parse', 'refs/heads/memory/test-host-2026-09-09'),
    /unknown revision/,
    'a prLookupFailed run must land nothing on origin now that the lookup runs before the push',
  );
  assert.equal(calls.mrCreate, 0);

  const second = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });

  assert.equal(second.pushed, true, 'nothing landed on the failed run, so the retry is a genuine push, not a reconcile-only one');
  assert.equal(second.reconciled, true);
  assert.ok(second.pr && second.pr.number, 'the retry must find/create the PR');
  assert.equal(calls.mrCreate, 1, 'exactly one PR is created, on the retry');
  const remoteSha = git(originDir, 'rev-parse', 'refs/heads/memory/test-host-2026-09-09').trim();
  assert.ok(remoteSha, 'the retry\'s push must land on origin');
});

test('R3 under a real squash: squash-merging the lane into main makes a same-day retry a true no-op (delivered:true)', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));
  const { vcs, calls } = recordingVcs();

  const first = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });
  assert.equal(first.pushed, true);
  assert.equal(calls.mrCreate, 1);

  // Simulate a real squash-merge of the lane's PR into `main` — auto-merge
  // is hardcoded `--squash` on both providers (R3), so `main`'s tree gains
  // the lane's tree EXACTLY, with no commit-ancestry relationship to the
  // lane ref at all (a `--is-ancestor` read would see this lane as pending
  // forever, re-pushing and re-opening a PR on every run).
  const mainHead = git(mainDir, 'rev-parse', 'main').trim();
  const laneTree = git(mainDir, 'rev-parse', `${first.commit}^{tree}`).trim();
  const squashCommit = git(mainDir, 'commit-tree', laneTree, '-p', mainHead, '-m', 'squash merge lane').trim();
  git(mainDir, 'update-ref', 'refs/heads/main', squashCommit);
  git(mainDir, 'push', 'origin', 'main');

  const callsBeforeSecond = { ...calls };
  const second = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });

  assert.equal(second.pushed, false, 'the lane is already on main — nothing to push');
  assert.equal(second.delivered, true);
  assert.equal(second.reconciled, false);
  assert.deepEqual(calls, callsBeforeSecond, 'a delivered lane must make zero push/list/create/arm calls');
  const remoteLaneSha = git(originDir, 'rev-parse', `refs/heads/${first.branch}`).trim();
  assert.equal(remoteLaneSha, first.commit, 'the lane ref itself is untouched by the squash-merge no-op');
});

test('#1050 repro: a same-day append after a squash-merge reparents onto origin/main — X is not re-listed', async () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));
  const { vcs } = recordingVcs();

  const first = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });
  assert.equal(first.pushed, true);

  // Squash-merge X into main — same plumbing as the "R3 under a real squash"
  // test above (auto-merge is hardcoded --squash on both providers, R3): no
  // commit-ancestry relationship between the lane ref and main survives.
  // Also delete the remote lane branch, matching the provider's own
  // delete-branch-on-merge convention this same auto-merge relies on
  // (design.md's Reparent note: a SURVIVING stale remote branch is a
  // different, already-documented case — `surveyRef` computes `behind>0`
  // and ship throws `diverged` rather than force-pushing over it).
  const mainHead = git(mainDir, 'rev-parse', 'main').trim();
  const laneTree = git(mainDir, 'rev-parse', `${first.commit}^{tree}`).trim();
  const squashCommit = git(mainDir, 'commit-tree', laneTree, '-p', mainHead, '-m', 'squash merge lane').trim();
  git(mainDir, 'update-ref', 'refs/heads/main', squashCommit);
  git(mainDir, 'push', 'origin', 'main');
  git(mainDir, 'push', 'origin', '--delete', first.branch);

  // NOW collect a genuinely new record Y on top of the (pre-squash) local
  // lane ref, and ship again — this is the bug's exact trigger: before
  // #936, the second commit still parented on X's pre-merge commit, so its
  // three-dot diff against origin/main re-derived X as "added by this lane"
  // forever.
  addCandidate(mainDir, '2026-09-rec-2222222222222222.jsonl', recordJson('rec-2222222222222222', 'y'));
  const second = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });

  assert.equal(second.pushed, true, 'Y is new content — this run must push');
  const secondParent = git(mainDir, 'rev-parse', `${second.commit}^`).trim();
  const originMainTip = git(originDir, 'rev-parse', 'main').trim();
  assert.equal(secondParent, originMainTip, "the new commit's parent must be origin/main's own tip, not X's pre-squash commit");

  const diffPaths = git(mainDir, 'diff', '--name-only', `origin/main...${second.commit}`)
    .trim().split('\n').filter(Boolean);
  assert.deepEqual(
    diffPaths,
    ['.memory/records/2026-09-rec-2222222222222222.jsonl'],
    'the three-dot diff (PR title/body/lane-paths) must list only Y — X must never be re-listed',
  );
});

test('a partially-delivered tip still appends on the existing tip — reparent only fires when EVERY lane path is delivered', async () => {
  const { mainDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));
  addCandidate(mainDir, '2026-09-rec-3333333333333333.jsonl', recordJson('rec-3333333333333333', 'z'));
  const { vcs } = recordingVcs();

  const first = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });
  assert.equal(first.pushed, true);

  // Land ONLY one of the lane's two paths directly on main (e.g. a human
  // cherry-picked a single record out of the lane's PR) — a partial
  // delivery: main gains rec-1111111111111111 but not rec-3333333333333333.
  // The file is already untracked-but-present on disk from `addCandidate`
  // above (collectLane never touches the working tree), so `git add` alone
  // stages it, byte-identical to what the lane shipped.
  git(mainDir, 'add', '.memory/records/2026-09-rec-1111111111111111.jsonl');
  git(mainDir, 'commit', '-q', '-m', 'cherry-pick one record onto main');
  git(mainDir, 'push', '-q', 'origin', 'main');

  addCandidate(mainDir, '2026-09-rec-2222222222222222.jsonl', recordJson('rec-2222222222222222', 'y'));
  const second = await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });

  assert.equal(second.pushed, true);
  const secondParent = git(mainDir, 'rev-parse', `${second.commit}^`).trim();
  assert.equal(secondParent, first.commit, 'a partially-delivered tip must keep appending on the existing tip, unchanged from today');
});

test('a stale/unfetchable base keeps appending on the existing tip — an unknown delivery state must never reparent', () => {
  const { mainDir, originDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));

  const first = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-09' });
  git(mainDir, 'push', '-q', 'origin', `${first.ref}:${first.ref}`);

  // Squash-merge X into main so it WOULD be delivered if this run's fetch
  // could see it — this test proves a fetch failure ALONE (baseStale) must
  // never reparent, delivered-on-the-remote or not.
  const mainHead = git(mainDir, 'rev-parse', 'main').trim();
  const laneTree = git(mainDir, 'rev-parse', `${first.commit}^{tree}`).trim();
  const squashCommit = git(mainDir, 'commit-tree', laneTree, '-p', mainHead, '-m', 'squash merge lane').trim();
  git(mainDir, 'update-ref', 'refs/heads/main', squashCommit);
  git(mainDir, 'push', 'origin', 'main');

  // Break the remote so THIS run's `git fetch origin main` fails. The stale
  // `refs/remotes/origin/main` from the prior successful fetch is still on
  // disk — a naive read would see the squash-merge and call it delivered;
  // `baseFetched` must gate that off.
  git(mainDir, 'remote', 'set-url', 'origin', join(mainDir, 'no-such-origin.git'));

  addCandidate(mainDir, '2026-09-rec-2222222222222222.jsonl', recordJson('rec-2222222222222222', 'y'));
  const second = collectLane({ root: mainDir, host: 'test-host', date: '2026-09-09' });

  assert.equal(second.baseFetched, false, "the broken remote must make this run's fetch fail");
  const secondParent = git(mainDir, 'rev-parse', `${second.commit}^`).trim();
  assert.equal(secondParent, first.commit, 'an unreadable delivery state must keep appending on the existing tip, never reparenting');
});

test('the main checkout is untouched: git status and HEAD are byte-identical before and after', async () => {
  const { mainDir } = buildFixtureRepo();
  addCandidate(mainDir, '2026-09-rec-1111111111111111.jsonl', recordJson('rec-1111111111111111', 'x'));
  const before = {
    status: git(mainDir, 'status', '--porcelain', '-uall'),
    head: git(mainDir, 'rev-parse', 'HEAD'),
  };

  const { vcs } = recordingVcs();
  await shipLane({ root: mainDir, project: 'x/y', tier: 'lite', host: 'test-host', date: '2026-09-09', vcs });

  const after = {
    status: git(mainDir, 'status', '--porcelain', '-uall'),
    head: git(mainDir, 'rev-parse', 'HEAD'),
  };
  assert.deepEqual(after, before, 'the ship touches no working tree (D6\'s scope boundary)');
});
