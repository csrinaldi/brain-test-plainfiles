// schema-v2.test.mjs — Unit tests for brain-review/2 schema validator (REQ-H2-2).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateSchemaV2, ALLOWED_EVIDENCE_CLASSES, ALLOWED_CAUSAL_DISPOSITIONS } from './schema-v2.mjs';

test('validateSchemaV2: valid finding with evidence_class and causal_disposition passes', () => {
  const finding = {
    id: 'R3-001',
    severity: 'blocker',
    claim: 'Potential race condition',
    evidence: 'git diff inspection',
    cites: 'cold-boot.mjs:42',
    evidence_class: 'inferential',
    causal_disposition: 'introduced',
  };

  const result = validateSchemaV2(finding);
  assert.deepEqual(result, { valid: true, finding });
});

test('validateSchemaV2: invalid evidence_class returns valid:false', () => {
  const finding = {
    id: 'R3-001',
    severity: 'blocker',
    claim: 'Race condition',
    evidence: 'hunk inspection',
    cites: 'cold-boot.mjs:42',
    evidence_class: 'speculative_invalid',
    causal_disposition: 'introduced',
  };

  const result = validateSchemaV2(finding);
  assert.equal(result.valid, false);
  assert.match(result.reason, /invalid evidence_class/i);
});

test('validateSchemaV2: invalid causal_disposition returns valid:false', () => {
  const finding = {
    id: 'R3-001',
    severity: 'blocker',
    claim: 'Race condition',
    evidence: 'hunk inspection',
    cites: 'cold-boot.mjs:42',
    evidence_class: 'inferential',
    causal_disposition: 'maybe_caused',
  };

  const result = validateSchemaV2(finding);
  assert.equal(result.valid, false);
  assert.match(result.reason, /invalid causal_disposition/i);
});

test('validateSchemaV2: exports exact frozen enum arrays', () => {
  assert.deepEqual(ALLOWED_EVIDENCE_CLASSES, ['deterministic', 'inferential', 'insufficient']);
  assert.deepEqual(ALLOWED_CAUSAL_DISPOSITIONS, [
    'introduced',
    'behavior-activated',
    'worsened',
    'pre-existing',
    'base-only',
    'unknown',
  ]);
});
