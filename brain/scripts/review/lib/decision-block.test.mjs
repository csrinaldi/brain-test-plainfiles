// decision-block.test.mjs — Unit tests for the `brain-decision/1` protocol:
// render + parse, both in decision-block.mjs by design (issue #473,
// design.md §B2 — emitter and inverse live in one module on purpose).
// REQ-473-1 (E1 fields), REQ-473-5 (unreadable/incomplete blocks fail closed).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderDecision, parseDecision } from './decision-block.mjs';

const HEAD_SHA = 'a'.repeat(40);
const PREFIX_SHA = HEAD_SHA.slice(0, 7);

/** Builds a fenced brain-decision/1 body directly from raw lines — used to
 * drive parse-level cases renderDecision cannot produce on its own (missing
 * fields, wrong protocol, extra unknown fields). */
function blockBody(lines) {
  return ['```yaml', ...lines, '```'].join('\n');
}

// ── unreadable body (REQ-473-5) ─────────────────────────────────────────────

test('parseDecision: returns null on an unreadable body (no fence)', () => {
  assert.equal(parseDecision({ body: 'just a regular comment, no fence here' }), null);
});

test('parseDecision: missing body (null/undefined) returns null, never throws', () => {
  assert.equal(parseDecision({ body: null }), null);
  assert.equal(parseDecision({}), null);
});

// ── E1 round-trip (REQ-473-1) ────────────────────────────────────────────────

test('renderDecision/parseDecision: round-trips every E1 field', () => {
  const input = {
    protocol: 'brain-decision/1',
    decision: 'APPROVE',
    head_sha: HEAD_SHA,
    actor: 'alice',
    at: '2026-08-07T12:00:00Z',
    in_reply_to: 'https://example.test/reviews/1',
  };
  const body = renderDecision(input);
  const result = parseDecision({ body });
  assert.deepEqual(result, input);
});

test('renderDecision/parseDecision: round-trips without the optional in_reply_to field', () => {
  const input = {
    decision: 'APPROVE',
    head_sha: HEAD_SHA,
    actor: 'alice',
    at: '2026-08-07T12:00:00Z',
  };
  const body = renderDecision(input);
  const result = parseDecision({ body });
  assert.equal(result.protocol, 'brain-decision/1');
  assert.equal(result.decision, 'APPROVE');
  assert.equal(result.head_sha, HEAD_SHA);
  assert.equal(result.actor, 'alice');
  assert.equal(result.at, '2026-08-07T12:00:00Z');
  assert.equal('in_reply_to' in result, false);
});

// ── E2 parse-level rules (one case per rule, design.md §E2) ─────────────────

test('parseDecision: rule 3 — protocol brain-review/1 (wrong family) is not addressed to this reader', () => {
  const body = blockBody([
    'protocol: brain-review/1',
    'decision: APPROVE',
    `head_sha: ${HEAD_SHA}`,
    'actor: alice',
  ]);
  assert.equal(parseDecision({ body }), null);
});

test('parseDecision: rule 4 — protocol brain-decision/2 (unsupported version) refuses', () => {
  const body = blockBody([
    'protocol: brain-decision/2',
    'decision: APPROVE',
    `head_sha: ${HEAD_SHA}`,
    'actor: alice',
  ]);
  assert.equal(parseDecision({ body }), null);
});

test('parseDecision: rule 5 — decision field absent', () => {
  const body = blockBody(['protocol: brain-decision/1', `head_sha: ${HEAD_SHA}`, 'actor: alice']);
  assert.equal(parseDecision({ body }), null);
});

test('parseDecision: rule 6 — decision present but not exactly APPROVE', () => {
  for (const bad of ['approve', 'APPROVED', 'REJECT']) {
    const body = blockBody([
      'protocol: brain-decision/1',
      `decision: ${bad}`,
      `head_sha: ${HEAD_SHA}`,
      'actor: alice',
    ]);
    assert.equal(parseDecision({ body }), null, `decision: ${bad} must refuse`);
  }
});

test('parseDecision: rule 7 — head_sha field absent', () => {
  const body = blockBody(['protocol: brain-decision/1', 'decision: APPROVE', 'actor: alice']);
  assert.equal(parseDecision({ body }), null);
});

