// sweep.mjs — the cross-day lane sweep (#936, absorbs #920's stranded-lane
// gap, ADR-0034). Revisits every LOCAL and REMOTE `memory/<host>-*` ref this
// host owns, other than today's (today's own branch is reconciled by
// today's `shipLane` call, under the same closed-PR rule — D5), and
// dispatches each one per spec.md's table:
//
//   delivered            -> delete the local ref only
//   pending, no/open PR  -> re-ship through `shipLane`, collection disabled
//   pending, closed PR   -> never re-ship, never reopen — report forever
//   unknown              -> keep the ref, report it
//   stale remote branch  -> fail loud (diverged), never force
//
// There is no age cutoff (spec.md's own "Out of Scope"): every unreconciled
// ref for this host is revisited on every run, however old.
//
// This module NEVER enumerates or acts on another host's refs — the
// `slugifyHost(host)` EXACT match (plan.mjs) is what makes that true; a
// `gandalf` host must never claim `gandalf-rog-...`'s refs (design step 3).

import { contentDelivery } from './delivery.mjs';
import { slugifyHost } from './plan.mjs';
import { emptyDuplicates } from '../lib/duplicates.mjs';
import { shipLane } from './ship.mjs';

// Deliberately narrower than `ship.mjs`'s own `BRANCH_GRAMMAR` — no optional
// `-<n>` disambiguator suffix. `plan.mjs` never emits that suffix, and a
// sweep-owned ref must match its OWN grammar exactly, not tolerate a shape
// nothing here ever produces.
const SWEEP_BRANCH_RE = /^memory\/(.+)-(\d{4}-\d{2}-\d{2})$/;

function parseBranch(branch) {
  const m = SWEEP_BRANCH_RE.exec(branch);
  return m ? { hostSlug: m[1], date: m[2] } : null;
}

/** `status` (`contentDelivery`'s vocabulary) -> the `delivered` tri-state
 * (`ship.mjs`'s own `surveyDelivery()` translation, reused verbatim so every
 * row in `sweepLanes`'s output speaks the same `true|false|null` dialect as
 * `shipLane`'s own outcome shape). */
function deliveredFromStatus(status) {
  return status === 'delivered' ? true : status === 'pending' ? false : null;
}

/**
 * noCollect() — the injected `collect` seam for a sweep-driven re-ship
 * (design step 5.3). Because `collectLane()` is never called, today's newly
 * collected records CANNOT enter a prior-day ref — `commit` is always
 * `null`, `collected` is always `0`. `ref`/`baseFetched` are threaded
 * through so the outcome shape's `ref`/`baseFetched` fields stay honest.
 *
 * @param {string} ref
 * @param {boolean} baseFetched
 */
export function noCollect(ref, baseFetched) {
  return {
    ref, commit: null, collected: 0, skipped: [],
    duplicates: emptyDuplicates(), baseFetched, skippedWorktrees: [],
  };
}

/** Every local `memory/*` ref, branch names (no `refs/heads/` prefix). An
 * unreadable `for-each-ref` degrades to an empty list — a survey read is
 * advisory, never fatal (mirrors `ship.mjs`'s own `parseCount` discipline:
 * fail toward "nothing found", not toward a thrown error, for a listing
 * call). */
