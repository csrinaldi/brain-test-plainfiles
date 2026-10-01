// postmerge/resolution.mjs — revert-resolution proved by WHOLE-COMMIT
// FIRST-PARENT DIFF-INVERSION, never by a message (design §3, revised after
// judgment-round-1's rename bypass, engram #916, against the prior
// path-scoped `P ∩ D = ∅` predicate; the AGGREGATION was later re-anchored
// to the NET tree state at HEAD after judgment-day Round 3, design §15). An
// offender O is resolved at tip iff its own first-parent contribution is
// NET-ABSENT from the tree at `tip` under exact-`normDiff` accounting:
//   netPresent(O, tip) = 1 + Σ_{W ∈ (O, tip]} sign(normDiff(W^1,W), dO)  ≤ 0
// where dO = normDiff(O^1, O), and each first-parent merge W strictly after
// O counts +1 when it RE-INTRODUCES O's contribution (fW == dO), −1 when it
// INVERTS it (fW == dOinv, the byte-exact backward diff O to O^1), and 0
// otherwise. This SUPERSEDES the earlier `∃ R` existence test: a single
// inverse commit no longer settles O — a revert that is itself later
// reverted (a revert-of-a-revert re-adding the payload) is net-present and
// stays flagged (design §15.3, REQ-D2-16; fixtures A5/A7). It is NOT a claim
// that "the payload is not on disk" — that phrasing described the collapsed,
// rename-forgeable predicate this module replaces. A rename or copy can make
// a payload absent from its original PATH while the content survives
// elsewhere (its contribution matches neither sign → counts 0 → O stays
// flagged); this predicate never inspects paths in isolation, it compares
// whole, byte-exact, normalized diff text. A commit trailer,
// ancestry, an author, a signature, or a branch name are NEVER consulted —
// they are free text or forgeable, and the tree is not. The only other
// resolution path is the recorded human gate (cursor.mjs accept), which
// lives outside this module by design (§2.4, §3.5).
//
// This module is PURE-READ — it never writes to `.git` or the work tree.
// An earlier revision wrote `* diff` into `<GIT_DIR>/info/attributes`
// before every diff (`hardenDiffRendering`, judgment-round-1). Rejected
// (both judges forged, judgment-round-1, engram #916): (1) INERT in a linked worktree —
// it wrote to `git rev-parse --absolute-git-dir` (the per-worktree gitdir),
// but git reads `info/attributes` from `--git-common-dir`; brain mandates
// worktree-per-task, so the write never reached the path git actually
// consults. (2) DESTRUCTIVE — an unconditional overwrite clobbers a
// human's pre-existing `.git/info/attributes` (e.g. git-crypt filters),
// never restored. (3) REDUNDANT — `--binary` alone already defeats the F-4
// attack (an attacker-planted `.gitattributes *.md -diff` at tip); a
// binary-attributed file still renders as a content-bearing base85 patch,
// so two distinct payloads never collapse to the same text. A read
// predicate that mutates the environment to measure has already lost.
//
// SECURITY SURFACE — `git diff`'s rendering is attacker-influenced by
// config and by in-repo `.gitattributes` read from whatever is checked out
// at the time of the call. Every diff is pinned:
// `-c diff.algorithm=myers -c diff.renames=false -c
// core.attributesFile=/dev/null` plus `--no-textconv --no-ext-diff
// --no-renames --binary -U3`. The CONTENT/TREE defense — behaviorally
// tested, reddens on drop (resolution.test.mjs's mutation-bar):
//
//   - `--binary` forces literal content for binary-attributed or
//     binary-content files instead of the content-blind
//     "Binary files ... differ" stub, which is IDENTICAL text for any two
//     different binary payloads at the same path. This is the load-bearing
//     defense against attacker-controlled rendering (F-4) now that the
//     predicate is pure-read.
//   - The rename PAIR `--no-renames` + `-c diff.renames=false` forces a
//     byte-exact delete+add rendering instead of similarity-based "rename
//     from/to" headers, which OMIT content entirely at 100% similarity — a
//     rename can relocate TAMPERED content and still render as zero bytes,
//     byte-identical to any other 100%-similar rename. Behaviorally tested,
//     but ONLY the pair reddens: git's default is `diff.renames=true`, so
//     the flag alone (config still off) and the config alone (flag still
//     set) each leave renames disabled — dropping BOTH is what reddens.
//   - `--no-ext-diff` refuses a `diff.external` helper. This one IS
//     behaviorally load-bearing and reddens on drop (HOSTILE-ENV safety
//     test): a GLOBAL `diff.external` applies to every path regardless of
//     attributes and OVERRIDES `--binary`'s rendering entirely, collapsing
//     distinct contents to the helper's output — so `--binary` does NOT
//     cover it and `--no-ext-diff` is the sole defense against it.
//
// The remaining three pins — `-c diff.algorithm=myers`,
// `-c core.attributesFile=/dev/null`, `--no-textconv` — are defense in
// depth / determinism, NOT behaviorally tested. They do NOT defend against
// attacker CONTENT (`--binary` does that); they guarantee the verdict does
// not depend on the ambient git config of the machine the predicate runs on
// (the "green that depends on the environment" failure class). Forged under
// an adversarial `GIT_CONFIG_GLOBAL` (hostile textconv, global
// attributesFile, `diff.algorithm=histogram` — forge_forkb2/forge_forkb3):
// given `--binary`, dropping any one of these THREE does not flip a verdict
// (`--binary` bypasses the textconv driver; the algorithm is run-consistent)
// — kept because they are cheap and load-bearing only if `--binary` is ever
// weakened. NEVER claim these three "redden on drop"; the HOSTILE-ENV
// ROBUSTNESS test asserts the honest positive instead (the verdict is
// correct *under* a hostile ambient config). `--no-ext-diff` is the
// exception among the pinned flags — it DOES redden (see above).

