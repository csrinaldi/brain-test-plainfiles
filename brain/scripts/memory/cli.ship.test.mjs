// cli.ship.test.mjs — `brain:memory:ship` through the real CLI (#888), against a
// fixture repo under BRAIN_MEMORY_TEST_ROOT, mirroring cli.collect.test.mjs's
// real-CLI pattern.
//
// NETWORK-FREE BY CONSTRUCTION, deliberately more so than cli.collect.test.mjs:
// `ship` DOES reach a real `vcs` port on a successful push (unlike `collect`,
// which never touches one at all), so every case here is engineered to never
// get past the pre-push divergence check or the dry-run short-circuit — the
// full push + PR + arm sequence is `lane/ship.integration.test.mjs`'s job,
// against a FAKE port. This file is scoped to the `ship` OP: dispatch
// boundary, argument handling, exit codes, i18n, and the credential-never-
// printed guarantee.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';

import { testTmp } from '../lib/test-tmp.mjs';
import { collectLane } from './lane/collect.mjs';
import en from '../i18n/en.mjs';
import es from '../i18n/es.mjs';

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

/** A bare origin + a `main` checkout pushed to it — mirrors
 * cli.collect.test.mjs's fixtureRepo, scoped to what `ship` needs. */
function fixtureRepo({ withCandidate = false } = {}) {
  const base = testTmp('cli-ship-');
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
  return { mainDir, originDir };
}

/** A repo whose lane ref already diverged from origin — engineered directly
 * via `collectLane` + a raw force-push, never through the CLI, so the ONLY
 * path this fixture ever drives through the real `ship` op is the pre-push
 * divergence refusal (before any `vcs` call).
 *
 * CRITICAL: this must use the exact same `host`/`date` the real CLI process
 * will compute for itself (`hostname()`, today's date) — `memory/cli.mjs`'s
 * `ship` op takes neither as a flag (mirrors `collect`'s own lack of a
 * `--date` override). A mismatched ref here would let the CLI's own
 * `collectLane` mint a DIFFERENT, non-diverged ref, sail past the
 * divergence check, and reach the REAL `vcs` port — exactly the "never call
 * the real VCS port in tests" rule this fixture exists to make structurally
 * impossible. */
function fixtureRepoDiverged() {
  const host = hostname();
  const date = new Date().toISOString().slice(0, 10);
  const { mainDir, originDir } = fixtureRepo({ withCandidate: true });
  const collected = collectLane({ root: mainDir, host, date });
  git(mainDir, 'push', 'origin', `${collected.ref}:${collected.ref}`);
  const raceTree = git(mainDir, 'rev-parse', `${collected.commit}^{tree}`).trim();
  const raceCommit = git(mainDir, 'commit-tree', raceTree, '-m', 'racing writer').trim();
  git(mainDir, 'push', '--force', 'origin', `${raceCommit}:${collected.ref}`);
  return { mainDir, originDir, ref: collected.ref };
}

// B1/C1 (#888 cold review, PR 2): the committed, DATA-driven fixture module
// — never an arbitrary path — that `BRAIN_VCS_TEST_MODULE` points every CLI
// -level test in this file at. See `__fixtures__/fake-vcs-port.mjs` and
// `memory/cli.mjs`'s `resolveVcsTestModulePath()` for the constraint this
// closes: before this batch, `runCli()` never set the seam at all, so every
// case that used it (four of the tests below) constructed the REAL, bound
// `getVcs()` port — reading this repo's own `brain.config.json` — on every
// run, one fixture mistake away from a real network call (see this file's
// own header comment for the near-miss that seam was built to close in the
// first place).
const FAKE_VCS_MODULE = join(HERE, '__fixtures__', 'fake-vcs-port.mjs');

/** Writes a `BRAIN_VCS_TEST_SCRIPT` data file for the committed fixture
 * module. The module itself never changes between tests — only the JSON
 * this returns does (B1: data varies, code does not). */
function writeVcsTestScript(base, script) {
  const path = join(base, 'vcs-script.json');
  writeFileSync(path, JSON.stringify(script), 'utf8');
  return path;
}

/** C1: every non-dry-run CLI run in this file goes through `runCli()` (or
 * sets the seam explicitly, for the handful of cases that need per-test
 * `mrCreate`/`mrAutoMerge` answers) — never the real `getVcs()`. The default
 * script here is intentionally empty: none of the cases that use plain
 * `runCli()` ever reach a `vcs` verb at all (nothing-to-ship and diverged
 * both short-circuit inside `shipLane` before `vcs` is touched), so the
 * fixture's own loud "not configured" fallback (see that file) is never hit
 * in practice — it exists as backstop, not as this default's real behavior. */
