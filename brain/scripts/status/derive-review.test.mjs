// derive-review.test.mjs — issue #280, slice 2. The server-side sections, and
// the one this port cannot answer yet.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveReview, deriveWorkingMemory, deriveStandingItems } from './derive-review.mjs';
import { isUncomputable } from './report.mjs';

// The real shape: a ```yaml fence, and `protocol:` as a SCALAR INSIDE the block
// — not the fence tag. Copied from `parse-verdict.test.mjs` rather than guessed,
// which is the point of consuming the existing parser instead of a new one.
const VERDICT_BODY = [
  'Some prose before the block.',
  '```yaml',
  'protocol: brain-review/2',
  'verdict: REVISE',
  'head_sha: abc1234',
  'rev: 3',
  '```',
  'Prose after.',
].join('\n');

// ── deriveReview — consumes parse-verdict, never re-implements it ─────────

test('deriveReview: the last verdict is read through the existing parser', () => {
  const s = deriveReview({
    reviews: [{ state: 'COMMENTED', author: 'csrinaldibot', body: VERDICT_BODY }],
    prHeadSha: 'abc1234', localHeadSha: 'abc1234',
  });
  const f = Object.fromEntries(s.fields);
  assert.equal(f.verdict.value, 'REVISE');
  assert.equal(f.rev.value, 3);
});

test('deriveReview: a verdict bound to an OLD head is named as stale', () => {
  // The fact an operator actually needs after a crash: the verdict they remember
  // may not describe the code they are looking at.
  const s = deriveReview({
    reviews: [{ state: 'COMMENTED', author: 'csrinaldibot', body: VERDICT_BODY }],
    prHeadSha: 'def5678', localHeadSha: 'def5678',
  });
  assert.match(String(Object.fromEntries(s.fields)['verdict binds'].value), /stale/i);
});

test('deriveReview: PR head vs local tip is its own fact', () => {
  const s = deriveReview({
    reviews: [{ state: 'COMMENTED', author: 'csrinaldibot', body: VERDICT_BODY }],
    prHeadSha: 'abc1234', localHeadSha: 'zzz9999',
  });
  assert.match(String(Object.fromEntries(s.fields)['pr head vs local'].value), /DIVERGE/);
});

test('deriveReview: reviews with no parseable verdict is a FACT, not a failure', () => {
  // A PR that has been reviewed by a human and never by brain is a normal state.
  // Rendering it as uncomputable would report a failure where there is none.
  const s = deriveReview({
    reviews: [{ state: 'APPROVED', author: 'someone', body: 'looks good' }],
    prHeadSha: 'abc1234', localHeadSha: 'abc1234',
  });
  const f = Object.fromEntries(s.fields);
  assert.equal(f.verdict.value, 'none posted');
  assert.equal(isUncomputable(f.verdict), false);
});

test('deriveReview: an unreachable forge degrades this section alone', () => {
  const s = deriveReview({ reviews: null, reason: 'gh api /pulls failed (HTTP 403)' });
  assert.match(Object.fromEntries(s.fields).verdict.reason, /403/);
});

test('deriveReview: no open PR is a fact too', () => {
  const s = deriveReview({ reviews: [], prHeadSha: null, localHeadSha: 'abc1234' });
  assert.equal(Object.fromEntries(s.fields).verdict.value, 'none posted');
});

// ── deriveWorkingMemory — the human's own notes ───────────────────────────

test('deriveWorkingMemory: the TAIL is what matters after a crash', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n');
  const s = deriveWorkingMemory({ resumeText: lines, tailLines: 3 });
  const v = String(Object.fromEntries(s.fields)['resume.md (tail)'].value);
  assert.match(v, /line 40/);
  assert.doesNotMatch(v, /line 1\b/, 'the head of a long file is not what a returning human needs');
});

test('deriveWorkingMemory: absent resume.md is a fact, not a failure', () => {
  const s = deriveWorkingMemory({ resumeText: null });
  const f = Object.fromEntries(s.fields)['resume.md (tail)'];
  assert.equal(f.value, 'absent');
  assert.equal(isUncomputable(f), false);
});

// ── deriveStandingItems — the section this port cannot answer ─────────────

test('deriveStandingItems: uncomputable, and it names the MISSING VERB', () => {
  // #280 says "consumes, never duplicates: if a piece is missing upstream, the
  // fix is upstream". The port has `issueComment` (write) and NO verb that reads
  // issue comments, so the tracker's index comment is unreachable from here.
  //
  // The honest render is uncomputable naming the gap — not a hand-rolled `gh`
  // call, which would bypass the port and violate the very contract this command
  // reports on.
  const s = deriveStandingItems({});
  const f = Object.fromEntries(s.fields)['open findings'];
  assert.equal(isUncomputable(f), true);
  assert.match(f.reason, /no verb/i);
  assert.match(f.reason, /#699/, 'the reason points at the ticket that owns the gap');
});
