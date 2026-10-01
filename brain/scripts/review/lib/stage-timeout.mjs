// stage-timeout.mjs — how long a stage engine gets, as a resolved value rather
// than a constant nobody had exercised (#682 slice 3, F.9).
//
// THE DEFECT THIS CLOSES WAS FOUND BY THE FIRST END-TO-END RUN, and it is worth
// recording exactly how. `STAGE_TIMEOUT_MS` was ten minutes, chosen with this
// comment beside it:
//
//   /** The wall clock a stage engine gets. A review reads a diff; it is not a build. */
//
// The reasoning is persuasive and the number was never measured. On the first
// real cold review — PR #765, 7098 added lines across 43 files — the engine was
// killed at the ceiling having written nothing, and the run refused. The
// operator's own probe in the same worktree answered in 4.8 seconds, so the
// engine was healthy and the ten minutes were simply not enough: a reviewer does
// not only read the diff, it opens the files the diff does NOT touch, reads the
// ADRs a finding must cite, and runs the suite when it needs to reproduce.
//
// SO THE FIX IS NOT A BIGGER CONSTANT. Replacing ten minutes with thirty would
// repeat the original defect one notch along — another plausible number with
// another convincing comment and still no measurement behind it. What this
// module does instead is make the value CONFIGURABLE, so a repo whose PRs are
// large can say so, and `runStage` reports the elapsed time on every run, so the
// next person to touch the default has evidence rather than an intuition. That
// is judgment:cold-3's lesson applied before the same mistake is made twice: a
// number the run measures and throws away is not a measurement anyone has.
//
// THE DEFAULT DELIBERATELY DOES NOT MOVE. Raising it for everyone on one
// data point would be the same guess in the other direction, and the failure it
// prevents is loud — a refusal naming the ceiling it hit — while the failure a
// too-generous default causes is silent: a hung engine holding a review for
// however long the number says. Loud and short beats quiet and long until there
// is a distribution to look at.

import { DEFAULT_STAGE_TIMEOUT_MS, formatDuration } from '../../lib/duration.mjs';

/**
 * The value in force before this key existed. NOT a preference — the constant
 * `claude.mjs` shipped, kept here so the default is one number rather than one
 * per backend.
 */
export const TIMEOUT_IN_FORCE_TODAY = DEFAULT_STAGE_TIMEOUT_MS;

/** Below this, no engine can do useful work; a value this small is a mistake. */
export const MIN_STAGE_TIMEOUT_MS = 30_000;

/**
 * resolveStageTimeout() — reads `reviewer.stageTimeoutMs`. PURE; throws on a
 * value an operator wrote and this layer cannot honour.
 *
 * REFUSES RATHER THAN DEFAULTS, for the reason `resolveConvergence` gives about
 * its own key: an operator who wrote the key asked for something, and silently
 * substituting the shipped value runs a review they did not configure — here,
 * one that dies at a ceiling they thought they had raised.
 *
 * @param {object|null} config The full brain.config.json object.
 * @returns {{ timeoutMs: number }}
 */
export function resolveStageTimeout(config) {
  const raw = config?.reviewer?.stageTimeoutMs;

  if (raw === undefined || raw === null) return { timeoutMs: TIMEOUT_IN_FORCE_TODAY };

  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new Error(
      `stage-timeout: reviewer.stageTimeoutMs must be a whole number of milliseconds — got ${JSON.stringify(raw)}. ` +
      'Refusing rather than defaulting: an operator who wrote the key asked for something, and silently ' +
      'substituting the shipped ceiling would run a review they did not configure.'
    );
  }

  if (raw < MIN_STAGE_TIMEOUT_MS) {
    throw new Error(
      `stage-timeout: reviewer.stageTimeoutMs is ${raw}ms, below the ${MIN_STAGE_TIMEOUT_MS}ms floor. ` +
      'An engine cannot read a diff in that, so every run would fail at the ceiling and report a ' +
      'timeout that says nothing about the change under review.'
    );
  }

  return { timeoutMs: raw };
}

// `formatDuration` lives in `lib/duration.mjs` and is re-exported here so the
// review port's callers keep one import. It moved because `claude.mjs` needed it
// too, and a harness backend importing a review module is the layering edge
// judgment:cold-7 named.
export { formatDuration };
