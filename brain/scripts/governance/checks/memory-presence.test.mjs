// memory-presence.test.mjs — Unit tests for memoryPresence check (REQ-S4-1)
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { memoryPresence } from './memory-presence.mjs';

// ── passing cases ─────────────────────────────────────────────────────────────

test('memoryPresence: observations include session_summary → pass', () => {
  assert.deepEqual(
    memoryPresence([{ type: 'session_summary', title: 'Session summary: brain' }]),
    { pass: true },
  );
});

test('memoryPresence: multiple types, one is session_summary → pass', () => {
  assert.deepEqual(
    memoryPresence([
      { type: 'decision', title: 'chose foo' },
      { type: 'session_summary', title: 'Session summary: brain' },
    ]),
    { pass: true },
  );
});

// ── failing cases ─────────────────────────────────────────────────────────────

test('memoryPresence: empty observations array → fail with reason', () => {
  const r = memoryPresence([]);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
});

test('memoryPresence: no session_summary among observations → fail with reason', () => {
  const r = memoryPresence([{ type: 'decision' }, { type: 'bugfix' }]);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
  assert.doesNotMatch(r.reason, /brain:save|brain-save/);
});

// ── graceful non-array inputs ─────────────────────────────────────────────────

test('memoryPresence: null input → fail gracefully', () => {
  const r = memoryPresence(null);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
});

test('memoryPresence: undefined input → fail gracefully', () => {
  const r = memoryPresence(undefined);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
});
