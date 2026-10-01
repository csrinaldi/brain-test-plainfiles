// collect.integration.test.mjs — collectLane() against a REAL temp repo with a
// bare origin and two real `git worktree add` trees (#887 Slice B).
//
// A pure unit suite (plan.test.mjs) cannot prove the two invariants this
// slice exists for: "no working tree is touched" and "the secret never
// reaches the object database" are facts about a real git object database,
// not about a function's return value. This file proves them against real
// git plumbing, mirroring bootstrap.worktree.test.mjs's real-worktree
// pattern and cli.audit.test.mjs's fixture-repo pattern.
//
// See openspec/changes/issue-887-lane-collector/{spec,design}.md.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { testTmp } from '../../lib/test-tmp.mjs';
// removeTempTree, not a bare rmSync: this file spawns git AND recursively
// removes a directory (the deleted prunable worktree) — issue #800/#802's
// adoption rule for exactly that combination.
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { collectLane, defaultGit } from './collect.mjs';

const COLLECT_SOURCE = readFileSync(new URL('./collect.mjs', import.meta.url), 'utf8');

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

/** A minimal valid record body, one physical JSON line. */
function recordJson(id, content) {
  return JSON.stringify({
    id, ts: '2026-09-09T00:00:00Z', actor: '@brain-test', actorKind: 'agent',
    type: 'discovery', project: 'brain', content,
  }) + '\n';
}

const FILES = {
  alreadyOnMain: '2026-09-rec-aaaaaaaaaaaaaaaa.jsonl',
  identical: '2026-09-rec-1111111111111111.jsonl',
  divergent: '2026-09-rec-2222222222222222.jsonl',
  secretRecord: '2026-09-rec-3333333333333333.jsonl',
  modified: '2026-09-rec-4444444444444444.jsonl',
};

/**
 * Builds: a bare `origin`, a `main` checkout pushed to it (carrying one
 * record already tracked on main — the "already-on-main" fixture's path),
 * and two linked worktrees (`wt-a`, `wt-b`) each on their own branch.
 *
 *   wt-a: a tracked-then-locally-edited record (modified-tracked, ' M'),
 *         an untracked identical-bytes copy, an untracked divergent copy,
 *         an untracked secret-bearing record.
 *   wt-b: an untracked identical-bytes copy, an untracked divergent copy
 *         (different bytes, same filename), an untracked copy of the
 *         already-on-main filename (candidate-shaped, but skipped because
 *         the path is already in origin/main's tree).
 *
 * `wt-a` sorts lexicographically before `wt-b` (same prefix, 'a' < 'b'), so
 * the divergent group's winner is always wt-a's bytes — C2's tiebreak.
 */
