// resume-schema.test.mjs — unit tests for validateResume(frontmatter).
//
// Acceptance criteria (task 1.1 / REQ-S1-1):
//   (a) Passes when all three required fields are present with valid values.
//   (b) Rejects (throws) when next_action is missing.
//   (c) Rejects (throws) when current_slice is missing.
//   (d) Rejects (throws) when blockers is missing.
//   (e) Rejects (throws) when blockers is not an array.
//
// Pure-function contract: no FS, no engram, no child processes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED: this import will fail until resume-schema.mjs is created (task 1.2).
import { validateResume, REQUIRED_FIELDS } from './resume-schema.mjs';

// ── REQUIRED_FIELDS export ────────────────────────────────────────────────────

test('REQUIRED_FIELDS exports the three required field names', () => {
  assert.deepEqual(REQUIRED_FIELDS, ['next_action', 'current_slice', 'blockers']);
});

// ── Valid frontmatter ─────────────────────────────────────────────────────────

test('validateResume: accepts a fully-populated frontmatter object', () => {
  assert.doesNotThrow(() =>
    validateResume({
      feature: 'feature-working-memory',
      checkpointed_at: '2026-06-26T20:55:00Z',
      checkpointed_from: 'host/feat/s1-contract',
      current_slice: 'Slice 1 — Generic Contract',
      next_action: 'Write the methodology doc',
      blockers: [],
      in_flight_decisions: ['resume.md is primary; apply-progress is best-effort enrichment'],
    }),
  );
});

test('validateResume: accepts a minimal frontmatter with only required fields', () => {
  assert.doesNotThrow(() =>
    validateResume({
      current_slice: 'Slice 2',
      next_action: 'Implement featureCheckpoint()',
      blockers: ['engram project-scoping unconfirmed'],
    }),
  );
});

test('validateResume: accepts blockers as a non-empty array', () => {
  assert.doesNotThrow(() =>
    validateResume({
      current_slice: 'Slice 1',
      next_action: 'Finish the contract',
      blockers: ['blocker A', 'blocker B'],
    }),
  );
});

// ── Missing required fields ───────────────────────────────────────────────────

test('validateResume: throws when next_action is missing', () => {
  assert.throws(
    () =>
      validateResume({
        current_slice: 'Slice 1',
        blockers: [],
      }),
    (err) => {
      assert.ok(
        err.message.includes('next_action'),
        `error message should mention 'next_action'; got: ${err.message}`,
      );
      return true;
    },
  );
});

test('validateResume: throws when current_slice is missing', () => {
  assert.throws(
    () =>
      validateResume({
        next_action: 'do something',
        blockers: [],
      }),
    (err) => {
      assert.ok(
        err.message.includes('current_slice'),
        `error message should mention 'current_slice'; got: ${err.message}`,
      );
      return true;
    },
  );
});

test('validateResume: throws when blockers is missing', () => {
  assert.throws(
    () =>
      validateResume({
        current_slice: 'Slice 1',
        next_action: 'do something',
      }),
    (err) => {
      assert.ok(
        err.message.includes('blockers'),
        `error message should mention 'blockers'; got: ${err.message}`,
      );
      return true;
    },
  );
});

// ── Type validation ───────────────────────────────────────────────────────────

test('validateResume: throws when blockers is a string instead of an array', () => {
  assert.throws(
    () =>
      validateResume({
        current_slice: 'Slice 1',
        next_action: 'do something',
        blockers: 'not-an-array',
      }),
    (err) => {
      assert.ok(
        err.message.includes('blockers'),
        `error message should mention 'blockers'; got: ${err.message}`,
      );
      return true;
    },
  );
});

test('validateResume: throws when blockers is an object instead of an array', () => {
  assert.throws(
    () =>
      validateResume({
        current_slice: 'Slice 1',
        next_action: 'do something',
        blockers: { item: 'not-an-array' },
      }),
    (err) => {
      assert.ok(
        err.message.includes('blockers'),
        `error message should mention 'blockers'; got: ${err.message}`,
      );
      return true;
    },
  );
});