function listLocalBranches(git, root) {
  const result = git(['for-each-ref', '--format=%(refname)', 'refs/heads/memory/'], { cwd: root });
  if (result.status !== 0) return [];
  return String(result.stdout ?? '')
    .split('\n')
    .filter(Boolean)
    .map((r) => r.replace(/^refs\/heads\//, ''));
}

/** Every remote `memory/*` ref via `ls-remote` — never a local clone of the
 * whole remote. `ok:false` on failure (design step 2's own degrade), so the
 * caller can report `remoteListed:false` and continue with local-only
 * classification rather than aborting the run. */
function listRemoteBranches(git, root) {
  const result = git(['ls-remote', '--heads', 'origin', 'refs/heads/memory/*'], { cwd: root });
  if (result.status !== 0) return { ok: false, branches: new Set() };
  const branches = new Set();
  for (const line of String(result.stdout ?? '').split('\n')) {
    const [sha, ref] = line.split('\t');
    if (!sha || !ref) continue;
    branches.add(ref.trim().replace(/^refs\/heads\//, ''));
  }
  return { ok: true, branches };
}

/** D7: a remote-only ref (present on `ls-remote`, no local counterpart).
 * Fetched into `refs/remotes/origin/<branch>` and classified there — nothing
 * is mutated, ever, for this row: no local ref is created, no push, no PR
 * lookup. Deleting a remote branch outright is Tier 2 (AGENTS.md), so
 * report-only is this row's entire behavior. */
function sweepRemoteOnly({ branch, date, git, root, baseFetched }) {
  const remoteTrackingRef = `refs/remotes/origin/${branch}`;
  const fetchResult = git(['fetch', 'origin', `+refs/heads/${branch}:${remoteTrackingRef}`], { cwd: root });
  if (fetchResult.status !== 0) {
    return {
      branch, date, where: 'remote', action: 'unknown',
      delivered: null, pr: null, reason: 'remoteFetchFailed',
    };
  }
  const delivery = contentDelivery({ git, root, rev: remoteTrackingRef, baseFetched });
  return {
    branch, date, where: 'remote', action: 'remoteOnly',
    delivered: deliveredFromStatus(delivery.status), pr: null, reason: delivery.reason,
  };
}

/** A local (or `both`) ref: classify by content delivery, then either
 * delete it (delivered), keep+report it (unknown), or re-ship it through
 * `shipLane` with collection disabled (pending) — `shipLane`'s own D4
 * closed-PR rule decides `shipped`/`reconciled`/`closedUnmerged` from
 * there, and its thrown failures (`diverged`/`prLookupFailed`/anything
 * else) map to this row's `diverged`/`unknown`/`failed`. */
async function sweepLocal({ branch, date, where, root, project, tier, host, git, vcs, ship, baseFetched }) {
  const ref = `refs/heads/${branch}`;

  const tipResult = git(['rev-parse', '--verify', '--quiet', ref], { cwd: root });
  if (tipResult.status !== 0) {
    // Listed by for-each-ref a moment ago, gone now (raced by something
    // else entirely) — fail closed, never guess.
    return { branch, date, where, action: 'unknown', delivered: null, pr: null, reason: 'refMissing' };
  }
  const observedSha = tipResult.stdout.trim();

  const delivery = contentDelivery({ git, root, rev: ref, baseFetched });

  if (delivery.status === 'unknown') {
    return { branch, date, where, action: 'unknown', delivered: null, pr: null, reason: delivery.reason };
  }

  if (delivery.status === 'delivered') {
    const deleteResult = git(['update-ref', '-d', ref, observedSha], { cwd: root });
    if (deleteResult.status !== 0) {
      return {
        branch, date, where, action: 'failed', delivered: true, pr: null,
        reason: deleteResult.stderr?.trim() || `update-ref -d exited ${deleteResult.status}`,
      };
    }
    return { branch, date, where, action: 'deleted', delivered: true, pr: null, reason: null };
  }

  // `pending` — re-ship through the ordinary ship path, with collection
  // disabled (D-sweep step 5.3): today's newly collected records must never
  // enter this prior-day ref.
  let result;
  try {
    result = await ship({
      root, project, tier, host, date, git, vcs,
      collect: () => noCollect(ref, baseFetched),
    });
  } catch (err) { /* surfaced: a per-branch failure is returned as a row (`action`, `reason`) that the ship op reports */
    if (err?.diverged) {
      return { branch, date, where, action: 'diverged', delivered: false, pr: null, reason: err.message };
    }
    if (err?.prLookupFailed) {
      // spec.md's own "unknown" scenario: an mrList throw (or an
      // uncomputable state/merged field, which `decidePr` also tags
      // `prLookupFailed`) is kept and reported, never guessed.
      return { branch, date, where, action: 'unknown', delivered: false, pr: null, reason: err.message };
    }
    return { branch, date, where, action: 'failed', delivered: false, pr: null, reason: err?.message ?? String(err) };
  }

  const action = result.closedUnmerged
    ? 'closedUnmerged'
    : result.pushed
      ? 'shipped'
      : result.reconciled
        ? 'reconciled'
        // Defensive fallback only — `pending` never reaches shipLane's own
        // `delivered === true` no-op path here, since this branch's tip was
        // JUST classified `pending` above. Kept rather than asserted, so a
        // genuinely impossible combination still reports as unresolved
        // instead of crashing the whole sweep.
        : 'unknown';

  return {
    branch, date, where, action,
    delivered: result.delivered, pr: result.pr, reason: result.deliveredReason ?? null,
  };
}

/**
 * sweepLanes() — see this file's header for the full behavior. Every git
 * call passes `{ cwd: root }` (design step, sweep.test.mjs's own guard).
 *
 * @param {{
 *   root: string, project: string, tier: string, host: string, today: string,
 *   git: Function, vcs: object, ship?: typeof shipLane,
 * }} opts
 * @returns {Promise<{ remoteListed: boolean, branches: Array<object> }>}
 */
export async function sweepLanes({ root, project, tier, host, today, git, vcs, ship = shipLane }) {
  const fetchResult = git(['fetch', 'origin', 'main'], { cwd: root });
  const baseFetched = fetchResult.status === 0;

  const hostSlug = slugifyHost(host);

  const localBranches = listLocalBranches(git, root);
  const { ok: remoteListed, branches: remoteBranches } = listRemoteBranches(git, root);

  /** branch (no `refs/heads/` prefix) -> { branch, date, where }. */
  const entries = new Map();

  for (const branch of localBranches) {
    const parsed = parseBranch(branch);
    // Suffixed names (`-<n>`) are ignored (SWEEP_BRANCH_RE has no such
    // group), and the host slug must match EXACTLY — never a prefix.
    if (!parsed || parsed.hostSlug !== hostSlug || parsed.date === today) continue;
    entries.set(branch, { branch, date: parsed.date, where: 'local' });
  }

  if (remoteListed) {
    for (const branch of remoteBranches) {
      const parsed = parseBranch(branch);
      if (!parsed || parsed.hostSlug !== hostSlug || parsed.date === today) continue;
      const existing = entries.get(branch);
      if (existing) existing.where = 'both';
      else entries.set(branch, { branch, date: parsed.date, where: 'remote' });
    }
  }

  // Ascending date order (design step 4) — plain code-unit compare is exact
  // for `YYYY-MM-DD`, no locale/ICU dependency.
  const ordered = [...entries.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const branches = [];
  for (const entry of ordered) {
    try {
      if (entry.where === 'remote') {
        branches.push(sweepRemoteOnly({ branch: entry.branch, date: entry.date, git, root, baseFetched }));
      } else {
        // eslint-disable-next-line no-await-in-loop -- each branch's own
        // git/vcs calls must be sequential (a shared, mutable local repo),
        // matching design's own "walk ascending, each in its own try/catch".
        branches.push(await sweepLocal({
          branch: entry.branch, date: entry.date, where: entry.where,
          root, project, tier, host, git, vcs, ship, baseFetched,
        }));
      }
    } catch (err) { /* surfaced: an unexpected throw is contained per branch and returned as a row with its reason */
      // Belt-and-braces: an unexpected throw from a git call this module
      // does not otherwise wrap (e.g. `for-each-ref` returning meanwhile
      // is fine as a status object, never a throw — but a future git()
      // implementation that DOES throw must still be contained per-branch,
      // never crash the whole sweep).
      branches.push({
        branch: entry.branch, date: entry.date, where: entry.where,
        action: 'failed', delivered: null, pr: null, reason: err?.message ?? String(err),
      });
    }
  }

  return { remoteListed, branches };
}
