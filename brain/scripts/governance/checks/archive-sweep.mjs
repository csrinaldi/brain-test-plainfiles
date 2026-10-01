// archive-sweep.mjs — the archive-sweep content-earned issue-link exemption
// (#557 phase 9 gap-close, design.md D6 amendment). One pure predicate,
// modeled on lane.mjs's classifyLane: the evidence is recomputed from the
// diff itself — an `auto-archive/*` head is NEVER trusted by branch name
// alone (ADR-0034 D1a / #905's discipline, applied to a second lane).
//
// THE GAP THIS CLOSES: sweep.mjs (design D6) renders a PR body ending
// "Part of #557." on a PR opened `--base main` — which issue-link's
// default-branch-conditional policy refuses ("Part of #N alone is only
// accepted on non-default (slice) targets"). PR #1097 failed with exactly
// that message on 2026-09-23. A branch-name-only exemption would be
// spoofable — anyone could push `auto-archive/<anything>` and skip the
// gate — so this predicate is earned by the diff's content, never granted
// by the branch name.
//
// WHAT `archiveChange` (archive-logic.mjs) ACTUALLY WRITES, and what this
// predicate allows:
//   - an exact-content move (`fs.rename`) of an entire change folder from
//     `openspec/changes/<name>/**` into `openspec/changes/archive/<iid>/**`
//     — proved by git's OWN 100%-similarity rename detection (`-M100%`),
//     never by path-shape guessing. A `<100%` match (any content drift
//     during the "rename") is reported by git as a separate delete+add
//     pair, which this predicate does NOT accept as a rename.
//   - a brand-new `openspec/specs/<capability>/spec.md` (`fs.mkdir` +
//     `writeFile`, when the destination did not exist)
//   - an APPEND to an EXISTING `openspec/specs/<capability>/spec.md`
//     (`mergeSpecs` trims trailing whitespace, then appends — this
//     predicate asserts "pure addition" with a ZERO-deletions numstat
//     check, never by path alone)
// Anything else — code, workflows, `brain/**`, `.memory/**`, a deletion
// with no matching rename, a spec MODIFICATION that deletes a line, or a
// diff carrying ONLY spec changes with no archive rename at all — is NOT
// exempt. At least one valid archive rename must be present: a spec-only
// diff proves nothing about an actual sweep having run (see the "spec-only
// edit" test — this is the hole a hand-made `auto-archive/*` branch could
// otherwise walk through).
//
// AN ADDED FILE UNDER `openspec/changes/archive/**` (issue #557 S5, ADR-0035
// residual risk 2 — CLOSED, not narrowed): checked `archiveChange` end to
// end — it writes under `archive/<iid>/**` ONLY via `fs.rename(srcDir,
// destDir)`, a whole-folder move with content untouched, plus
// `fs.mkdir('openspec/changes/archive')` (a directory, not a file write
// inside `<dest>`). Content untouched means git's `-M100%` detector always
// reports every file that lands under `archive/<iid>/**` as an R100 rename,
// never an `A`. `sweep.mjs`'s markdown report goes to
// `$RUNNER_TEMP/sweep-body.md` (outside the repo, used only as the PR
// body) — it is never `git add`-ed. Measured against the real 2026-09-23
// phase-6 backfill (`fdca7970...a3bb5b02`, 612 diff lines): every `A` line
// is `openspec/specs/<capability>/spec.md`; zero `A` lines exist anywhere
// under `archive/**`. So there is NO legitimate case an exemption here
// would protect — not a narrow one, none — and the rule is tightened all
// the way: an `A` (or an `M`, already refused by the `SPEC_FILE_RE`-only
// check below) under `openspec/changes/archive/**` is ALWAYS offending,
// full stop, with no folder-pairing carve-out and no cross-check needed.
//
// An earlier version of this predicate exempted an added file under
// `archive/<dest>/**` when `<dest>` also matched a rename destination
// folder elsewhere in the diff ("pairs with a rename"). That was itself
// gameable: one genuine rename into `archive/9/` plus an unrelated
// `A openspec/changes/archive/9/payload.sh` still returned `exempt: true`,
// because the pairing checked only the FOLDER, never the specific file.
// Closed by removing the carve-out entirely rather than tightening the
// pairing further — the evidence above shows there was never a legitimate
// case to preserve, so the zero-tolerance rule costs nothing.
//
// RESIDUAL RISK (stated per the maintainer's request, not silently
// accepted): this predicate does NOT verify the archived folder's `<iid>`
// destination actually corresponds to the source folder's own issue number
// — only that the rename is byte-identical (git-proven) and the relative
// path below the two-segment prefix matches. A content-identical file
// could in principle be renamed into a DIFFERENT `<iid>` than its source
// folder's own number without this predicate objecting. That is judged
// acceptable here because (a) forging it still requires git-proven
// byte-identical content — not an arbitrary payload — and (b) the
// review-load motivation for a real sweep never spoofs this; a fuller
// cross-check against `sdd-layout.mjs#parseChangeId` is a possible
// follow-up, not required to close this gap.

/** `auto-archive/<date>` exactly, mirroring `governance-postmerge.yml`'s
 * `br="auto-archive/${today}"` where `today="$(date -u +%F)"` (YYYY-MM-DD).
 * Never a prefix match — no trailing suffix, no leading path segment. */
