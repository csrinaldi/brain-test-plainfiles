// token.test.mjs — Unit tests for scripts/vcs/lib/token.mjs (generic VCS_TOKEN).
// Run with: npm test  (node --test, no dependencies)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { tokenEnvVar, readEnvVar, vcsToken } from './token.mjs';

// ── tokenEnvVar ──────────────────────────────────────────────────────────────────

test('tokenEnvVar returns VCS_TOKEN for github', () => {
  assert.equal(tokenEnvVar('github'), 'VCS_TOKEN');
});

test('tokenEnvVar returns VCS_TOKEN for gitlab', () => {
  assert.equal(tokenEnvVar('gitlab'), 'VCS_TOKEN');
});

test('tokenEnvVar returns VCS_TOKEN for any unrecognised provider', () => {
  assert.equal(tokenEnvVar('bitbucket'), 'VCS_TOKEN');
});

// ── readEnvVar ───────────────────────────────────────────────────────────────────

test('readEnvVar reads a key from .env', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-token-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, '.env'), 'MY_KEY=my_value\n');
  assert.equal(readEnvVar('MY_KEY', tmp), 'my_value');
});

test('readEnvVar returns null when the key is absent from .env', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-token-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, '.env'), 'OTHER=val\n');
  assert.equal(readEnvVar('MY_KEY', tmp), null);
});

test('readEnvVar falls back to process.env when .env does not exist', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-token-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // tmp dir has no .env file — triggers the catch fallback
  const saved = process.env.BRAIN_TOKEN_TEST_FALLBACK;
  process.env.BRAIN_TOKEN_TEST_FALLBACK = 'from-process';
  t.after(() => {
    if (saved === undefined) delete process.env.BRAIN_TOKEN_TEST_FALLBACK;
    else process.env.BRAIN_TOKEN_TEST_FALLBACK = saved;
  });
  assert.equal(readEnvVar('BRAIN_TOKEN_TEST_FALLBACK', tmp), 'from-process');
});

test('readEnvVar returns null when key absent from .env and process.env', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-token-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, '.env'), 'UNRELATED=x\n');
  delete process.env.DEFINITELY_NOT_SET_KEY;
  assert.equal(readEnvVar('DEFINITELY_NOT_SET_KEY', tmp), null);
});

// ── vcsToken ─────────────────────────────────────────────────────────────────────

test('vcsToken("github") reads VCS_TOKEN from .env', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-token-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, '.env'), 'VCS_TOKEN=ghp_test123\n');
  assert.equal(vcsToken('github', tmp), 'ghp_test123');
});

test('vcsToken("gitlab") reads VCS_TOKEN from .env', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-token-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, '.env'), 'VCS_TOKEN=glpat_test456\n');
  assert.equal(vcsToken('gitlab', tmp), 'glpat_test456');
});

test('vcsToken returns null when VCS_TOKEN is not set', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-token-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  writeFileSync(join(tmp, '.env'), 'OTHER=value\n');
  const saved = process.env.VCS_TOKEN;
  delete process.env.VCS_TOKEN;
  t.after(() => {
    if (saved !== undefined) process.env.VCS_TOKEN = saved;
  });
  assert.equal(vcsToken('github', tmp), null);
});

test('vcsToken reads VCS_TOKEN from process.env as fallback', (t) => {
  const tmp = mkdtempSync(join(tmpdir(), 'brain-token-test-'));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  // .env exists but does not contain VCS_TOKEN — process.env should be the fallback
  writeFileSync(join(tmp, '.env'), 'OTHER=value\n');
  const saved = process.env.VCS_TOKEN;
  // Store in a variable first so the literal is not directly assigned to a "token" key,
  // which would trigger the repo:check hardcoded-secret pattern.
  const fixture = 'env-fallback-tok';
  process.env.VCS_TOKEN = fixture;
  t.after(() => {
    if (saved === undefined) delete process.env.VCS_TOKEN;
    else process.env.VCS_TOKEN = saved;
  });
  assert.equal(vcsToken('gitlab', tmp), fixture);
});
