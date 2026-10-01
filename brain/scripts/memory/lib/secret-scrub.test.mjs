// secret-scrub.test.mjs — unit tests for the fail-closed secret scanner
// (issue #214, C1b). Pure-function contract: no filesystem access beyond a
// real temp plaintext fixture read by `scrubRecordsFile` (no engram/
// child-process dependency). The gzip-chunk reader this once also tested
// (`scrubChunkFile`) retired with the chunk-reading exporter it served
// (#955 R4, epic task 2.4).
//
// RED: these imports fail until secret-scrub.mjs is created.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_SECRET_PATTERNS,
  DEFAULT_SECRET_ALLOW_PATTERNS,
  compilePatterns,
  resolveSecretConfig,
  scanTextForSecrets,
  scrubRecordsFile,
} from './secret-scrub.mjs';

// ── compilePatterns ────────────────────────────────────────────────────────────

test('compilePatterns: compiles regex source strings into RegExp objects', () => {
  const patterns = compilePatterns(['ghp_[A-Za-z0-9]{20,}', 'AKIA[0-9A-Z]{16}']);
  assert.equal(patterns.length, 2);
  assert.ok(patterns[0] instanceof RegExp);
  assert.ok(patterns[1] instanceof RegExp);
});

// ── resolveSecretConfig ─────────────────────────────────────────────────────────

test('resolveSecretConfig: returns the default patterns when config is empty/undefined', () => {
  const { patternSources, allowPatternSources } = resolveSecretConfig(undefined);
  assert.deepEqual(patternSources, DEFAULT_SECRET_PATTERNS);
  assert.deepEqual(allowPatternSources, DEFAULT_SECRET_ALLOW_PATTERNS);
});

test('resolveSecretConfig: a consumer pattern is additive — defaults are never dropped', () => {
  const { patternSources } = resolveSecretConfig({
    governance: { memorySecretPatterns: ['custom-token-[0-9]{6}'] },
  });
  assert.ok(patternSources.includes('custom-token-[0-9]{6}'), 'custom pattern must be present');
  for (const d of DEFAULT_SECRET_PATTERNS) {
    assert.ok(patternSources.includes(d), `default pattern must survive: ${d}`);
  }
});

test('resolveSecretConfig: allowPatterns come only from config — no default allowlist ships', () => {
  const { allowPatternSources } = resolveSecretConfig({
    governance: { memorySecretAllowPatterns: ['glpat-EXAMPLE-TUTORIAL-TOKEN'] },
  });
  assert.deepEqual(allowPatternSources, ['glpat-EXAMPLE-TUTORIAL-TOKEN']);
});

// ── scanTextForSecrets ──────────────────────────────────────────────────────────

test('scanTextForSecrets: detects a GitHub PAT (ghp_)', () => {
  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const hit = scanTextForSecrets('line one\nghp_abcdefghijklmnopqrstuvwxyz01\nline three', patterns);
  assert.ok(hit, 'expected a hit');
  assert.equal(hit.lineNumber, 2);
});

test('scanTextForSecrets: detects a GitLab PAT (glpat-)', () => {
  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const hit = scanTextForSecrets('glpat-aBcDeFgHiJkLmNoPqRsT01', patterns);
  assert.ok(hit, 'expected a hit');
  assert.equal(hit.lineNumber, 1);
});

test('scanTextForSecrets: detects an AWS access key (AKIA...)', () => {
  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const hit = scanTextForSecrets('key = AKIAABCDEFGHIJKLMNOP', patterns);
  assert.ok(hit, 'expected a hit');
});

test('scanTextForSecrets: detects a PEM private-key header', () => {
  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const hit = scanTextForSecrets('-----BEGIN RSA PRIVATE KEY-----', patterns);
  assert.ok(hit, 'expected a hit');
});

test('scanTextForSecrets: returns null when nothing matches', () => {
  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const hit = scanTextForSecrets('nothing secret here, just decisions and patterns', patterns);
  assert.equal(hit, null);
});

test('scanTextForSecrets: an allowlist entry suppresses a matched line (the only bypass)', () => {
  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const allow = compilePatterns(['glpat-EXAMPLE-TUTORIAL-TOKEN']);
  const hit = scanTextForSecrets('example: glpat-EXAMPLE-TUTORIAL-TOKEN in a tutorial', patterns, allow);
  assert.equal(hit, null, 'allowlisted line must not be reported as a hit');
});

test('scanTextForSecrets: the allowlist does not suppress an unrelated match on a different line', () => {
  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const allow = compilePatterns(['glpat-EXAMPLE-TUTORIAL-TOKEN']);
  const hit = scanTextForSecrets(
    'example: glpat-EXAMPLE-TUTORIAL-TOKEN in a tutorial\nghp_realleakedtoken0123456789ab',
    patterns,
    allow,
  );
  assert.ok(hit, 'the second, non-allowlisted line must still be reported');
  assert.equal(hit.lineNumber, 2);
});

// ── scrubRecordsFile — plaintext JSONL reader, no gunzip (REQ-C2B1-2, #221 C2b-1) ──

function tmpRecordsFile(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-secret-scrub-records-'));
  const file = join(dir, '2026-07.jsonl');
  writeFileSync(file, lines.join('\n') + '\n');
  return { dir, file };
}

test('scrubRecordsFile: detects a secret in a plaintext records JSONL line, reporting the line number', (t) => {
  const { dir, file } = tmpRecordsFile([
    '{"id":"rec-aaa","content":"clean line one"}',
    '{"id":"rec-bbb","content":"token: ghp_abcdefghijklmnopqrstuvwxyz01"}',
  ]);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const hit = scrubRecordsFile(file, patterns);
  assert.ok(hit, 'expected a hit inside the plaintext records file');
  assert.equal(hit.lineNumber, 2);
  assert.match(hit.pattern, /ghp_/);
});

test('scrubRecordsFile: a clean records file returns null', (t) => {
  const { dir, file } = tmpRecordsFile(['{"id":"rec-ccc","content":"just a normal decision"}']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const hit = scrubRecordsFile(file, patterns);
  assert.equal(hit, null);
});

test('scrubRecordsFile: reads plaintext directly — a raw non-gzip file is readable (no gunzip step)', (t) => {
  const { dir, file } = tmpRecordsFile(['{"id":"rec-ddd","content":"plaintext, never gzipped"}']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.doesNotThrow(() => scrubRecordsFile(file, compilePatterns(DEFAULT_SECRET_PATTERNS)));
});

test('scrubRecordsFile: an allowlisted line is suppressed, same allowlist contract as scanTextForSecrets', (t) => {
  const { dir, file } = tmpRecordsFile(['{"id":"rec-eee","content":"glpat-EXAMPLE-TUTORIAL-TOKEN"}']);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const patterns = compilePatterns(DEFAULT_SECRET_PATTERNS);
  const allow = compilePatterns(['glpat-EXAMPLE-TUTORIAL-TOKEN']);
  const hit = scrubRecordsFile(file, patterns, allow);
  assert.equal(hit, null);
});
