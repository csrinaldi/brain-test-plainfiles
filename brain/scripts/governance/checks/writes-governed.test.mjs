// writes-governed.test.mjs — the human-gate invariant read on merged history (#511).
//
// The defect these pin is not a bug in a function, it is a MEANING: L6's `warn` on
// absent review evidence is correct at PR time ("not reviewed yet") and wrong on
// merged history ("never reviewed"). Every case below is about which reading applies
// and about the three things that are NOT a verdict — abstention, a capability gap,
// and a failed read.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { writesGoverned } from './writes-governed.mjs';

const ADR = ['brain/project/decisions/adr-0902-example.md'];
const APPROVED = [{ state: 'APPROVED', author: 'a-human' }];

// ── the reading of absence, which is the whole ticket ────────────────────────

test('writes-governed: standard, a brain/ change with NO reviews FAILS — post-merge, "not yet" is "never"', () => {
  const r = writesGoverned({
    changedFiles: ADR, reviews: [], author: 'someone', prResolved: true, tier: 'standard',
  });
  assert.equal(r.pass, false,
    'L6 warns here because a PR may still be reviewed; a merged PR will not be');
  assert.match(r.reason, /never/i, 'the reason must say why the reading differs');
});

test('writes-governed: standard, an APPROVED review passes', () => {
  const r = writesGoverned({
    changedFiles: ADR, reviews: APPROVED, author: 'someone-else', prResolved: true, tier: 'standard',
  });
  assert.equal(r.pass, true);
});

test('writes-governed: standard, only COMMENTED reviews still FAILS', () => {
  const r = writesGoverned({
    changedFiles: ADR, reviews: [{ state: 'COMMENTED', author: 'a-human' }],
    author: 'someone', prResolved: true, tier: 'standard',
  });
  assert.equal(r.pass, false, 'a comment is not an approval — L6 already says so');
});

// ── the tier ruling: at lite, authorship IS the gate (ADR-0026) ──────────────

test('writes-governed: lite, a non-agent author needs no review (ADR-0026 ratified this)', () => {
  const r = writesGoverned({
    changedFiles: ADR, reviews: [], author: 'csrinaldi', prResolved: true, tier: 'lite',
  });
  assert.equal(r.pass, true,
    'lite declares two-human constraints unsatisfiable by construction; authorship is the evidence');
});

test('writes-governed: lite, an AGENT author fails — containment does not tier', () => {
  const r = writesGoverned({
    changedFiles: ADR, reviews: [], author: 'csrinaldibot',
    botAllowlist: ['csrinaldibot'], prResolved: true, tier: 'lite',
  });
  assert.equal(r.pass, false,
    'no tier permits an agent-authored brain/ change — REQ-L6-1′');
});

// ── the three shapes that are NOT verdicts ───────────────────────────────────

test('writes-governed: no PR resolved → ABSTAINS, never fails (#474)', () => {
  const r = writesGoverned({ changedFiles: ADR, prResolved: false });
  assert.equal(r.abstain, true);
  assert.equal(r.pass, undefined,
    'a merge with no PR stays evaluable — failing it re-poisons the windows #474 cleared');
});

test('writes-governed: an adapter without prReviews → ABSTAINS (capability gap, not a failed read)', () => {
  const r = writesGoverned({ changedFiles: ADR, reviews: null, prResolved: true, tier: 'standard' });
  assert.equal(r.abstain, true);
  assert.match(r.reason, /capability gap/i);
});

test('writes-governed: a merge touching no brain/ path passes without consulting reviews', () => {
  const r = writesGoverned({
    changedFiles: ['src/whatever.mjs'], reviews: [], prResolved: true, tier: 'standard',
  });
  assert.equal(r.pass, true);
});

// ── the rule has exactly one implementation ──────────────────────────────────

test('writes-governed: the tier matrix is L6\'s, not a copy — lite and standard disagree here', () => {
  const input = { changedFiles: ADR, reviews: [], author: 'a-person', prResolved: true };
  assert.equal(writesGoverned({ ...input, tier: 'lite' }).pass, true);
  assert.equal(writesGoverned({ ...input, tier: 'standard' }).pass, false);
  // If this ever agrees at both tiers, someone re-implemented the matrix locally instead
  // of calling evaluateBrainWritesReviewed — the #340 defect, one module over.
});
