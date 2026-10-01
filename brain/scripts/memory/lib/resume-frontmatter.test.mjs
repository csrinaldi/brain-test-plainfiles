// resume-frontmatter.test.mjs — unit tests for parseFrontmatter / serializeFrontmatter.
//
// Acceptance criteria (Slice 2 spec / feature-working-memory-contract.md):
//   - Round-trip stability: parse → serialize → parse produces identical frontmatter object.
//   - NEVER throws on malformed input (no closing ---, empty string, non-string).
//   - Returns { frontmatter: null, body: source } for missing/broken frontmatter.
//   - Parses flat string scalars (quoted and unquoted).
//   - Parses string arrays (blockers, in_flight_decisions).
//   - Preserves prose body after closing ---.
//   - Arrays with special chars (spaces, colons, em-dashes) round-trip correctly.
//
// Node built-ins only — no YAML dependency.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED: import fails until resume-frontmatter.mjs is created.
import { parseFrontmatter, serializeFrontmatter } from './resume-frontmatter.mjs';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/** Parse → serialize → parse and assert both parsed objects are deeply equal. */
function assertRoundTrip(source) {
  const first = parseFrontmatter(source);
  if (!first.frontmatter) return; // not a frontmatter doc — skip round-trip
  const serialized = serializeFrontmatter(first.frontmatter, first.body);
  const second = parseFrontmatter(serialized);
  assert.deepEqual(
    second.frontmatter,
    first.frontmatter,
    `round-trip frontmatter mismatch.\nFirst:  ${JSON.stringify(first.frontmatter)}\nSecond: ${JSON.stringify(second.frontmatter)}`,
  );
  assert.equal(second.body, first.body, 'round-trip body mismatch');
}

// ---------------------------------------------------------------------------
// Malformed / edge input — NEVER throws
// ---------------------------------------------------------------------------

test('parseFrontmatter: does not throw on empty string', () => {
  assert.doesNotThrow(() => parseFrontmatter(''));
  const result = parseFrontmatter('');
  assert.equal(result.frontmatter, null);
});

test('parseFrontmatter: does not throw on null input', () => {
  assert.doesNotThrow(() => parseFrontmatter(null));
  const result = parseFrontmatter(null);
  assert.equal(result.frontmatter, null);
});

test('parseFrontmatter: does not throw on plain prose with no frontmatter', () => {
  const prose = '## Section\n\nSome paragraph text.\n';
  assert.doesNotThrow(() => parseFrontmatter(prose));
  const result = parseFrontmatter(prose);
  assert.equal(result.frontmatter, null);
  assert.equal(result.body, prose);
});

test('parseFrontmatter: does not throw on unclosed frontmatter (no closing ---)', () => {
  const input = '---\nkey: value\n';
  assert.doesNotThrow(() => parseFrontmatter(input));
  const result = parseFrontmatter(input);
  assert.equal(result.frontmatter, null);
  assert.equal(result.body, input);
});

// ---------------------------------------------------------------------------
// Scalar parsing
// ---------------------------------------------------------------------------

test('parseFrontmatter: parses unquoted scalar', () => {
  const input = '---\nfeature: feature-working-memory\n---\n';
  const { frontmatter } = parseFrontmatter(input);
  assert.equal(frontmatter.feature, 'feature-working-memory');
});

test('parseFrontmatter: parses double-quoted scalar with spaces', () => {
  const input = '---\ncurrent_slice: "Slice 2 — engram backend impl"\n---\n';
  const { frontmatter } = parseFrontmatter(input);
  assert.equal(frontmatter.current_slice, 'Slice 2 — engram backend impl');
});

test('parseFrontmatter: parses unquoted ISO-8601 timestamp', () => {
  const input = '---\ncheckpointed_at: 2026-06-26T20:55:00Z\n---\n';
  const { frontmatter } = parseFrontmatter(input);
  assert.equal(frontmatter.checkpointed_at, '2026-06-26T20:55:00Z');
});

test('parseFrontmatter: parses checkpointed_from with slash separator', () => {
  const input = '---\ncheckpointed_from: hostname-A/feat/s1-contract\n---\n';
  const { frontmatter } = parseFrontmatter(input);
  assert.equal(frontmatter.checkpointed_from, 'hostname-A/feat/s1-contract');
});

// ---------------------------------------------------------------------------
// Array parsing
// ---------------------------------------------------------------------------

test('parseFrontmatter: parses empty array', () => {
  const input = '---\nblockers:\n---\n';
  const { frontmatter } = parseFrontmatter(input);
  assert.deepEqual(frontmatter.blockers, []);
});

test('parseFrontmatter: parses array with one element', () => {
  const input = '---\nblockers:\n  - "engram sync project-scoping unconfirmed"\n---\n';
  const { frontmatter } = parseFrontmatter(input);
  assert.deepEqual(frontmatter.blockers, ['engram sync project-scoping unconfirmed']);
});

