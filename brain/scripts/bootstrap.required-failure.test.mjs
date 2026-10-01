// bootstrap.required-failure.test.mjs — issue #1112, cold-review round 3,
// should-fix (class C): a refused PAT write must not be a clean exit.
//
// The fail-closed gate (blocker 2, then extended for symlinks in round 3)
// refuses to write an unsafe `.env`, but only ever `warn`ed — the same soft
// signal `bootstrap.sh` already uses for genuinely optional degradations
// (a missing `gh` binary, a failed `brain:memory:pull`). A VCS token the
// operator actually typed in, that env:init could not safely persist, is not
// optional in that sense: MISSING_OPTIONAL's own name says what class it is
// for. `REQUIRED_FAILURES` is the separate list for this class — appended
// only when the operator tried to provide a token the write-gate refused —
// and a non-empty list both names itself in the final summary AND turns into
// a non-zero exit code, so a script that still prints "Environment ready"
// is not also read as success by anything that checks `$?`.
//
// Two fragments, lifted verbatim out of bootstrap.sh (#340):
//   - `pat-write-gate`: the same fragment blocker 2 already covers, now also
//     asserted to push onto REQUIRED_FAILURES on every refusal.
//   - `required-failure-summary`: prints the summary line and exits 1 when
//     REQUIRED_FAILURES is non-empty; otherwise falls through untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const LINES = readFileSync(BOOTSTRAP, 'utf8').split('\n');

function fragment(beginMarker, endMarker) {
  const start = LINES.findIndex((l) => l.includes(beginMarker));
  assert.ok(start >= 0, `bootstrap.sh must have a ${beginMarker} marker`);
  const end = LINES.findIndex((l, i) => i > start && l.includes(endMarker));
  assert.ok(end > start, `bootstrap.sh must have a matching ${endMarker} marker`);
  return LINES.slice(start + 1, end).join('\n');
}

const WRITE_GATE = fragment('BEGIN pat-write-gate', 'END pat-write-gate');
const SUMMARY = fragment('BEGIN required-failure-summary', 'END required-failure-summary');

// ── pat-write-gate: a refusal must record a REQUIRED failure ───────────────

function runWriteGate({ envSecretSafe, envSecretUnsafeReason = '', patValue }) {
  const script = [
    'set -euo pipefail',
    'env_set() { :; }', // never reached when unsafe; a no-op is enough here
    'ok()   { :; }',
    'warn() { :; }',
    'REQUIRED_FAILURES=()',
    'VCS_TOKEN_VAR=VCS_TOKEN',
    `VCS_TOKEN="${patValue}"`,
    `ENV_SECRET_SAFE=${envSecretSafe}`,
    `ENV_SECRET_UNSAFE_REASON=${envSecretUnsafeReason}`,
    'ENV_SYMLINK_TARGET=/outside/secrets.env',
    'I18N_BOOTSTRAP_PAT_SKIPPED=skipped',
    'I18N_BOOTSTRAP_PAT_SAVED="%s saved"',
    'I18N_BOOTSTRAP_PAT_TRACKEDREFUSED="%s tracked-refused"',
    'I18N_BOOTSTRAP_PAT_GITIGNOREREFUSED="%s gitignore-refused"',
    'I18N_BOOTSTRAP_PAT_SYMLINKREFUSED="%s symlink-refused: %s"',
    'I18N_BOOTSTRAP_PAT_NOTREGULARFILEREFUSED="%s notregular-refused"',
    'I18N_BOOTSTRAP_PAT_HARDLINKEDREFUSED="%s hardlinked-refused"',
    'I18N_BOOTSTRAP_PAT_SETTINGSNOTE=settings-note',
    WRITE_GATE,
    'printf \'%s\' "${#REQUIRED_FAILURES[@]}"',
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

for (const reason of ['tracked', 'ignoreFailed', 'symlink', 'notRegularFile']) {
  test(`#1112 pat-write-gate: a refused write (reason=${reason}) records exactly one REQUIRED_FAILURES entry`, () => {
    const result = runWriteGate({ envSecretSafe: 'false', envSecretUnsafeReason: reason, patValue: 'CANDIDATE_PAT_VALUE_NOT_REAL_00000000' });
    assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
    assert.equal(result.stdout, '1', `expected exactly one REQUIRED_FAILURES entry for reason=${reason}; stderr:\n${result.stderr}`);
  });
}

test('#1112 pat-write-gate: a SAFE write records no failure', () => {
  const result = runWriteGate({ envSecretSafe: 'true', patValue: 'CANDIDATE_PAT_VALUE_NOT_REAL_00000000' });
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.equal(result.stdout, '0');
});

test('#1112 pat-write-gate: an EMPTY token (operator skipped) records no failure — nothing was attempted', () => {
  const result = runWriteGate({ envSecretSafe: 'false', envSecretUnsafeReason: 'tracked', patValue: '' });
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.equal(result.stdout, '0', 'skipping the prompt is not a failed attempt');
});

// ── required-failure-summary: names the failure(s) and exits non-zero ──────

function runSummary(requiredFailures) {
  const arrayLiteral = requiredFailures.length
    ? `REQUIRED_FAILURES=(${requiredFailures.map((f) => `"${f}"`).join(' ')})`
    : 'REQUIRED_FAILURES=()';
  const script = [
    'set -uo pipefail', // NOT -e: this fragment's own `exit 1` must be observable, not treated as a script-fatal error by the wrapper
    arrayLiteral,
    'I18N_BOOTSTRAP_DONE_REQUIREDFAILED="required step(s) failed: %s"',
    SUMMARY,
    'echo AFTER_SUMMARY_UNREACHED_IF_FAILURES', // proves the fragment actually exits, rather than merely printing
  ].join('\n');
  return spawnSync('bash', ['-c', script], { encoding: 'utf8' });
}

test('#1112 required-failure-summary: non-empty REQUIRED_FAILURES exits non-zero and names the failure', () => {
  const result = runSummary(['VCS_TOKEN not saved (.env is tracked)']);
  assert.notEqual(result.status, 0, 'a required failure must exit non-zero');
  assert.match(result.stdout, /required step\(s\) failed/);
  assert.match(result.stdout, /VCS_TOKEN not saved/);
  assert.doesNotMatch(result.stdout, /AFTER_SUMMARY_UNREACHED_IF_FAILURES/, 'the fragment must actually exit, not just print');
});

test('#1112 required-failure-summary: empty REQUIRED_FAILURES falls through untouched, exit 0', () => {
  const result = runSummary([]);
  assert.equal(result.status, 0, `stderr:\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /required step\(s\) failed/);
  assert.match(result.stdout, /AFTER_SUMMARY_UNREACHED_IF_FAILURES/);
});
