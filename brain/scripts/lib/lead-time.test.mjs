// lead-time.test.mjs — pure lead-time selection for brain-metrics (issue #324/M9, design D4).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectApprovalEvent, leadTimeDays } from './lead-time.mjs';

const APPROVED = 'status:approved';

test('selectApprovalEvent: picks the LAST approvedLabel add at-or-before the merge date (D4 — re-approval wins)', () => {
  const events = [
    { action: 'add', label: APPROVED, at: '2026-07-01T00:00:00Z' },
    { action: 'remove', label: APPROVED, at: '2026-07-05T00:00:00Z' },
    { action: 'add', label: APPROVED, at: '2026-07-10T00:00:00Z' },
  ];
  const event = selectApprovalEvent(events, APPROVED, '2026-07-15T00:00:00Z');
  assert.equal(event.at, '2026-07-10T00:00:00Z');
});

test('selectApprovalEvent: ignores an add AFTER the merge date', () => {
  const events = [
    { action: 'add', label: APPROVED, at: '2026-07-01T00:00:00Z' },
    { action: 'add', label: APPROVED, at: '2026-07-20T00:00:00Z' }, // after merge
  ];
  const event = selectApprovalEvent(events, APPROVED, '2026-07-15T00:00:00Z');
  assert.equal(event.at, '2026-07-01T00:00:00Z');
});

test('selectApprovalEvent: ignores adds of a DIFFERENT label', () => {
  const events = [{ action: 'add', label: 'status:other', at: '2026-07-01T00:00:00Z' }];
  assert.equal(selectApprovalEvent(events, APPROVED, '2026-07-15T00:00:00Z'), null);
});

test('selectApprovalEvent: returns null when events is null (uncomputable fetch) or empty', () => {
  assert.equal(selectApprovalEvent(null, APPROVED, '2026-07-15T00:00:00Z'), null);
  assert.equal(selectApprovalEvent([], APPROVED, '2026-07-15T00:00:00Z'), null);
});

test('leadTimeDays: computes days between the selected approval event and the merge date', () => {
  const events = [{ action: 'add', label: APPROVED, at: '2026-07-01T00:00:00Z' }];
  assert.equal(leadTimeDays(events, APPROVED, '2026-07-06T00:00:00Z'), 5);
});

test('leadTimeDays: returns null (N/A) when no qualifying approval event exists — never throws', () => {
  assert.equal(leadTimeDays(null, APPROVED, '2026-07-06T00:00:00Z'), null);
  assert.equal(leadTimeDays([], APPROVED, '2026-07-06T00:00:00Z'), null);
});
