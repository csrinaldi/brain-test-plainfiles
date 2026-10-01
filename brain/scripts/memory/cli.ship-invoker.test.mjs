// cli.ship-invoker.test.mjs — CLI-level proof that `cli.mjs ship`'s invoker
// guard runs BEFORE any credential read or VCS call (#1012, REQ-SHIP-1,
// REQ-SHIP-2).
//
// UNSEAMED BY CONSTRUCTION: every spawn in this file uses a DEFANGED env —
// BRAIN_VCS_TEST_MODULE, BRAIN_MEMORY_TOKEN, GH_TOKEN, GITHUB_TOKEN and
// GITLAB_TOKEN are all removed, GH_CONFIG_DIR points at an empty directory
// so no ambient `gh` credential is reachable, and (for the non-dry-run
// cases) BRAIN_MEMORY_TEST_ROOT points at an empty directory that is NOT a
// git repository. `cli.ship.test.mjs`'s own tests all go through
// `BRAIN_VCS_TEST_MODULE` (C1 there) — this file is the deliberate
// complement: it proves the refusal fires precisely in the ABSENCE of that
// seam, so the meta-test's `refusal-asserted` reason for this file is
// literally true. Before the guard existed, case (a) would have died deep
// inside `collect()` on the non-git root (`lane/ship.mjs:254`) — a
// confusing, unrelated failure — rather than refusing cleanly at the top.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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

/** A bare origin + a `main` checkout pushed to it — the minimum `shipLane`'s
 * `--dry-run` path needs to compute a plan without erroring. Deliberately
 * separate from cli.ship.test.mjs's own `fixtureRepo()` (not exported) —
 * this file's fixture never carries a candidate record, since the
 * dry-run case here only proves the guard's bypass, not shipLane's plan
 * content (that is cli.ship.test.mjs's job). */
function gitFixture() {
  const base = testTmp('cli-ship-invoker-git-');
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
  return mainDir;
}

/** An empty directory that is deliberately NOT a git repository — the
 * refusal case's root, so nothing past the guard could ever succeed by
 * accident. */
function nonGitRoot() {
  const dir = testTmp('cli-ship-invoker-nongit-');
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Builds the defanged env this whole file spawns with. `withNodeTestContext`
 * defaults to false and must be explicitly deleted (not merely left unset)
 * because the PARENT test-runner process already has NODE_TEST_CONTEXT set
 * — `env: {...process.env}` would otherwise leak it into every "no test
 * context" case, which is exactly the ambient-signal risk REQ-SHIP-2
 * guards against. */
function defangedEnv({ withNodeTestContext = false, root, extra = {} } = {}) {
  const env = { ...process.env };
  delete env.BRAIN_VCS_TEST_MODULE;
  delete env.BRAIN_MEMORY_TOKEN;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  delete env.GITLAB_TOKEN;
  if (withNodeTestContext) {
    env.NODE_TEST_CONTEXT = 'child-v8';
  } else {
    delete env.NODE_TEST_CONTEXT;
  }
  env.GH_CONFIG_DIR = testTmp('cli-ship-invoker-ghcfg-');
  if (root) env.BRAIN_MEMORY_TEST_ROOT = root;
  return { ...env, ...extra };
}

test('#1012 (a) no NODE_TEST_CONTEXT, no --invoker, BRAIN_MEMORY_TOKEN blank: refused as invokerMissing, NOT the blank-token error, empty stdout', () => {
  const root = nonGitRoot();
  const run = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: defangedEnv({ root, extra: { BRAIN_MEMORY_TOKEN: '' } }),
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /invokerMissing|hook.*sweep.*manual|brain:memory:ship/i);
  assert.doesNotMatch(run.stderr, /unset it to use the ambient identity/, 'the guard must refuse before the blank-token check ever runs');
  assert.equal(run.stdout, '', 'a refused run must never print a JSON result, even with --json');
});

test('#1012 (b) NODE_TEST_CONTEXT set with a syntactically valid --invoker manual: refused as invokerUnderTest', () => {
  const root = nonGitRoot();
  const run = spawnSync(process.execPath, [CLI, 'ship', '--json', '--invoker', 'manual'], {
    encoding: 'utf8',
    env: defangedEnv({ withNodeTestContext: true, root }),
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /NODE_TEST_CONTEXT/);
  assert.equal(run.stdout, '');
});

test('#1012 (c) --dry-run --json against a real git fixture, no seam at all: exit 0, dryRun:true', () => {
  const root = gitFixture();
  const run = spawnSync(process.execPath, [CLI, 'ship', '--dry-run', '--json'], {
    encoding: 'utf8',
    env: defangedEnv({ root }),
  });
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.invoker, null, 'no --invoker was declared — --dry-run is the bypass');
});
