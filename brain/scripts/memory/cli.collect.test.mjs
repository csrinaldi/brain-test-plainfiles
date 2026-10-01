// cli.collect.test.mjs — `brain:memory:collect` through the real CLI (#887 Slice B),
// against a fixture repo under BRAIN_MEMORY_TEST_ROOT, mirroring
// cli.audit.test.mjs's real-CLI pattern (#870).
//
// The deep git-plumbing invariants (no-mutation, no-secret-in-object-db, the
// ref lifecycle, the CAS) are `lane/collect.integration.test.mjs`'s job —
// this file is scoped to the `collect` OP: argument handling, the text/JSON
// rendering, the exit codes, and the dispatch boundary (never a backend).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { testTmp } from '../lib/test-tmp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, 'cli.mjs');

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t',
  GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t',
};

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (cwd=${cwd}): ${r.stderr}`);
  return r.stdout;
}

/** A bare origin, a `main` checkout pushed to it, and (by default) one
 * untracked, clean, off-main record in `main`'s own `.memory/records/` —
 * the main checkout counts as a worktree like any other.
 *
 * `configureIdentity` defaults to `true`: `collectLane()`'s own `commit-tree`
 * call (collect.mjs) never receives an `env` override, so it resolves the
 * AMBIENT identity — repo-local config, not the `GIT_ENV` this file's own
 * `git()` helper uses only for the setup commands above. Set `false` only
 * to build a repo that deliberately carries no identity anywhere (the
 * `memory.collect.failed` / "Author identity unknown" case below). */
function fixtureRepo({ withCandidate = true, configureIdentity = true } = {}) {
  const base = testTmp('cli-collect-');
  const originDir = join(base, 'origin.git');
  const mainDir = join(base, 'main');
  git(base, 'init', '--bare', '-q', originDir);
  git(base, 'init', '-q', '-b', 'main', mainDir);
  git(mainDir, 'remote', 'add', 'origin', originDir);
  if (configureIdentity) {
    git(mainDir, 'config', 'user.email', 'test@example.invalid');
    git(mainDir, 'config', 'user.name', 'brain-test');
  }
  git(mainDir, 'commit', '-q', '--allow-empty', '-m', 'root');
  git(mainDir, 'push', '-q', '-u', 'origin', 'main');
  git(mainDir, 'fetch', '-q', 'origin');
  if (withCandidate) {
    const dir = join(mainDir, '.memory', 'records');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, '2026-09-rec-1111111111111111.jsonl'),
      JSON.stringify({
        id: 'rec-1111111111111111', ts: '2026-09-09T00:00:00Z', actor: '@t',
        actorKind: 'agent', type: 'discovery', project: 'brain', content: 'x',
      }) + '\n',
      'utf8',
    );
  }
  return mainDir;
}

/** A bare origin plus a `main` checkout carrying ONE tracked-then-locally-
 * modified record (` M`, `modified-tracked`) and one untracked secret-
 * bearing record (`secret`) — the two skip reasons `brain:memory:collect`'s own
 * stderr lines (`memory.collect.secretSkipped` / `.modifiedTrackedSkipped`)
 * exist to summarize by count. Neither is a candidate that ever gets
 * collected, so the run's `collected` count is irrelevant to this fixture's
 * purpose. */
function fixtureRepoWithSkips() {
  const base = testTmp('cli-collect-skiplines-');
  const originDir = join(base, 'origin.git');
  const mainDir = join(base, 'main');
  git(base, 'init', '--bare', '-q', originDir);
  git(base, 'init', '-q', '-b', 'main', mainDir);
  git(mainDir, 'remote', 'add', 'origin', originDir);
  git(mainDir, 'config', 'user.email', 'test@example.invalid');
  git(mainDir, 'config', 'user.name', 'brain-test');

  const dir = join(mainDir, '.memory', 'records');
  mkdirSync(dir, { recursive: true });

  const modifiedFile = join(dir, '2026-09-rec-cccccccccccccccc.jsonl');
  writeFileSync(
    modifiedFile,
    JSON.stringify({
      id: 'rec-cccccccccccccccc', ts: '2026-09-09T00:00:00Z', actor: '@t',
      actorKind: 'agent', type: 'discovery', project: 'brain', content: 'original',
    }) + '\n',
    'utf8',
  );
  git(mainDir, 'add', join('.memory', 'records', '2026-09-rec-cccccccccccccccc.jsonl'));
  git(mainDir, 'commit', '-q', '-m', 'track one record');
  git(mainDir, 'push', '-q', '-u', 'origin', 'main');
  git(mainDir, 'fetch', '-q', 'origin');

  // tracked, then edited locally without committing — ` M`, modified-tracked.
  writeFileSync(
    modifiedFile,
    JSON.stringify({
      id: 'rec-cccccccccccccccc', ts: '2026-09-09T00:00:00Z', actor: '@t',
      actorKind: 'agent', type: 'discovery', project: 'brain', content: 'edited locally, uncommitted',
    }) + '\n',
    'utf8',
  );

  // untracked, secret-bearing.
  writeFileSync(
    join(dir, '2026-09-rec-dddddddddddddddd.jsonl'),
    JSON.stringify({
      id: 'rec-dddddddddddddddd', ts: '2026-09-09T00:00:00Z', actor: '@t',
      actorKind: 'agent', type: 'discovery', project: 'brain', content: `token ghp_${'x'.repeat(24)}`,
    }) + '\n',
    'utf8',
  );

  return mainDir;
}

/** A bare origin, `main` pushed to it, and ONE linked worktree (`wt`) — the
 * minimum shape that lets `collectLane()` see the SAME candidate filename
 * twice (main counts as a worktree like any other; see `fixtureRepo()`'s own
 * comment above). Both copies are byte-identical, untracked, and never
 * committed anywhere — the exact residue a union merge, or two clones
 * capturing the same record independently, leaves behind (#574's opening
 * case, exercised here through `collect` specifically for cli.mjs:362's
 * `await reportDuplicates(...)`). */
function fixtureRepoWithDuplicateCandidate() {
  const base = testTmp('cli-collect-dup-');
  const originDir = join(base, 'origin.git');
  const mainDir = join(base, 'main');
  const wtDir = join(base, 'wt');
  git(base, 'init', '--bare', '-q', originDir);
  git(base, 'init', '-q', '-b', 'main', mainDir);
  git(mainDir, 'remote', 'add', 'origin', originDir);
  git(mainDir, 'config', 'user.email', 'test@example.invalid');
  git(mainDir, 'config', 'user.name', 'brain-test');
  git(mainDir, 'commit', '-q', '--allow-empty', '-m', 'root');
  git(mainDir, 'push', '-q', '-u', 'origin', 'main');
  git(mainDir, 'fetch', '-q', 'origin');
  git(mainDir, 'worktree', 'add', '-q', wtDir, '-b', 'lane-wt');

  const dupRecord = JSON.stringify({
    id: 'rec-2222222222222222', ts: '2026-09-09T00:00:00Z', actor: '@t',
    actorKind: 'agent', type: 'discovery', project: 'brain', content: 'same record, two worktrees',
  }) + '\n';
  for (const dir of [mainDir, wtDir]) {
    const recordsDir = join(dir, '.memory', 'records');
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(join(recordsDir, '2026-09-rec-2222222222222222.jsonl'), dupRecord, 'utf8');
  }
  return mainDir;
}

/** `MEMORY_BACKEND` deliberately points at a backend that cannot be
 * imported — if `collect` ever fell through to backend dispatch, every one
 * of these runs would fail with "backend 'no-such-backend' not found". */
function runCli(root, ...args) {
  return spawnSync(process.execPath, [CLI, 'collect', ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_MEMORY_TEST_ROOT: root, MEMORY_BACKEND: 'no-such-backend' },
  });
}

test('brain:memory:collect prints memory.collect.done and exits 0 with candidates present', () => {
  const run = runCli(fixtureRepo());
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /memory\/cli:.*collected 1 record/i);
});

test('brain:memory:collect prints memory.collect.nothing and exits 0 once the lane already carries everything', () => {
  const root = fixtureRepo();
  const first = runCli(root);
  assert.equal(first.status, 0, first.stderr);
  const second = runCli(root);
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /memory\/cli:.*nothing new/i);
});

test('brain:memory:collect --json carries the full shape on stdout only', () => {
  const run = runCli(fixtureRepo(), '--json');
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.match(parsed.ref, /^refs\/heads\/memory\//);
  assert.ok(parsed.commit, 'a run with a candidate must carry a commit sha');
  assert.equal(parsed.collected, 1);
  assert.ok(Array.isArray(parsed.skipped));
  assert.ok(parsed.duplicates && typeof parsed.duplicates === 'object');
});

test('brain:memory:collect REPORTS a duplicate candidate shared by two worktrees on stderr (cli.mjs:362 — must not race process.exit(0))', () => {
  const run = runCli(fixtureRepoWithDuplicateCandidate());
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /1 duplicate record id\(s\)/, 'the duplicate must be REPORTED, not dropped by an unawaited reportDuplicates racing process.exit(0)');
  assert.match(run.stderr, /the lane commit/, 'collect names its own surface, not the default "the index"');
  assert.ok(run.stderr.includes('rec-2222222222222222'), 'the duplicated id is named');
});

test('brain:memory:collect never invokes a backend, regardless of MEMORY_BACKEND', () => {
  const run = runCli(fixtureRepo());
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /backend 'no-such-backend' not found/);
});

test('cold-2 — brain:memory:collect prints memory.collect.secretSkipped and memory.collect.modifiedTrackedSkipped on stderr with the right counts', () => {
  const run = runCli(fixtureRepoWithSkips());
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /memory\/cli:.*1 secret-bearing record\(s\) skipped/i);
  assert.match(run.stderr, /memory\/cli:.*1 tracked-and-modified record\(s\) skipped/i);
  // D4's guarantee, restated at the CLI surface: the matched secret literal
  // itself must never appear anywhere in the process output, count-only.
  assert.doesNotMatch(run.stdout + run.stderr, /ghp_x{24}/);
});

test('brain:memory:collect --json always carries skippedWorktrees, even when empty (#921)', () => {
  const run = runCli(fixtureRepo(), '--json');
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.ok(Array.isArray(parsed.skippedWorktrees), 'skippedWorktrees must always be an array, never absent or undefined');
  assert.deepEqual(parsed.skippedWorktrees, []);
});

test('#921 — brain:memory:collect prints memory.collect.worktreeSkipped on stderr with count + path when a worktree could not be inspected', () => {
  // Registers a SECOND worktree, then corrupts its `.git` file to point at a
  // nonexistent gitdir. The directory itself still exists, so
  // `git worktree list --porcelain` never marks it `prunable` (proven below)
  // — but `git -C <path> status` fails for real ("fatal: not a git
  // repository"), exactly the unreadable-worktree case #921 describes,
  // distinct from the intentional prunable/bare skip.
  const root = fixtureRepo();
  const wtDir = join(dirname(root), 'wt-unreadable');
  git(root, 'worktree', 'add', '-q', wtDir, '-b', 'lane-unreadable');
  writeFileSync(join(wtDir, '.git'), 'gitdir: /nonexistent/gitdir/path\n', 'utf8');
  const porcelain = git(root, 'worktree', 'list', '--porcelain');
  assert.doesNotMatch(porcelain, /prunable/, 'a corrupted-but-present worktree must not be reported prunable — this test must exercise the unreadable path, not the pre-existing prunable skip');

  const run = runCli(root);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /memory\/cli:.*1 worktree\(s\) could not be inspected/i);
  assert.match(run.stderr, new RegExp(wtDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // F4 (cold review): the text surface must carry WHY, not just which path —
  // the reason git itself gave, not merely count + path.
  assert.match(run.stderr, /not a git repository/i);
});

test('brain:memory:collect fails loudly with memory.collect.failed and exits 1 on a genuine git failure', () => {
  const root = testTmp('cli-collect-nogit-'); // not a git repository at all
  mkdirSync(root, { recursive: true });
  const run = runCli(root);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /memory\/cli:/);
});

test('brain:memory:collect fails with git\'s own author-identity message (memory.collect.failed) when no identity is configured anywhere', () => {
  // D6: the collector uses the AMBIENT git identity, never a fabricated or
  // token-based one — so when NOTHING configures an identity (no repo-local
  // config, no global config, no system config), `commit-tree` must fail
  // loudly with git's own message, and the CLI must surface it verbatim via
  // `memory.collect.failed`, never mask it as something else. This is the
  // exact failure the #897 cold review found on the GitHub runner: git 2.55,
  // no `~/.gitconfig`. Isolated here the same way, but scoped to this one
  // subprocess only.
  const root = fixtureRepo({ configureIdentity: false });
  const isolatedHome = testTmp('cli-collect-no-home-');
  // eslint-disable-next-line no-unused-vars
  const { GIT_AUTHOR_NAME, GIT_AUTHOR_EMAIL, GIT_COMMITTER_NAME, GIT_COMMITTER_EMAIL, ...cleanEnv } = process.env;
  const run = spawnSync(process.execPath, [CLI, 'collect'], {
    encoding: 'utf8',
    env: {
      ...cleanEnv,
      BRAIN_MEMORY_TEST_ROOT: root,
      MEMORY_BACKEND: 'no-such-backend',
      HOME: isolatedHome,
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
  assert.equal(run.status, 1, run.stderr);
  assert.match(run.stderr, /memory\/cli: .*collect failed/);
  assert.match(run.stderr, /Author identity unknown/, 'the surfaced message must be git\'s own, unrewritten');
});

test('brain:memory:collect resolves from package.json, beside the other memory:* scripts', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, '../../../package.json'), 'utf8'));
  assert.equal(pkg.scripts['memory:collect'], 'node ./brain/scripts/memory/cli.mjs collect');
});
