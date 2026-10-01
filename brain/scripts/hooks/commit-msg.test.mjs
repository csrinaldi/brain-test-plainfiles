// scripts/hooks/commit-msg.test.mjs — integration tests for the commit-msg hook.
// (Issue #91)
//
// Acceptance criteria:
//
//   (a) A merge / revert / chore(release) / chore(memory) commit with no #N is
//       allowed (exit 0) — these are machine-generated and ticket-less.
//   (b) A feat / fix commit with no #N is still blocked (exit 1).
//   (c) The conventional-commit FORMAT check still applies to everyone
//       (a non-conventional message is blocked).
//   (d) A well-formed commit carrying a #N ref passes.
//
// Technique: write each candidate message to a temp commit-msg file and invoke
// the hook as `sh <hook> <file>` with the real PATH (node must be present so the
// `command -v node` guard does not short-circuit). Assertions are on exit code.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Absolute path to the hook under test.
const HOOK_PATH = new URL('./commit-msg', import.meta.url).pathname;

/**
 * Run the commit-msg hook against a message string.
 * The real PATH is preserved so the hook's `command -v node` guard passes and
 * the format / ticket-ref checks actually execute.
 *
 * @param {string} message  The candidate commit message.
 * @returns {number} The hook's exit status (0 = allowed, 1 = blocked).
 */
function runHook(message) {
  const dir = mkdtempSync(join(tmpdir(), 'cm-'));
  try {
    const msgFile = join(dir, 'COMMIT_EDITMSG');
    writeFileSync(msgFile, message);
    const result = spawnSync('sh', [HOOK_PATH, msgFile], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME ?? '/tmp' },
      encoding: 'utf8',
      timeout: 5000,
    });
    return result.status;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// (a) Exempt commit types are allowed without a #N
// ---------------------------------------------------------------------------

const EXEMPT_WITHOUT_REF = [
  ["Merge branch 'feature/x' into main", 'merge'],
  ['Revert "feat(auth): add JWT validation"', 'revert'],
  ['chore(release): v0.7.0', 'chore(release)'],
  ['chore(memory): sync session handoff', 'chore(memory)'],
];

for (const [message, label] of EXEMPT_WITHOUT_REF) {
  test(`commit-msg: ${label} commit with no #N is allowed`, () => {
    assert.equal(
      runHook(message),
      0,
      `${label} commit must be exempt from the ticket-ref requirement`,
    );
  });
}

// ---------------------------------------------------------------------------
// (b) Non-exempt types still require a #N
// ---------------------------------------------------------------------------

const REQUIRES_REF = [
  ['feat: add new endpoint', 'feat'],
  ['fix(hooks): correct exit code', 'fix'],
  ['refactor(core): extract helper', 'refactor'],
  ['perf(db): cache lookups', 'perf'],
  // The exemption is NARROW: only the exact chore(release)/chore(memory) scopes
  // are exempt. Adjacent scopes must still require a ticket ref.
  ['chore(release-notes): update changelog', 'chore(release-notes)'],
  ['chore(memory-sync): extra sync', 'chore(memory-sync)'],
];

for (const [message, label] of REQUIRES_REF) {
  test(`commit-msg: ${label} commit with no #N is blocked`, () => {
    assert.equal(
      runHook(message),
      1,
      `${label} commit must still require a ticket ref`,
    );
  });
}

// ---------------------------------------------------------------------------
// (c) The conventional-commit FORMAT check applies to everyone
// ---------------------------------------------------------------------------

test('commit-msg: a non-conventional message is blocked (format check)', () => {
  assert.equal(runHook('updated some files (#42)'), 1);
});

// ---------------------------------------------------------------------------
// (d) A well-formed commit carrying a #N ref passes
// ---------------------------------------------------------------------------

test('commit-msg: feat commit with a #N ref is allowed', () => {
  assert.equal(runHook('feat(auth): add JWT validation (#42)'), 0);
});

test('commit-msg: ticket ref in the body (Closes #N) is accepted', () => {
  assert.equal(runHook('fix(hooks): correct exit code\n\nCloses #91'), 0);
});
