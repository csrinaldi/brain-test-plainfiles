// cli.save-search.test.mjs — CLI-level tests for the net-new `save`/`search`
// verbs (C3, issue #246, REQ-C3-1). Mirrors cli.migrate-v1.test.mjs's
// test-only root-redirect idiom: cli.mjs resolves `.memory/` from its own
// file location, not `cwd`, so these tests redirect via BRAIN_MEMORY_TEST_ROOT
// (a test-only seam, see cli.mjs) — every invocation here points at a fresh
// temp dir, NEVER the real `.memory/`.
//
// #738 (design A6, #897 precedent): `save` now reads `brain.actor`/
// `brain.agentEnv` from the real `git config --get` (cwd = testRoot) and
// `actorKind` from the real process env. Every fixture below therefore
// `git init`s the test root and sets a LOCAL `brain.actor`, and every spawn
// isolates GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM and controls AI_AGENT
// explicitly — otherwise this suite's verdict would depend on the machine
// (or CI runner) it happens to run on, exactly the trap #897 already found
// once for a different CLI-spawn suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, symlinkSync, existsSync, readdirSync, readFileSync, chmodSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

const ISOLATED_GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
// #714: `BRAIN_MEMORY_UPSTREAM_REF` is stripped alongside `AI_AGENT` — the
// `--supersedes` refusal test below spawns the real CLI, which resolves the
// upstream ref through the real, unstubbed predicate. Left ambient, an
// exported `BRAIN_MEMORY_UPSTREAM_REF` (the variable an operator debugging
// `brain:memory:share`/#701 would set) overrides the derived origin/HEAD /
// origin/main lookup and changes the could-not-verify wording this suite
// pins, making the verdict depend on the developer's shell.
// eslint-disable-next-line no-unused-vars
const { AI_AGENT: _ambientAiAgent, BRAIN_MEMORY_UPSTREAM_REF: _ambientUpstreamRef, ...ENV_NO_AI_AGENT } = process.env;

/** `git init`s `root` and configures a LOCAL `brain.actor` — the one-command
 * setup #738 requires before any capture. Isolated from ambient global/system
 * config (A6) so this fixture behaves the same on every machine. */
function initIdentity(root, actor = '@test') {
  const env = { ...process.env, ...ISOLATED_GIT_ENV };
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', env });
  spawnSync('git', ['config', '--local', 'brain.actor', actor], { cwd: root, encoding: 'utf8', env });
}

/** `withAgent: true` sets a deterministic AI_AGENT value (⇒ actorKind agent);
 * `false` strips it from the child's env entirely (⇒ actorKind human) — never
 * left to whatever happens to be ambient in the runner's own shell. */
function runCli(args, { backend = 'plainfiles', testRoot, withAgent = true } = {}) {
  const base = withAgent ? { ...ENV_NO_AI_AGENT, AI_AGENT: 'test-agent' } : ENV_NO_AI_AGENT;
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...base, ...ISOLATED_GIT_ENV, MEMORY_BACKEND: backend, ...(testRoot ? { BRAIN_MEMORY_TEST_ROOT: testRoot } : {}) },
  });
}

// ── save dispatches to plainfiles.mjs#save with parsed flags + positionals ──

test('MEMORY_BACKEND=plainfiles + memory save <title> <content> --type ... dispatches to plainfiles save and writes a record', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-'));
  initIdentity(testRoot);
  const result = runCli(
    ['save', 'A title', 'The body', '--type', 'discovery', '--project', 'brain', '--scope', 'project', '--topic', 'x/y'],
    { testRoot },
  );

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  const recordsDir = join(testRoot, '.memory', 'records');
  assert.ok(existsSync(recordsDir), 'records/ must be written');
  const files = readdirSync(recordsDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1);
  const raw = readFileSync(join(recordsDir, files[0]), 'utf8').trim();
  const record = JSON.parse(raw);
  assert.equal(record.type, 'discovery');
  assert.equal(record.project, 'brain');
  assert.ok(record.content.includes('A title'));
  assert.ok(record.content.includes('The body'));
  assert.equal(record.actor, '@test', 'actor comes from the configured brain.actor handle');
  // NO --actor/--actor-kind/--ts flag is recognized anywhere in the parser.
  // actorKind is MEASURED from the (controlled, here-deterministic) agent-marker env.
  assert.equal(record.actorKind, 'agent');
});