function buildFixtureRepo() {
  const base = testTmp('brain-lane-');
  const originDir = join(base, 'origin.git');
  const mainDir = join(base, 'main');
  const wtADir = join(base, 'wt-a');
  const wtBDir = join(base, 'wt-b');

  git(base, 'init', '--bare', '-q', originDir);
  git(base, 'init', '-q', '-b', 'main', mainDir);
  git(mainDir, 'remote', 'add', 'origin', originDir);
  // Repo-local identity, not env: `collectLane()`'s own `commit-tree` call
  // (collect.mjs) never receives an `env` override, so it runs under
  // whatever identity the AMBIENT environment resolves — exactly D6's
  // "ambient identity, never a token" contract. `GIT_ENV` above only covers
  // the git commands THIS fixture builder issues directly; it never reaches
  // `collectLane`'s internal git calls. On a machine/CI runner with no
  // global/system identity configured, `commit-tree` fails with git's own
  // "Author identity unknown" (issue #897 cold-review CI finding) unless the
  // repo itself carries one — a linked `git worktree add` shares the common
  // `.git/config`, so setting it once here on `mainDir` covers `wt-a`/`wt-b`
  // too (same precedent as `records-merge.integration.test.mjs:56-57`).
  git(mainDir, 'config', 'user.email', 'test@example.invalid');
  git(mainDir, 'config', 'user.name', 'brain-test');

  // root commit WITHOUT the already-on-main file — both worktree branches
  // fork from here, so neither tracks it. If the file were already on `main`
  // when the worktrees branched, writing it there would be a no-op (git
  // status would show nothing at all — an untracked copy is only possible
  // for a file this branch never checked out).
  mkdirSync(join(mainDir, '.memory', 'records'), { recursive: true });
  writeFileSync(join(mainDir, '.memory', '.gitkeep'), '', 'utf8');
  git(mainDir, 'add', '.memory');
  git(mainDir, 'commit', '-q', '-m', 'root');
  git(mainDir, 'push', '-q', '-u', 'origin', 'main');
  git(mainDir, 'fetch', '-q', 'origin');

  git(mainDir, 'worktree', 'add', '-q', wtADir, '-b', 'lane-a');
  git(mainDir, 'worktree', 'add', '-q', wtBDir, '-b', 'lane-b');
  for (const wt of [wtADir, wtBDir]) mkdirSync(join(wt, '.memory', 'records'), { recursive: true });

  // NOW advance origin/main past the point both worktrees forked from, so
  // `mainPaths` includes this file while neither worktree branch tracks it —
  // the only way an untracked copy at the same path is possible at all.
  writeFileSync(
    join(mainDir, '.memory', 'records', FILES.alreadyOnMain),
    recordJson('rec-aaaaaaaaaaaaaaaa', 'already on main'),
    'utf8',
  );
  git(mainDir, 'add', join('.memory', 'records', FILES.alreadyOnMain));
  git(mainDir, 'commit', '-q', '-m', 'add the already-on-main record');
  git(mainDir, 'push', '-q', 'origin', 'main');
  git(mainDir, 'fetch', '-q', 'origin');

  // modified-tracked: commit ONE record on wt-a's own branch, scoped `add`
  // so the other untracked fixtures written below never get swept in.
  const modifiedPath = join('.memory', 'records', FILES.modified);
  writeFileSync(join(wtADir, modifiedPath), recordJson('rec-4444444444444444', 'original'), 'utf8');
  git(wtADir, 'add', modifiedPath);
  git(wtADir, 'commit', '-q', '-m', 'track one record on lane-a');
  writeFileSync(join(wtADir, modifiedPath), recordJson('rec-4444444444444444', 'edited locally, uncommitted'), 'utf8');

  // identical-bytes copy in both worktrees.
  const identicalContent = recordJson('rec-1111111111111111', 'identical copy');
  writeFileSync(join(wtADir, '.memory', 'records', FILES.identical), identicalContent, 'utf8');
  writeFileSync(join(wtBDir, '.memory', 'records', FILES.identical), identicalContent, 'utf8');

  // divergent copy: same filename, different bytes.
  writeFileSync(join(wtADir, '.memory', 'records', FILES.divergent), recordJson('rec-2222222222222222', 'version from wt-a'), 'utf8');
  writeFileSync(join(wtBDir, '.memory', 'records', FILES.divergent), recordJson('rec-2222222222222222', 'version from wt-b'), 'utf8');

  // secret-bearing record, wt-a only.
  writeFileSync(
    join(wtADir, '.memory', 'records', FILES.secretRecord),
    recordJson('rec-3333333333333333', `token ghp_${'x'.repeat(24)}`),
    'utf8',
  );

  // already-on-main: untracked in wt-b, same path as the file main already carries.
  writeFileSync(
    join(wtBDir, '.memory', 'records', FILES.alreadyOnMain),
    recordJson('rec-aaaaaaaaaaaaaaaa', 'already on main'),
    'utf8',
  );

  return { base, originDir, mainDir, wtADir, wtBDir };
}

/** `git status --porcelain -uall` snapshots, main + both worktrees. */
function statusSnapshot({ mainDir, wtADir, wtBDir }) {
  return {
    main: git(mainDir, 'status', '--porcelain', '-uall'),
    wtA: git(wtADir, 'status', '--porcelain', '-uall'),
    wtB: git(wtBDir, 'status', '--porcelain', '-uall'),
  };
}

function headSnapshot({ mainDir, wtADir, wtBDir }) {
  return {
    main: git(mainDir, 'rev-parse', 'HEAD'),
    wtA: git(wtADir, 'rev-parse', 'HEAD'),
    wtB: git(wtBDir, 'rev-parse', 'HEAD'),
  };
}

/** Wraps defaultGit, recording every argv this module issues. */
function countingGit() {
  const calls = [];
  const git = (argv, opts) => {
    calls.push(argv);
    return defaultGit(argv, opts);
  };
  return { git, calls };
}

