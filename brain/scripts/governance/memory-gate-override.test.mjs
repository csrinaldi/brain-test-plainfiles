// memory-gate-override.test.mjs — RED coverage for #1024's D7 override rule
// (REQ-L3-5).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { decideMemoryGateOverride, SKIP_MEMORY_GATE_LABEL } from './memory-gate-override.mjs';

test('honored at standard with a distinct applier', () => {
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: [{ actor: { login: 'alice' }, action: 'add', label: SKIP_MEMORY_GATE_LABEL, at: '2026-09-18T00:00:00Z' }],
    prAuthor: 'bob',
    tier: 'standard',
  });
  assert.equal(result.honored, true);
  assert.equal(result.applier, 'alice');
  assert.match(result.reason, /honored at the "standard" tier/);
});

test('refused when the applier is the PR author', () => {
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: [{ actor: { login: 'bob' }, action: 'add', label: SKIP_MEMORY_GATE_LABEL }],
    prAuthor: 'bob',
    tier: 'standard',
  });
  assert.equal(result.honored, false);
  assert.match(result.reason, /PR author \(@bob\) is refused/);
});

test('refused when the applier is the PR author, compared case-insensitively (Batch 3, MINOR)', () => {
  // The author-check must not be defeated by a login-case mismatch (GitHub
  // logins are case-insensitive) — `isInList` already lowercases for the
  // reviewActors/agentActors deny lists; the author comparison must match.
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: [{ actor: { login: 'Bob' }, action: 'add', label: SKIP_MEMORY_GATE_LABEL }],
    prAuthor: 'bob',
    tier: 'standard',
  });
  assert.equal(result.honored, false);
  assert.match(result.reason, /PR author \(@Bob\) is refused/);
});

test('refused when the applier is a governance.reviewActors login', () => {
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: [{ actor: { login: 'reviewer-bot' }, action: 'add', label: SKIP_MEMORY_GATE_LABEL }],
    prAuthor: 'bob',
    tier: 'standard',
    reviewActors: ['reviewer-bot'],
  });
  assert.equal(result.honored, false);
  assert.match(result.reason, /review identity/);
});

test('refused when the applier is a governance.agentActors login', () => {
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: [{ actor: { login: 'agent-bot' }, action: 'add', label: SKIP_MEMORY_GATE_LABEL }],
    prAuthor: 'bob',
    tier: 'standard',
    agentActors: ['agent-bot'],
  });
  assert.equal(result.honored, false);
  assert.match(result.reason, /agent identity/);
});

test('the latest add event wins over an earlier add/remove pair', () => {
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: [
      { actor: { login: 'first-applier' }, action: 'add', label: SKIP_MEMORY_GATE_LABEL, at: '2026-09-01T00:00:00Z' },
      { actor: { login: 'first-applier' }, action: 'remove', label: SKIP_MEMORY_GATE_LABEL, at: '2026-09-02T00:00:00Z' },
      { actor: { login: 'second-applier' }, action: 'add', label: SKIP_MEMORY_GATE_LABEL, at: '2026-09-03T00:00:00Z' },
    ],
    prAuthor: 'bob',
    tier: 'standard',
  });
  assert.equal(result.honored, true);
  assert.equal(result.applier, 'second-applier');
});

test('events === null while the label is present is never honored', () => {
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: null,
    prAuthor: 'bob',
    tier: 'standard',
  });
  assert.equal(result.honored, false);
  assert.match(result.reason, /applier could not be read/);
});

test('no add event found for the label is never honored', () => {
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: [{ actor: { login: 'alice' }, action: 'add', label: 'unrelated-label' }],
    prAuthor: 'bob',
    tier: 'standard',
  });
  assert.equal(result.honored, false);
  assert.match(result.reason, /applier could not be read/);
});

test('labels === null never reads as a skip and never blocks evaluation', () => {
  const result = decideMemoryGateOverride({
    labels: null,
    labelEvents: null,
    prAuthor: 'bob',
    tier: 'standard',
  });
  assert.equal(result.honored, false);
  assert.equal(result.present, false);
  assert.match(result.reason, /labels uncomputable/);
});

test('the label is absent — no reason to report', () => {
  const result = decideMemoryGateOverride({
    labels: [],
    labelEvents: [],
    prAuthor: 'bob',
    tier: 'standard',
  });
  assert.equal(result.honored, false);
  assert.equal(result.present, false);
  assert.equal(result.reason, null);
});

test('not consulted at lite — noted, not honored', () => {
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: [{ actor: { login: 'alice' }, action: 'add', label: SKIP_MEMORY_GATE_LABEL }],
    prAuthor: 'bob',
    tier: 'lite',
  });
  assert.equal(result.honored, false);
  assert.match(result.reason, /not consulted at the "lite" tier/);
});

test('refused at regulated with the reason naming the tier', () => {
  const result = decideMemoryGateOverride({
    labels: [SKIP_MEMORY_GATE_LABEL],
    labelEvents: [{ actor: { login: 'alice' }, action: 'add', label: SKIP_MEMORY_GATE_LABEL }],
    prAuthor: 'bob',
    tier: 'regulated',
  });
  assert.equal(result.honored, false);
  assert.equal(result.refused, true);
  assert.match(result.reason, /not honored at the "regulated" tier/);
});