function runCli(root, ...args) {
  return spawnSync(process.execPath, [CLI, 'ship', ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAIN_MEMORY_TEST_ROOT: root,
      MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE,
    },
  });
}

test('brain:memory:ship is a valid op, dispatched before backend selection', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = runCli(mainDir);
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /backend 'no-such-backend' not found/);
  assert.doesNotMatch(run.stderr, /unknown op/);
});

test('nothing to ship: exit 0, prints memory.ship.nothing', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = runCli(mainDir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /memory\/cli:/);
});

test('--json carries the outcome shape on stdout only', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = runCli(mainDir, '--json');
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.pushed, false);
  assert.equal(parsed.pr, null);
  assert.equal(parsed.dryRun, false);
});

// #1012: the guard's own decision is echoed on --json, so an e2e run that
// only ever exercises the bypass path (BRAIN_VCS_TEST_MODULE) can still
// prove a caller's --invoker marker survived the whole chain.
test('#1012 --json carries invoker:null when no --invoker was declared (bypass excuses it here)', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = runCli(mainDir, '--json');
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.invoker, null);
});

test('#1012 --json carries invoker:\'manual\' when --invoker manual was declared', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = runCli(mainDir, '--json', '--invoker', 'manual');
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.invoker, 'manual');
});

test('--dry-run prints the plan and makes zero of ship\'s own network calls (push/fetch never happen)', () => {
  const { mainDir, originDir } = fixtureRepo({ withCandidate: true });
  const beforeOriginRefs = git(originDir, 'for-each-ref', 'refs/heads/memory/');
  assert.equal(beforeOriginRefs, '', 'no lane ref must exist on origin before the dry run');

  const run = runCli(mainDir, '--dry-run', '--json');
  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.dryRun, true);
  assert.equal(parsed.pushed, false);
  assert.equal(parsed.pr, null);

  const afterOriginRefs = git(originDir, 'for-each-ref', 'refs/heads/memory/');
  assert.equal(afterOriginRefs, '', 'a dry run must never push the lane ref to origin');
});

test('a pre-seeded divergent origin lane: exit 1 + memory.ship.diverged, this path never reaches the port', () => {
  const { mainDir, originDir, ref } = fixtureRepoDiverged();
  const beforeSha = git(originDir, 'for-each-ref', '--format=%(objectname)', 'refs/heads/memory/').trim();

  const run = runCli(mainDir);
  assert.equal(run.status, 1);
  assert.match(run.stderr, /memory\/cli:.*diverged/i);
  // E4: `fixtureRepoDiverged()` computes its own `host`/`date` once, at
  // fixture-build time; the real CLI process computes its own `hostname()`/
  // today's date independently, moments later. `ship.mjs`'s own diverged
  // error interpolates the exact ref IT computed (`${ref} is behind
  // origin's matching ref`) into `err.message`, which flows straight
  // through to stderr here — so asserting this fixture's `ref` literally
  // appears in stderr is a real proof the two computations agreed. A
  // UTC-midnight straddle between fixture setup and this `runCli()` call
  // would silently mint a DIFFERENT, non-diverged ref inside the CLI
  // process, sail past this pre-check, and reach the real `vcs` port
  // instead — exactly the failure mode this assertion turns into a loud,
  // attributable test failure rather than a rare, unexplained flake.
  assert.ok(
    run.stderr.includes(ref),
    `expected the CLI's own diverged-ref message to include this fixture's ref (${ref}); stderr: ${run.stderr}`,
  );

  const afterSha = git(originDir, 'for-each-ref', '--format=%(objectname)', 'refs/heads/memory/').trim();
  assert.equal(afterSha, beforeSha, 'the diverged remote ref must be left exactly as it was');
});

test('the CLI never re-throws: a diverged run exits cleanly with no stack trace on stderr', () => {
  const { mainDir } = fixtureRepoDiverged();
  const run = runCli(mainDir);
  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr, /at .*\(.*\.m?js:\d+:\d+\)/, 'an uncaught exception would print a stack trace — this must be a caught, mapped failure');
});