test('B1.1/B1.2 — collects clean candidates, routes every skip, and touches no working tree or index', () => {
  const repo = buildFixtureRepo();
  const before = { status: statusSnapshot(repo), head: headSnapshot(repo) };

  const result = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' });

  assert.equal(result.ref, 'refs/heads/memory/test-host-2026-09-09');
  assert.ok(result.commit, 'a run with candidates must produce a commit');
  assert.equal(result.baseFetched, true);

  // identical (1) + divergent winner (1) = 2 collected; secret/already-on-main/modified-tracked all skipped.
  assert.equal(result.collected, 2);

  const reasons = Object.fromEntries(result.skipped.map((s) => [s.file, s.reason]));
  assert.equal(reasons[FILES.alreadyOnMain], 'already-on-main');
  assert.equal(reasons[FILES.modified], 'modified-tracked');
  assert.equal(reasons[FILES.secretRecord], 'secret');
  const secretSkip = result.skipped.find((s) => s.file === FILES.secretRecord);
  assert.ok(secretSkip.pattern && secretSkip.lineNumber, 'a secret skip carries pattern + lineNumber only');
  assert.ok(!('line' in secretSkip), 'the matched line text must never be attached to the skip entry');

  // both the identical-bytes filename and the divergent filename repeat
  // across the two worktrees, so both are duplicate GROUPS; only the
  // divergent one is marked divergent (A6: byte difference drives the
  // tiebreak, canonical difference drives the `divergent` flag).
  assert.equal(result.duplicates.ids, 2);
  assert.equal(result.duplicates.divergent, 1);

  const after = { status: statusSnapshot(repo), head: headSnapshot(repo) };
  assert.deepEqual(after.status, before.status, 'git status --porcelain -uall must be byte-identical before/after in every worktree');
  assert.deepEqual(after.head, before.head, 'HEAD must be unchanged in every worktree');

  const winnerBlob = git(repo.mainDir, 'cat-file', '-p', `${result.commit}:${'.memory/records/' + FILES.divergent}`);
  assert.match(winnerBlob, /version from wt-a/, 'C2 tiebreak: the lexicographically-first worktree path wins');
});

test('B1.3 — the secret never reaches the object database', () => {
  const repo = buildFixtureRepo();
  const secretFile = join(repo.wtADir, '.memory', 'records', FILES.secretRecord);

  const result = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' });

  // the would-be blob id, computed the same way the shell would have (no -w: never written for real here).
  // From the file's path, not `--stdin` with the `input` option: a piped stdin never sees EOF in the cold reviewer's sandbox (#1221).
  const wouldBeOid = execFileSync('git', ['hash-object', '--no-filters', secretFile], { cwd: repo.mainDir, encoding: 'utf8' }).trim();
  const catFile = spawnSync('git', ['cat-file', '-e', wouldBeOid], { cwd: repo.mainDir, encoding: 'utf8' });
  assert.notEqual(catFile.status, 0, 'the secret-bearing blob must never have been written with hash-object -w');

  const lsTree = git(repo.mainDir, 'ls-tree', '-r', result.commit);
  assert.doesNotMatch(lsTree, new RegExp(FILES.secretRecord), 'the secret-bearing path must be absent from the committed tree');

  const dump = JSON.stringify(result);
  assert.doesNotMatch(dump, /ghp_x{24}/, 'the matched secret literal must never appear in the returned shape');
});

