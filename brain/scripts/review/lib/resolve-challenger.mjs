// resolve-challenger.mjs — ONE resolution of the judgment half (issue #682).
// REQ-682-1, REQ-682-2, REQ-682-3's axis value, REQ-682-6.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BINDING DEBT IS RETIRED (#576 D4). The header that stood here since #682
// instructed, once #312 landed: delete the binding half, call the port
// instead, keep the AXIS resolution. This is that deletion — one prorogue late.
//
// The challenger's ROLE now lives on the port's shelf
// (roles/first-party/adversary-challenger.mjs) and `resolveJudgment` serves it
// as `challengerRole` — whatever runner slice 3 builds reads the PORT, never a
// config binding. The AXIS (who challenges: a human today) stays here: that is
// reviewer policy, exactly as ruled.
//
// `reviewer.inferential.challenger.{agent, model}` were RESERVED for the
// binding and — measured before this move — never read by any line. They stay
// unread and are documented as inert (#229's post-release doctrine: the read
// is what retires; the keys are not deleted from anyone's config).
// ─────────────────────────────────────────────────────────────────────────────
//
// WHY ONE FUNCTION AND NOT TWO — the correction the cold review forced.
//
// The first cut exported `resolveChallenger` and `resolveAxis` as near-copies,
// and they disagreed on two inputs. Worse, `cli.mjs` used `resolveAxis(...) !==
// null` as a PROXY for "is the producer enabled", which is a different question.
//
// And the producer's gate (`inferentialEnabled`) and the challenger's gate
// (`protocol === '/2'`) DISAGREED AT A SHIPPED TIER DEFAULT. At `standard`
// (`inferentialEnabled: true`, `reviewProtocol: 'brain-review/1'`) the producer
// ran and `applyCausalAdmission` was skipped entirely, so a reasoned blocker was
// produced, never challenged, never escalated — and the verdict declared
// `controls_not_applied: []`, i.e. the judgment control WAS applied. That is the
// exact state #552 ruled against, re-created by having a second gate.
//
// So there is now ONE resolution and one `run` flag that both halves read. They
// cannot disagree, because there is nothing left to disagree with.

import { ROUTED_HUMAN, UNCHALLENGED } from '../evaluators/refuter.mjs';

/** The axes #682 ruled on. A closed vocabulary — an unrecognised value refuses. */
export const AXES = Object.freeze(['human', 'same-model', 'cross-family', 'mechanical']);

/**
 * The runners this build implements, keyed by axis — the ONE declaration of
 * which axes are real here. `resolveJudgment`'s dispatch reads this map and
 * `IMPLEMENTED_AXES` is derived from it, so the set an operator is TOLD about
 * cannot drift from the set that actually routes to a runner.
 *
 * It was two declarations until the cold review of the terminal PR: a hand-
 * written constant beside a dispatch ternary deciding the same thing. The
 * mutation that proved it — claiming `same-model` was implemented while
 * `same-model` still routed to `unbuiltRunner` — passed the full suite.
 *
 * A `Map` rather than an object literal: the lookup key comes from operator
 * config, and a Map has no inherited keys for it to land on.
 */
import { firstPartyInstance } from '../../roles/first-party/index.mjs';

const RUNNERS = new Map([['human', humanRunner]]);

/**
 * Axes this build implements, DERIVED from `RUNNERS`. Separate from `AXES`:
 * "not a real axis" (a typo the operator fixes) and "real but unbuilt" (a
 * property of the build) are different facts and they are reported differently.
 *
 * Slice 3 adds `same-model` by adding its runner to `RUNNERS`. One edit, and
 * both the dispatch and this declaration follow it.
 */
export const IMPLEMENTED_AXES = Object.freeze([...RUNNERS.keys()]);

/**
 * The protocol the judgment half requires, and it is not a preference.
 * `brain-review/1` renders neither `evidence_class` nor the refuter markers, so
 * at `/1` a reasoned finding is invisible AND unchallengeable — the producer
 * would be emitting claims into a format that cannot carry them.
 */
export const JUDGMENT_PROTOCOL = 'brain-review/2';

/**
 * The axis when nobody declares one (#743 ruling, 2026-08-20).
 *
 * `human` and not `null`, because `human` is what actually happens: a reasoned
 * blocker nobody automated is challenged by a person, and `humanRunner` marks it
 * `routed:human` and escalates. It is also the only axis this build implements,
 * so it is the one default that does not overstate the strength of the evidence.
 *
 * The tier used to answer this — `standard` said `same-model`, `regulated` said
 * `cross-family` — and both named axes nothing implements. When slice 3 builds
 * `same-model`, moving this default is one line and a visible decision.
 */
export const DEFAULT_AXIS = 'human';

/**
 * humanRunner() — REQ-682-6, and the reason this is a runner rather than `null`.
 *
 * `null` already means something: `evaluateRefuter` reads it as "there is
 * nothing to challenge this with" and marks every reasoned blocker
 * `unchallenged`. "A human challenges this by design" is a DIFFERENT state, and
 * rendering the two identically re-folds the pair #552 unfolded.
 *
 * TOTAL over its input — one outcome per blocker, always. `evaluateRefuter` now
 * backstops a partial runner, but a runner shipped from here must not need it.
 */
