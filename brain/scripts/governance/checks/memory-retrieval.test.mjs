// memory-retrieval.test.mjs — Unit tests for memoryRetrieval check (T2.1, REQ-L3-4)
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryRetrieval } from './memory-retrieval.mjs';

// ── HIT: scoped session_summary present ─────────────────────────────────────

test('memoryRetrieval: scoped session_summary present → pass, reason does not say WARN/partial', () => {
  const r = memoryRetrieval(
    [{ type: 'session_summary', issue: 379, title: 'Session summary: brain' }],
    379,
  );
  assert.equal(r.pass, true);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
  assert.doesNotMatch(r.reason, /warn/i);
  assert.doesNotMatch(r.reason, /partial/i);
});

test('memoryRetrieval: multiple scoped records, one is session_summary → pass clean', () => {
  const r = memoryRetrieval(
    [
      { type: 'decision', issue: 379 },
      { type: 'session_summary', issue: 379 },
    ],
    379,
  );
  assert.equal(r.pass, true);
  assert.doesNotMatch(r.reason, /warn/i);
});

// ── MISS: zero records scoped to the issue ──────────────────────────────────

test('memoryRetrieval: zero records scoped to the issue → fail with reason', () => {
  const r = memoryRetrieval([], 379);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
  assert.match(r.reason, /379/);
});

test('memoryRetrieval: records exist but none scoped to this issue → fail with reason', () => {
  const r = memoryRetrieval(
    [{ type: 'session_summary', issue: 12 }],
    999,
  );
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
});

// ── PARTIAL: scoped records exist but none is session_summary → warn (pass:true) ──

test('memoryRetrieval: scoped records exist but none is session_summary → pass:true with partial/warn reason', () => {
  const r = memoryRetrieval(
    [{ type: 'decision', issue: 379 }],
    379,
  );
  assert.equal(r.pass, true);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
  assert.match(r.reason, /warn|partial/i);
});

// ── graceful non-array inputs ────────────────────────────────────────────────

test('memoryRetrieval: null observations → treated as empty → fail gracefully', () => {
  const r = memoryRetrieval(null, 379);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
});

test('memoryRetrieval: undefined observations → treated as empty → fail gracefully', () => {
  const r = memoryRetrieval(undefined, 379);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
});

// ── regression guard: a record for a DIFFERENT issue must not satisfy scoping ──

test('memoryRetrieval: record scoped to issue #12 must NOT satisfy issue #999 (the exact bug this closes)', () => {
  const r = memoryRetrieval(
    [{ type: 'session_summary', issue: 12, title: 'Session summary: unrelated issue' }],
    999,
  );
  assert.equal(r.pass, false);
  assert.match(r.reason, /999/);
});

// ── defensive Number() coercion: record.issue as a string vs number ─────────

test('memoryRetrieval: record.issue as a string "999" matches issueNumber 999 (Number() coercion)', () => {
  const r = memoryRetrieval(
    [{ type: 'session_summary', issue: '999' }],
    999,
  );
  assert.equal(r.pass, true);
  assert.doesNotMatch(r.reason, /warn/i);
});

test('memoryRetrieval: record.issue as a number still matches issueNumber (baseline for the coercion test above)', () => {
  const r = memoryRetrieval(
    [{ type: 'session_summary', issue: 999 }],
    999,
  );
  assert.equal(r.pass, true);
});