test('B1.4 — ref lifecycle: first run creates, same-day re-run appends, a third no-op run leaves it untouched', () => {
  const repo = buildFixtureRepo();

  const first = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' });
  assert.ok(first.commit);
  // one commit AHEAD of origin/main — rev-list --count on the ref itself
  // would also count origin/main's own history, which this fixture seeds
  // with more than zero commits.
  assert.equal(git(repo.mainDir, 'rev-list', '--count', `origin/main..${first.ref}`).trim(), '1');
  const refList1 = git(repo.mainDir, 'for-each-ref', 'refs/heads/memory/').split('\n').filter(Boolean);
  assert.equal(refList1.length, 1, 'exactly one refs/heads/memory/* entry — never a -<n> branch');

  // a new candidate appears after the first run.
  const newFile = '2026-09-rec-5555555555555555.jsonl';
  writeFileSync(join(repo.wtBDir, '.memory', 'records', newFile), recordJson('rec-5555555555555555', 'second batch'), 'utf8');

  const second = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' });
  assert.ok(second.commit);
  assert.notEqual(second.commit, first.commit);
  assert.equal(git(repo.mainDir, 'rev-list', '--count', `origin/main..${second.ref}`).trim(), '2');
  const parentOfSecond = git(repo.mainDir, 'rev-parse', `${second.commit}^`).trim();
  assert.equal(parentOfSecond, first.commit, 'the append parents off the ref\'s prior tip, not origin/main again');
  const refList2 = git(repo.mainDir, 'for-each-ref', 'refs/heads/memory/').split('\n').filter(Boolean);
  assert.equal(refList2.length, 1, 'still exactly one refs/heads/memory/* entry after the append');
  // C1: the identical/divergent winners re-enter `plan.files` on this second
  // run (they are still untracked candidates on disk, and `mainPaths` is
  // filtered against origin/main, never the lane ref) — but only `newFile`
  // is an actual NEW blob relative to the ref's prior tip. `collected` and
  // the commit subject must both reflect that, not the planner's per-run
  // winner count.
  assert.equal(second.collected, 1, 'only the genuinely new file counts as collected on a same-day re-run');
  const secondSubject = git(repo.mainDir, 'log', '-1', '--format=%s', second.commit).trim();
  assert.match(
    secondSubject,
    /\(1 records\)$/,
    'the commit subject must count only the newly-added file, not the group winners re-included from the ref tip',
  );

  // a third run with nothing new.
  const tipBeforeThird = git(repo.mainDir, 'rev-parse', second.ref).trim();
  const third = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' });
  assert.equal(third.commit, null);
  assert.equal(git(repo.mainDir, 'rev-parse', second.ref).trim(), tipBeforeThird, 'the ref sha is unchanged when there is nothing new to collect');
});

test('B1.5 — a lost CAS race exits non-zero as `raced`, leaves the ref untouched by this run, and is never retried', () => {
  const repo = buildFixtureRepo();
  const first = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' });
  assert.ok(first.commit);

  // a new candidate for the second run.
  const newFile = '2026-09-rec-6666666666666666.jsonl';
  writeFileSync(join(repo.wtBDir, '.memory', 'records', newFile), recordJson('rec-6666666666666666', 'raced batch'), 'utf8');

  // a racing writer: right when OUR run issues `update-ref`, force-move the
  // ref out from under it first, using a raw git call outside the seam —
  // simulating a second collector that won the race in between our plan-time
  // tip observation and our own update-ref call.
  const raceTree = git(repo.mainDir, 'rev-parse', `${first.commit}^{tree}`).trim();
  const raceCommit = git(repo.mainDir, 'commit-tree', raceTree, '-m', 'racing writer').trim();
  let updateRefCalls = 0;
  const racingGit = (argv, opts) => {
    if (argv[0] === 'update-ref') {
      updateRefCalls += 1;
      git(repo.mainDir, 'update-ref', first.ref, raceCommit);
    }
    return defaultGit(argv, opts);
  };

  assert.throws(
    () => collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host', git: racingGit }),
    (err) => {
      assert.equal(err.raced, true);
      assert.match(err.message, /raced|memory\.collect\.raced/i);
      return true;
    },
  );

  assert.equal(updateRefCalls, 1, 'the CAS is attempted exactly once — a lost race is never retried');
  assert.equal(git(repo.mainDir, 'rev-parse', first.ref).trim(), raceCommit, 'the racing writer\'s ref move survives — our run did not overwrite it');
});

test('E2 — an update-ref failure with a non-CAS stderr shape is reported as a genuine failure, never tagged `raced`', () => {
  const repo = buildFixtureRepo();
  const first = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' });
  assert.ok(first.commit);

  const newFile = '2026-09-rec-7777777777777777.jsonl';
  writeFileSync(join(repo.wtBDir, '.memory', 'records', newFile), recordJson('rec-7777777777777777', 'e2 batch'), 'utf8');

  // a stubbed `update-ref` failure that is NOT one of git's real CAS-lock
  // shapes ("cannot lock ref", "reference already exists", "is at ... but
  // expected") — a disk-pressure/permissions-class failure, say.
  const failingGit = (argv, opts) => {
    if (argv[0] === 'update-ref') {
      return { status: 128, stdout: '', stderr: 'fatal: Unable to create directory: No space left on device' };
    }
    return defaultGit(argv, opts);
  };

  assert.throws(
    () => collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host', git: failingGit }),
    (err) => {
      assert.notEqual(err.raced, true, 'a non-lock/non-CAS stderr must never be tagged raced');
      assert.match(err.message, /No space left on device/, 'the genuine git failure message must survive, unrewritten');
      assert.doesNotMatch(err.message, /memory\.collect\.raced/, 'the raced prefix belongs only to a real CAS loss');
      return true;
    },
  );
});