import { gitTry, gitOrThrow } from './git-seam.mjs';

/** Build the injectable git seam bound to `cwd` (parity with cursor.mjs). */
export function makeGit(cwd = process.cwd()) {
  return { try: (argv) => gitTry(argv, { cwd }), orThrow: (argv) => gitOrThrow(argv, { cwd }) };
}

// Config pins. `diff.algorithm=myers` and `core.attributesFile=/dev/null`
// are defense in depth / determinism, NOT behaviorally reddenable given
// `--binary` (see module header; forge_forkb2/forge_forkb3). `diff.renames=
// false` is the CONFIG half of the rename PAIR (the flag half is
// `--no-renames` below); git's default is `renames=true`, so only dropping
// BOTH reddens — neither alone does. None of these stops attacker CONTENT —
// `--binary` (and, against a global `diff.external`, `--no-ext-diff`) does.
const HARDENED_CONFIG = [
  '-c', 'diff.algorithm=myers',
  '-c', 'diff.renames=false',
  '-c', 'core.attributesFile=/dev/null',
];

// `--no-textconv`: refuse a textconv driver — defense in depth /
// determinism, NOT behaviorally reddenable given `--binary` (which bypasses
// textconv). `--no-ext-diff`: refuse a `diff.external` helper — this one
// IS behaviorally load-bearing and reddens on drop: a global `diff.external`
// applies to every path and OVERRIDES `--binary`'s rendering, so `--binary`
// does not cover it (HOSTILE-ENV safety test). `--no-renames`: byte-exact
// delete+add, never a content-eliding rename header — behaviorally tested
// but reddens ONLY as the pair with `diff.renames=false` (see
// HARDENED_CONFIG). `--binary`: literal content instead of a content-blind
// "Binary files ... differ" stub — the load-bearing content/tree defense
// now that this module is pure-read; behaviorally tested, reddens on drop.
// `-U3`: a deliberate, documented
// context window — position-tolerant enough that an unrelated intervening
// edit elsewhere in the file does not pin a legitimate revert (see
// resolution.test.mjs's drift/blast-radius fixtures), narrow enough that
// it is never relied upon to hide content (every differing region still
// renders its own hunk; nothing outside a hunk's own change is omitted
// from the file's overall diff).
const DIFF_ARGS = ['diff', '--no-textconv', '--no-ext-diff', '--no-renames', '--binary', '-U3'];

