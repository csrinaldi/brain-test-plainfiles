// diff-size.test.mjs — Unit tests for diffSize check (REQ-S4-1)
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { diffSize } from './diff-size.mjs';

// Fixture 1: .memory/ file (3 lines) + brain/scripts/foo.mjs (5 lines); ignore .memory/**
// → 5 lines total, within 400-line budget → pass
const FIXTURE_EXCLUDED = [
  '3\t0\t.memory/session.jsonl.gz',
  '5\t0\tbrain/scripts/foo.mjs',
].join('\n');

// Fixture 2: 401 changed lines → fail
const FIXTURE_OVER = '300\t101\tsrc/big.mjs';

// Fixture 3: binary file (- / -) → 0 lines → pass
const FIXTURE_BINARY = '-\t-\tbrain/assets/logo.png';

test('diffSize: excluded paths bring total within budget → pass', () => {
  const r = diffSize(FIXTURE_EXCLUDED, ['.memory/**']);
  assert.deepEqual(r, { pass: true });
});

test('diffSize: total exceeds 400-line budget → fail with reason containing count', () => {
  const r = diffSize(FIXTURE_OVER, []);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.includes('401'),
    `reason must include "401", got: ${r.reason}`);
});

test('diffSize: binary files count as 0 → pass', () => {
  const r = diffSize(FIXTURE_BINARY, []);
  assert.deepEqual(r, { pass: true });
});
