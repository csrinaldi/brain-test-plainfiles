// scripts/hooks/pre-receive.test.mjs — e2e tests for the pre-receive hook.
//
// Creates a real bare git repository, installs the hook, clones it into a working
// copy, then performs actual git pushes to verify the hook enforces commit-message
// invariants — proving a real bare-repo push rejection and acceptance.
//
// Tests:
//   (a) A push with a BAD commit message is rejected (non-zero exit; output mentions
//       "pre-receive").
//   (b) A push with a GOOD message (feat(x): add thing (#1)) is accepted (exit 0).
//   (c) An exempt commit (chore(release): v1.0.0, no ticket ref) is accepted (exit 0).
//
// Guard: all tests are skipped gracefully if git is not available in PATH.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  copyFileSync,
  chmodSync,
} from 'node:fs';
import { removeTempTree } from '../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const HOOK_SRC = new URL('./pre-receive', import.meta.url).pathname;

// Guard: skip all tests if git is not available.
const gitAvailableCheck = spawnSync('git', ['--version'], { encoding: 'utf8' });
const GIT_AVAILABLE = gitAvailableCheck.status === 0;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Spawn git with the given args in the given cwd.
 * Suppresses interactive prompts for CI environments.
 */
function git(args, cwd) {
  return spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
    },
    timeout: 10000,
  });
}

/**
 * Set up an isolated fixture with:
 *   - a bare repo at <root>/server.git with the pre-receive hook installed
 *   - a working clone at <root>/clone with user identity configured
 *
 * Returns { root, bareDir, cloneDir }. Caller is responsible for cleanup.
 */
function setupFixture(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));

  // 1. Bare repo.
  const bareDir = join(root, 'server.git');
  mkdirSync(bareDir, { recursive: true });
  git(['init', '--bare', bareDir]);

  // 2. Install the pre-receive hook.
  const hookDst = join(bareDir, 'hooks', 'pre-receive');
  copyFileSync(HOOK_SRC, hookDst);
  chmodSync(hookDst, 0o755);

  // 3. Working clone.
  const cloneDir = join(root, 'clone');
  git(['clone', bareDir, cloneDir]);

  // 4. Configure user identity (required for git commit in clean/CI environments).
  git(['config', 'user.email', 'test@example.com'], cloneDir);
  git(['config', 'user.name', 'Test User'], cloneDir);

  return { root, bareDir, cloneDir };
}

/**
 * Write a unique file, stage it, commit with the given message, and push to origin.
 * Returns the spawnSync result of `git push`.
 */