// #1119: real reproduction of the audit's evidence (#1081 F7,
// evidence/51-seam2a.txt + 52-after-2a.txt) — decidePr's mrList lookup
// throws BEFORE the push (D4), so the CLI must report that nothing was
// pushed, and origin must genuinely carry no `memory/*` ref, ever.
test('#1119: a decidePr mrList lookup failure never claims the push landed — and it never did', () => {
  const { mainDir, originDir } = fixtureRepo({ withCandidate: true });
  // Deliberately never written: fake-vcs-port.mjs's mrList reads this path
  // and throws "is not valid JSON" on ENOENT, exactly like evidence 51's
  // injected outage (BRAIN_VCS_TEST_SCRIPT pointing at a missing file).
  const missingScriptPath = join(testTmp('cli-ship-1119-'), 'seam2-missing.json');

  const run = spawnSync(process.execPath, [CLI, 'ship'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: mainDir, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: missingScriptPath,
    },
  });

  assert.equal(run.status, 1);
  assert.match(run.stderr, /memory\/cli:.*prLookupFailed/i, run.stderr);
  assert.doesNotMatch(
    run.stderr, /already landed/i,
    'the pre-push decidePr lookup failed — nothing was ever pushed, so the message must never claim it landed',
  );
  assert.match(run.stderr, /nothing was pushed/i, run.stderr);

  // Evidence 52's own check, reproduced: no memory/* ref exists on origin.
  const originRefs = git(originDir, 'for-each-ref', '--format=%(refname)', 'refs/heads/memory/');
  assert.equal(originRefs.trim(), '', 'a decidePr failure must land nothing on origin, matching what the message now says');
});

test('BRAIN_MEMORY_TOKEN never appears in stdout or stderr, on any path', () => {
  const sentinel = 'sekrit-token-value-do-not-print';
  const { mainDir: nothingRoot } = fixtureRepo({ withCandidate: false });
  const runNothing = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: nothingRoot, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_MEMORY_TOKEN: sentinel, BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE,
    },
  });
  assert.doesNotMatch(runNothing.stdout + runNothing.stderr, new RegExp(sentinel));

  const { mainDir: divergedRoot } = fixtureRepoDiverged();
  const runDiverged = spawnSync(process.execPath, [CLI, 'ship'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: divergedRoot, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_MEMORY_TOKEN: sentinel, BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE,
    },
  });
  assert.doesNotMatch(runDiverged.stdout + runDiverged.stderr, new RegExp(sentinel));
});

test('the op reads BRAIN_MEMORY_TOKEN exactly once (source guard) and threads only a bound vcs + identityBound to shipLane', () => {
  const source = readFileSync(CLI, 'utf8');
  const reads = source.match(/process\.env\[MEMORY_TOKEN_ENV\]/g) ?? [];
  assert.equal(reads.length, 1, `BRAIN_MEMORY_TOKEN must be read exactly once via MEMORY_TOKEN_ENV, found ${reads.length} occurrence(s)`);
  assert.doesNotMatch(source, /shipLane\([^)]*identity\b(?!Bound)/, 'shipLane must never receive the raw token — only identityBound');
});

// #1012: the guard call must run before either credential-touching or
// VCS-touching line in the ship block — a source-order check, since the
// guard's own effect (an early exit) is otherwise indistinguishable from
// "the guard runs last but nothing before it happened to fail".
test('#1012 source-order guard: decideShipInvoker is called before both the token read and getVcs in the ship block', () => {
  const source = readFileSync(CLI, 'utf8');
  const shipBlockStart = source.indexOf('if (op === "ship")');
  const shipBlockEnd = source.indexOf('if (op === "migrate-v1")');
  const shipBlock = source.slice(shipBlockStart, shipBlockEnd);

  const guardIdx = shipBlock.indexOf('decideShipInvoker(');
  const tokenReadIdx = shipBlock.indexOf('process.env[MEMORY_TOKEN_ENV]');
  const getVcsIdx = shipBlock.indexOf('.getVcs(');
  // Cold review on #1012: the ship block's dynamic imports ran before the
  // guard. Those modules have no top-level side effects today, but a refactor
  // that moves work into one would slip past the two checks above.
  const firstImportIdx = shipBlock.indexOf('await import(');

  assert.notEqual(guardIdx, -1, 'the ship block must call decideShipInvoker');
  assert.notEqual(tokenReadIdx, -1, 'the ship block must still read the token exactly once');
  assert.notEqual(getVcsIdx, -1, 'the ship block must still reference getVcs exactly once');
  assert.notEqual(firstImportIdx, -1, 'the ship block must still load its modules dynamically');
  assert.ok(guardIdx < firstImportIdx, 'the guard must run before the ship block loads any module');
  assert.ok(guardIdx < tokenReadIdx, 'the guard must run before the token is ever read');
  assert.ok(guardIdx < getVcsIdx, 'the guard must run before getVcs is ever reached');
});

test('C1 (cold review) guard: runCli() always sets BRAIN_VCS_TEST_MODULE — combined with the source guard below (getVcs gated behind the ternary\'s false branch), no test in this file that goes through runCli() can ever reach the real getVcs()', () => {
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const fnStart = source.indexOf('function runCli(');
  assert.notEqual(fnStart, -1, 'runCli() must exist in this file');
  const fnEnd = source.indexOf('\n}', fnStart);
  const fnBody = source.slice(fnStart, fnEnd);
  assert.match(
    fnBody,
    /BRAIN_VCS_TEST_MODULE:\s*FAKE_VCS_MODULE/,
    'runCli() must set BRAIN_VCS_TEST_MODULE to the committed fixture on EVERY call — before this batch, none of the four runCli()-driven non-dry-run tests set it at all, so each one constructed the real, bound getVcs() port on every run',
  );
});

