// controls.test.mjs — the verdict's statement about itself (issue #683,
// implementing #575 Ruling 3).
//
// The end-to-end proof — a real `brain:review` run whose posted body carries the
// declaration — is in test/review-regulated/regulated-review.e2e.test.mjs. This
// file pins the rule: the vocabulary, the union, and the invariant that keeps
// the declaration from quietly becoming false.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CONTROL_CLASSES, NOT_A_CONTROL, unionControls, complementControls, checkControlsCoverFindings,
} from './controls.mjs';
import { ALLOWED_EVIDENCE_CLASSES } from './schema-v2.mjs';
import { PRODUCES as TRANCHE } from '../evaluators/tranche.mjs';
import { PRODUCES as CHECKPOINT } from '../evaluators/checkpoint.mjs';
import { PRODUCES as RULING } from '../evaluators/ruling.mjs';

test('#683: the vocabulary is DRAWN FROM evidence_class, and every class is accounted for', () => {
  // One rule, one vocabulary — a parallel list would be #130/#340/#555 at the
  // level of words. But the two sets are not EQUAL, and the first cut of this
  // test asserted that they were: `schema-v2.mjs` allows three classes and only
  // two of them name a way a finding can be established. `insufficient` names
  // the opposite, so it is not a control.
  //
  // The partition is what is asserted, so a fourth evidence class cannot be
  // added without someone deciding which side of this line it falls on.
  assert.deepEqual(
    [...CONTROL_CLASSES, ...NOT_A_CONTROL].sort(),
    [...ALLOWED_EVIDENCE_CLASSES].sort(),
    'every evidence class must be either a control or explicitly not one — no third state',
  );
  assert.equal(CONTROL_CLASSES.some((c) => NOT_A_CONTROL.includes(c)), false, 'the two sets must be disjoint');
});

test('#683: an `insufficient` finding does not contradict the declaration', () => {
  // It is not a claim that a control ran, so it cannot make the declaration
  // false — and treating it as undeclared would REFUSE the run (cli.mjs) over a
  // finding that says nothing about what was applied.
  const r = checkControlsCoverFindings(['deterministic'], [{ id: 'a', evidence_class: 'insufficient' }]);
  assert.equal(r.ok, true);
});

test('#683: every evaluator declares what it produces, and today all three are mechanical', () => {
  for (const [name, produces] of [['tranche', TRANCHE], ['checkpoint', CHECKPOINT], ['ruling', RULING]]) {
    assert.deepEqual(produces, ['deterministic'], `${name} must declare its own class`);
    assert.ok(Object.isFrozen(produces), `${name}'s declaration must not be mutable at a distance`);
  }
});

test('#683: the union is deduped and ordered, so two runs of one shape render identically', () => {
  assert.deepEqual(unionControls([['deterministic'], ['deterministic']]), ['deterministic']);
  assert.deepEqual(unionControls([['inferential'], ['deterministic']]), ['deterministic', 'inferential']);
  assert.deepEqual(unionControls([]), []);
});

test('#683: an undeclared class is REFUSED, not passed through — a claimed control must exist', () => {
  assert.throws(() => unionControls([['telepathy']]), /not a control class/);
  // The reason, stated: silence is recoverable, a believed false claim is not.
  assert.throws(() => unionControls([['deterministic'], ['Deterministic']]), /not a control class/);
});

// ── The invariant that stops the declaration becoming a lie ─────────────────

test('#683: a finding established by an undeclared class is caught', () => {
  const r = checkControlsCoverFindings(['deterministic'], [
    { id: 'a', evidence_class: 'deterministic' },
    { id: 'b', evidence_class: 'inferential' },
  ]);
  assert.equal(r.ok, false);
  assert.deepEqual(r.undeclared, ['inferential']);
  assert.match(r.error, /does not declare in PRODUCES/);
});

test('#683: a /1 finding carries no evidence_class, and absence is not a claim', () => {
  const r = checkControlsCoverFindings(['deterministic'], [{ id: 'a', evidence: 'x' }]);
  assert.equal(r.ok, true, 'brain-review/1 findings are unannotated by design — that is not a violation');
});

test('#683: NO findings is not a violation — that is the case the whole design turns on', () => {
  // A clean mechanical run. If this were a violation, or if the declaration were
  // derived from findings instead of from evaluators, a green verdict would
  // report no controls at all — "nothing ran" and "ran, found nothing" collapsed
  // back into one answer, on the verdicts where nobody would look.
  assert.equal(checkControlsCoverFindings(['deterministic'], []).ok, true);
});

// ═══════════════════════════════════════════════════════════════════════════
// #690 — the complement: closing #575 Ruling 3's word "only"
// ═══════════════════════════════════════════════════════════════════════════

test('#690: the complement is DERIVED from the same closed list, never a second one', () => {
  assert.deepEqual(complementControls(['deterministic']), ['inferential']);
  assert.deepEqual(complementControls(['inferential']), ['deterministic']);
  assert.deepEqual(complementControls([]), [...CONTROL_CLASSES]);
});

test('#690: the two halves partition the vocabulary — for every possible applied set', () => {
  // The property, not three examples of it. A hand-maintained "did not run" list
  // would satisfy the cases above and drift on the first added class; this cannot.
  const subsets = [[], ['deterministic'], ['inferential'], ['deterministic', 'inferential']];
  for (const applied of subsets) {
    const notApplied = complementControls(applied);
    assert.deepEqual(
      [...applied, ...notApplied].sort(),
      [...CONTROL_CLASSES].sort(),
      `applied ${JSON.stringify(applied)} + not-applied ${JSON.stringify(notApplied)} must cover the vocabulary exactly`,
    );
    assert.equal(applied.some((c) => notApplied.includes(c)), false, 'and the halves must be disjoint');
  }
});

test('#690: when #682 lands, the complement empties itself — no edit required', () => {
  // The reason this is derived rather than declared: the day a judgment
  // evaluator declares `inferential`, the "did not run" half goes to [] on its
  // own. A hardcoded list would keep asserting a falsehood until someone
  // remembered it, which is the stale-honesty-marker failure #683 named.
  assert.deepEqual(complementControls(unionControls([['deterministic'], ['inferential']])), []);
});

test('#690: `insufficient` is not in either half — it is not a control at all', () => {
  assert.equal(complementControls([]).includes('insufficient'), false);
});