test('parseDecision: rule 8 — head_sha malformed (not 40 hex chars)', () => {
  const body = blockBody([
    'protocol: brain-decision/1',
    'decision: APPROVE',
    'head_sha: not-a-valid-sha-at-all',
    'actor: alice',
  ]);
  assert.equal(parseDecision({ body }), null);
});

test('parseDecision: rule 9 — head_sha is a valid 7-char PREFIX of a real sha (still refused — not 40 hex)', () => {
  const body = blockBody([
    'protocol: brain-decision/1',
    'decision: APPROVE',
    `head_sha: ${PREFIX_SHA}`,
    'actor: alice',
  ]);
  assert.equal(parseDecision({ body }), null);
});

test('parseDecision: rule 12 — actor field absent', () => {
  const body = blockBody(['protocol: brain-decision/1', 'decision: APPROVE', `head_sha: ${HEAD_SHA}`]);
  assert.equal(parseDecision({ body }), null);
});

// ── #612: whitespace-only refuses exactly like absent, not like an empty value ──

test('parseDecision: #612 — decision: (whitespace-only, no value) refuses, same as absent', () => {
  const body = blockBody([
    'protocol: brain-decision/1',
    'decision: ',
    `head_sha: ${HEAD_SHA}`,
    'actor: alice',
  ]);
  assert.equal(parseDecision({ body }), null);
});

test('parseDecision: #612 — head_sha: (whitespace-only, no value) refuses, same as absent', () => {
  const body = blockBody([
    'protocol: brain-decision/1',
    'decision: APPROVE',
    'head_sha: ',
    'actor: alice',
  ]);
  assert.equal(parseDecision({ body }), null);
});

test('parseDecision: #612 — actor: (whitespace-only, no value) refuses, same as absent', () => {
  const body = blockBody([
    'protocol: brain-decision/1',
    'decision: APPROVE',
    `head_sha: ${HEAD_SHA}`,
    'actor: ',
  ]);
  assert.equal(parseDecision({ body }), null);
});

test('parseDecision: rule 17 — only the FIRST fence in a body is read', () => {
  const first = blockBody([
    'protocol: brain-decision/1',
    'decision: APPROVE',
    `head_sha: ${HEAD_SHA}`,
    'actor: alice',
  ]);
  const secondInvalid = blockBody(['protocol: brain-decision/2']);
  // First fence valid, second (ignored) invalid — result reflects the first.
  assert.deepEqual(parseDecision({ body: `${first}\n\nSome prose.\n\n${secondInvalid}` }), {
    protocol: 'brain-decision/1',
    decision: 'APPROVE',
    head_sha: HEAD_SHA,
    actor: 'alice',
  });
  // First fence invalid, second (ignored, even though it WOULD be valid) —
  // result is null, never falls through to a later fence.
  assert.equal(parseDecision({ body: `${secondInvalid}\n\nSome prose.\n\n${first}` }), null);
});

test('parseDecision: rule 18 — at absent or malformed never blocks admission (audit-only, unread)', () => {
  const body = blockBody([
    'protocol: brain-decision/1',
    'decision: APPROVE',
    `head_sha: ${HEAD_SHA}`,
    'actor: alice',
    'at: not-a-real-timestamp',
  ]);
  const result = parseDecision({ body });
  assert.notEqual(result, null);
  assert.equal(result.at, 'not-a-real-timestamp');
});

test('parseDecision: rule 19 — in_reply_to garbage never blocks admission (audit-only, unread)', () => {
  const body = blockBody([
    'protocol: brain-decision/1',
    'decision: APPROVE',
    `head_sha: ${HEAD_SHA}`,
    'actor: alice',
    'in_reply_to: not-a-url-or-id !!',
  ]);
  const result = parseDecision({ body });
  assert.notEqual(result, null);
  assert.equal(result.in_reply_to, 'not-a-url-or-id !!');
});

test('parseDecision: rule 20 — unknown extra fields are ignored, never block admission', () => {
  const body = blockBody([
    'protocol: brain-decision/1',
    'decision: APPROVE',
    `head_sha: ${HEAD_SHA}`,
    'actor: alice',
    'dispositions: something-not-in-slice-1',
  ]);
  const result = parseDecision({ body });
  assert.notEqual(result, null);
  assert.equal('dispositions' in result, false);
});
