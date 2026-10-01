// adr-presence.mjs — check ADR file + brain/HOME.md are consistently updated.
// If neither is present the PR has no ADR requirement → pass (no false-positive).
// Returns { pass: boolean, reason?: string }.

const ADR_RE = /^brain\/project\/decisions\/adr-\d+-.+\.md$/;
const HOME = 'brain/HOME.md';

/**
 * A NEW ADR must be indexed in brain/HOME.md. A TOUCHED one must not — correcting a
 * line in an ADR from months ago cannot reasonably require re-indexing it, and that
 * is what this check did while it decided on file NAMES alone: its input is
 * `git diff --name-only`, which lists added, modified and deleted paths without
 * distinguishing them (issue #510, found blocking PR #507).
 *
 * `addedFiles` is optional and defaults to "assume every touched ADR is new", which
 * is exactly the pre-#510 behaviour — so a caller that cannot cheaply produce an
 * added-only list keeps working, and the three ENFORCEMENT surfaces (run-check,
 * brain-check, merge-walk) all pass it so they cannot disagree about the same merge.
 *
 * Note the asymmetry, which is deliberate: the "HOME.md without an ADR" branch reads
 * the TOUCHED set, not the added one. A PR that edits an existing ADR and its index
 * entry together is coherent and passed before #510; keying that branch on the added
 * set would have turned this fix into a regression.
 *
 * @param {string[]} changedFiles  Paths from `git diff --name-only`.
 * @param {string[]|null} [addedFiles]  Paths from `git diff --diff-filter=A --name-only`.
 *   Omit (or null) to keep the pre-#510 behaviour.
 * @returns {{ pass: boolean, reason?: string }}
 */
export function adrPresence(changedFiles, addedFiles = null) {
  const files = Array.isArray(changedFiles) ? changedFiles : [];
  const touchedAdrs = files.filter(f => ADR_RE.test(f));
  const addedAdrs = Array.isArray(addedFiles)
    ? addedFiles.filter(f => ADR_RE.test(f))
    : touchedAdrs;
  const hasHome = files.includes(HOME);

  if (touchedAdrs.length === 0 && !hasHome) return { pass: true };
  if (addedAdrs.length > 0 && !hasHome) {
    // Name it. The pre-#510 message said "ADR file added" on evidence that could not
    // establish adding, and sent a reader looking for a file that was never there.
    return {
      pass: false,
      reason: `ADR added without a brain/HOME.md entry: ${addedAdrs.join(', ')}`,
    };
  }
  if (hasHome && touchedAdrs.length === 0) {
    return { pass: false, reason: 'brain/HOME.md changed but no ADR file found — missing decision doc?' };
  }
  return { pass: true };
}
