// yaml-block.drift.test.mjs — cross-parser equivalence guard (issue #473,
// design.md §B3 guard 1). `parseVerdict` (brain-review/N) and `parseDecision`
// (brain-decision/1) both read fenced-YAML carriers through what MUST be the
// same underlying primitives (`extractFencedBlock`/`scalar`). This table
// renders the same pathological carrier trait into a body for EACH protocol
// and asserts both readers agree on the shared fields (`protocol`,
// `head_sha`) — both a value, or both `null`. If either parser re-inlines
// its own private copy of the fence/scalar primitives, a row here disagrees.
//
// This is deliberately NOT a source scan (`red-proof-blind-along-an-unvaried-
// axis.md` — a scan is blind by SPELLING). It is a behavioral equivalence
// check driven through the public API of both modules.
//
// Every row uses a VALID 40-hex `head_sha` value and varies only the
// surrounding carrier syntax (fence markers, line endings, key indentation,
// fence count, block emptiness) — never the value's own content. Varying the
// value's format would exercise each protocol's own (intentionally
// different) field validation, not the shared reading primitive this guard
// protects.
//
// The value-side contract (a real value vs. a whitespace-only key line,
// #612) lives in `yaml-block.test.mjs`, not here — every gate this file's
// rows probe refuses `''` and `null` identically, so a trailing-space row
// added here would pass unchanged before and after that repair and prove
// nothing (design.md §D-E).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseVerdict } from './parse-verdict.mjs';
import { parseDecision } from './decision-block.mjs';

const SHA = 'b'.repeat(40);

/** Builds a brain-review/2 body (protocol is included in parseVerdict's
 * result only for /2, keeping it comparable to parseDecision's always-present
 * `protocol` field) from raw block lines, with a configurable fence opener. */
function reviewBody(lines, { fenceOpen = '```yaml', fenceClose = '```', eol = '\n' } = {}) {
  const body = [fenceOpen, 'protocol: brain-review/2', 'verdict: APPROVE', `head_sha: ${SHA}`, ...lines, fenceClose].join('\n');
  return eol === '\n' ? body : body.replace(/\n/g, eol);
}

function decisionBody(lines, { fenceOpen = '```yaml', fenceClose = '```', eol = '\n' } = {}) {
  const body = [fenceOpen, 'protocol: brain-decision/1', 'decision: APPROVE', `head_sha: ${SHA}`, 'actor: alice', ...lines, fenceClose].join('\n');
  return eol === '\n' ? body : body.replace(/\n/g, eol);
}

/** Table row: `{ name, opts, expectHeadSha }`. `expectHeadSha` is `SHA` when
 * both parsers are expected to read the block, or `null` when the carrier is
 * expected to defeat both parsers identically. */
const ROWS = [
  { name: 'no fence at all', raw: true, expectHeadSha: null },
  { name: 'bare fence, no yaml tag', opts: { fenceOpen: '```' }, expectHeadSha: SHA },
  { name: 'yaml-tagged fence with a trailing space before the newline', opts: { fenceOpen: '```yaml ' }, expectHeadSha: SHA },
  { name: 'CRLF line endings throughout the body', opts: { eol: '\r\n' }, expectHeadSha: SHA },
  { name: 'leading tab before the head_sha key (breaks the column-0 anchor)', tabKey: true, expectHeadSha: null },
  { name: 'empty block (fence present, no content)', empty: true, expectHeadSha: null },
  { name: 'uppercase PROTOCOL key (case-folded key must defeat both parsers identically)', upperProtoKey: true, expectHeadSha: null },
];

for (const row of ROWS) {
  test(`yaml-block drift — ${row.name}`, () => {
    let rBody;
    let dBody;
    if (row.raw) {
      rBody = 'just a regular comment, no fence here';
      dBody = 'just a regular comment, no fence here';
    } else if (row.empty) {
      rBody = '```yaml\n```';
      dBody = '```yaml\n```';
    } else if (row.tabKey) {
      rBody = ['```yaml', 'protocol: brain-review/2', 'verdict: APPROVE', `\thead_sha: ${SHA}`, '```'].join('\n');
      dBody = ['```yaml', 'protocol: brain-decision/1', 'decision: APPROVE', `\thead_sha: ${SHA}`, 'actor: alice', '```'].join('\n');
    } else if (row.upperProtoKey) {
      rBody = ['```yaml', 'PROTOCOL: brain-review/2', 'verdict: APPROVE', `head_sha: ${SHA}`, '```'].join('\n');
      dBody = ['```yaml', 'PROTOCOL: brain-decision/1', 'decision: APPROVE', `head_sha: ${SHA}`, 'actor: alice', '```'].join('\n');
    } else {
      rBody = reviewBody([], row.opts);
      dBody = decisionBody([], row.opts);
    }

    const reviewResult = parseVerdict({ body: rBody });
    const decisionResult = parseDecision({ body: dBody });

    assert.equal(
      reviewResult?.head_sha ?? null,
      row.expectHeadSha,
      `parseVerdict head_sha mismatch for row "${row.name}"`,
    );
    assert.equal(
      decisionResult?.head_sha ?? null,
      row.expectHeadSha,
      `parseDecision head_sha mismatch for row "${row.name}"`,
    );
    assert.equal(
      reviewResult?.protocol ?? null,
      row.expectHeadSha === null ? null : 'brain-review/2',
      `parseVerdict protocol mismatch for row "${row.name}"`,
    );
    assert.equal(
      decisionResult?.protocol ?? null,
      row.expectHeadSha === null ? null : 'brain-decision/1',
      `parseDecision protocol mismatch for row "${row.name}"`,
    );
  });
}

test('yaml-block drift — two fences in one body: only the FIRST is read, identically by both parsers', () => {
  const firstReview = ['```yaml', 'protocol: brain-review/2', 'verdict: APPROVE', `head_sha: ${SHA}`, '```'].join('\n');
  const secondReview = ['```yaml', 'protocol: brain-review/2', 'verdict: REVISE', `head_sha: ${'c'.repeat(40)}`, '```'].join('\n');
  const firstDecision = ['```yaml', 'protocol: brain-decision/1', 'decision: APPROVE', `head_sha: ${SHA}`, 'actor: alice', '```'].join('\n');
  const secondDecision = ['```yaml', 'protocol: brain-decision/1', 'decision: APPROVE', `head_sha: ${'c'.repeat(40)}`, 'actor: bob', '```'].join('\n');

  const reviewResult = parseVerdict({ body: `${firstReview}\n\nProse.\n\n${secondReview}` });
  const decisionResult = parseDecision({ body: `${firstDecision}\n\nProse.\n\n${secondDecision}` });

  assert.equal(reviewResult.head_sha, SHA);
  assert.equal(decisionResult.head_sha, SHA);
});
