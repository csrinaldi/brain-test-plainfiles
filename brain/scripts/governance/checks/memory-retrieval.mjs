// memory-retrieval.mjs — T2.1: issue-scoped memory-gate evaluator (REQ-L3-4).
//
// memory-presence.mjs's memoryPresence() is a GLOBAL existence check: it passes
// if ANY session_summary observation exists anywhere in .memory/records/,
// completely decoupled from which issue the current PR/change is about — a
// leftover session_summary about issue #12 satisfies the gate for a PR closing
// issue #999 (ADR-0015's own header comment calls memory-gate "the
// promised-but-unbuilt" gate). This module closes that gap by SCOPING the
// observation set to the issue the current change targets before verifying
// coverage, once the wrapper in run-check.mjs has resolved that issue number.
//
// Returns { pass: boolean, reason?: string }, the same shared contract every
// other pure evaluator in checks/ uses (memoryPresence, issueLink, adrPresence,
// diffSize) — this file stays pure (no fs/gh), same discipline as those.

/**
 * Verify that at least one memory record scoped to `issueNumber` exists, and
 * that a `session_summary` is among them.
 *
 * Three outcomes:
 *   - MISS (fail):    no record at all has `record.issue === issueNumber` —
 *                      the memory cache for this issue is missing entirely.
 *   - PARTIAL (warn):  scoped records exist but none is a `session_summary` —
 *                      non-blocking; `pass: true` with a reason flagging the
 *                      partial coverage (this shared contract has no distinct
 *                      warn exit code — see run-check.mjs's resultToExit()).
 *   - HIT (pass):      a scoped `session_summary` exists — clean pass.
 *
 * `record.issue` is coerced via `Number()` before comparison so a JSONL
 * round-tripped string ("999") still matches a numeric `issueNumber` (999).
 *
 * @param {Array<{type?: string, issue?: number|string, [key: string]: unknown}>} observations
 *   A non-array (including null/undefined) is treated as empty.
 * @param {number} issueNumber
 *   The issue number the current change targets — assumed already resolved by
 *   the caller (this function does not detect it; see run-check.mjs's
 *   runMemoryGateCheck wrapper, which decides whether scoping is even
 *   possible before calling here — same separation of concerns as
 *   adrPresence/diffSize being fed pre-computed inputs).
 * @returns {{ pass: boolean, reason?: string }}
 */
export function memoryRetrieval(observations, issueNumber) {
  const obs = Array.isArray(observations) ? observations : [];
  const scoped = obs.filter(o => Number(o?.issue) === issueNumber);

  if (scoped.length === 0) {
    return {
      pass: false,
      reason: `memory-gate: no memory records scoped to issue #${issueNumber} — capture a session summary (mem_session_summary) referencing this issue before closing`,
    };
  }

  const hasSummary = scoped.some(o => o?.type === 'session_summary');
  if (!hasSummary) {
    return {
      pass: true,
      reason: `memory-gate: WARN — ${scoped.length} memory record(s) scoped to issue #${issueNumber} but none is a session_summary (partial coverage) — consider capturing mem_session_summary before closing`,
    };
  }

  return {
    pass: true,
    reason: `memory-gate: verified session_summary scoped to issue #${issueNumber}`,
  };
}
