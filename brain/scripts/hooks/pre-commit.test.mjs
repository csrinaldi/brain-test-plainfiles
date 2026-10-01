// pre-commit.test.mjs — issue #701 wiring: staged-records-check runs between
// the main/master block and check-refs.mjs. Mirrors pre-push.test.mjs's
// technique: a synthetic PATH with mock node/git shell scripts, no real
// subprocess spawned.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_PATH = new URL('./pre-commit', import.meta.url).pathname;

function makeTempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

/**
 * @param {object} opts
 * @param {string} opts.callLog
 * @param {string} [opts.branch='feature/x']
 * @param {number} [opts.stagedRecordsCode=0]
 * @param {number} [opts.checkRefsCode=0]
 * @param {boolean} [opts.hasCommit=true] issue #1112 gate 0 — whether the
 *   fake repo has any commit at all (`git rev-list -n 1 --all` non-empty).
 *   `true` for every pre-existing test here: they all model a repo that
 *   already has history, which is the universe checks 1/2 governed before
 *   gate 0 existed. `pre-commit.unborn-head.test.mjs` covers the `false`
 *   (no-commit-at-all) path against REAL git; the one test below that sets
 *   `hasCommit: false` here is a fast unit-level mirror of that same gate.
 */
function createMockBin({
  callLog, branch = 'feature/x', stagedRecordsCode = 0, checkRefsCode = 0,
  // #788 — WHERE the commit is being made. The default is a LINKED WORKTREE
  // because that is where task work belongs since #782; every test written
  // before this option was added is a task-branch commit, and a task-branch
  // commit belongs in a worktree. Opt into the main checkout to exercise the
  // refusal.
  inMainCheckout = false,
  hasCommit = true,
}) {
  const binDir = makeTempDir('pc-bin-');
  writeFileSync(
    join(binDir, 'node'),
    [
      '#!/usr/bin/env sh',
      // $1 = script path
      'case "$1" in',
      '  *staged-records-check.mjs)',
      `    echo staged-records-check >> "${callLog}"`,
      `    exit ${stagedRecordsCode}`,
      '    ;;',
      '  *check-refs.mjs)',
      `    echo check-refs >> "${callLog}"`,
      `    exit ${checkRefsCode}`,
      '    ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(binDir, 'node'), 0o755);

  writeFileSync(
    join(binDir, 'git'),
    [
      '#!/usr/bin/env sh',
      'if [ "$1" = "rev-list" ]; then',
      `  ${hasCommit ? "printf 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\\n'" : ':'}`,
      'elif [ "$1" = "rev-parse" ] && [ "$2" = "--abbrev-ref" ]; then',
      `  printf '%s\\n' "${branch}"`,
      'elif [ "$1" = "rev-parse" ] && [ "$2" = "--show-toplevel" ]; then',
      '  printf "/fake/repo\\n"',
      'elif [ "$1" = "rev-parse" ] && [ "$2" = "--git-dir" ]; then',
      `  printf '%s\\n' "${inMainCheckout ? '.git' : '/fake/repo/.git/worktrees/brain-issue-788'}"`,
      'elif [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then',
      `  printf '%s\\n' "${inMainCheckout ? '.git' : '/fake/repo/.git'}"`,
      'fi',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(binDir, 'git'), 0o755);
  return binDir;
}

const SAFE_SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';

function runHook(binDir) {
  return spawnSync('sh', [HOOK_PATH], {
    env: { PATH: `${binDir}:${SAFE_SYSTEM_PATH}`, HOME: process.env.HOME ?? '/tmp' },
    encoding: 'utf8',
    timeout: 5000,
  });
}

function readCallLog(callLog) {
  if (!existsSync(callLog)) return [];
  return readFileSync(callLog, 'utf8').trim().split('\n').filter(Boolean);
}

test('pre-commit: staged-records-check runs BEFORE check-refs, both on a clean branch', (t) => {
  const tmpRoot = makeTempDir('pc-root-');
  const callLog = join(tmpRoot, 'calls.log');
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const binDir = createMockBin({ callLog });
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const result = runHook(binDir);
  assert.equal(result.status, 0);
  assert.deepEqual(readCallLog(callLog), ['staged-records-check', 'check-refs']);
});

test('pre-commit: staged-records-check REFUSING blocks the commit and check-refs never runs', (t) => {
  const tmpRoot = makeTempDir('pc-root-');
  const callLog = join(tmpRoot, 'calls.log');
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const binDir = createMockBin({ callLog, stagedRecordsCode: 1 });
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const result = runHook(binDir);
  assert.equal(result.status, 1);
  assert.deepEqual(readCallLog(callLog), ['staged-records-check'], 'check-refs must never run once the gate refuses');
});

test('pre-commit: a direct commit to main is blocked before either check runs', (t) => {
  const tmpRoot = makeTempDir('pc-root-');
  const callLog = join(tmpRoot, 'calls.log');
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const binDir = createMockBin({ callLog, branch: 'main' });
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const result = runHook(binDir);
  assert.equal(result.status, 1);
  assert.deepEqual(readCallLog(callLog), [], 'the main/master block precedes both checks');
});

// ── #788 · #782 slice 2 — WHERE the commit is being made ──────────────────

test('pre-commit: a task branch in the MAIN CHECKOUT is refused', (t) => {
  // `harness-contract.md` — "NEVER a branch in the main checkout when parallel
  // work is possible". The rule was canonical, compiled into AGENTS.md, and
  // enforced by nothing: an agent session on 2026-08-27 created five such
  // branches with the rule loaded.
  const tmpRoot = makeTempDir('pc-root-');
  const callLog = join(tmpRoot, 'calls.log');
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const binDir = createMockBin({ callLog, branch: 'fix/issue-788', inMainCheckout: true });
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const result = runHook(binDir);
  assert.equal(result.status, 1);
  assert.deepEqual(readCallLog(callLog), [], 'nothing downstream may run once the gate refuses');
});

test('pre-commit: the refusal names the verb AND the bypass', (t) => {
  // A refusal that names no remedy costs the operator the session, and one with
  // no way out gets worked around by hand — which is worse than the rule it
  // guards. The bypass is the one check 1 already established.
  //
  // THE FLAG IS NOT SPELLED IN THIS FILE, and that is `check-refs-rules.mjs`'s
  // `no-verify-bypass` rule working as designed: it scopes itself to tracked
  // SCRIPTS (`onlyExt: .mjs/.js/.ts/.sh`) and deliberately excludes the
  // extensionless hooks, which "document the bypass option to users, which is
  // legitimate self-documentation, not an invocation" (ADR-0014 §9).
  //
  // So the hook may name the flag and this test may not. The alternatives were
  // both worse: splitting the literal to slip past the pattern is the evasion
  // the rule exists to prevent, and adding this file to the exemption list
  // would blind the rule for the whole file — "a dead exemption is not inert".
  // Asserting the command without the flag keeps the coverage and still fails
  // if the refusal stops offering a way out.
  const tmpRoot = makeTempDir('pc-root-');
  const callLog = join(tmpRoot, 'calls.log');
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const binDir = createMockBin({ callLog, branch: 'fix/issue-788', inMainCheckout: true });
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const out = `${runHook(binDir).stdout}${runHook(binDir).stderr}`;
  assert.match(out, /brain:ticket:start/, 'the remedy is the verb that would have done it right');
  assert.match(out, /bypass: git commit/, 'the escape hatch must be named where it is needed');
});

test('pre-commit: the SAME branch inside a linked worktree is silent', (t) => {
  // A guard that fires everywhere is not a guard. This is the direction that
  // proves the check reads WHERE rather than merely refusing.
  const tmpRoot = makeTempDir('pc-root-');
  const callLog = join(tmpRoot, 'calls.log');
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const binDir = createMockBin({ callLog, branch: 'fix/issue-788', inMainCheckout: false });
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const result = runHook(binDir);
  assert.equal(result.status, 0);
  assert.deepEqual(readCallLog(callLog), ['staged-records-check', 'check-refs'],
    'the existing checks must still run, unchanged, where the commit belongs');
});

test('pre-commit: main is still refused by check 1, before the worktree check', (t) => {
  // Ordering matters for the MESSAGE. On `main` in the main checkout both checks
  // would fire; the operator must be told the one that is actionable, and
  // "commit to main" is the more specific fact.
  const tmpRoot = makeTempDir('pc-root-');
  const callLog = join(tmpRoot, 'calls.log');
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const binDir = createMockBin({ callLog, branch: 'main', inMainCheckout: true });
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const result = runHook(binDir);
  assert.equal(result.status, 1);
  assert.match(`${result.stdout}${result.stderr}`, /direct commits to 'main'/);
});

// ── #1112 gate 0 — no commit at all (fast unit-level mirror; the real-git
//    proof, including the orphan-branch regression, lives in
//    pre-commit.unborn-head.test.mjs) ───────────────────────────────────────

test('#1112 gate 0: a repo with NO commit at all is exempt from checks 1 and 2, even on "main" in the main checkout', (t) => {
  const tmpRoot = makeTempDir('pc-root-');
  const callLog = join(tmpRoot, 'calls.log');
  t.after(() => rmSync(tmpRoot, { recursive: true, force: true }));

  const binDir = createMockBin({ callLog, branch: 'main', inMainCheckout: true, hasCommit: false });
  t.after(() => rmSync(binDir, { recursive: true, force: true }));

  const result = runHook(binDir);
  assert.equal(result.status, 0, `expected the no-commit-at-all exemption to pass through; stderr:\n${result.stderr}`);
  assert.deepEqual(readCallLog(callLog), ['staged-records-check', 'check-refs']);
});