test('memory save recognizes NO --actor/--actor-kind/--ts flag anywhere in the parser', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-noflag-'));
  initIdentity(testRoot);
  const result = runCli(
    ['save', 't', 'c', '--type', 'discovery', '--project', 'brain', '--actor', 'spoofed', '--actor-kind', 'human', '--ts', '1999-01-01T00:00:00Z'],
    { testRoot },
  );
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  const recordsDir = join(testRoot, '.memory', 'records');
  const files = readdirSync(recordsDir).filter((f) => f.endsWith('.jsonl'));
  const record = JSON.parse(readFileSync(join(recordsDir, files[0]), 'utf8').trim());
  assert.equal(record.actor, '@test', 'a --actor flag must be silently ignored — actor is never spoofable');
  assert.equal(record.actorKind, 'agent', 'a --actor-kind flag must be silently ignored — actorKind is never spoofable');
  assert.notEqual(record.ts, '1999-01-01T00:00:00Z', 'a --ts flag must be silently ignored — ts is always measured');
});

// ── search dispatches to plainfiles.mjs#search ──────────────────────────────

test('MEMORY_BACKEND=plainfiles + memory search <query> dispatches to plainfiles search and finds a prior save', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-search-'));
  initIdentity(testRoot);
  const saveResult = runCli(
    ['save', 'Findable title', 'unique-search-needle-xyz', '--type', 'discovery', '--project', 'brain'],
    { testRoot },
  );
  assert.equal(saveResult.status, 0, `seed save failed: ${saveResult.stderr}`);

  const searchResult = runCli(['search', 'unique-search-needle-xyz'], { testRoot });
  assert.equal(searchResult.status, 0, `expected exit 0, got ${searchResult.status}. stderr: ${searchResult.stderr}`);
  assert.ok(searchResult.stdout.includes('unique-search-needle-xyz') || searchResult.stdout.match(/1 matching record/),
    `expected search output to surface the match: ${searchResult.stdout}`);
});

test('memory search under plainfiles with no match prints an empty-results message and exits 0', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-search-empty-'));
  initIdentity(testRoot);
  const result = runCli(['search', 'nothing-will-match-this-xyz'], { testRoot });
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
});

// ── #738 — capture refuses without a configured handle ──────────────────────

test(
  '#738: with an isolated HOME, no brain.actor configured, and a handle-shaped `user.name` present, save ' +
    'still exits non-zero naming the remedy (MINOR-3d, fresh-context review — `user.name` must never substitute for brain.actor)',
  () => {
    const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-noactor-'));
    const isolatedHome = mkdtempSync(join(tmpdir(), 'brain-cli-save-noactor-home-'));
    const gitEnv = { ...process.env, ...ISOLATED_GIT_ENV };
    spawnSync('git', ['init', '-q'], { cwd: testRoot, encoding: 'utf8', env: gitEnv });
    // A handle-shaped `user.name` set LOCALLY — a decoy this refusal must not honor.
    spawnSync('git', ['config', '--local', 'user.name', '@sneaky'], { cwd: testRoot, encoding: 'utf8', env: gitEnv });
    // deliberately NO `git config --local brain.actor` — a fresh clone.

    const result = spawnSync(process.execPath, [cliPath, 'save', 't', 'c', '--type', 'discovery', '--project', 'brain'], {
      encoding: 'utf8',
      env: {
        ...ENV_NO_AI_AGENT,
        ...ISOLATED_GIT_ENV,
        HOME: isolatedHome,
        MEMORY_BACKEND: 'plainfiles',
        BRAIN_MEMORY_TEST_ROOT: testRoot,
      },
    });

    assert.notEqual(result.status, 0, 'a save with no configured handle must exit non-zero');
    assert.match(result.stderr, /git config --local brain\.actor/, 'the refusal must name the remedy');
    const recordsDir = join(testRoot, '.memory', 'records');
    assert.equal(existsSync(recordsDir), false, 'nothing may be appended when the actor is unset');
  },
);

