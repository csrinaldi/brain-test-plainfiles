// delivery.mjs — contentDelivery(), the shared, fail-closed content-delivery
// classifier (#936, D3). Extracted verbatim from ship.mjs's own
// surveyDelivery() (ship.mjs:99-119, pre-#936) — a pure extraction, no
// behavior change. Both the same-day reparent (collect.mjs step 8) and the
// cross-day sweep (lane/sweep.mjs) call this instead of duplicating the
// classification.
//
// This is a LEAF module (D3): it imports nothing from `lane/`, so
// `collect.mjs` and `ship.mjs` can both import it without a ship<->collect
// import cycle, and `collect.mjs` stays IO-only.
//
// "Tip's own tree" is implemented as the paths the lane ref added since
// `merge-base(origin/main, rev)` — the three-dot diff — never the whole tip
// tree. A whole-tree check would read a record later scrubbed from `main`
// as pending forever (spec.md's own rationale for this helper).

/**
 * contentDelivery() — classifies whether `rev`'s own added content is
 * already present, byte-identical, in `origin/main`.
 *
 * @param {{ git: Function, root: string, rev: string, baseFetched: boolean }} opts
 * @returns {{ status: 'delivered'|'pending'|'unknown', reason: null|'baseStale'|'diffFailed' }}
 *
 * All-or-nothing, never a partial match: a single undelivered path anywhere
 * in the lane's own tip tree keeps the whole ref `pending`. Fail-closed:
 * any unreadable precondition (a stale base, either diff failing) resolves
 * to `unknown` — this function NEVER returns `delivered` on a read it could
 * not complete.
 *
 * The first diff is byte-identical to `ship.mjs`'s own `buildTitleAndBody()`
 * three-dot diff (R4's deliberate argv collision — same question, same
 * answer); the second is distinguished by its `--` pathspec.
 */
export function contentDelivery({ git, root, rev, baseFetched }) {
  if (baseFetched === false) {
    return { status: 'unknown', reason: 'baseStale' };
  }

  const laneDiff = git(['diff', '--name-only', `origin/main...${rev}`], { cwd: root });
  if (laneDiff.status !== 0) {
    return { status: 'unknown', reason: 'diffFailed' };
  }
  const lanePaths = String(laneDiff.stdout ?? '').split('\n').filter(Boolean);
  if (lanePaths.length === 0) {
    return { status: 'delivered', reason: null };
  }

  const undeliveredDiff = git(['diff', '--name-only', rev, 'origin/main', '--', ...lanePaths], { cwd: root });
  if (undeliveredDiff.status !== 0) {
    return { status: 'unknown', reason: 'diffFailed' };
  }
  const undeliveredPaths = String(undeliveredDiff.stdout ?? '').split('\n').filter(Boolean);
  return { status: undeliveredPaths.length === 0 ? 'delivered' : 'pending', reason: null };
}