async function humanRunner(blockers = []) {
  return {
    outcomes: blockers.map(f => ({
      id: f.id,
      outcome: ROUTED_HUMAN,
      rationale:
        'Routed to a human challenger by configuration (reviewer.inferential.challenger.axis = "human"). ' +
        'No automated challenge was attempted, and none was expected.',
    })),
  };
}

/**
 * unbuiltRunner() — an axis this build does not implement.
 *
 * It reports every blocker `UNCHALLENGED` rather than throwing. The first cut
 * threw, and the cold review showed the throw is caught NOWHERE: it surfaced as
 * an unhandled rejection with no verdict posted, REPLACING #552's honest
 * `unchallenged` + `escalate: 'human'` + posted REVISE. Trading a posted
 * fail-closed verdict for a crash is a regression of #552's fix, not a louder
 * failure — the operator ends up with LESS information, not more.
 *
 * It still refuses to substitute a weaker axis: the rationale names the
 * configured axis, so a reader sees which challenge did not happen and why.
 * `evaluateRefuter` escalates on `UNCHALLENGED`, so the run fails closed and
 * says so on the wire instead of in a stack trace.
 */
function unbuiltRunner(axis) {
  return async (blockers = []) => ({
    outcomes: blockers.map(f => ({
      id: f.id,
      outcome: UNCHALLENGED,
      rationale:
        `The configured challenger axis "${axis}" is not implemented in this build ` +
        `(implemented: ${IMPLEMENTED_AXES.join(', ')}). Nothing challenged this finding. ` +
        'Refusing to substitute a weaker axis than the one configured.',
    })),
  });
}

/**
 * resolveJudgment() — the SINGLE gate for the judgment half.
 *
 * Returns `{ run, axis, challenger, reason }`:
 *   - `run`        — whether the judgment half runs AT ALL. Both the producer
 *                    and the challenger read this one flag.
 *   - `axis`       — the resolved axis as a VALUE, for the verdict's
 *                    declaration (REQ-682-3). `null` when the half does not run.
 *   - `challenger` — the runner, or `null` when the half does not run.
 *   - `reason`     — why it does not run. Never a silent `false`.
 *   - `enabled`    — whether the half was ASKED for, by config OR by tier.
 *                    Separate from `run` because the two answer different
 *                    questions, and a caller that conflates them cannot tell a
 *                    repo that never wanted the half from one that wanted it and
 *                    was refused.
 *
 * Order (REQ-682-1):
 *   1. `reviewer.inferential.enabled` — ON unless explicitly `false` (#743).
 *   2. The protocol must be `brain-review/2` — see `JUDGMENT_PROTOCOL`.
 *   3. `reviewer.inferential.challenger.axis`, else `DEFAULT_AXIS`.
 *   4. An axis outside `AXES` THROWS: it is operator-fixable config, and
 *      defaulting would hide an unknown evidentiary strength.
 *
 * @param {{config?: object, protocol?: string}} args
 * @returns {{run: boolean, axis: string|null, challenger: Function|null, challengerRole: object|null, reason: string|null}}
 * @throws {Error} on an unrecognised axis
 */
export function resolveJudgment({ config, protocol = JUDGMENT_PROTOCOL } = {}) {
  const off = (reason, enabled = true) => ({ run: false, axis: null, challenger: null, challengerRole: null, reason, enabled });

  const inferential = config?.reviewer?.inferential ?? {};

  // #743 ruling — ON when the key is absent, OFF only on an explicit `false`.
  // The addendum chose this direction knowing its cost: until slice 3 supplies a
  // transport, every verdict in every repo carries the "enabled but no transport"
  // condition below. A half that is on and says it cannot run is honest; one that
  // is off because nobody set a key is a capability nobody knows they lack.
  const enabled = inferential.enabled !== false;
  if (!enabled) {
    return off('the judgment half is disabled (reviewer.inferential.enabled is false)', false);
  }

  // The gate that used to live only at the challenger's call site. Reading it
  // HERE is what stops the two halves from disagreeing.
  if (protocol !== JUDGMENT_PROTOCOL) {
    return off(
      `the judgment half requires ${JUDGMENT_PROTOCOL} and this run is "${protocol}" — ` +
      `${protocol} renders neither evidence_class nor the refuter markers, so a reasoned ` +
      'finding would be neither visible nor challengeable. Set reviewer.protocol to ' +
      `${JUDGMENT_PROTOCOL} to enable the judgment half.`
    );
  }

  // An explicit `null` falls to the default too, and that is deliberate: `null`
  // is not a member of `AXES`, so it cannot mean "no challenger" — it can only
  // mean "unset". The refusal that used to live here fired when an enabled half
  // met a tier supplying no axis; the tier no longer supplies one, so the branch
  // is gone rather than kept as a condition nothing can reach.
  const axis = inferential.challenger?.axis ?? DEFAULT_AXIS;

  if (!AXES.includes(axis)) {
    throw new Error(
      `resolve-challenger: unrecognised challenger axis ${JSON.stringify(axis)} — ` +
      `must be one of: ${AXES.join(', ')}. ` +
      'Refusing rather than defaulting: an unknown axis is an unknown evidentiary strength.'
    );
  }

  return {
    run: true,
    enabled: true,
    axis,
    challenger: RUNNERS.get(axis) ?? unbuiltRunner(axis),
    // #576 D4: the role the runner speaks AS — served from the port's shelf,
    // never from a config binding.
    challengerRole: firstPartyInstance('adversary-challenger'),
    reason: null,
  };
}