/**
 * The normalized diff between two revs: pinned config + pinned flags (see
 * module header), with the position-only `@@ ...@@` hunk-header lines and
 * the blob-id `index ...` lines dropped — everything else (paths, modes,
 * +/- content including whitespace, binary literal blocks) is kept
 * BYTE-EXACT. Position tolerance lets a legitimate revert match despite an
 * unrelated intervening edit shifting line numbers elsewhere in the file;
 * byte-exactness is what makes the match a genuine content proof, not an
 * approximation. `git diff` exits 0 whether or not the revs differ; a
 * non-zero status is a real error (e.g. a bad rev), so `orThrow` fails
 * closed rather than returning a vacuous empty string. PURE-READ — never
 * mutates `.git` or the work tree (see module header).
 */
function normDiff(git, a, b) {
  const raw = git.orThrow([...HARDENED_CONFIG, ...DIFF_ARGS, a, b]);
  return raw
    .split('\n')
    .filter((line) => !/^@@ /.test(line) && !/^index /.test(line))
    .join('\n');
}

/**
 * The commits on the audited first-parent line strictly after `offender`, up to
 * and including `tip` — exactly the set brain-audit tracks:
 * `git rev-list --first-parent <offender>..<tip>`. Enumeration order does not
 * matter; every candidate is checked.
 *
 * J-2 IS CLOSED (issue #518). This carried `--merges`, so a revert landing as a
 * squash, a rebase-merge, or a direct non-merge push was NEVER enumerated here,
 * whatever it reverted — `isResolvedAt` fell through to `{ resolved: false }` and
 * routed a genuine revert to the human gate. That was fail-CLOSED and therefore
 * survivable, which is why it was documented rather than fixed.
 *
 * Two things changed. First, its premise expired: the docstring reassured that
 * brain merges with `--merge` so "the gap is real but currently unexercised
 * here", measured at 105 first-parent merges and 0 non-merge reverts. Re-measured
 * over the 60 days to 2026-08-10: **31 single-parent commits on the first-parent
 * line**. Both directions are live now.
 *
 * Second — and this is why it could not stay documented — the OFFENDER side
 * widened in the same change. Two enumerators that disagree about what a window
 * contains is worse than either narrow one: an offender enumerated by
 * `listAuditedCommits` whose genuine revert is invisible here would be reported
 * and never clear. They move together or not at all.
 *
 * Note for anyone following the old pointer: J-2's reassurance that "no forgery
 * slips through" described THIS function's direction. It never applied to the
 * offender-side walk, where the same filter was fail-OPEN.
 */
