// stage-seam.mjs — the `runStage` seam B.5 requires, and the refusal REQ-S3-1
// demands (#682 slice 3, B.6).
//
// REQ-S3-1's third state is the one this file exists for:
//
//   > WHEN the entry names an engine with no backend
//   > THEN the run REFUSES rather than falling back. An engine the operator
//   > named and did not get is not the same state as one they never named.
//
// So there are THREE states at this layer and they must stay three, not two:
//
//   unrouted          → `runColdReviewStage` never gets here. Not this file's
//                       business, and deliberately not a failure.
//   routed, no engine → REFUSED, naming the engine and what it lacks.
//   routed, engine    → the backend's own `{ok, reason}` answer, untouched.
//
// FALLING BACK IS THE FAILURE MODE, not crashing. A seam that quietly ran
// `claude` when the operator wrote `engine: 'plain'` would produce a review —
// a plausible, well-formatted, entirely real review — from a model they did not
// choose, and nothing on the verdict would say so. That is worse than no review,
// because the operator has no way to find out. This file names exactly one
// engine: the one it was given.
//
// THE REFUSAL IS A RESULT, NOT A THROW, and that is a choice about which
// mechanism carries it. `runColdReviewStage` already has a channel for "the
// transport ran and broke" (`{routed: true, ok: false, reason}`) which `cli.mjs`
// refuses to post on. A missing backend is a transport failure like a non-zero
// exit is, so it rides the same channel rather than adding a second one to keep
// honest. The reason says which engine and what it lacked, because "the run
// refused" without a name is not something an operator can act on.

import { dispatch as defaultDispatch } from './cli.mjs';

/** The op name the harness routes a stage through. */
export const RUN_STAGE_OP = 'run-stage';

/**
 * makeRunStageSeam() — the `deps.runStage` that `runColdReviewStage` requires.
 *
 * `timeoutMs` RIDES THROUGH TOO, and it did not until the first cold review of
 * this slice found it missing (judgment:cold-1, third pass). The seam
 * destructured five names and forwarded exactly those, so the value
 * `runColdReviewStage` resolved from `reviewer.stageTimeoutMs` was dropped here
 * and the backend fell back to its own default — an operator raising the key
 * still died at ten minutes, while the backend's timeout message told them to
 * raise it. A key the run instructs you to set and then ignores.
 *
 * NOTHING PINNED THIS HOP, and that is the lesson rather than the bug.
 * `run-stage.test.mjs` pinned the BACKEND honouring `timeoutMs`;
 * `run-cold-review-stage.test.mjs` pinned the REVIEW LAYER supplying it. Both
 * green, with the seam between them unvaried — every caller-side test injects a
 * `runStage` double and never drives this function. The SITE axis again, one
 * layer further along than F.9's own note placed it.
 *
 * ABSENT MEANS "THE BACKEND'S OWN DEFAULT", exactly like `credentialEnv`: an
 * `undefined` reaching `runStage` leaves its parameter default in force, which
 * is already fail-closed. This seam invents no ceiling of its own.
 *
 * `forgeConfigDir` rides through UNINTERPRETED for the same reason, and with
 * one addition worth stating: the caller that passes it is the caller that RAN
 * THE PROBE against an env carrying it (#775). A seam that defaulted it would
 * shadow a forge CLI nobody measured, and the probe's answer would then describe
 * an environment the child does not get.
 *
 * `credentialEnv` rides through UNINTERPRETED. It names env vars the backend
 * must strip from the producer's environment (judgment:cold-2); this seam does
 * not decide the set and does not default it — the backend's own default is
 * already fail-closed, so a seam that invented one here would be a second
 * declaration of the same policy with nothing comparing the two.
 *
 * @param {{dispatch?: Function}} [deps]
 * @returns {(args: {stage: string, prompt: string, model?: string|null,
 *                   engine: string, cwd?: string, credentialEnv?: string[],
 *                   routed?: object, changeId?: string,
 *                   forgeConfigDir?: string, timeoutMs?: number, output?: object})
 *            => Promise<{ok: boolean, reason?: string}>}
 */
export function makeRunStageSeam({ dispatch = defaultDispatch } = {}) {
  // #836 (S4, cold review round 1): `routed` and `changeId` ride through.
  // This seam's own header records the lesson — it once destructured five
  // names, dropped `timeoutMs` silently, and an operator's setting died here.
  // The same defect, relearned with S4's evidence payload: the backends demand
  // bound evidence, and a seam that swallows it turns every lifecycle dispatch
  // into a guard refusal about a field the caller DID pass.
  return async function runStage({ engine, stage, prompt, model = null, cwd, credentialEnv, forgeConfigDir, timeoutMs, output, routed, changeId } = {}) {
    if (typeof engine !== 'string' || engine.trim() === '') {
      return {
        ok: false,
        reason: 'stage-seam: no engine was named — a stage cannot be routed to nothing.',
      };
    }

    let result;
    try {
      // ONE ENGINE, NAMED ONCE. There is no second call in this function and no
      // list to walk: the only name that can reach `dispatch` is the one the
      // operator wrote. That is what makes "does not fall back" a property of
      // the code's shape rather than a promise in a comment.
      result = await dispatch(engine, RUN_STAGE_OP, [{ stage, prompt, model, cwd, credentialEnv, forgeConfigDir, timeoutMs, output, routed, changeId }]);
    } catch (err) {
      // EVERY throw is a refusal, not just the two `dispatch` spells out
      // (backend not found; backend does not implement the op). Matching on
      // those two messages would make this seam silently permissive the day a
      // third failure mode appears — and a seam whose refusal has holes is a
      // seam that falls back, just less obviously.
      // `err?.message ?? String(err)` rather than `err.message`: the catch is
      // deliberately catch-ALL, so it catches throws that are not Errors. A
      // rejection with `null` made this line throw a TypeError, turning the
      // refusal into the abort it exists to prevent — found by the test that
      // enumerates non-Error throws, not by reading.
      const detail = err?.message ?? String(err);
      return {
        ok: false,
        reason:
          `the engine "${engine}" could not run the "${stage}" stage — ${detail}. ` +
          'Refusing rather than falling back: an engine you named and did not get is not ' +
          'the same state as one you never named, and a review from a model you did not ' +
          'choose would look exactly like a review from one you did.',
      };
    }

    // A backend that answered nothing is not a success. `dispatch` returned the
    // op's value from B.6 onward; before that it discarded it, and this branch
    // is what would have caught that regression had it existed then.
    if (!result || typeof result !== 'object') {
      return {
        ok: false,
        reason: `the engine "${engine}" returned no result for the "${stage}" stage`,
      };
    }

    return result;
  };
}