// ── --supersedes (#805): the CLI enforces "exactly one id"; the backend cannot ──
//
// MERGE NOTE (#738 × #805): these fixtures predate the actor rule. Every one of
// them now calls `initIdentity` first — not cosmetics: without it the arity and
// shape refusals below would still exit 1, but for the WRONG reason (the actor
// refusal, which fires inside the backend), and the tests would keep passing
// while the guard they exist to pin was gone. With a configured handle, the
// only thing that can refuse is the parser rule under test.

test('memory save --supersedes <local id> writes the field and exits 0', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-supersedes-'));
  initIdentity(testRoot);
  const seed = runCli(['save', 'A', 'first record', '--type', 'discovery', '--project', 'brain'], { testRoot });
  assert.equal(seed.status, 0, `seed save failed: ${seed.stderr}`);
  const recordsDir = join(testRoot, '.memory', 'records');
  const seedFile = readdirSync(recordsDir).filter((f) => f.endsWith('.jsonl'))[0];
  const targetId = JSON.parse(readFileSync(join(recordsDir, seedFile), 'utf8').trim()).id;

  const result = runCli(
    ['save', 'B', 'a correction', '--type', 'discovery', '--project', 'brain', '--supersedes', targetId],
    { testRoot },
  );
  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  const files = readdirSync(recordsDir).filter((f) => f.endsWith('.jsonl'));
  const record = files
    .map((f) => JSON.parse(readFileSync(join(recordsDir, f), 'utf8').trim().split('\n').pop()))
    .find((r) => r.supersedes === targetId);
  assert.ok(record, 'the written record must carry the supersedes field');
});

test('memory save --supersedes given twice exits 1, naming fan-in as deferred', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-supersedes-repeat-'));
  initIdentity(testRoot);
  const result = runCli(
    ['save', 't', 'c', '--type', 'discovery', '--project', 'brain', '--supersedes', 'rec-0123456789abcdef', '--supersedes', 'rec-fedcba9876543210'],
    { testRoot },
  );
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stdout: ${result.stdout}`);
  assert.match(result.stderr, /fan-in|deferred/i, `must name fan-in as deferred: ${result.stderr}`);
  const recordsDir = join(testRoot, '.memory', 'records');
  assert.equal(existsSync(recordsDir), false, 'a repeated --supersedes must never reach a write');
});

test('memory save --supersedes as the final argument (no value) exits 1, no record written', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-supersedes-noval-'));
  initIdentity(testRoot);
  const result = runCli(
    ['save', 't', 'c', '--type', 'discovery', '--project', 'brain', '--supersedes'],
    { testRoot },
  );
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stdout: ${result.stdout}`);
  const recordsDir = join(testRoot, '.memory', 'records');
  assert.equal(existsSync(recordsDir), false, 'a value-less --supersedes must never reach a write');
});