function commitAndPush(cloneDir, message) {
  const filename = join(cloneDir, `file-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(filename, `content-${Date.now()}\n`);
  git(['add', '.'], cloneDir);
  git(['commit', '-m', message], cloneDir);
  // Push explicitly to refs/heads/main to avoid upstream-tracking issues on
  // first push to an empty bare repo (avoids "no upstream branch" errors).
  return git(['push', 'origin', 'HEAD:refs/heads/main'], cloneDir);
}

/**
 * Append to an EXISTING tracked file (vs. commitAndPush's new-file creation),
 * commit with the given message, and push to origin. Proves rejection on a
 * realistic MODIFICATION, not only on new-file addition (issue #244 A4, CP-A4a).
 * Returns the spawnSync result of `git push`.
 */
function appendAndPush(cloneDir, file, message) {
  writeFileSync(file, `\nappended-${Date.now()}\n`, { flag: 'a' });
  git(['add', '.'], cloneDir);
  git(['commit', '-m', message], cloneDir);
  return git(['push', 'origin', 'HEAD:refs/heads/main'], cloneDir);
}

// ---------------------------------------------------------------------------
// (a) BAD commit message — push must be REJECTED
// ---------------------------------------------------------------------------

test('pre-receive: rejects push with a non-conventional commit message', { skip: !GIT_AVAILABLE }, (t) => {
  const { root, cloneDir } = setupFixture('pr-bad-');
  t.after(() => removeTempTree(root));

  const result = commitAndPush(cloneDir, 'bad message no ticket');

  assert.notEqual(result.status, 0, 'push must be rejected (non-zero exit)');

  // The hook output (stdout) is forwarded by git to the client's stderr/stdout.
  const combined = (result.stdout ?? '') + (result.stderr ?? '');
  assert.match(
    combined,
    /pre-receive/,
    `rejection output must mention "pre-receive"; got: ${JSON.stringify(combined)}`,
  );
});

// ---------------------------------------------------------------------------
// (b) GOOD commit message — push must be ACCEPTED
// ---------------------------------------------------------------------------

test('pre-receive: accepts push with a valid conventional commit and ticket ref', { skip: !GIT_AVAILABLE }, (t) => {
  const { root, cloneDir } = setupFixture('pr-good-');
  t.after(() => removeTempTree(root));

  const result = commitAndPush(cloneDir, 'feat(x): add thing (#1)');

  assert.equal(
    result.status,
    0,
    `push must succeed (exit 0); stderr: ${result.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// (c) Exempt commit — chore(release) with no ticket ref must be ACCEPTED
// ---------------------------------------------------------------------------

test('pre-receive: accepts exempt chore(release) commit without a ticket ref', { skip: !GIT_AVAILABLE }, (t) => {
  const { root, cloneDir } = setupFixture('pr-exempt-');
  t.after(() => removeTempTree(root));

  const result = commitAndPush(cloneDir, 'chore(release): v1.0.0');

  assert.equal(
    result.status,
    0,
    `exempt chore(release) commit must be accepted (exit 0); stderr: ${result.stderr}`,
  );
});

// ---------------------------------------------------------------------------
// (d) Multi-commit push with a BAD middle commit — the WHOLE push is REJECTED.
//     This is the critical fail-closed scenario: a bad commit must not slip
//     through just because it is not the first or last in the batch.
// ---------------------------------------------------------------------------

test('pre-receive: rejects a multi-commit push when a middle commit is bad', { skip: !GIT_AVAILABLE }, (t) => {
  const { root, cloneDir } = setupFixture('pr-multi-');
  t.after(() => removeTempTree(root));

  // Three commits in ONE push: good, BAD (middle), good.
  for (const msg of ['feat(a): first (#1)', 'bad middle commit', 'feat(c): third (#3)']) {
    const f = join(cloneDir, `f-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
    writeFileSync(f, `c-${Date.now()}\n`);
    git(['add', '.'], cloneDir);
    git(['commit', '-m', msg], cloneDir);
  }
  const result = git(['push', 'origin', 'HEAD:refs/heads/main'], cloneDir);

  assert.notEqual(result.status, 0, 'a batch containing any bad commit must be rejected');
  const combined = (result.stdout ?? '') + (result.stderr ?? '');
  assert.match(combined, /pre-receive/, `rejection must mention "pre-receive"; got: ${JSON.stringify(combined)}`);
});

// ---------------------------------------------------------------------------
// (e) CP-A4a — APPEND to an existing tracked file (issue #244 A4, REQ-A4-4).
//     Proves rejection on a realistic MODIFICATION, not only on new-file
//     addition — the fixture-tested GitLab-server-hook acceptance evidence
//     (the hook is provider-agnostic pure git-server mechanics — no GitLab,
//     no network).
// ---------------------------------------------------------------------------

test('pre-receive: rejects an append to a tracked file with a non-compliant message (bare-repo push rejection, CP-A4a)', { skip: !GIT_AVAILABLE }, (t) => {
  const { root, cloneDir } = setupFixture('pr-append-bad-');
  t.after(() => removeTempTree(root));

  // First: a COMPLIANT commit that creates a tracked file.
  const first = commitAndPush(cloneDir, 'feat(x): create tracked file (#1)');
  assert.equal(first.status, 0, `setup push must succeed; stderr: ${first.stderr}`);

  const trackedFile = join(cloneDir, 'tracked.txt');
  writeFileSync(trackedFile, 'initial content\n');
  git(['add', '.'], cloneDir);
  git(['commit', '-m', 'feat(x): add tracked.txt (#1)'], cloneDir);
  const seed = git(['push', 'origin', 'HEAD:refs/heads/main'], cloneDir);
  assert.equal(seed.status, 0, `seed push must succeed; stderr: ${seed.stderr}`);

  const beforeRef = git(['rev-parse', 'origin/main'], cloneDir).stdout.trim();

  // Then: APPEND to that file with a NON-COMPLIANT message → rejected.
  const result = appendAndPush(cloneDir, trackedFile, 'bad append no ticket');

  assert.notEqual(result.status, 0, 'append push must be rejected (non-zero exit)');
  const combined = (result.stdout ?? '') + (result.stderr ?? '');
  assert.match(combined, /pre-receive/, `rejection output must mention "pre-receive"; got: ${JSON.stringify(combined)}`);

  git(['fetch', 'origin'], cloneDir);
  const afterRef = git(['rev-parse', 'origin/main'], cloneDir).stdout.trim();
  assert.equal(afterRef, beforeRef, "bare repo's ref must NOT be updated past the last compliant commit");
});

test('pre-receive: accepts an append to a tracked file with a compliant message (bare-repo push acceptance, CP-A4a)', { skip: !GIT_AVAILABLE }, (t) => {
  const { root, cloneDir } = setupFixture('pr-append-good-');
  t.after(() => removeTempTree(root));

  const trackedFile = join(cloneDir, 'tracked.txt');
  writeFileSync(trackedFile, 'initial content\n');
  git(['add', '.'], cloneDir);
  git(['commit', '-m', 'feat(x): add tracked.txt (#1)'], cloneDir);
  const seed = git(['push', 'origin', 'HEAD:refs/heads/main'], cloneDir);
  assert.equal(seed.status, 0, `seed push must succeed; stderr: ${seed.stderr}`);

  const result = appendAndPush(cloneDir, trackedFile, 'feat(x): append to tracked file (#1)');

  assert.equal(result.status, 0, `compliant append push must succeed (exit 0); stderr: ${result.stderr}`);

  const afterRef = git(['rev-parse', 'origin/main'], cloneDir).stdout.trim();
  const localRef = git(['rev-parse', 'HEAD'], cloneDir).stdout.trim();
  assert.equal(afterRef, localRef, "bare repo's ref must reflect the new commit");
});