test('B1 (cold review): BRAIN_VCS_TEST_MODULE outside the committed fixture root is refused before any import is attempted, exit 1', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAIN_MEMORY_TEST_ROOT: mainDir,
      MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: '/tmp/x.mjs',
    },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /BRAIN_VCS_TEST_MODULE must resolve inside/);
  assert.equal(run.stdout, '', 'a refused seam must never print a JSON result — nothing was imported, nothing ran');
});

test('B1 (cold review): the committed fixture module itself resolves and works (positive case, mirrors the escape test above)', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = runCli(mainDir, '--json');
  assert.equal(run.status, 0, run.stderr);
  assert.doesNotMatch(run.stderr, /BRAIN_VCS_TEST_MODULE must resolve inside/);
});

test('C2 (cold review): identityBound reflects whether BRAIN_MEMORY_TOKEN was set for this run', () => {
  const sentinel = 'not-a-real-credential-just-a-presence-check';
  const { mainDir: boundRoot } = fixtureRepo({ withCandidate: false });
  const boundRun = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: boundRoot, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_MEMORY_TOKEN: sentinel,
    },
  });
  assert.equal(boundRun.status, 0, boundRun.stderr);
  assert.equal(JSON.parse(boundRun.stdout).identityBound, true);
  assert.doesNotMatch(boundRun.stderr, /BRAIN_MEMORY_TOKEN is not set/);

  const { mainDir: unboundRoot } = fixtureRepo({ withCandidate: false });
  const unboundEnv = {
    ...process.env, BRAIN_MEMORY_TEST_ROOT: unboundRoot, MEMORY_BACKEND: 'no-such-backend',
    BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE,
  };
  delete unboundEnv.BRAIN_MEMORY_TOKEN;
  const unboundRun = spawnSync(process.execPath, [CLI, 'ship', '--json'], { encoding: 'utf8', env: unboundEnv });
  assert.equal(unboundRun.status, 0, unboundRun.stderr);
  assert.equal(JSON.parse(unboundRun.stdout).identityBound, false);
  assert.match(unboundRun.stderr, /BRAIN_MEMORY_TOKEN is not set/);
});

test('cold review correction: BRAIN_MEMORY_TOKEN set but blank is refused, exit 1, never reported as identityBound', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAIN_MEMORY_TEST_ROOT: mainDir,
      MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE,
      BRAIN_MEMORY_TOKEN: '',
    },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /BRAIN_MEMORY_TOKEN is set but empty/);
  // Proves the fake port was never reached: the fixture's own loud "not
  // configured" fallback (see fake-vcs-port.mjs) never fires, because the
  // refusal above happens before any vcs verb is called.
  assert.doesNotMatch(run.stderr, /not configured for this run/);
  assert.equal(run.stdout, '', 'a refused blank token must never print a JSON result — identityBound must never appear as true');
});

test('cold review correction: BRAIN_MEMORY_TOKEN set to whitespace-only is refused the same way as empty', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAIN_MEMORY_TEST_ROOT: mainDir,
      MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE,
      BRAIN_MEMORY_TOKEN: '   ',
    },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /BRAIN_MEMORY_TOKEN is set but empty/);
  assert.doesNotMatch(run.stderr, /not configured for this run/);
  assert.equal(run.stdout, '', 'a refused whitespace-only token must never print a JSON result');
});

test('a full success run (push + PR create + arm) goes through the committed fixture vcs module, never the real getVcs()/gh port', () => {
  const { mainDir, originDir } = fixtureRepo({ withCandidate: true });
  const scriptPath = writeVcsTestScript(testTmp('cli-ship-fake-vcs-'), {
    mrList: [],
    mrCreate: { url: 'https://fake-vcs.invalid/pull/999' },
    mrAutoMerge: { enabled: true, url: null },
  });

  const run = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAIN_MEMORY_TEST_ROOT: mainDir,
      MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE,
      BRAIN_VCS_TEST_SCRIPT: scriptPath,
    },
  });

  assert.equal(run.status, 0, run.stderr);
  const parsed = JSON.parse(run.stdout);
  assert.equal(parsed.pushed, true);
  assert.equal(parsed.pr.number, 999, "the PR number must come from the injected fake — a real gh/glab call could never return this value");
  assert.equal(parsed.autoMerge.enabled, true);

  const afterOriginRefs = git(originDir, 'for-each-ref', '--format=%(refname)', 'refs/heads/memory/');
  assert.notEqual(afterOriginRefs, '', 'the push itself is real git, against the LOCAL bare origin fixture — never GitHub');
});