test('B1.6 — scope + seam guard: every `-C` call is a `status`, no push, no worktree prune, no PR/hook code', () => {
  const repo = buildFixtureRepo();

  // a real prunable worktree: add one, then delete its directory from disk —
  // git now reports it `prunable` in `worktree list --porcelain`.
  const prunableDir = join(repo.base, 'wt-prunable');
  git(repo.mainDir, 'worktree', 'add', '-q', prunableDir, '-b', 'lane-prunable');
  removeTempTree(prunableDir);

  const { git: recordingGit, calls } = countingGit();
  const result = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host', git: recordingGit });
  assert.ok(result.commit);

  for (const argv of calls) {
    if (argv[0] === '-C') assert.equal(argv[2], 'status', `every -C call must be a status call, got: ${argv.join(' ')}`);
    assert.notEqual(argv[0], 'push', 'lane/collect.mjs must never push');
    assert.notEqual(argv.includes('prune'), true, 'git worktree prune must never be invoked');
  }
  assert.ok(!calls.some((argv) => argv[0] === '-C' && argv[1] === prunableDir), 'a prunable worktree must never be status-checked');

  assert.doesNotMatch(COLLECT_SOURCE, /(['"])push\1/, 'no push argv literal may exist in the source at all');
  assert.doesNotMatch(COLLECT_SOURCE, /pull-request|mrCreate|mrAutoMerge/i, 'no PR-body builder or PR call may exist');
  assert.doesNotMatch(COLLECT_SOURCE, /hooks?\//i, 'no hook invocation may exist');

  git(repo.mainDir, 'worktree', 'prune');
});

test('cold-1 — a staged rename record is one candidate (the new path), never split into a bogus old-path entry from parseStatusZ\'s NUL split', () => {
  // `git status --porcelain -z -uall` emits a rename/copy record as TWO
  // NUL-terminated parts: `R  <newpath>\0<oldpath>\0` — the second part is
  // the bare pre-image path, with no status-code prefix at all. A parser
  // that treats every NUL-delimited part as its own `{status, path}` entry
  // slices two arbitrary characters off the front of that bare path as if
  // they were a status code, manufacturing a second, bogus candidate that
  // was never a real status line.
  const base = testTmp('brain-lane-rename-');
  const originDir = join(base, 'origin.git');
  const mainDir = join(base, 'main');
  git(base, 'init', '--bare', '-q', originDir);
  git(base, 'init', '-q', '-b', 'main', mainDir);
  git(mainDir, 'remote', 'add', 'origin', originDir);
  git(mainDir, 'config', 'user.email', 'test@example.invalid');
  git(mainDir, 'config', 'user.name', 'brain-test');

  const recordsDir = join(mainDir, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  const oldFile = '2026-09-rec-aaaaaaaaaaaaaaaa.jsonl';
  const newFile = '2026-09-rec-bbbbbbbbbbbbbbbb.jsonl';
  writeFileSync(join(recordsDir, oldFile), recordJson('rec-aaaaaaaaaaaaaaaa', 'renamed record'), 'utf8');
  git(mainDir, 'add', join('.memory', 'records', oldFile));
  git(mainDir, 'commit', '-q', '-m', 'track the record that will be renamed');
  git(mainDir, 'push', '-q', '-u', 'origin', 'main');
  git(mainDir, 'fetch', '-q', 'origin');

  // `git mv` stages both sides of the rename in one step; content is
  // byte-identical, so git's default rename detection reports it as a
  // single `R ` record, not a delete+add pair.
  git(mainDir, 'mv', join('.memory', 'records', oldFile), join('.memory', 'records', newFile));

  const statusZOut = git(mainDir, 'status', '--porcelain', '-z', '-uall', '--', '.memory/records');
  assert.match(statusZOut, /^R {2}/, 'the fixture must actually produce a staged rename record, or this test proves nothing');

  const result = collectLane({ root: mainDir, date: '2026-09-09', host: 'test-host' });

  const relevant = result.skipped.filter((s) => s.file === oldFile || s.file === newFile);
  assert.equal(relevant.length, 1, 'the rename must route to exactly one skip entry — the bare old-path NUL part must never become its own candidate');
  assert.equal(relevant[0].file, newFile, 'the surviving entry must be the new path, not a mangled slice of the old one');
  assert.equal(relevant[0].reason, 'unexpected-status');
  assert.equal(relevant[0].code, 'R ', 'the header comment\'s own claim: a rename falls through as unexpected-status');
});

// ── #712 — a secret policy that cannot be read is not the default secret
// policy. T-C1/T-C2 use `buildFixtureRepo()` — the SAME real git repo every
// other test in this file drives — rather than a hand-rolled canned `git`
// seam: every sibling git step (fetch, rev-parse, worktree list, ls-tree,
// status) runs for real and succeeds, so the read under test is the ONLY
// thing that can make either test fail. `loadConfig` is NOT injected in
// either test — it is the unit.

test('T-C1 — an unreadable brain.config.json makes collectLane throw, naming the file and the parse failure (#712, REQ-SCAN-1/4)', () => {
  const repo = buildFixtureRepo();
  // present but unparseable, at the scanned root (`collectLane`'s `root`,
  // not the git plumbing) — a real repo means every sibling git call below
  // this read (worktree list, ls-tree, status) has already succeeded before
  // the read runs, so a git failure cannot make this test pass for the
  // wrong reason.
  writeFileSync(join(repo.mainDir, 'brain.config.json'), '{ not valid json', 'utf8');

  assert.throws(
    () => collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' }),
    (err) => {
      assert.match(err.message, /brain\.config\.json/, 'the message must name the file');
      assert.match(err.message, /could not be parsed/, 'the message must name the failure kind');
      return true;
    },
  );
});

// ── #921 — an unreadable worktree is reported, never silently dropped ──────

test('#921 — a worktree whose `git status` fails is recorded in skippedWorktrees with its path and reason, and does not silence the other worktree\'s real candidates', () => {
  const repo = buildFixtureRepo();

  // wt-b's `-C status` call fails (simulating an unreadable worktree —
  // permissions, a corrupted .git file, whatever the real cause); every
  // other call (including wt-a's own status) passes straight through to
  // the real git plumbing.
  const flakyGit = (argv, opts) => {
    if (argv[0] === '-C' && argv[1] === repo.wtBDir && argv[2] === 'status') {
      return { status: 128, stdout: '', stderr: 'fatal: could not read worktree' };
    }
    return defaultGit(argv, opts);
  };

  const result = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host', git: flakyGit });

  assert.equal(result.skippedWorktrees.length, 1, 'exactly one worktree must be reported skipped');
  assert.equal(result.skippedWorktrees[0].path, repo.wtBDir);
  assert.match(result.skippedWorktrees[0].reason, /could not read worktree/);

  // wt-a was still fully inspected — its own candidates (identical + secret +
  // modified-tracked) were never silenced by wt-b's failure. `collected: 0`
  // must be distinguishable here (there IS a skip to report), but this run
  // still had real inspectable work: at least the modified-tracked/secret
  // skips from wt-a's own candidates must be present.
  const wtAReasons = result.skipped.filter((s) => s.worktree === repo.wtADir).map((s) => s.reason);
  assert.ok(wtAReasons.length > 0, 'wt-a\'s own candidates must still be collected/skipped normally — one failing worktree must not blank out the rest');
});

test('#921 — no skipped worktrees on a clean run leaves skippedWorktrees an empty array (never absent, never undefined)', () => {
  const repo = buildFixtureRepo();
  const result = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' });
  assert.deepEqual(result.skippedWorktrees, []);
});

test('T-C2 — no brain.config.json at all leaves collectLane on the default pattern set, ref minted (#712, REQ-SCAN-3)', () => {
  const repo = buildFixtureRepo();
  // buildFixtureRepo() never writes a brain.config.json — this is the
  // absent case by construction, no extra setup needed.

  const result = collectLane({ root: repo.mainDir, date: '2026-09-09', host: 'test-host' });

  assert.ok(result.ref, 'a run with candidates must still mint a ref when no config exists at all');
  assert.ok(result.commit, 'the absent-config case must not refuse — the default pattern set applies');
});
