// diff-size-count.test.mjs — Unit tests for parseDiffNumstat (REQ-S2-3)
// Run with: npm test  (node --test, no dependencies)
//
// Covers REQ-S2-3: diff-size-count helper parses git diff --numstat output,
// excludes paths matched by ignoreList globs, and sums additions + deletions.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseDiffNumstat } from './diff-size-count.mjs';

// ── Fixtures ──────────────────────────────────────────────────────────────────
// git diff --numstat format: <added>\t<deleted>\t<path>
// Binary files use `-` in place of numeric counts.

// Fixture 1: .memory/ file (3 added) + brain/scripts/foo.mjs (5 added),
//            ignoreList excludes .memory/** → expected total: 5
const FIXTURE_IGNORE = [
  '3\t0\t.memory/session-2026-06-26.jsonl.gz',
  '5\t0\tbrain/scripts/foo.mjs',
].join('\n');

// Fixture 2: single file with additions AND deletions → expected: 8
const FIXTURE_ADD_DEL = '5\t3\tsrc/main.mjs';

// Fixture 3: binary file (- / -) → treated as 0 changed lines
const FIXTURE_BINARY = '-\t-\tbrain/assets/logo.png';

// Fixture 4: empty input → 0
const FIXTURE_EMPTY = '';

// ── Tests ─────────────────────────────────────────────────────────────────────

test('parseDiffNumstat: excludes paths matching ignoreList glob, counts the rest', () => {
  const result = parseDiffNumstat(FIXTURE_IGNORE, ['.memory/**']);
  // .memory/session-* excluded; brain/scripts/foo.mjs (5+0 = 5) included.
  assert.equal(result, 5);
});

test('parseDiffNumstat: sums additions + deletions for included files', () => {
  const result = parseDiffNumstat(FIXTURE_ADD_DEL, []);
  // 5 added + 3 deleted = 8
  assert.equal(result, 8);
});

test('parseDiffNumstat: treats binary marker "-" as 0 changed lines', () => {
  const result = parseDiffNumstat(FIXTURE_BINARY, []);
  // binary: 0 + 0 = 0
  assert.equal(result, 0);
});

test('parseDiffNumstat: returns 0 for empty input', () => {
  assert.equal(parseDiffNumstat(FIXTURE_EMPTY, []), 0);
});