test('parseFrontmatter: parses array with multiple elements', () => {
  const input = [
    '---',
    'in_flight_decisions:',
    '  - "resume.md is primary"',
    '  - "active feature resolved from single dir"',
    '---',
    '',
  ].join('\n');
  const { frontmatter } = parseFrontmatter(input);
  assert.deepEqual(frontmatter.in_flight_decisions, [
    'resume.md is primary',
    'active feature resolved from single dir',
  ]);
});

test('parseFrontmatter: parses array items with colons and em-dashes', () => {
  const input = [
    '---',
    'blockers:',
    '  - "Slice 2 — blocked by: missing engram binary"',
    '---',
    '',
  ].join('\n');
  const { frontmatter } = parseFrontmatter(input);
  assert.deepEqual(frontmatter.blockers, ['Slice 2 — blocked by: missing engram binary']);
});

// ---------------------------------------------------------------------------
// Body preservation
// ---------------------------------------------------------------------------

test('parseFrontmatter: preserves prose body after closing ---', () => {
  const input = '---\nfeature: test\ncurrent_slice: S1\nnext_action: do thing\nblockers:\n---\n## Where I am\n\nSome prose.\n';
  const { frontmatter, body } = parseFrontmatter(input);
  assert.equal(frontmatter.feature, 'test');
  assert.ok(body.includes('## Where I am'), 'body should contain prose heading');
  assert.ok(body.includes('Some prose.'), 'body should contain prose paragraph');
});

test('parseFrontmatter: body is empty string when no prose follows ---', () => {
  const input = '---\nfeature: test\ncurrent_slice: S1\nnext_action: do thing\nblockers:\n---\n';
  const { body } = parseFrontmatter(input);
  assert.equal(body, '');
});

// ---------------------------------------------------------------------------
// Round-trip stability
// ---------------------------------------------------------------------------

test('round-trip: simple scalars only', () => {
  assertRoundTrip([
    '---',
    'feature: feature-working-memory',
    'current_slice: Slice-1',
    'next_action: do-next-thing',
    'blockers:',
    '---',
    '',
  ].join('\n'));
});

test('round-trip: scalars with spaces and special chars (quoted)', () => {
  assertRoundTrip([
    '---',
    'feature: feature-working-memory',
    'checkpointed_at: 2026-06-26T20:55:00Z',
    'checkpointed_from: hostname-A/feat/s1-working-memory-contract',
    'current_slice: "Slice 2 — engram backend impl"',
    'next_action: "Write the featureResume() projection-loop test (TDD red first)"',
    'blockers:',
    '---',
    '',
  ].join('\n'));
});

test('round-trip: arrays with simple items', () => {
  assertRoundTrip([
    '---',
    'current_slice: Slice-2',
    'next_action: implement-things',
    'blockers:',
    '  - blocker-A',
    '  - blocker-B',
    '---',
    '',
  ].join('\n'));
});

test('round-trip: arrays with quoted items containing special chars', () => {
  assertRoundTrip([
    '---',
    'current_slice: Slice-2',
    'next_action: implement-things',
    'blockers:',
    '  - "engram sync --export project-scoping unconfirmed"',
    'in_flight_decisions:',
    '  - "resume.md is primary; apply-progress engram obs is best-effort enrichment only"',
    '  - "active feature resolved from the single openspec/changes/<X>/ dir, not the branch name"',
    '---',
    '',
  ].join('\n'));
});

test('round-trip: full example with body', () => {
  assertRoundTrip([
    '---',
    'feature: feature-working-memory',
    'checkpointed_at: 2026-06-26T20:55:00Z',
    'checkpointed_from: hostname-A/feat/s1-contract',
    'current_slice: "Slice 2 — engram backend impl"',
    'next_action: "Write the featureResume() test (TDD red first)"',
    'blockers:',
    '  - "engram sync project-scoping unconfirmed"',
    'in_flight_decisions:',
    '  - "resume.md is primary"',
    '---',
    '',
    '## Where I am',
    '',
    'Free prose narrative.',
    '',
    '## Notes',
    '',
    'Anything extra.',
    '',
  ].join('\n'));
});

// ---------------------------------------------------------------------------
// serializeFrontmatter edge cases
// ---------------------------------------------------------------------------

test('serializeFrontmatter: produces parseable output for empty object', () => {
  const serialized = serializeFrontmatter({});
  const { frontmatter } = parseFrontmatter(serialized);
  assert.deepEqual(frontmatter, {});
});

test('serializeFrontmatter: attaches body when provided', () => {
  const serialized = serializeFrontmatter({ feature: 'x' }, '\n## Title\n\nProse.\n');
  assert.ok(serialized.includes('## Title'), 'body should be in serialized output');
  const { body } = parseFrontmatter(serialized);
  assert.ok(body.includes('## Title'));
});
