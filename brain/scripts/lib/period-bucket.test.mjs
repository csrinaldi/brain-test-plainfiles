// period-bucket.test.mjs — pure bucketing for brain-metrics (issue #324, M9).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { bucketOf } from './period-bucket.mjs';

test('bucketOf: month period buckets an ISO timestamp to YYYY-MM (UTC)', () => {
  assert.equal(bucketOf('2026-07-15T10:30:00Z', 'month'), '2026-07');
  assert.equal(bucketOf('2026-01-01T00:00:00Z', 'month'), '2026-01');
  assert.equal(bucketOf('2026-12-31T23:59:59Z', 'month'), '2026-12');
});

test('bucketOf: month period defaults when no period arg given', () => {
  assert.equal(bucketOf('2026-07-15T10:30:00Z'), '2026-07');
});

test('bucketOf: a UTC day boundary near midnight buckets by UTC, not local time', () => {
  // 2026-01-31T23:00:00Z is still January in UTC regardless of local offset.
  assert.equal(bucketOf('2026-01-31T23:00:00Z', 'month'), '2026-01');
  // 2026-02-01T00:30:00Z has already rolled to February in UTC.
  assert.equal(bucketOf('2026-02-01T00:30:00Z', 'month'), '2026-02');
});

test('bucketOf: week period buckets to ISO 8601 week (YYYY-Www)', () => {
  // 2026-01-01 is a Thursday — ISO week 1 of 2026 (contains the year's first Thursday).
  assert.equal(bucketOf('2026-01-01T00:00:00Z', 'week'), '2026-W01');
  // 2026-01-05 (Monday) starts ISO week 2.
  assert.equal(bucketOf('2026-01-05T00:00:00Z', 'week'), '2026-W02');
});

test('bucketOf: ISO week correctly assigns a late-December date to next year\'s week 1', () => {
  // 2025-12-29 is a Monday, ISO week 1 of 2026 (per ISO 8601, the week containing
  // the year's first Thursday) — a year-boundary edge case bucketOf must not miss.
  assert.equal(bucketOf('2025-12-29T00:00:00Z', 'week'), '2026-W01');
});

test('bucketOf: throws on an unrecognized period (fail-closed, never a silent misbucket)', () => {
  assert.throws(() => bucketOf('2026-07-15T10:30:00Z', 'quarter'), /period/i);
});

test('bucketOf: throws on an unparseable timestamp (fail-closed)', () => {
  assert.throws(() => bucketOf('not-a-date', 'month'), /invalid|date/i);
});