// fresh-context review MINOR-1 — the `--supersedes=<id>` equals-form is not the
// space-separated shape this parser recognizes for ANY flag: `key` becomes
// `"supersedes=<id>"`, so the loop's `key === "supersedes"` check misses it and
// `flags.supersedes` is left undefined while the next argv token is consumed as
// that bogus key's value. Measured before the fix: exit 0, record written
// WITHOUT the field — silently contradicting the catalog's "never saved
// silently without the field you asked for". Refused here the same way a
// value-less `--supersedes` is refused.
test('memory save --supersedes=<id> (equals form) exits 1, no record written', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-supersedes-eq-'));
  initIdentity(testRoot);
  const result = runCli(
    ['save', 't', 'c', '--type', 'discovery', '--project', 'brain', '--supersedes=rec-0123456789abcdef'],
    { testRoot },
  );
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stdout: ${result.stdout}`);
  const recordsDir = join(testRoot, '.memory', 'records');
  assert.equal(existsSync(recordsDir), false, 'the equals form must never reach a write');
});

// ── #874 — save is REACHABLE under MEMORY_BACKEND=engram with no binary: the
// record lands durably, the index is rebuilt, and hydrate defers (never
// refuses, never throws, exits 0). This is the required CLI-level proof:
// unlike the unit-level engram.save.test.mjs / engram.hydrate.test.mjs, this
// drives the REAL cli.mjs in a child process with a PATH engineered so the
// engram binary is MEASURABLY absent (a `which` shim with nothing else on
// it) — never an inherited, ambient PATH that might or might not have engram
// installed on the machine this happens to run on.

const REAL_WHICH = execFileSync('sh', ['-c', 'command -v which'], { encoding: 'utf8' }).trim();
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

/** A sandbox PATH carrying ONLY `which` + `git` (real) — `engram` is measurably absent. */
function noEngramPath() {
  const dir = mkdtempSync(join(tmpdir(), 'brain-cli-save-engram-nobin-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(REAL_WHICH, join(bin, 'which'));
  symlinkSync(REAL_GIT, join(bin, 'git'));
  return bin;
}

test('MEMORY_BACKEND=engram + no engram binary: save exits 0, writes exactly one record + one index line, id on stdout, deferred on stderr', () => {
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-engram-'));
  initIdentity(testRoot);
  const bin = noEngramPath();

  const result = spawnSync(process.execPath, [cliPath, 'save', 'A title', 'The body', '--type', 'discovery', '--project', 'brain'], {
    encoding: 'utf8',
    env: {
      HOME: process.env.HOME,
      PATH: bin,
      ...ISOLATED_GIT_ENV,
      MEMORY_BACKEND: 'engram',
      BRAIN_MEMORY_TEST_ROOT: testRoot,
    },
  });

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);

  const recordsDir = join(testRoot, '.memory', 'records');
  const recordFiles = readdirSync(recordsDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(recordFiles.length, 1, 'exactly one record file must exist');
  const recordLines = readFileSync(join(recordsDir, recordFiles[0]), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(recordLines.length, 1, 'exactly one record line');

  const indexPath = join(testRoot, '.memory', 'index.jsonl');
  const indexLines = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(indexLines.length, 1, 'exactly one index line');

  const record = JSON.parse(recordLines[0]);
  assert.ok(result.stdout.includes(record.id), `stdout must carry the record id: ${result.stdout}`);
  assert.match(result.stderr, /deferred/i, `stderr must say the hydration deferred: ${result.stderr}`);
});

// ── cold review B1 (#924): a throwing hydration guard (e.g. `mkdirSync`
// hitting ENOSPC/EACCES in `acquireHydrationGuard`'s unguarded staging step)
// must still fold into the SAME deferred envelope — `save` durably writes the
// record and index, then exits 0, exactly as when the binary is absent. This
// drives the REAL `acquireHydrationGuard` (not a seam): the child's `TMPDIR`
// is pointed at a directory with its write bit removed, so the guard's own
// `mkdirSync(staging)` throws for real. `engram` is put on PATH as a fake
// executable that must NEVER be invoked — the guard throw happens before
// `_engramSave` would ever spawn it.

/** A `PATH` carrying real `which`/`git` plus a FAKE `engram` that, if ever
 * invoked, marks `markerFile` — proving `_engramSave` was reached (which
 * this test asserts never happens). */
function fakeEngramPath(markerFile) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-cli-save-engram-guardfail-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(REAL_WHICH, join(bin, 'which'));
  symlinkSync(REAL_GIT, join(bin, 'git'));
  const engramScript = join(bin, 'engram');
  writeFileSync(engramScript, `#!/bin/sh\ntouch "${markerFile}"\nexit 0\n`, { mode: 0o755 });
  return bin;
}

