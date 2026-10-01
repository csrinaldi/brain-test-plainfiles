// lane.mjs — the lane predicate, pure (#905, ADR-0034 L1, design.md A1-A3).
//
// One pure module owns the lane predicate; three IO wrappers (run-check.mjs's
// issue-link case, lane-paths.mjs, brain-audit.mjs's walk) ask it three
// different questions of the SAME decomposition — see design.md A1's table.
// No `fs`, no `child_process` (ADR-0016): every input arrives as an argument.

/**
 * The producer's own grammar (design A3): matches `plan.mjs`'s
 * `REF_GRAMMAR_RE` (`memory/lane/plan.mjs:42`) with `refs/heads/` stripped —
 * NOT ADR-0034 L1's wider `(-\d+)?` draft, which nothing in this repo can
 * produce (a same-day second `collect` appends to the same ref, #887 D2).
 * Accepting a suffix nothing can build would widen the exemption for free.
 */
export const LANE_BRANCH_RE = /^memory\/[a-z0-9][a-z0-9-]*-\d{4}-\d{2}-\d{2}$/;

/** A flat (non-nested) `.memory/records/*.jsonl` path — `[^/]+` refuses `.memory/records/sub/x.jsonl`
 *  and the prefix alone refuses `.memory/index.jsonl`, with no special case for either. */
export const LANE_PATH_RE = /^\.memory\/records\/[^/]+\.jsonl$/;

/**
 * classifyLane() — the decomposition three callers ask three questions of
 * (design A1): `lane` alone cannot serve `lane-paths`, which must discriminate
 * a non-lane branch (pass, nothing to check) from a lane branch carrying code
 * (fail, name the offending paths) — both read `lane: false`. `laneBranch`
 * is the branch-name half alone; `lanePaths` is the path-conjunction half
 * alone (design A8: brain-audit's walk has no branch name post-merge and
 * reads `lanePaths` with `sourceBranch: null`).
 *
 * The evidence is `changedFiles` + `addedFiles` from a three-dot diff
 * (`base...head`), never `git diff --name-status -M` (design A2): every entry
 * of `changedFiles` must match `LANE_PATH_RE` AND appear in `addedFiles` — a
 * modification, a deletion, and a rename each appear in `--name-only` and are
 * absent from `--diff-filter=A`, so the set-inclusion conjunction already
 * refuses all three without parsing a status letter.
 *
 * `changedFiles`/`addedFiles` absent (null/undefined, an uncomputable diff)
 * classify as not-a-lane — NEVER surfaced as `uncomputable: true` here; that
 * field belongs to a caller's exit-code mapping (`resultToExit`), not to this
 * pure predicate. `changedFiles` present but empty is `'empty diff'`: absent
 * evidence is never an exemption.
 *
 * INVARIANT (asserted by lane.test.mjs across every case): `lane === laneBranch && lanePaths`.
 *
 * @param {{ sourceBranch?: string|null, changedFiles?: string[]|null, addedFiles?: string[]|null }} input
 * @returns {{ lane: boolean, laneBranch: boolean, lanePaths: boolean, offending: string[], reason: string }}
 */
export function classifyLane({ sourceBranch, changedFiles, addedFiles } = {}) {
  const laneBranch = typeof sourceBranch === 'string' && LANE_BRANCH_RE.test(sourceBranch);

  let offending = [];
  let lanePaths;
  if (changedFiles == null || addedFiles == null) {
    lanePaths = false;
  } else if (changedFiles.length === 0) {
    lanePaths = false;
  } else {
    const addedSet = new Set(addedFiles);
    offending = changedFiles.filter((path) => !(LANE_PATH_RE.test(path) && addedSet.has(path)));
    lanePaths = offending.length === 0;
  }

  const lane = laneBranch && lanePaths;
  const reason = describeLane({ sourceBranch, laneBranch, changedFiles, addedFiles, offending, lanePaths });

  return { lane, laneBranch, lanePaths, offending, reason };
}

/**
 * Human-readable reason for classifyLane's verdict — never load-bearing for
 * the booleans above, only for a reader/log line. Priority mirrors the
 * conjunction: an absent branch outranks a mismatched grammar, which outranks
 * an uncomputable/empty diff, which outranks a named offending path.
 */
function describeLane({ sourceBranch, laneBranch, changedFiles, addedFiles, offending, lanePaths }) {
  if (sourceBranch == null) {
    return 'lane: source branch is absent — an unverifiable lane is not a lane';
  }
  if (!laneBranch) {
    return `lane: branch "${sourceBranch}" does not match the lane grammar (${LANE_BRANCH_RE.source})`;
  }
  if (changedFiles == null || addedFiles == null) {
    return 'lane: diff uncomputable — an unverifiable lane is not a lane';
  }
  if (changedFiles.length === 0) {
    return 'lane: empty diff';
  }
  if (!lanePaths) {
    return `lane: offending path(s): ${offending.join(', ')}`;
  }
  return 'lane: clean — branch and paths both satisfy the predicate';
}