test('R11 (#920): pushed:false && reconciled:true renders as "reconciled", never "nothing" — a same-day retry that finds/creates the PR with zero new records', () => {
  const { mainDir, originDir } = fixtureRepo({ withCandidate: true });

  // Run 1: a full success (push + create + arm), same shape as the fixture
  // above — the lane lands on origin but is never merged into main.
  const firstScript = writeVcsTestScript(testTmp('cli-ship-fake-vcs-'), {
    mrList: [],
    mrCreate: { url: 'https://fake-vcs.invalid/pull/999' },
    mrAutoMerge: { enabled: true, url: null },
  });
  const first = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: mainDir, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: firstScript,
    },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstParsed = JSON.parse(first.stdout);
  assert.equal(firstParsed.pushed, true);

  // Run 2: zero new candidates, the lane ref already matches origin
  // (ahead:0), and the PR from run 1 is still open by headBranch — records
  // are still absent from `origin/main` (never merged), so this is the M1
  // shape: no push, but find/create + arm must still run. `branch` is read
  // from run 1's own outcome, never reconstructed — `plan.mjs`'s
  // `slugifyHost()` can rewrite a raw `hostname()` that this fixture must
  // not have to re-derive.
  const secondScript = writeVcsTestScript(testTmp('cli-ship-fake-vcs-'), {
    // D4 (#936): the lookup now spans every state, so an item that omits
    // `state` reads as uncomputable (`prLookupFailed`, fail closed) — this
    // fixture's PR is genuinely still open, so it must say so explicitly.
    mrList: [{ number: 999, title: 't', headBranch: firstParsed.branch, state: 'open', merged: false }],
    mrAutoMerge: { enabled: true, url: null },
  });
  const jsonRun = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: mainDir, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: secondScript,
    },
  });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.pushed, false);
  assert.equal(parsed.reconciled, true);
  assert.equal(parsed.pr.number, 999);

  const textRun = spawnSync(process.execPath, [CLI, 'ship'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: mainDir, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: secondScript,
    },
  });
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.match(textRun.stdout, /memory\/cli:.*reconcil/i, 'a reconciliation-without-a-push must never print "nothing new to ship"');
  assert.doesNotMatch(textRun.stdout, /nothing new to ship/i);

  const afterOriginMainRefs = git(originDir, 'for-each-ref', '--format=%(refname)', 'refs/heads/memory/');
  assert.notEqual(afterOriginMainRefs, '', 'the lane ref itself must still be present on origin');
});

test('D4/R8 reversal (#936): a branch whose only PR is closed unmerged is reported, never re-pushed, never given a fresh PR', () => {
  const { mainDir, originDir } = fixtureRepo({ withCandidate: true });

  // Run 1: a full success — the lane's PR lands on origin but is never
  // merged into main.
  const firstScript = writeVcsTestScript(testTmp('cli-ship-fake-vcs-'), {
    mrList: [],
    mrCreate: { url: 'https://fake-vcs.invalid/pull/999' },
    mrAutoMerge: { enabled: true, url: null },
  });
  const first = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: mainDir, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: firstScript,
    },
  });
  assert.equal(first.status, 0, first.stderr);
  const firstParsed = JSON.parse(first.stdout);
  assert.equal(firstParsed.pushed, true);
  const beforeSha = git(originDir, 'for-each-ref', '--format=%(objectname)', 'refs/heads/memory/').trim();

  // A human closes PR #999 without merging it. Run 2: the same lane still
  // has pending content (records never reached origin/main), so the pre-#936
  // path would have pushed and opened a fresh PR (#920 R8). #936 reverses
  // that: no push, no mrCreate, and the run reports closedUnmerged.
  const secondScript = writeVcsTestScript(testTmp('cli-ship-fake-vcs-'), {
    mrList: [{ number: 999, title: 't', headBranch: firstParsed.branch, state: 'closed', merged: false }],
  });
  const jsonRun = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: mainDir, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: secondScript,
    },
  });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.closedUnmerged, true);
  assert.equal(parsed.pushed, false);
  assert.equal(parsed.pr.number, 999);
  assert.equal(parsed.autoMerge, null);

  const afterSha = git(originDir, 'for-each-ref', '--format=%(objectname)', 'refs/heads/memory/').trim();
  assert.equal(afterSha, beforeSha, 'a closed-unmerged branch must never be re-pushed to origin');

  const textRun = spawnSync(process.execPath, [CLI, 'ship'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: mainDir, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: secondScript,
    },
  });
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.match(textRun.stdout, /memory\/cli:.*999/, 'the closed PR number must be reported in the text output');
  assert.doesNotMatch(textRun.stdout, /nothing new to ship/i);

  // Run again on the SAME (still closed-unmerged) state to prove this is
  // reported on EVERY run, never just once (spec.md's own scenario).
  const thirdRun = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: mainDir, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: secondScript,
    },
  });
  assert.equal(thirdRun.status, 0, thirdRun.stderr);
  assert.equal(JSON.parse(thirdRun.stdout).closedUnmerged, true);
});

