// env-read.test.mjs — issue #316. One reader, one precedence, and a losing
// value that is REPORTED rather than dropped.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseEnvFile,
  resolveEnv,
  readEnv,
  readShellEnv,
  describeResolution,
} from './env-read.mjs';

function withEnvFile(t, body) {
  const root = mkdtempSync(join(tmpdir(), 'brain-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return (contents) => {
    writeFileSync(join(root, '.env'), contents, 'utf8');
    return root;
  };
}

// ── parseEnvFile: one parse, and the four call sites disagreed on all of it ──

test('parseEnvFile: skips comments and blank lines', () => {
  assert.deepEqual(parseEnvFile('# a comment\n\nA=1\n   \n# B=2\nC=3\n'), { A: '1', C: '3' });
});

test('parseEnvFile: splits on the FIRST `=`, so a value may contain one', () => {
  assert.equal(parseEnvFile('URL=https://x/y?a=b\n').URL, 'https://x/y?a=b');
});

test('parseEnvFile: trims the key and the value', () => {
  // `harness/cli.mjs` and `memory/cli.mjs` trimmed the LINE and then sliced, so
  // `KEY = v` produced the key `"KEY "` — unreachable by any lookup, silently.
  // `token.mjs` matched `startsWith("KEY=")`, which never matched it at all.
  assert.deepEqual(parseEnvFile('  KEY  =  value  \n'), { KEY: 'value' });
});

test('parseEnvFile: strips ONE matched pair of surrounding quotes', () => {
  // No call site stripped them, so `VCS_TOKEN="abc"` resolved to `"abc"` WITH
  // the quotes and produced a 401 that named nothing. Same silent-failure class
  // as a dead value in the file.
  assert.equal(parseEnvFile('A="abc"\n').A, 'abc');
  assert.equal(parseEnvFile("B='abc'\n").B, 'abc');
});

test('parseEnvFile: an unmatched or inner quote is left alone', () => {
  assert.equal(parseEnvFile('A="abc\n').A, '"abc');
  assert.equal(parseEnvFile('B=ab"cd\n').B, 'ab"cd');
  assert.equal(parseEnvFile('C="a"b"\n').C, 'a"b');
});

test('parseEnvFile: a line with no `=` is skipped, not half-read', () => {
  assert.deepEqual(parseEnvFile('JUSTAKEY\nA=1\n'), { A: '1' });
});

test('parseEnvFile: an empty value is a STATED empty, not an absence', () => {
  // The distinction #641 already needed one layer up: a key stated empty is an
  // operator's choice; a missing key is not.
  assert.deepEqual(parseEnvFile('A=\n'), { A: '' });
});

// ── resolveEnv: the precedence, ruled shell-first (#316) ───────────────────

test('resolveEnv: the SHELL wins over the file', (t) => {
  const root = withEnvFile(t)('K=from-file\n');
  const r = resolveEnv('K', { env: { K: 'from-shell' }, root });
  assert.equal(r.value, 'from-shell');
  assert.equal(r.source, 'shell');
});

test('resolveEnv: the file is used when the shell does not state the key', (t) => {
  const root = withEnvFile(t)('K=from-file\n');
  const r = resolveEnv('K', { env: {}, root });
  assert.equal(r.value, 'from-file');
  assert.equal(r.source, 'file');
});

test('resolveEnv: the fallback is used when neither states it', (t) => {
  const root = withEnvFile(t)('OTHER=1\n');
  const r = resolveEnv('K', { env: {}, root, fallback: 'default-v' });
  assert.equal(r.value, 'default-v');
  assert.equal(r.source, 'default');
});

test('resolveEnv: absent is absent — no fallback invented', (t) => {
  const root = withEnvFile(t)('OTHER=1\n');
  const r = resolveEnv('K', { env: {}, root });
  assert.equal(r.value, null);
  assert.equal(r.source, 'absent');
});

test('resolveEnv: a missing .env is not an error', () => {
  const r = resolveEnv('K', { env: { K: 'v' }, root: join(tmpdir(), 'brain-env-does-not-exist') });
  assert.equal(r.value, 'v');
  assert.equal(r.source, 'shell');
});

// ── Gap C: the losing value is REPORTED, never silently dropped ────────────

test('resolveEnv: a shadowed file value is reported', (t) => {
  // THE DEFECT THIS CLOSES, measured 2026-08-27: a dead `VCS_TOKEN` line in
  // `.env` shadowed a healthy `gh` keyring session and every port verb answered
  // `HTTP 401 Bad credentials` while `gh auth status` reported a good login.
  // Under shell-first the roles invert — and a caller must still be able to SAY
  // that two values were in play.
  const root = withEnvFile(t)('K=from-file\n');
  const r = resolveEnv('K', { env: { K: 'from-shell' }, root });
  assert.deepEqual(r.shadowed, { source: 'file', value: 'from-file' });
});

test('resolveEnv: identical values in both places are not a shadow', (t) => {
  const root = withEnvFile(t)('K=same\n');
  const r = resolveEnv('K', { env: { K: 'same' }, root });
  assert.equal(r.shadowed, null, 'agreement is not a conflict worth reporting');
});

test('resolveEnv: the file alone shadows nothing', (t) => {
  const root = withEnvFile(t)('K=only-file\n');
  assert.equal(resolveEnv('K', { env: {}, root }).shadowed, null);
});

test('describeResolution: names the key, the source and the shadowed value', (t) => {
  const root = withEnvFile(t)('K=from-file\n');
  const line = describeResolution(resolveEnv('K', { env: { K: 'from-shell' }, root }));
  assert.match(line, /K/);
  assert.match(line, /shell/);
  assert.match(line, /\.env/);
  assert.doesNotMatch(line, /from-shell|from-file/, 'a description must never print the VALUE');
});

// ── readShellEnv: ADR-0033 Amendment 1's non-goal, executable ──────────────

test('readShellEnv: never reads the file, even when the shell is silent', (t) => {
  // ADR-0033 Amendment 1 (#773) ruled that `BRAIN_REVIEWER_TOKEN` stays
  // shell-resolved. Routing the reviewer through the shared reader is the exact
  // shape that would have delivered 1b by accident, so the opt-out is a NAMED
  // spelling at the call site rather than a flag buried in options: a reviewer
  // reading `readShellEnv` can see the ruling being obeyed.
  const root = withEnvFile(t)('SHELL_ONLY=from-file\n');
  assert.equal(readShellEnv('SHELL_ONLY', { env: {}, root }), null);
  assert.equal(readShellEnv('SHELL_ONLY', { env: { SHELL_ONLY: 'from-shell' }, root }), 'from-shell');
});

test('readShellEnv: a file value present but unused is still REPORTED', (t) => {
  // Silence here is what cost a session: three `.env` edits that could not
  // possibly take effect, and nothing said so.
  const root = withEnvFile(t)('SHELL_ONLY=from-file\n');
  const r = resolveEnv('SHELL_ONLY', { env: {}, root, allowFile: false });
  assert.equal(r.value, null);
  assert.equal(r.source, 'absent');
  assert.deepEqual(r.ignored, { source: 'file', reason: 'shell-only' });
});

// ── readEnv: the convenience spelling every call site uses ─────────────────

test('readEnv: returns the value, or null', (t) => {
  const root = withEnvFile(t)('K=v\n');
  assert.equal(readEnv('K', { env: {}, root }), 'v');
  assert.equal(readEnv('MISSING', { env: {}, root }), null);
});

test('readEnv: honours the fallback', (t) => {
  const root = withEnvFile(t)('OTHER=1\n');
  assert.equal(readEnv('K', { env: {}, root, fallback: 'd' }), 'd');
});
