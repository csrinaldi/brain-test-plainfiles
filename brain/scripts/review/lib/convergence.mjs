// convergence.mjs — `reviewer.convergence.maxRounds` (#682 slice 3, C.1, REQ-682-5).
//
// TWO BOUNDS, TWO QUANTITIES, AND THEY ARE NOT THE SAME NUMBER READ TWICE:
//
//   §7's `rev >= 3`      counts POSTED REVISIONS. It asks "how many times may this
//                        PR be re-reviewed before a human is summoned", lives in
//                        `verdict.mjs`'s `boundHit`, and is read from the count of
//                        prior verdict blocks on the PR.
//   `maxRounds`          counts PRODUCE ROUNDS INSIDE ONE RUN. It asks "how long
//                        may a single review argue with itself before it stops",
//                        and nothing about it survives the run.
//
// Conflating them is how a run either loops or stops early for the wrong reason:
// a PR on its third revision would get a one-round review, and a run that wanted
// three rounds would be told it had already used them up on previous days.
//
// This file therefore imports NOTHING from `verdict.mjs`, and the test drives the
// two knobs independently — moving `maxRounds` must leave §7's escalation exactly
// where it was, and moving `priorRevCount` must leave the round count alone.
// That independence is the requirement; a test asserting both happen to equal 3
// would pass under an implementation that read one constant twice.
//
// WHAT ONE ROUND MEANS TODAY, measured rather than assumed: `gatherInferentialInputs`
// calls `deps.generate` once and `evaluateRefuter` challenges the result once. So
// the bound in force before this key existed is ONE, and that is the default —
// REQ-682-5's second clause is "when it is absent, the bound in force today
// applies, UNCHANGED", which means the default cannot be a round number somebody
// thought was nicer.
//
// AND THE KEY BOUNDS THE PRODUCE ROUNDS, NOT A PRODUCE→CHALLENGE PAIR. This file
// stated the measurement above correctly and then bounded only the first half of
// it, while REQ-682-5 said "produce→challenge rounds" — the header and the
// requirement it cited did not describe the same loop. #682's own cold review
// found it (`judgment:cold-5`) and measured it: `maxRounds: 4` yields 4 produce
// calls and 1 challenge.
//
// The REQUIREMENT was corrected, not the code, and the reason is what the bound
// is FOR. It exists so a run cannot loop, and the only thing in a run that CAN
// loop is the produce loop below; `applyCausalAdmission` is a straight-line call
// that challenges the blocking set once. Bounding it at N would not make anything
// safer — it would pay N challenger costs to challenge the same findings and
// invite N different answers about one claim. A challenger that genuinely
// iterates would change that, and would have to change REQ-682-5 with it.
//
// AND WITH TODAY'S TRANSPORT, A HIGHER BOUND CONVERGES ON ROUND 2. The artifact is
// a static file: `makeArtifactGenerate` reads the same `cold-review.md` every
// round, so round 2 produces the same findings, every one of them is a duplicate,
// and the loop stops. That is not a defect and it is not a reason to withhold the
// key — the loop and the bound are real, and they become load-bearing the moment
// a transport re-runs the stage between rounds. It IS a reason to write it down:
// an operator setting `maxRounds: 5` today gets one round of work and should know
// that from here rather than from a bill.

/**
 * The number of produce rounds that ran before this key existed. NOT a preference
 * — a measurement of `gatherInferentialInputs`, and the value REQ-682-5's
 * "unchanged" clause is defined against.
 */
export const ROUNDS_IN_FORCE_TODAY = 1;

/**
 * resolveConvergence() — PURE.
 *
 * @param {{reviewer?: {convergence?: {maxRounds?: unknown}}}} config
 * @returns {{maxRounds: number}}
 * @throws {Error} when the key exists and cannot be read as a round count
 */
export function resolveConvergence(config) {
  const raw = config?.reviewer?.convergence?.maxRounds;

  if (raw === undefined || raw === null) return { maxRounds: ROUNDS_IN_FORCE_TODAY };

  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new Error(
      `convergence: reviewer.convergence.maxRounds must be a whole number of rounds — got ${JSON.stringify(raw)}. ` +
      'Refusing rather than defaulting: an operator who wrote the key asked for something, and ' +
      'silently substituting the old bound would run a review they did not configure.'
    );
  }

  // ZERO IS REFUSED, and the reason is that it is not a bound. "Run the judgment
  // half zero times" is a way of saying "do not run it", which
  // `reviewer.inferential.enabled: false` already says — and it says it where the
  // verdict can report it, as a disabled half rather than as a half that ran and
  // found nothing. Two spellings of one state is how the two become readable as
  // different things.
  if (raw < 1) {
    throw new Error(
      `convergence: reviewer.convergence.maxRounds must be at least 1 — got ${raw}. ` +
      'Zero rounds is not a bound on a run, it is a way of not running: use ' +
      'reviewer.inferential.enabled = false, which the verdict reports as a disabled half ' +
      'rather than as a half that ran and found nothing.'
    );
  }

  return { maxRounds: raw };
}