test('E1 (cold review): mrCreate returns a URL with no derivable PR number and the rescan finds nothing: exit 0, prNumberUnknown', () => {
  const scriptFor = () => writeVcsTestScript(testTmp('cli-ship-fake-vcs-'), {
    mrList: [],
    mrCreate: { url: 'https://fake-vcs.invalid/pull/' },
  });

  const { mainDir: jsonRoot } = fixtureRepo({ withCandidate: true });
  const jsonRun = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: jsonRoot, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: scriptFor(),
    },
  });
  assert.equal(jsonRun.status, 0, jsonRun.stderr);
  const parsed = JSON.parse(jsonRun.stdout);
  assert.equal(parsed.pr.number, null);
  assert.equal(parsed.autoMerge, null);

  const { mainDir: textRoot } = fixtureRepo({ withCandidate: true });
  const textRun = spawnSync(process.execPath, [CLI, 'ship'], {
    encoding: 'utf8',
    env: {
      ...process.env, BRAIN_MEMORY_TEST_ROOT: textRoot, MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE, BRAIN_VCS_TEST_SCRIPT: scriptFor(),
    },
  });
  assert.equal(textRun.status, 0, textRun.stderr);
  assert.match(textRun.stdout, /memory\/cli:.*number could not be derived/i);
});

test('E3 (cold review): raced/badHost are mapped the same way "collect" maps them (source guard — neither op has a host/date CLI override, so neither is exercised behaviorally; see cli.collect.test.mjs\'s own precedent)', () => {
  const source = readFileSync(CLI, 'utf8');
  const shipBlockStart = source.indexOf('if (op === "ship")');
  const shipBlockEnd = source.indexOf('function shipOutcomeKey');
  const shipBlock = source.slice(shipBlockStart, shipBlockEnd);
  assert.match(shipBlock, /err\?\.raced \? "raced"/, 'a raced collect() failure must be tagged distinctly from a generic ship failure');
  assert.match(shipBlock, /err\?\.badHost \? "badHost"/, 'a badHost collect() failure must be tagged distinctly from a generic ship failure');
  // The i18n key is built via a template literal (`memory.ship.${key}`), so
  // it never appears as a literal string in cli.mjs's own source — checked
  // instead against both catalogs, mirroring "collect"'s own precedent
  // (`memory.collect.raced`/`memory.collect.badHost`).
  assert.equal(typeof en['memory.ship.raced'], 'string', 'en.mjs must carry memory.ship.raced');
  assert.equal(typeof en['memory.ship.badHost'], 'string', 'en.mjs must carry memory.ship.badHost');
  assert.equal(typeof es['memory.ship.raced'], 'string', 'es.mjs must carry memory.ship.raced');
  assert.equal(typeof es['memory.ship.badHost'], 'string', 'es.mjs must carry memory.ship.badHost');
});

// #1119: `prLookupFailed` is thrown from two call sites in ship.mjs with
// opposite push states (decidePr's own lookup, always pre-push per D4; and
// createPr's one-shot re-scan, always post-push) — a single static message
// claiming one outcome for both would be false on one of them. See
// evidence at openspec/changes/issue-1081-memory-2-0-exit-audit/evidence/
// 51-seam2a.txt + 52-after-2a.txt on the #1081 branch: a decidePr failure
// left nothing on origin, while the pre-#1119 message claimed the push
// "already landed and is durable".
test('#1119: prLookupFailed forks on err.pushed into two honest keys — neither catalog claims the wrong outcome (source guard + content)', () => {
  const source = readFileSync(CLI, 'utf8');
  const shipBlockStart = source.indexOf('if (op === "ship")');
  const shipBlockEnd = source.indexOf('function shipOutcomeKey');
  const shipBlock = source.slice(shipBlockStart, shipBlockEnd);
  assert.match(
    shipBlock,
    /err\?\.prLookupFailed \? \(err\.pushed \? "prLookupFailedAfterPush" : "prLookupFailed"\)/,
    'a prLookupFailed error must be routed by err.pushed to one of two distinct keys',
  );

  for (const [label, cat] of [['en', en], ['es', es]]) {
    const preText = cat['memory.ship.prLookupFailed'];
    const postText = cat['memory.ship.prLookupFailedAfterPush'];
    assert.equal(typeof preText, 'string', `${label}.mjs must carry memory.ship.prLookupFailed`);
    assert.equal(typeof postText, 'string', `${label}.mjs must carry memory.ship.prLookupFailedAfterPush`);

    // The pre-push key (decidePr) must never claim a push landed.
    assert.doesNotMatch(
      preText, /already landed|ya se concretó/i,
      `${label}.mjs memory.ship.prLookupFailed must not claim a push happened — decidePr's lookup always runs before the push (D4)`,
    );
    // ...and must say what actually happened (nothing was pushed) and that
    // retrying is fine.
    assert.match(
      preText, /nothing was pushed|no se envió nada/i,
      `${label}.mjs memory.ship.prLookupFailed must state that nothing was pushed`,
    );
    assert.match(
      preText, /retry|reintent/i,
      `${label}.mjs memory.ship.prLookupFailed must say how/whether to retry`,
    );

    // The post-push key (createPr's re-scan) is the one case where a push
    // genuinely did land — its own claim must stay true, not be erased.
    assert.match(
      postText, /already landed|ya se concretó/i,
      `${label}.mjs memory.ship.prLookupFailedAfterPush must state the push already landed — it runs strictly after the push step`,
    );
  }
});