function firstParentMergesAfter(git, offender, tip) {
  const out = git.orThrow(['rev-list', '--first-parent', `${offender}..${tip}`]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * `sign` of a candidate merge against a target payload signature — the
 * per-candidate term of the net-parity aggregation (design §15.3). Given the
 * candidate's own first-parent contribution `fW = normDiff(W^1, W)`, a target
 * signature `s`, and that target's EXACT reverse patch `sInv`:
 *   +1  if fW === s      (W RE-INTRODUCES the payload)
 *   −1  if fW === sInv   (W INVERTS the payload)
 *    0  otherwise         (unrelated — e.g. a rename, whose delete+add text
 *                          matches neither → the payload stays counted)
 * `sInv` is a DISTINCT git computation (a `normDiff` read backward), never a
 * textual reversal of `s`, so it is passed precomputed. For any non-empty
 * `s`, `s !== sInv` (a forward add and its reverse differ in +/- polarity),
 * so the two branches never both fire.
 *
 * CONTRACT (F-1, sound on the EXPORTED surface) — an empty target signature
 * `s === ''` is VACUOUS and is refused fail-closed by THROWING, right here,
 * before either branch is consulted. An empty `s` would otherwise make an
 * empty `fW` match `fW === s` and return a spurious +1, misclassifying a
 * content-free candidate as a re-add. The refusal lives on the primitive
 * itself (not only in the callers) so `sign` is sound when called directly:
 * its internal callers (`netPresent`, `netAddFull`) already reject their own
 * empty payload signature first, so this throw is unreachable via them and
 * exists solely to keep the export honest for future direct callers.
 */
export function sign(fW, s, sInv) {
  if (s === '') {
    throw new Error('sign: empty target signature (F-1 vacuity) — refused fail-closed');
  }
  if (fW === s) return 1;
  if (fW === sInv) return -1;
  return 0;
}

/**
 * `netPresent(O, tip)` — the DIRECTIONAL net-parity of O's first-parent
 * payload signature at `tip` (design §15.3, REQ-D2-16):
 *
 *   netPresent(O, tip) = 1 + Σ_{W ∈ (O, tip]} sign(normDiff(W^1,W), dO, dOinv)
 *
 * O's own contribution is the `+1` base term; every first-parent merge
 * STRICTLY AFTER O (the half-open `(O, tip]` range — O's own boundary is
 * EXCLUDED, so the HEAD-most merge is never wholesale cancelled as its own
 * canceller) adds its `sign`. `≤ 0` ⟺ the payload signature is net-ABSENT at
 * the tip. The DIRECTIONAL range is deliberate and asymmetric with
 * `netAddFull`'s full-window range (design §15.3's "why the ranges differ"
 * note): a live re-add sitting at HEAD must always reach the checks, so it
 * can never be resolved away by counting only merges that precede it.
 *
 * CONTRACT (F-1, sound on the EXPORTED surface) — an offender whose own
 * first-parent contribution is EMPTY (`dO === ''`, e.g. an empty-effect
 * `-s ours` merge) is VACUOUS and is refused fail-closed by THROWING, before
 * any counting. An unguarded count would seed `+1` and then let empty-diff
 * merges in range match `fW === dO` (`'' === ''`), reporting a spurious
 * net-present total for a payload that has no signature at all. `isResolvedAt`
 * guards this same case UPSTREAM (its F-1 first branch, which still fires
 * first on the production path), but `netPresent` is EXPORTED: its soundness
 * must NOT depend on how a caller reaches it, so the guard is duplicated here,
 * on the primitive itself, for future direct callers (PR3 is the first new
 * one). This mirrors `isResolvedAt`'s fail-closed F-1 (never a vacuous
 * net-absent verdict) rather than weakening it.
 *
 * PURE-READ — every term is a `normDiff`, which never mutates `.git` or the
 * work tree. Anchored at `tip` (always HEAD by §2.2).
 */
export function netPresent(offender, tip, { git }) {
  const dO = normDiff(git, `${offender}^1`, offender);
  if (dO === '') {
    throw new Error('netPresent: offender has no first-parent contribution (F-1 vacuity) — refused fail-closed');
  }
  const dOinv = normDiff(git, offender, `${offender}^1`);
  let net = 1;
  for (const w of firstParentMergesAfter(git, offender, tip)) {
    net += sign(normDiff(git, `${w}^1`, w), dO, dOinv);
  }
  return net;
}

/**
 * Is `offender` resolved at `tip`?  (design §15.3, REQ-D2-16 — net-parity)
 *   dO = normDiff(offender^1, offender)     — offender's own first-parent
 *                                              contribution (payload signature)
 *   if dO === ''  →  { resolved: false,
 *                       reason: 'offender has no first-parent contribution' }
 *                     ◄── EXPLICIT anti-vacuity guard (F-1): its return object
 *                         and reason string are preserved and it remains the
 *                         FIRST branch; only the condition variable was renamed
 *                         (`pO` → `dO`). git emits nothing for an empty diff, so
 *                         an unguarded net count would resolve garbage —
 *                         refused, loudly, first, never a vacuous pass.
 *   resolved  ⟺  netPresent(offender, tip) ≤ 0
 *                     ◄── O's contribution is NET-ABSENT at the tip under
 *                         exact-normDiff accounting. A single later inverse no
 *                         longer suffices: a revert-of-a-revert that re-adds
 *                         the payload leaves it net-present → still flagged
 *                         (the §15 CRITICAL; fixtures A5/A7).
 */
export function isResolvedAt(offender, tip, { git }) {
  const dO = normDiff(git, `${offender}^1`, offender);
  if (dO === '') return { resolved: false, reason: 'offender has no first-parent contribution' };
  return netPresent(offender, tip, { git }) <= 0 ? { resolved: true } : { resolved: false };
}

/**
 * The audited first-parent commits in the CLOSED window `[from, to]` — inclusive
 * of BOTH endpoints, unlike `firstParentMergesAfter`'s half-open `(from, to]`.
 * Enumerated as `${from}^1..${to}` so the commit AT `from` is itself counted.
 *
 * `--merges` dropped in the same pass as its sibling above (issue #518): the
 * reverter-exemption's signed count and the audited set must range over the same
 * commits, or a candidate can be exempted by a window it was never measured in.
 * This is the range the FULL-WINDOW reverter-skip primitive needs: its signed
 * count must see the offender sitting at the window base BEHIND a cleanup
 * revert that lands at the tip. PURE-READ.
 */
function firstParentMergesInclusive(git, from, to) {
  const out = git.orThrow(['rev-list', '--first-parent', `${from}^1..${to}`]);
  return out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/**
 * `netAddFull(C)` — the FULL-WINDOW net-parity of candidate C's OWN
 * first-parent payload signature over the CLOSED window `[from, to]`
 * (design §15.3, the reverter-skip primitive). This is GROUNDWORK for PR3's
 * `reverterExempt`; it is deliberately NOT wired into `brain-audit.mjs` here
 * (that rebase is PR3, design §15.9). The whole-window invariant lives HERE,
 * in `resolution.mjs`, rather than being re-derived by the caller:
 *
 *   dC = normDiff(C^1, C)
 *   netAddFull(C) = |{ W ∈ [from,to] : normDiff(W^1,W) == dC }|
 *                 − |{ W ∈ [from,to] : normDiff(W^1,W) == dCinv }|
 *
 * Unlike `netPresent` there is NO `+1` base term and the range is FULL-WINDOW
 * (inclusive of `from`), because a legitimate cleanup revert `C` sitting at
 * the tip — with nothing after it to cancel it — must still see the offender
 * it inverted BEHIND it in the window to earn its tree-keyed exemption. A
 * DIRECTIONAL-only count over `(C, tip]` (empty for a tip-most C) would wrongly
 * fail to exempt the legit reverter (design §15.3's range-asymmetry note).
 * `≤ 0` ⟺ C's own contribution is net-absent across the window.
 *
 * CONTRACT (F-1, sound on the EXPORTED surface) — a candidate whose own
 * first-parent contribution is EMPTY (`dC === ''`) is VACUOUS and is refused
 * fail-closed by THROWING, before any counting: an unguarded count would let
 * empty-diff merges in the window match `fW === dC` (`'' === ''`) and could
 * report a `≤ 0` total, spuriously exempting a content-free candidate. PR3's
 * `reverterExempt` composition ALSO short-circuits on `dC ≠ ''` (design §15.3:
 * exempt ⟺ `dC ≠ '' AND netAddFull(C) ≤ 0`, together with the
 * `TREE_KEYED_CHECKS` restriction), but that upstream guard protects only that
 * one caller. `netAddFull` is EXPORTED, so its soundness must NOT depend on
 * how a caller reaches it — the vacuity refusal lives on the primitive itself,
 * consistent with `netPresent`/`isResolvedAt`'s fail-closed F-1. Given a
 * non-empty `dC`, this primitive computes the signed count.
 */
export function netAddFull(candidate, { git, from, to }) {
  const dC = normDiff(git, `${candidate}^1`, candidate);
  if (dC === '') {
    throw new Error('netAddFull: candidate has no first-parent contribution (F-1 vacuity) — refused fail-closed');
  }
  const dCinv = normDiff(git, candidate, `${candidate}^1`);
  let net = 0;
  for (const w of firstParentMergesInclusive(git, from, to)) {
    net += sign(normDiff(git, `${w}^1`, w), dC, dCinv);
  }
  return net;
}

// The added-paths query. Reuses `HARDENED_CONFIG`'s rename PAIR — the CONFIG
// half `diff.renames=false` plus the FLAG half `--no-renames` below — because
// rename detection is the whole attack surface here: at 100% similarity git
// renders a relocation as `R`, never as `A`, so a rename-laundered payload
// would present an EMPTY added-set and be vacuously "absent" while sitting live
// on the tree under a new name. As in `normDiff`, only dropping BOTH reddens
// (git's default is `diff.renames=true`). `diff.relative=false` pins the paths
// to the repo root regardless of the cwd the seam was bound to, so a caller
// running from a subdirectory cannot silently shrink the pathspec. `--binary`
// and `-U3` are deliberately ABSENT: this query reads NAMES, never content, so
// there is no rendering to harden — the content defense stays in `normDiff`,
// where the comparison that needs it lives.
const ADDED_PATHS_ARGS = [
  '-c', 'diff.relative=false',
  'diff', '--no-textconv', '--no-ext-diff', '--no-renames',
  '--diff-filter=AM', '--name-only', '-z',
];

/**
 * `addedPathsAbsentAt(C, tip)` — are ALL of candidate C's OWN TOUCHED-BY-WRITE
 * paths ABSENT from the tree at `tip`? (external ruling rev 4 introduced this as
 * the `(c′)` liveness guard over ADDED paths; ruling rev 11 widened it to ADDED
 * ∪ MODIFIED to close A10 — issue #297.)
 *
 *   touched(C) = { p : p is ADDED or MODIFIED by the normDiff-pinned
 *                      first-parent diff C^1..C }
 *   addedPathsAbsentAt(C, tip)  ⟺  ∀ p ∈ touched(C) : p ∉ tree(tip)
 *
 * NAME: the export is still `addedPathsAbsentAt` because renaming it is a
 * public-surface change beyond the one-character shape rev 11 ruled. The name is
 * now narrower than the behavior; flagged in PR3c for the owner rather than
 * widened unilaterally.
 *
 * WHY A TREE READ AND NOT ANOTHER SIGNED COUNT. `netAddFull` answers "did C's
 * contribution cancel out INSIDE the window [from,to]?" — never "is C's payload
 * live right now?". When the payload's ORIGINAL introduction sits BEHIND the
 * window base, the window contains only a delete and a re-add, nets to 0, and a
 * live-at-tip offender earns the exemption: the A8 fail-open. This predicate
 * asks the tip itself, so it is blind to the window entirely.
 *
 * WHY NOT `isResolvedAt` (the rejected rev-3 binding, recorded so it is not
 * re-proposed): `isResolvedAt` counts the DIRECTIONAL half-open `(C, tip]`,
 * which is EMPTY for any tip-most merge → `resolved:false` categorically → it
 * denies the exemption to EVERY legitimate tip-most cleanup revert, the exact
 * case the reverter-skip exists to serve (frozen A2/A6). Right property, wrong
 * mechanism; see openspec/changes/issue-259-d2/brain-drafts/ruling-bound-to-an-unrun-mechanism.md.
 *
 * THE EMPTY ADDED-SET IS `true` BY RULING, NOT BY ACCIDENT. A candidate that
 * only DELETES — the cleanup-revert shape — adds no path, so the ∀ is vacuously
 * satisfied and the exemption stays available; `netAddFull` keeps deciding
 * whether it is actually earned. The early return is also LOAD-BEARING: `ls-tree
 * ... --` with zero pathspecs lists the WHOLE tree, which would score every pure
 * delete as "present" and break A2/A6 (mutation bar, resolution.test.mjs).
 *
 * FAILURE DIRECTION IS CLOSED. This predicate can only WITHHOLD an exemption,
 * never manufacture one: a wrong `false` yields an EXTRA `[FAIL]`, never a
 * missed offender. Both git calls are `orThrow`, so an uncomputable tree is a
 * throw that surfaces at the CLI's fail-closed catch (exit 2) — never a silent
 * exemption.
 *
 * WHY `AM` AND NOT `A` (A10, ruling rev 11 — the KNOWN EDGE this comment used to
 * record as OPEN, now CLOSED). Scoped to ADDED paths only, a MODIFICATION-shaped
 * payload — offending content injected into a pre-existing file, so the path is
 * never `A` — presented an EMPTY set and passed VACUOUSLY, while the content sat
 * live at the tip. The finder froze it as A10 and it reproduced. Widening to
 * `AM` closes it: a modified path is present at the tip, so the exemption is
 * denied. Measured, not argued — the frozen set is 1822/1822 with A10 green.
 *
 * MEASURED COST, and the guard it is bound to. Widening ALSO denies the
 * exemption to a LEGITIMATE modify-shaped tip-most cleanup reverter, which then
 * emits `[FAIL-SHA]` — the auto-revert signal — on a merge whose whole
 * contribution was removal. PR4 acting on that would revert the cleanup and
 * RESURRECT the payload (the harm §15.5 names). Rev 11 ruled STAGED C: this fix
 * lands now because A10 is a LIVE fail-open, and the suppression of that
 * `[FAIL-SHA]` is a HARD PRECONDITION OF PR4 — PR4 does not consume `[FAIL-SHA]`
 * until the modify-shaped-denial suppression and its frozen fixture land.
 *
 * STILL UNCOVERED, recorded not hidden: `--diff-filter=AM` does not select `T`
 * (typechange, e.g. a file replaced by a symlink). No fixture exercises it and
 * no machinery is built for it — evidence-first, as with A10 before the finder
 * proved it.
 *
 * PURE-READ — a diff and a tree listing; never mutates `.git` or the work tree.
 */
export function addedPathsAbsentAt(candidate, tip, { git }) {
  const raw = git.orThrow([
    ...HARDENED_CONFIG, ...ADDED_PATHS_ARGS, `${candidate}^1`, candidate,
  ]);
  const added = raw.split('\0').filter(Boolean);
  if (added.length === 0) return true; // pure deletes — vacuously absent (see above)
  // `--full-tree` makes both the listing and the pathspecs root-relative
  // regardless of cwd; `-z` keeps unusual path bytes intact. Non-empty output
  // means at least one added path still exists at the tip.
  const present = git.orThrow([
    'ls-tree', '-r', '-z', '--name-only', '--full-tree', tip, '--', ...added,
  ]);
  return present.split('\0').filter(Boolean).length === 0;
}

/**
 * `revertResurrectsAt(C, tip)` — would reverting candidate C RE-ADD content that
 * is ABSENT from the tree at `tip`? (PR4 precondition; external ruling rev 1 on
 * #302 — Option C, payload-anchored liveness, operationalised against the
 * PROPERTY fixtures A11/A12 froze.)
 *
 *   revertResurrectsAt(C, tip)
 *     = ∃ path p, ∃ line L : L is REMOVED by the normDiff-pinned first-parent
 *       diff C^1..C on p, AND L is ABSENT from the blob at tip:p
 *
 * WHY THIS IS THE DISCRIMINATOR. `[FAIL-SHA]` nominates C for AUTOMATIC reversion
 * (PR4). Reverting C applies its inverse — it RE-ADDS whatever C removed. If any
 * line C removed is absent from the tip, reverting C resurrects it. When that
 * resurrected content is the ungoverned payload a prior merge cleaned up, the
 * nomination is the §15.5 harm: PR4 would revert the cleanup and put the payload
 * back. So a merge that resurrects on revert is REPORTED (never a silent PASS)
 * but never nominated. A merge that only ADDS (no removed lines) resurrects
 * nothing → nominable; reverting it purely removes what it added.
 *
 * WHY IT READS THE TIP, NOT THE WINDOW. A windowed net count cannot see the base
 * state (the A8/A10 blindness), and it cannot tell a pure-removal cleanup (A11,
 * nets 0) from a live re-add (A10, also nets 0). And it cannot tell either from a
 * REPLACE-shaped cleanup (A12), whose merge ADDS a live line while its NET effect
 * is removal — the shape that refuted the line-membership primitive `[candidate
 * 1]`. The removed-line-absent-at-tip test keys on what reverting would
 * RESURRECT, which is exactly the harm, and reads the tip tree directly.
 *
 * IDENTIFICATION NOTE (ruling rev 1 §mechanism-boundary). The ruling names the
 * offending payload for `adrPresence` (the ungoverned ADR content). Rather than
 * re-identify "the offending content" per check — which is genuinely ambiguous
 * for a REPLACE (is it the removed offender, or the added placeholder?) and for
 * `diffSize` (churn has no content identity) — this predicate binds to the
 * frozen PROPERTY instead: "a merge whose net effect removes the offending
 * payload must never carry [FAIL-SHA]" (A12). Reverting-resurrects is that
 * property made operational and check-agnostic. Where a future check needs a
 * finer identity than "any removed line", that is the escalation the ruling
 * reserves — not improvised here.
 *
 * EXACT-LINE, byte-compared against the tip blob via the SAME pinned diff
 * `normDiff` uses (no rename laundering, root-relative), so two distinct payloads
 * never collapse. A path C deleted entirely is absent at tip ⇒ every line it
 * removed resurrects ⇒ not nominable. PURE-READ.
 */
export function revertResurrectsAt(candidate, tip, { git }) {
  const raw = git.orThrow([
    ...HARDENED_CONFIG, '-c', 'diff.relative=false',
    'diff', '--no-textconv', '--no-ext-diff', '--no-renames',
    '--diff-filter=AMD', '-U0', `${candidate}^1`, candidate,
  ]);
  // Collect (path -> removed line bodies) from the diff.
  const removedByPath = new Map();
  let cur = null;
  for (const line of raw.split('\n')) {
    const m = /^--- a\/(.*)$/.exec(line);
    if (m) { cur = m[1]; if (!removedByPath.has(cur)) removedByPath.set(cur, []); continue; }
    const mp = /^\+\+\+ b\/(.*)$/.exec(line);
    if (mp) { cur = mp[1]; if (!removedByPath.has(cur)) removedByPath.set(cur, []); continue; }
    if (cur && line.startsWith('-') && !line.startsWith('---')) {
      removedByPath.get(cur).push(line.slice(1));
    }
  }
  for (const [path, removed] of removedByPath) {
    if (removed.length === 0) continue;
    let blobLines;
    try {
      blobLines = new Set(git.orThrow(['show', `${tip}:${path}`]).split('\n'));
    } catch { /* swallow-ok: an unreadable blob reads as "every removed line resurrects" — the fail-closed direction */
      return true; // path absent at tip → every removed line resurrects
    }
    if (removed.some((L) => !blobLines.has(L))) return true;
  }
  return false;
}

/**
 * Is `candidate` the reverter of `offender`? (design §3.3) — the PAIRWISE
 * diff-inversion primitive: `candidate`'s own contribution, read backward, is
 * byte-identical to what the offender introduced.
 *
 * ⚠ SUPERSEDED by `netAddFull` (design §15.3, judgment-day Round 3). The
 * pairwise "∃ one inverse" crowning is defeated by a revert-of-a-revert
 * (`R2 = git revert R`), which this wrongly crowns as "revert of R" while
 * re-introducing the payload at HEAD. The full-window `netAddFull(C) ≤ 0` is
 * the net-anchored replacement, and `netAddFull` supersedes this export as the
 * reverter predicate. This export is RETAINED (not deleted) only because its
 * own export surface and its pre-existing dedicated test in
 * `resolution.test.mjs` are frozen for this PR. PR3 rewrites the reverter-skip
 * onto `netAddFull` and removes `isReverterOf` (design §15.9). Do NOT build new
 * callers on it — use `netAddFull`.
 */
export function isReverterOf(offender, candidate, { git }) {
  const pO = normDiff(git, `${offender}^1`, offender);
  if (pO === '') return false;
  return normDiff(git, candidate, `${candidate}^1`) === pO;
}
