// controls.mjs — what a verdict says about ITSELF: which classes of control the
// run actually applied (issue #683, implementing #575 Ruling 3).
//
// THE PROBLEM, in one posted verdict:
//
//     conditions: []
//     escalate: null
//
// Nothing there says judgment was never applied. A reader — a human deciding
// whether to merge, or at `lite` a gate reading a label derived from this —
// takes `conditions: []` for "reviewed, nothing outstanding". The truthful
// reading is "the mechanical half ran; the judgment half does not exist."
// Those are different answers and only the second is true, which makes this the
// `evidence-reader-empty-on-failure` family at the level of the STAGE.
//
// ─────────────────────────────────────────────────────────────────────────────
// DERIVED FROM THE EVALUATORS THAT RAN, NEVER FROM THE FINDINGS PRESENT.
//
// This is the whole design and it is worth being blunt about why. Deriving the
// list from the `evidence_class` values on the findings is the obvious
// implementation and it is WRONG: a clean mechanical run produces zero findings,
// so the derived list would be empty — and "no control ran" would render
// identically to "controls ran and found nothing".
//
// That is the exact defect this module exists to remove, re-created inside its
// own fix, and it would be invisible precisely on the verdicts that matter most
// (the green ones). A control class is a property of what was EXECUTED, not of
// what was found.
// ─────────────────────────────────────────────────────────────────────────────
//
// So each evaluator declares what it is capable of producing (`PRODUCES`), and
// the verdict reports the union over the evaluators that actually ran. That
// keeps the field correct across #682 without anyone remembering to update it:
// a judgment evaluator declares `inferential`, and the day it runs the verdict
// says so by itself. A hardcoded "mechanical only" string would become a lie on
// that day, and a stale honesty marker is worse than none.

/**
 * The closed vocabulary, and deliberately the SAME words `brain-review/2`'s
 * `evidence_class` already uses (`lib/schema-v2.mjs`).
 *
 * Not a third word for the same distinction: the finding-level field says how
 * ONE finding was established, this says which of those a RUN was capable of
 * establishing at all. One vocabulary, two altitudes.
 */
export const CONTROL_CLASSES = Object.freeze(['deterministic', 'inferential']);

/**
 * Evidence classes that are NOT controls, and why the distinction is real.
 *
 * `schema-v2.mjs` allows three; only two of them name a way a finding can be
 * ESTABLISHED. `insufficient` names the opposite — a finding whose evidence was
 * not enough — so it is a property of one finding, never a control a run
 * applied. There is no such thing as running the insufficient control.
 *
 * Split out rather than filtered inline so the drift guard has something to
 * assert against: `CONTROL_CLASSES ∪ NOT_A_CONTROL` must equal
 * `ALLOWED_EVIDENCE_CLASSES`, which forces whoever adds a fourth class to decide
 * which side it is on instead of having this file silently ignore it.
 */
export const NOT_A_CONTROL = Object.freeze(['insufficient']);

/**
 * The union of what the given evaluators declare, in `CONTROL_CLASSES` order so
 * two runs of the same shape render identically.
 *
 * Refuses an undeclared class rather than passing it through. A typo would
 * otherwise post a verdict claiming a control nobody wrote, which is a worse
 * failure than the silence this replaces — the claim would be believed.
 *
 * @param {string[][]} declarations  each evaluator's own `PRODUCES`
 * @returns {string[]}
 */
export function unionControls(declarations = []) {
  const seen = new Set();
  for (const declared of declarations) {
    for (const c of declared ?? []) {
      if (!CONTROL_CLASSES.includes(c)) {
        throw new Error(
          `controls: "${c}" is not a control class. Known: ${CONTROL_CLASSES.join(', ')}. ` +
          'A verdict may not claim a control that does not exist.',
        );
      }
      seen.add(c);
    }
  }
  return CONTROL_CLASSES.filter((c) => seen.has(c));
}

/**
 * The other half of the declaration: the control classes that did NOT run.
 *
 * WHY A COMPLEMENT AND NOT AN INFERENCE (#690). `controls: ["deterministic"]`
 * declares what ran. It does not declare that judgment did not — to get there a
 * reader has to know the vocabulary is closed, know `inferential` is the other
 * member, and NOTICE it is missing. That is absence carrying the meaning again,
 * which is the exact thing #683 exists to stop, one notch weaker.
 *
 * #575 Ruling 3 says a mechanical-only review must declare it ran mechanical
 * checks **only**, and "only" is the word a positive list alone cannot say.
 * Because `CONTROL_CLASSES` is closed and small, the complement is finite,
 * known, and costs one line.
 *
 * NOT a `conditions` entry, and that was measured rather than assumed:
 * `conditions` is inert with respect to the conclusion (`buildVerdict` only
 * appends to it), so putting it there would have been SAFE — but `conditions`
 * is where a reader looks for something wrong with THIS verdict's evidence, and
 * a constant that fires on every verdict until #682 lands turns that channel
 * into wallpaper. A permanent entry in the alarm channel is worse than an
 * informational field next to the thing it completes.
 *
 * Derived from the same list rather than declared separately: a hand-maintained
 * "not run" list would drift from `CONTROL_CLASSES` the first time either
 * changed, which is #683's own rule applied one field over.
 *
 * @param {string[]} controls  what DID run
 * @returns {string[]}
 */
export function complementControls(controls = []) {
  return CONTROL_CLASSES.filter((c) => !controls.includes(c));
}

/**
 * The anti-drift invariant: every finding's `evidence_class` must be covered by
 * the declared controls.
 *
 * This is what keeps the declaration from quietly becoming false. An evaluator
 * that starts emitting a class it did not declare is exactly how a truthful
 * field turns into a confident lie, and it is the failure mode a hand-maintained
 * list has by construction.
 *
 * `/1` findings carry no `evidence_class` at all and are skipped — absence is
 * not a claim about a control. `insufficient` is skipped for the same reason:
 * see `NOT_A_CONTROL`.
 *
 * @param {string[]} controls
 * @param {Array<{evidence_class?:string}>} findings
 * @returns {{ok:true}|{ok:false, undeclared:string[], error:string}}
 */
export function checkControlsCoverFindings(controls = [], findings = []) {
  const undeclared = [...new Set(
    findings
      .map((f) => f?.evidence_class)
      // `insufficient` is skipped for the same reason absence is: neither claims
      // that a control ran, so neither can contradict the declaration.
      .filter((c) => c && !NOT_A_CONTROL.includes(c) && !controls.includes(c)),
  )];
  if (undeclared.length === 0) return { ok: true };
  return {
    ok: false,
    undeclared,
    error:
      `the verdict declares controls [${controls.join(', ')}] but carries finding(s) established by ` +
      `[${undeclared.join(', ')}] — an evaluator is producing a class it does not declare in PRODUCES.`,
  };
}