test('the real getVcs()/gh port is only ever imported when BRAIN_VCS_TEST_MODULE is unset (source guard)', () => {
  const source = readFileSync(CLI, 'utf8');
  assert.match(source, /BRAIN_VCS_TEST_MODULE/, 'the ship op must expose the vcs test-substitution seam');
  const shipBlockStart = source.indexOf('if (op === "ship")');
  const shipBlockEnd = source.indexOf('if (op === "migrate-v1")');
  const shipBlock = source.slice(shipBlockStart, shipBlockEnd);
  const getVcsRefs = shipBlock.match(/\.getVcs\(/g) ?? [];
  assert.equal(getVcsRefs.length, 1, `getVcs must be referenced exactly once in the ship block, found ${getVcsRefs.length}`);
  assert.match(
    shipBlock,
    /vcsTestModule\s*\?\s*await import\(pathToFileURL\(resolveVcsTestModulePath\(vcsTestModule\)\)\.href\)\s*:\s*await \(await import\("\.\.\/vcs\/cli\.mjs"\)\)\.getVcs\(/,
    "getVcs must be gated behind the ternary's false branch — only reached when BRAIN_VCS_TEST_MODULE is unset",
  );
});

test('M1 (re-review): a symlink placed inside FIXTURE_ROOT pointing outside it is refused via real-path containment, not just a lexical check', () => {
  const outsideDir = testTmp('cli-ship-symlink-target-');
  const markerPath = join(outsideDir, 'imported.marker');
  const leakModulePath = join(outsideDir, 'leak.mjs');
  writeFileSync(
    leakModulePath,
    [
      "import { writeFileSync } from 'node:fs';",
      `writeFileSync(${JSON.stringify(markerPath)}, 'imported');`,
      'export const mrList = async () => [];',
      "export const mrCreate = async () => ({ url: null });",
      'export const mrAutoMerge = async () => ({ enabled: false });',
      '',
    ].join('\n'),
    'utf8',
  );

  const symlinkPath = join(HERE, '__fixtures__', `zz-escape-${process.pid}.mjs`);
  try {
    symlinkSync(leakModulePath, symlinkPath);

    const { mainDir } = fixtureRepo({ withCandidate: false });
    const run = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        BRAIN_MEMORY_TEST_ROOT: mainDir,
        MEMORY_BACKEND: 'no-such-backend',
        BRAIN_VCS_TEST_MODULE: symlinkPath,
      },
    });

    assert.equal(run.status, 1);
    assert.match(run.stderr, /BRAIN_VCS_TEST_MODULE must resolve inside/);
    assert.equal(run.stdout, '', 'a refused seam must never print a JSON result — nothing was imported, nothing ran');
    assert.equal(
      existsSync(markerPath),
      false,
      'the symlink target must never be imported — a lexical-only containment check would have followed it and written this marker',
    );
  } finally {
    rmSync(symlinkPath, { force: true });
  }
});

test('L1 (re-review): BRAIN_VCS_TEST_MODULE set but blank is refused, not silently treated as unset (which would bind the real port)', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAIN_MEMORY_TEST_ROOT: mainDir,
      MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: '',
    },
  });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /BRAIN_VCS_TEST_MODULE is set but empty/);
  assert.equal(run.stdout, '', 'a refused blank seam must never print a JSON result');
});

