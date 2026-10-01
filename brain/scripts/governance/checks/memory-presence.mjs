// memory-presence.mjs — check that committed .memory/ contains a session_summary record.
// Returns { pass: boolean, reason?: string }.
//
// This is an existence check decoupled from the merge diff: brain-audit reads the
// working-tree records once (before the merge loop, via `readRecordObservations`) and
// passes the collected observations to this function.  The check is therefore the same
// for every merge in a run — it verifies that the repo has AT LEAST ONE session summary
// captured, EVER.
//
// SCOPE, stated because its name and its position invite a stronger reading (issue #519,
// closed in favour of #862 — see below). This does NOT verify that the change under review
// captured anything. `.memory/` held 205 session summaries while going six days without a
// single new record, and this gate was green on every PR in that window — correctly, by the
// definition above. The PR template's "Memory materialized before closing" is a per-change
// promise; this check is repo-scoped, and the two are not the same statement.
//
// #795 is closed in favour of #862: ADR-0034
// (`brain/project/decisions/adr-0034-memory-travels-on-its-own-lane.md`) is the ruling on what
// this gate can and cannot tell. A record no longer rides the feature branch at all (#890,
// Amendment 3) — the per-change promise is now the lane's to keep, not this file's. Export
// trigger: `brain:memory:ship` (`brain/scripts/memory/cli.mjs` op `ship`, which calls
// `shipLane` in `brain/scripts/memory/lane/ship.mjs`), fired by the SessionEnd hook and the
// day-start sweep (`brain/scripts/memory/session-end-ship.mjs`,
// `brain/scripts/memory/day-start-sweep.mjs`) whenever `memory.lane.enabled` is true (it is,
// in this repo — ADR-0034 Amendment 3), or run by hand otherwise. Backend→file lag: closed
// for capture since #874 — `engram.save()` is record-first (rule 2 of the conformance table
// in `memory-backend-contract.md`), so `.memory/records/` holds the file before the backend
// copy exists. Delivery to `main` is bounded instead by the next lane ship plus a human
// merge, because this repository has `allow_auto_merge` disabled, which ADR-0034 L2 did not
// anticipate. #1024 closed the gap this header used to describe: CI now hands the memory-gate
// job `PR_NUMBER`/`PR_BODY`/`VCS_TOKEN` (`.github/workflows/governance.yml`), so
// `runMemoryGateCheck` (`run-check.mjs`) reaches `memoryRetrieval()` (issue-scoped, unioning the
// PR tree with `origin/<default>`) whenever a PR/MR context is present; this function
// (`memoryPresence`) remains the fallback for the repo-scoped case — no PR context, or a body
// with no detectable issue reference. What was already closed is the silence: `brain:session:start`
// reports the newest record's age, so a memory layer that stops being written says so.
//
// The path in this header used to read `.memory/chunks/*.jsonl.gz`. That directory no
// longer exists — the C4 migration (#247) moved the durable layer to `.memory/records/`
// and the reader followed; only this comment did not.

/**
 * Verify that at least one session_summary observation exists in the committed
 * .memory/chunks/ directory.
 *
 * BRITTLE EXTERNAL DEPENDENCY: the shape of `observations` items is determined by
 * engram's export format (.memory/chunks/*.jsonl.gz).  Each item is expected to have
 * at least `{ id, type, title, content, ... }`.  If engram changes its schema,
 * this check may silently pass or fail unexpectedly.
 *
 * @param {Array<{type: string, [key: string]: unknown}>} observations
 *   Parsed observation objects extracted from committed .memory/chunks/*.jsonl.gz files
 *   by brain-audit before the merge loop.  A non-array is treated as empty (→ fail).
 * @returns {{ pass: boolean, reason?: string }}
 */
export function memoryPresence(observations) {
  const obs = Array.isArray(observations) ? observations : [];
  if (obs.some(o => o?.type === 'session_summary')) return { pass: true };
  return {
    pass: false,
    reason: 'no session_summary observation found in committed .memory/ — capture a session summary (mem_session_summary) before closing',
  };
}
