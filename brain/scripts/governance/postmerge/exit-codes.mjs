// exit-codes.mjs — the ONE source of the governance exit contract (REQ-D2-6,
// design §5). Every evaluator and the postmerge workflow map to the SAME three
// codes, so "a genuine infra failure is 2, never a false 0/1" is enforced by a
// shared function rather than re-invented per check.
//
//   0  PASS         — the check evaluated and passed.
//   1  VIOLATION    — the check evaluated and found a real violation.
//   2  UNCOMPUTABLE  — the check could NOT evaluate (git/IO/API failure). It is
//                     never silently downgraded to a clean pass or a violation
//                     (the "never a silent verdict" property).

/** The three-code contract. */
export const EXIT = Object.freeze({
  PASS: 0,
  VIOLATION: 1,
  UNCOMPUTABLE: 2,
});

/**
 * Map a check result to its process exit code.
 *
 * `uncomputable` DOMINATES: an infra-failed result is 2 regardless of any
 * pass/false also present — an uncomputable check must never read as clean or
 * as a mere violation. Otherwise `pass:true → 0`, `pass:false → 1`.
 *
 * @param {{ pass?: boolean, uncomputable?: boolean }} result
 * @returns {0|1|2}
 */
export function resultToExit(result) {
  if (result && result.uncomputable === true) return EXIT.UNCOMPUTABLE;
  return result && result.pass === true ? EXIT.PASS : EXIT.VIOLATION;
}