test('L2 (re-review): a non-JSON BRAIN_VCS_TEST_SCRIPT fails with a path-only message — the fixture never echoes the file\'s content', () => {
  const scriptDir = testTmp('cli-ship-fake-vcs-badjson-');
  const scriptPath = join(scriptDir, 'vcs-script.json');
  const sentinelMarker = 'FAKE_SECRET_TOKEN_should_never_reach_stderr';
  writeFileSync(scriptPath, `this is not json, contains a ${sentinelMarker}`, 'utf8');

  const { mainDir } = fixtureRepo({ withCandidate: true });
  const run = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAIN_MEMORY_TEST_ROOT: mainDir,
      MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE,
      BRAIN_VCS_TEST_SCRIPT: scriptPath,
    },
  });

  assert.equal(run.status, 1);
  assert.doesNotMatch(run.stderr, new RegExp(sentinelMarker), 'the error must never echo the bad file\'s content');
  assert.doesNotMatch(run.stderr, /this is not json/, 'the error must never echo the bad file\'s content');
  assert.match(run.stderr, /BRAIN_VCS_TEST_SCRIPT at .* is not valid JSON/, 'the error must name the path, not the content');
  assert.ok(run.stderr.includes(scriptPath), "the error must name the offending path so it's still debuggable");
});

// F1 (cold review): before this test, cli.mjs's own `ship`-op print of the
// #921 worktreeSkipped line (the automated surface — SessionEnd and
// day:start invoke `ship`, never `collect` by hand) had ZERO coverage;
// deleting the print block left the whole suite green. Mirrors
// cli.collect.test.mjs's own equivalent test for the "collect" op.
test('#921 — brain:memory:ship prints memory.collect.worktreeSkipped on stderr with count + path + reason when a worktree could not be inspected', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const wtDir = join(dirname(mainDir), 'wt-unreadable');
  git(mainDir, 'worktree', 'add', '-q', wtDir, '-b', 'lane-unreadable');
  writeFileSync(join(wtDir, '.git'), 'gitdir: /nonexistent/gitdir/path\n', 'utf8');

  const run = runCli(mainDir);
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stderr, /memory\/cli:.*1 worktree\(s\) could not be inspected/i);
  assert.match(run.stderr, new RegExp(wtDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  // F4 (cold review): reason, not just count + path.
  assert.match(run.stderr, /not a git repository/i);
});

// #936 remediation (cold review WARNING): sweepLanes() is documented "never
// throws", but that promise only holds INSIDE its own per-branch loop —
// nothing in cli.mjs's `ship` op enforced it at the call site, so a throw
// from sweepLanes()'s pre-loop code (the shared `fetch`, `listLocalBranches`,
// `listRemoteBranches`, or `slugifyHost`) would land in the SAME `catch` that
// reports today's shipLane() outcome, turning an already-successful ship
// into a reported `memory.ship.failed` / exit 1.
//
// `BRAIN_MEMORY_SWEEP_FORCE_THROW` is a test-only injection seam (mirrors
// `BRAIN_MEMORY_HEAL_FORCE_THROW`, cli.heal-duplicates.test.mjs): it throws
// immediately before cli.mjs's own call to `sweepLanes()`, so this test
// exercises cli.mjs's OWN isolation of that call, independent of whether
// sweepLanes()'s internals ever hit this in practice. NEVER set outside
// tests.
test('#936 remediation: a throwing sweepLanes() never turns today\'s successful ship into a failure — exit 0, fail-closed sweep marker', () => {
  const { mainDir } = fixtureRepo({ withCandidate: false });
  const run = spawnSync(process.execPath, [CLI, 'ship', '--json'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      BRAIN_MEMORY_TEST_ROOT: mainDir,
      MEMORY_BACKEND: 'no-such-backend',
      BRAIN_VCS_TEST_MODULE: FAKE_VCS_MODULE,
      BRAIN_MEMORY_SWEEP_FORCE_THROW: '1',
    },
  });

  assert.equal(run.status, 0, run.stdout + run.stderr);
  const parsed = JSON.parse(run.stdout);
  // Today's own ship outcome is untouched — still the "nothing to ship"
  // shape this fixture always produces.
  assert.equal(parsed.pushed, false);
  assert.equal(parsed.pr, null);
  // The sweep outcome is a fail-closed marker, not `null` and not a thrown
  // process exit — `{ branches: [...] }`'s absence here is itself the proof
  // that the throw was caught before ever reaching the per-branch shape.
  assert.equal(parsed.sweep.failed, true);
  assert.match(parsed.sweep.reason, /BRAIN_MEMORY_SWEEP_FORCE_THROW/);
  // Reported on stderr too — evidence discipline mirrors pushed/prExisting/armed.
  assert.match(run.stderr, /memory\/cli:.*sweep failed/i);
});

test('brain:memory:ship resolves from package.json, beside the other memory:* scripts', () => {
  const pkg = JSON.parse(readFileSync(join(HERE, '../../../package.json'), 'utf8'));
  // #1012: the manual invoker declares itself at the script level — every
  // caller of cli.mjs ship must pass a marker, including this one.
  assert.equal(pkg.scripts['memory:ship'], 'node ./brain/scripts/memory/cli.mjs ship --invoker manual');
});
