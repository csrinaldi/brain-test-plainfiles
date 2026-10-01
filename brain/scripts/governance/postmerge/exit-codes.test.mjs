// exit-codes.test.mjs — the single source of the 0/1/2 exit contract (REQ-D2-6,
// Phase 5.1). One mapping from a check result to a process exit code, so no
// evaluator can invent its own convention.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { EXIT, resultToExit } from './exit-codes.mjs';

test('EXIT names the three-code contract', () => {
  assert.equal(EXIT.PASS, 0);
  assert.equal(EXIT.VIOLATION, 1);
  assert.equal(EXIT.UNCOMPUTABLE, 2);
});

test('resultToExit: uncomputable → 2 (never a false pass/violation)', () => {
  assert.equal(resultToExit({ uncomputable: true }), 2);
  // uncomputable dominates: even with pass/false present, an uncomputable result
  // is 2 — an infra failure is never downgraded to a clean or a violation.
  assert.equal(resultToExit({ uncomputable: true, pass: true }), 2);
  assert.equal(resultToExit({ uncomputable: true, pass: false }), 2);
});

test('resultToExit: a clean pass → 0', () => {
  assert.equal(resultToExit({ pass: true }), 0);
});

test('resultToExit: a genuine violation → 1', () => {
  assert.equal(resultToExit({ pass: false }), 1);
  assert.equal(resultToExit({ pass: false, reason: 'x' }), 1);
});

test('resultToExit: a missing/false uncomputable flag is treated as computable', () => {
  assert.equal(resultToExit({ pass: true, uncomputable: false }), 0);
  assert.equal(resultToExit({ pass: false, uncomputable: false }), 1);
});