export const SWEEP_BRANCH_RE = /^auto-archive\/\d{4}-\d{2}-\d{2}$/;

const CHANGES_FOLDER_RE = /^openspec\/changes\/(?!archive\/)[^/]+\/(.+)$/;
const ARCHIVE_DEST_RE = /^openspec\/changes\/archive\/[^/]+\/(.+)$/;
const SPEC_FILE_RE = /^openspec\/specs\/[^/]+\/spec\.md$/;

/**
 * Parses one `git diff --numstat` line into `{ added, deleted, path }`,
 * where `added`/`deleted` are `NaN` for a binary file's `-` markers —
 * NEVER coerced to 0, so a binary spec.md fails the pure-addition check
 * closed rather than silently passing it.
 *
 * @param {string} line
 * @returns {{ added: number, deleted: number, path: string }|null} null for
 *   a rename's compressed `{old => new}` numstat line (3 tab fields, but
 *   the trailing field is not a plain path) — those carry no independent
 *   information this predicate needs; renames are read from name-status.
 */
function parseNumstatLine(line) {
  const parts = line.split('\t');
  if (parts.length !== 3) return null;
  const [addedStr, deletedStr, path] = parts;
  return { added: Number(addedStr), deleted: Number(deletedStr), path };
}

/**
 * classifySweepDiff() — the archive-sweep content predicate. Evidence is a
 * `git diff -M100% --name-status BASE...HEAD` line list (`nameStatusLines`)
 * and the matching `-M100% --numstat` line list (`numstatLines`), both
 * pre-split (never raw multi-line strings, matching `classifyLane`'s
 * contract). Absent evidence (an uncomputable diff) or an empty diff are
 * both `exempt: false` — never a silent pass.
 *
 * @param {{ nameStatusLines?: string[]|null, numstatLines?: string[]|null }} input
 * @returns {{ exempt: boolean, reason: string, offending: string[] }}
 */
export function classifySweepDiff({ nameStatusLines, numstatLines } = {}) {
  if (!Array.isArray(nameStatusLines) || !Array.isArray(numstatLines)) {
    return {
      exempt: false,
      reason: 'archive-sweep: diff uncomputable — an unverifiable sweep diff is never exempt',
      offending: [],
    };
  }
  if (nameStatusLines.length === 0) {
    return { exempt: false, reason: 'archive-sweep: empty diff', offending: [] };
  }

  const numstatByPath = new Map();
  for (const line of numstatLines) {
    const parsed = parseNumstatLine(line);
    if (parsed) numstatByPath.set(parsed.path, parsed);
  }

  const offending = [];
  let renameCount = 0;

  // Single pass — no rename/added-file pairing is needed (issue #557 S5):
  // zero added files under archive/** are ever exempt, full stop, so an
  // `A` line's classification no longer depends on what any `R` line says.
  for (const line of nameStatusLines) {
    const parts = line.split('\t');
    const status = parts[0];

    if (status.startsWith('R')) {
      // -M100% only ever emits R100 (an exact-similarity threshold cannot
      // report a lower score) — a defensive check in case that assumption
      // is ever violated by a different invocation.
      const [, oldPath, newPath] = parts;
      const oldMatch = status === 'R100' ? oldPath?.match(CHANGES_FOLDER_RE) : null;
      const newMatch = status === 'R100' ? newPath?.match(ARCHIVE_DEST_RE) : null;
      if (status === 'R100' && oldMatch && newMatch && oldMatch[1] === newMatch[1]) {
        renameCount += 1;
      } else {
        offending.push(`${oldPath ?? '?'} -> ${newPath ?? '?'} (not a recognized archive rename)`);
      }
      continue;
    }

    const path = parts[1];
    if (status === 'A') {
      // A new capability spec file is the ONLY legitimate `A` this predicate
      // allows (issue #557 S5 — see the header comment). No added file under
      // `openspec/changes/archive/**` is ever exempt, regardless of what
      // renames exist elsewhere in the diff: no real `archiveChange` run
      // ever adds one there.
      if (SPEC_FILE_RE.test(path)) continue;
      offending.push(path);
      continue;
    }
    if (status === 'M') {
      if (!SPEC_FILE_RE.test(path)) {
        offending.push(path);
        continue;
      }
      const counts = numstatByPath.get(path);
      if (!counts || !Number.isFinite(counts.deleted) || counts.deleted !== 0) {
        offending.push(`${path} (modification is not a pure addition)`);
      }
      continue;
    }
    // D (non-renamed delete), C (copy), T (typechange), U (unmerged) — never exempt.
    offending.push(path ?? line);
  }

  if (offending.length > 0) {
    return {
      exempt: false,
      reason: `archive-sweep: non-archive change(s) present: ${offending.join(', ')}`,
      offending,
    };
  }
  if (renameCount === 0) {
    return {
      exempt: false,
      reason: 'archive-sweep: no archive rename present — a spec-only change is never exempt',
      offending: [],
    };
  }
  return {
    exempt: true,
    reason: 'archive-sweep: diff is a pure archive move (renames + spec additions only)',
    offending: [],
  };
}