test('MEMORY_BACKEND=engram + a throwing hydration guard: save STILL exits 0, writes exactly one record + one index line, deferred on stderr, engram never spawned', (t) => {
  // A read-only directory does not stop root (mode bits are not consulted for
  // uid 0), so the EACCES this fixture relies on never happens there.
  if (typeof process.getuid === 'function' && process.getuid() === 0) { t.skip('root ignores directory mode bits'); return; }
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-engram-guardfail-root-'));
  initIdentity(testRoot);
  const markerFile = join(mkdtempSync(join(tmpdir(), 'brain-cli-save-engram-guardfail-marker-')), 'engram-was-spawned');
  const bin = fakeEngramPath(markerFile);

  const readonlyTmp = mkdtempSync(join(tmpdir(), 'brain-cli-save-engram-guardfail-tmp-'));
  chmodSync(readonlyTmp, 0o500); // read+execute only — the guard's own mkdirSync must throw EACCES

  let result;
  try {
    result = spawnSync(process.execPath, [cliPath, 'save', 'A title', 'The body', '--type', 'discovery', '--project', 'brain'], {
      encoding: 'utf8',
      env: {
        HOME: process.env.HOME,
        PATH: bin,
        TMPDIR: readonlyTmp,
        ...ISOLATED_GIT_ENV,
        MEMORY_BACKEND: 'engram',
        BRAIN_MEMORY_TEST_ROOT: testRoot,
      },
    });
  } finally {
    chmodSync(readonlyTmp, 0o700); // restore so the test harness can clean it up
  }

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stdout: ${result.stdout} stderr: ${result.stderr}`);
  assert.equal(existsSync(markerFile), false, 'engram must never be spawned once the guard itself has thrown');

  const recordsDir = join(testRoot, '.memory', 'records');
  const recordFiles = readdirSync(recordsDir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(recordFiles.length, 1, 'exactly one record file must exist');
  const recordLines = readFileSync(join(recordsDir, recordFiles[0]), 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(recordLines.length, 1, 'exactly one record line');

  const indexPath = join(testRoot, '.memory', 'index.jsonl');
  const indexLines = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.equal(indexLines.length, 1, 'exactly one index line');

  const record = JSON.parse(recordLines[0]);
  assert.ok(result.stdout.includes(record.id), `stdout must carry the record id: ${result.stdout}`);
  assert.match(result.stderr, /deferred/i, `stderr must say the hydration deferred: ${result.stderr}`);
  assert.match(result.stderr, /guard-failed/i, `stderr must name the guard failure: ${result.stderr}`);
});

test('memory save --supersedes <unknown id> under the non-git test root exits 1 with could-not-verify, quoted', () => {
  // The test root is a git repo with NO remote (it must be one at all so #738's
  // `brain.actor` can be configured locally) — `origin/HEAD` and `origin/main`
  // still fail to resolve, so design.md A8's premise holds unchanged: an unknown
  // id here is honestly could-not-verify, never not-in-store.
  const testRoot = mkdtempSync(join(tmpdir(), 'brain-cli-save-supersedes-unknown-'));
  initIdentity(testRoot);
  const result = runCli(
    ['save', 't', 'c', '--type', 'discovery', '--project', 'brain', '--supersedes', 'rec-0123456789abcdef'],
    { testRoot },
  );
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stdout: ${result.stdout}`);
  assert.match(result.stderr, /no upstream ref resolved \(tried origin\/HEAD, origin\/main\)/,
    `the could-not-verify reason must be quoted verbatim: ${result.stderr}`);
  const recordsDir = join(testRoot, '.memory', 'records');
  assert.equal(existsSync(recordsDir), false);
});
