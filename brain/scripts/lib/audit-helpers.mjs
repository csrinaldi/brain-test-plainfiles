// audit-helpers.mjs — Pure helpers extracted from brain-audit.mjs for unit testability.
// These functions contain no I/O or side effects and can be imported safely in tests.

/**
 * Parse a PR number from a merge commit subject line.
 *
 * Tries two patterns in order:
 *   1. GitHub auto-generated merge subject: "Merge pull request #N from ..."
 *   2. Trailing parenthetical notation:     "feat: something (#N)"
 *
 * @param {string} subject  Merge commit subject line.
 * @returns {number|null}   PR number, or null if none found.
 */
export function parsePrNumber(subject) {
  if (typeof subject !== 'string') return null;
  // GitHub auto-generated merge subject
  const mpr = subject.match(/Merge pull request #(\d+)/i);
  if (mpr) return Number(mpr[1]);
  // Squash/manual notation: "feat: something (#42)"
  const mparen = subject.match(/\(#(\d+)\)\s*$/);
  if (mparen) return Number(mparen[1]);
  return null;
}

/**
 * Whether the diff-size check should be skipped because the PR carries the
 * size:exception label.
 *
 * @param {string[]} labels  Label names from the PR.
 * @returns {boolean}
 */
export function shouldSkipSize(labels) {
  return Array.isArray(labels) && labels.includes('size:exception');
}

/**
 * Select the body to run the issueLink check against.
 *
 * Merge commit bodies produced by GitHub are typically the auto-generated
 * "Merge pull request #N from branch" string, which never contains
 * Closes/Part of #N.  Those references live in the PR DESCRIPTION.
 *
 * When a PR description is available (fetched via prView), prefer it over the
 * raw commit body.  Fall back to the commit body when the PR description is
 * absent or empty (VCS unavailable, no PR number found, etc.) so the check
 * still runs best-effort.
 *
 * @param {string} prBody      PR description from prView ('' when unavailable).
 * @param {string} commitBody  Raw `git log -1 --format=%B` output.
 * @returns {string}
 */
export function selectIssueLinkBody(prBody, commitBody) {
  return (typeof prBody === 'string' && prBody.trim()) ? prBody : commitBody;
}

/**
 * Extract the observations array from a parsed engram chunk object.
 *
 * BRITTLE EXTERNAL DEPENDENCY: the chunk schema is determined by engram's export
 * format (.memory/chunks/*.jsonl.gz).  Currently the format is a single JSON object
 * { "sessions": ..., "observations": [...] } (NOT line-delimited JSONL despite the
 * file extension).  If engram changes its schema, this function may return [].
 *
 * @param {unknown} parsed  A parsed chunk object (JSON.parse output from a gunzip'd chunk).
 * @returns {Array<{type: string, [key: string]: unknown}>}  Observation objects, or [] on schema drift.
 */
export function chunkObservations(parsed) {
  if (parsed && Array.isArray(parsed.observations)) return parsed.observations;
  return [];
}

/**
 * Whether a commit sha is "after" (i.e. has the baseline as an ancestor).
 *
 * The `isAncestorFn` seam mirrors `git merge-base --is-ancestor <baseline> <sha>`:
 *   - returns true  → baseline IS ancestor of sha → include sha in the audit
 *   - returns false → baseline is NOT ancestor of sha → skip sha as pre-baseline
 *
 * The seam is injectable so the decision logic can be unit-tested without
 * spawning a real git process.
 *
 * @param {string} baseline   Git ref or tag marking the audit start point.
 * @param {string} sha        Merge commit sha being evaluated.
 * @param {(baseline: string, sha: string) => boolean} isAncestorFn
 * @returns {boolean}  true = sha is after baseline → include in audit
 */
export function isAfterBaseline(baseline, sha, isAncestorFn) {
  return isAncestorFn(baseline, sha);
}

/**
 * The AUDITED TIP of a git range — the revision every net-parity skip must
 * anchor its liveness question to (design §2.2, MINOR 1 of the external ruling
 * rev 3 on #297).
 *
 *   'origin/main..HEAD'  → 'HEAD'
 *   'v1.0.0..release-2'  → 'release-2'
 *   'main...release-2'   → 'release-2'   (symmetric difference — still the RHS)
 *   'origin/main..'      → 'HEAD'        (git reads an omitted RHS as HEAD)
 *   'HEAD' / 'v2.0.0'    → itself        (a bare revision IS the tip)
 *
 * WHY THIS IS NOT A CONSTANT. `resolveRange` accepts an arbitrary range from
 * `process.argv[2]`, but the skips used to ask "is this payload net-absent at
 * `'HEAD'`?" regardless. Auditing a NON-HEAD tip then answered a question about
 * a different commit: an offender reverted somewhere PAST the audited tip would
 * be exempted out of a window that never contained the revert. §2.2 recorded
 * "the window ends at the tip" as a precondition and nothing enforced it; this
 * makes it code.
 *
 * The three-dot case is split FIRST on purpose — splitting on `'..'` first
 * would cut `'A...B'` into `['A', '.B']` and hand back a ref with a stray
 * leading dot.
 *
 * @param {string} range  A git range or bare revision.
 * @returns {string}      The revision the audit is anchored at.
 */
export function auditedTip(range) {
  const trimmed = String(range).trim();
  for (const sep of ['...', '..']) {
    const i = trimmed.indexOf(sep);
    if (i !== -1) {
      const rhs = trimmed.slice(i + sep.length).trim();
      return rhs || 'HEAD';
    }
  }
  return trimmed;
}

/**
 * The BASE of an audit range — `auditedTip`'s mirror (issue #518).
 *
 *   'A..B' / 'A...B'  → 'A'
 *   'HEAD' / 'v2.0.0' → null   (a bare revision names no base)
 *   '..B'             → null   (an empty left side is not a base)
 *
 * Exists for ONE caller: the remediation line `brain-audit` prints next to a
 * surviving `adrPresence` failure. That line used to read
 *
 *   cursor.mjs accept <offending-sha> --reason "…"
 *
 * which was wrong three times over, and the third is the one worth naming.
 *
 *   1. It omitted `<to>`. The CLI's contract is `accept <from> <to> --reason`.
 *   2. It did not even fail on arity: `rest = [sha, '--reason', '<why…>']` makes
 *      `to === '--reason'`, all three bindings truthy, `usage()` never fires —
 *      and `acceptManually` prints `accept: <reason>` to stdout BEFORE
 *      `advanceCursor` rejects the non-hex `to`. A success-shaped line, then a
 *      failure.
 *   3. It named the OFFENDING merge in the `from` position. `from` is the
 *      human's assertion of the CURSOR value they reviewed — that is what gives
 *      the CAS its function — and the verb advances a WINDOW, not a merge. There
 *      is no per-merge accept. So the old line also misdescribed what accepting
 *      does, which is the part a correct-looking fix would have preserved.
 *
 * `null` rather than a guess when there is no base: the caller then prints an
 * explicitly placeholder-shaped command instead of a runnable-looking wrong one.
 * Fabricating `HEAD~1` here would put a plausible sha in a CAS lease.
 *
 * Three-dot split first, same reason as `auditedTip`: `'A...B'` cut on `'..'`
 * yields a base with a stray trailing dot.
 *
 * @param {string} range  A git range or bare revision.
 * @returns {string|null} The revision the audit window starts at, or null.
 */
export function auditedBase(range) {
  const trimmed = String(range).trim();
  for (const sep of ['...', '..']) {
    const i = trimmed.indexOf(sep);
    if (i !== -1) {
      const lhs = trimmed.slice(0, i).trim();
      return lhs || null;
    }
  }
  return null;
}
