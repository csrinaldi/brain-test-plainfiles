// ship.mjs — the lane ship: one push, one PR, and a credential this module
// never holds (#888, ADR-0034 L1/L2/L5, following #887's collectLane()).
//
// shipLane() is an orchestration function with FOUR injected seams and no
// import of its own that touches the machine: `collect` (default
// collectLane), `git` (default the already-exported defaultGit,
// collect.mjs:44), a BOUND port object `vcs` (never three separate function
// parameters — see A2 in design.md), and `tier`. Everything it decides is
// decided from those four; everything it reports is derived from what they
// returned. The credential never enters here — the `ship` op on
// memory/cli.mjs reads BRAIN_MEMORY_TOKEN once, hands it to getVcs(), and
// passes this function the BOUND port plus `identityBound: boolean`, never
// the token (A5). See openspec/changes/issue-888-lane-ship/design.md,
// decisions A1-A7, for the exact rationale behind every branch below.

import { collectLane, defaultGit } from './collect.mjs';
import { tierParams } from '../../vcs/governance-tiers.mjs';
import { contentDelivery } from './delivery.mjs';

/** Run `git(argv, opts)`; parse its stdout as a non-negative integer count,
 * defaulting to 0 on anything unparseable (never throws — a survey read is
 * advisory, not load-bearing). */
function parseCount(result) {
  const n = Number.parseInt(String(result.stdout ?? '').trim(), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * surveyRef() — A1 step 2 / A3. Determines whether the local ref is ahead of
 * and/or behind origin's matching ref, WITHOUT ever forcing a push decision
 * itself: git's own non-fast-forward refusal at push time is the safety net
 * (A3), this is only the honest pre-report.
 *
 * - no local ref at all           -> ahead:0, behind:0, remoteRefPresent:null
 *   (nothing has ever been collected here; the caller's own commit:null check
 *   is what actually decides "nothing to ship").
 * - local ref exists, remote ref absent (a create, not a divergence)
 *                                  -> behind:0, remoteRefPresent:false, ahead
 *                                     is the ref's own full commit count.
 * - local ref exists, fetch fails for any OTHER reason (offline/transport)
 *                                  -> degrades like collect's own baseFetched:
 *                                     behind:null (unknown), ahead:1 (a
 *                                     sentinel that never masks a real ship
 *                                     as "nothing to do" — the push attempt
 *                                     itself is the authoritative check, A3).
 * - local ref exists, fetch succeeds -> real ahead/behind via rev-list.
 *
 * R2 (#920): also returns `tip` — the ref's own sha, or `null` when the ref
 * has never been created locally. `tip === null` is the STRUCTURAL cold-1
 * no-op condition the caller now branches on, replacing the old inferred
 * `ahead === 0` reading (`ahead === 0` is also true for a ref that exists
 * and is simply unreconciled — the exact state #920 repairs).
 */
function surveyRef({ git, root, ref, branch }) {
  const tipResult = git(['rev-parse', '--verify', '--quiet', ref], { cwd: root });
  if (tipResult.status !== 0) {
    return { ahead: 0, behind: 0, remoteRefPresent: null, tip: null };
  }
  const tip = tipResult.stdout.trim();

  const remoteRef = `refs/remotes/origin/${branch}`;
  const fetchResult = git(['fetch', 'origin', `+refs/heads/${branch}:${remoteRef}`], { cwd: root });
  if (fetchResult.status !== 0) {
    if (/couldn't find remote ref/.test(fetchResult.stderr)) {
      const aheadAll = git(['rev-list', '--count', ref], { cwd: root });
      return { ahead: parseCount(aheadAll), behind: 0, remoteRefPresent: false, tip };
    }
    return { ahead: 1, behind: null, remoteRefPresent: null, tip };
  }

  const behindResult = git(['rev-list', '--count', `${ref}..${remoteRef}`], { cwd: root });
  const aheadResult = git(['rev-list', '--count', `${remoteRef}..${ref}`], { cwd: root });
  return { ahead: parseCount(aheadResult), behind: parseCount(behindResult), remoteRefPresent: true, tip };
}

/**
 * surveyDelivery() — R3/R4 (#920): "did these records reach `origin/main`'s
 * CONTENT?", via content containment, never commit ancestry (`merge-base
 * --is-ancestor` would report every squash-merged lane as pending forever —
 * see proposal R3).
 *
 * #936 (D3): the classification itself now lives in the shared, leaf
 * `contentDelivery()` helper (`lane/delivery.mjs`) — reused by the same-day
 * reparent (`collect.mjs` step 8) and the cross-day sweep (`lane/sweep.mjs`).
 * This function is a THIN WRAPPER translating that helper's
 * `{status, reason}` shape back to this module's own pre-#936
 * `{delivered, reason}` shape — `delivered`→`true`, `pending`→`false`,
 * `unknown`→`null`, same `reason`. No behavior change: the wrapper's argv
 * and every observable outcome are byte-identical to the pre-#936 body (see
 * `surveyOkRules` in ship.test.mjs for the ordered fake-git pair this
 * requires, and `delivery.test.mjs` for the helper's own direct coverage).
 */
function surveyDelivery({ git, root, ref, baseFetched }) {
  const { status, reason } = contentDelivery({ git, root, rev: ref, baseFetched });
  const delivered = status === 'delivered' ? true : status === 'pending' ? false : null;
  return { delivered, reason };
}

// A4: the branch's own grammar (ADR-0034 L1, adr-0034:49) — tolerating the
// planner's optional `-<n>` disambiguator suffix, which `lane/plan.mjs` does
// not emit today but the regex stays permissive for it regardless.
const BRANCH_GRAMMAR = /^memory\/(?<host>[a-z0-9][a-z0-9-]*)-(?<date>\d{4}-\d{2}-\d{2})(?:-\d+)?$/;

/**
 * buildTitleAndBody() — A4. `title`/body follow the ticket's own grammar
 * (task 0.1 of tasks.md — a delta from this same file's design.md, called out
 * there and in the PR body): `title` carries the record count, the body's
 * first line does not. `host`/`date` are PARSED FROM THE BRANCH, never taken
 * from the caller's raw params directly — `lane/plan.mjs`'s `slugifyHost()`
 * can rewrite `host` (lowercased, non-`[a-z0-9]` runs collapsed to `-`)
 * before it ever reaches the ref, so re-deriving from the branch is the only
 * way the title provably matches what the ref actually says (A4's own
 * "never a second clock read" rationale, applied to the slug too). `n` and
 * the path list come from ONE source — the three-dot diff against
 * `origin/main` — never `collected` (#887's own C1 lesson: `collected`
 * counts this run's additions, not the lane's). The diff's own exit status
 * is honored: when `origin/main` cannot be resolved (a missing/unfetched
 * base, `git diff` exits non-zero), `paths` is unknowable — reporting it as
 * `[]`/`(0 records)` would be a false "nothing shipped" claim on a run that
 * pushed real records, so the count is reported as unknown instead.
 */
function buildTitleAndBody({ git, root, ref, branch }) {
  const m = BRANCH_GRAMMAR.exec(branch);
  const host = m ? m.groups.host : branch;
  const date = m ? m.groups.date : '';

  const diffResult = git(['diff', '--name-only', `origin/main...${ref}`], { cwd: root });
  if (diffResult.status !== 0) {
    const title = `memory: ${host} ${date} (records: unknown)`;
    const bodyLines = [
      `Memory lane: ${host} ${date}`,
      'Records: unknown — origin/main could not be fetched, the diff could not be computed',
    ];
    return { title, body: `${bodyLines.join('\n')}\n` };
  }
  const paths = String(diffResult.stdout ?? '').split('\n').filter(Boolean).sort();
  const n = paths.length;
  const title = `memory: ${host} ${date} (${n} records)`;
  const bodyLines = [`Memory lane: ${host} ${date}`, `Records: ${n}`, ...paths.map((p) => `- ${p}`)];
  return { title, body: `${bodyLines.join('\n')}\n` };
}

/** parsePrNumber() — A6/spec "PR number is derived, never guessed". Query
 * strings and fragments are stripped first so `.../pull/123?tab=files` and
 * `.../pull/123#comment` both still parse. The PRIMARY form requires an
 * explicit `/pull/<n>` or `/merge_requests/<n>` segment (covers both
 * `.../pull/123` and `.../-/merge_requests/12`); a trailing-integer form is
 * only the FALLBACK, and even then it requires the digits to be their own
 * path segment (preceded by `/`) — a URL like `https://host/g/p2` must
 * never be misread as PR number 2 just because its last character is a
 * digit. */
function parsePrNumber(url) {
  if (typeof url !== 'string') return null;
  const clean = url.split(/[?#]/)[0];
  const primary = clean.match(/\/(?:pull|merge_requests)\/(\d+)\/?$/);
  if (primary) return Number(primary[1]);
  const fallback = clean.match(/\/(\d+)\/?$/);
  return fallback ? Number(fallback[1]) : null;
}

/**
 * decidePr() — D4 (#936), REVERSES #920's R8. `mrList` is the ONE port verb
 * that THROWS (design A6, measured: github.mjs:458/gitlab.mjs:614 call a
 * JSON runner that throws on non-zero exit, unlike mrCreate/mrAutoMerge
 * which each catch their own). Wrapped here so a lookup failure is tagged
 * `prLookupFailed` and fails the run closed.
 *
 * R8 REVERSAL (#920 -> #936): #920's R8 ruling was "PR closed unmerged ⇒
 * pending ⇒ push if needed, then a fresh PR" — implemented, pre-#936, by
 * querying `mrList({state:'open'})` ALONE: a closed PR could never be found
 * by that query, so the branch always fell through to `mrCreate`, i.e. a
 * fresh PR every run. This is now REVERSED: the query below spans ALL
 * states (bound to this one branch via the D2 `headBranch` filter, never a
 * repo-wide scan) so a closed-unmerged history is actually visible, and a
 * closed-unmerged branch's only decision is `closedUnmerged` — reported on
 * every run, never re-pushed, never given a fresh PR.
 *
 * D4's rule, once the list is filtered to `headBranch === branch` (a
 * foreign branch's PR must never affect this decision):
 * - any item with `state === 'open'` -> reuse it (`action: 'reuse'`)
 * - no matches at all -> `action: 'create'`
 * - otherwise the HIGHEST-numbered match ("newest") decides:
 *   - `state === null || merged === null` (uncomputable) -> `prLookupFailed`
 *   - `state === 'closed' && merged === false` -> `action: 'closedUnmerged'`
 *   - anything else (`merged === true`, i.e. a pre-#936 [closed, merged]
 *     history) -> `action: 'create'`
 *
 * Called BEFORE the push (moved from `ship.mjs`'s old post-push position) —
 * a push onto a branch whose only PR was closed unmerged would itself be a
 * re-ship, which spec.md forbids regardless of whether a fresh PR follows.
 */
async function decidePr({ vcs, project, branch }) {
  let list;
  try {
    list = await vcs.mrList({ project, state: 'all', headBranch: branch });
  } catch (err) {
    const e = new Error(`memory.ship.prLookupFailed: mrList failed — ${err.message}`);
    e.prLookupFailed = true;
    // #1119: this call always runs before the push (D4's own ordering,
    // enforced by this function's call site below, line ~400 vs the push at
    // ~412) — so a throw here can never mean anything landed. Tagged
    // explicitly rather than left to be guessed downstream, so the i18n
    // message key chosen in cli.mjs never has to re-derive it.
    e.pushed = false;
    throw e;
  }
  const matches = list.filter((m) => m.headBranch === branch);
  const open = matches.find((m) => m.state === 'open');
  if (open) return { action: 'reuse', number: open.number };
  if (matches.length === 0) return { action: 'create' };

  const newest = matches.reduce((a, b) => (b.number > a.number ? b : a));
  if (newest.state == null || newest.merged == null) {
    const e = new Error(`memory.ship.prLookupFailed: mrList's item #${newest.number} for ${branch} is missing state/merged`);
    e.prLookupFailed = true;
    e.pushed = false; // #1119: same reasoning as the throw above — pre-push.
    throw e;
  }
  if (newest.state === 'closed' && newest.merged === false) {
    return { action: 'closedUnmerged', number: newest.number };
  }
  // `merged === true` (or, in principle, any other computable combination
  // D1's enum does not actually produce) — a merged PR's branch is being
  // re-shipped with fresh content, so a NEW PR is the correct outcome, same
  // as an empty list.
  return { action: 'create' };
}

/** createPr() — A1 step 5, the `action: 'create'` half of `decidePr()`'s
 * decision. Unchanged from the pre-#936 `mrCreate` + one-shot re-scan
 * sequence — only the caller now decides WHETHER to reach this, before the
 * push, rather than always falling through to it after.
 *
 * `pushed` (#1119) is threaded through purely for error reporting: unlike
 * `decidePr()`'s own lookup (always pre-push), THIS function is only ever
 * reached after shipLane's push step has already run — so a rescan failure
 * here can genuinely mean the push already landed. `pushed` carries the
 * real, caller-observed outcome of that push step (`false` when nothing was
 * pending) rather than assuming it always ran. */
async function createPr({ vcs, project, branch, title, body, pushed }) {
  const created = await vcs.mrCreate({ project, title, body, head: branch, base: 'main', labels: [] });
  if (!created.url) {
    const e = new Error(`memory.ship.prCreateFailed: mrCreate failed — ${created.error ?? 'unknown error'}`);
    e.prCreateFailed = true;
    throw e;
  }

  let number = parsePrNumber(created.url);
  if (number === null) {
    let rescan;
    try {
      rescan = await vcs.mrList({ project, state: 'open' });
    } catch (err) {
      const e = new Error(`memory.ship.prLookupFailed: the one-shot mrList re-scan failed — ${err.message}`);
      e.prLookupFailed = true;
      e.pushed = pushed;
      throw e;
    }
    const rescanFound = rescan.find((m) => m.headBranch === branch);
    number = rescanFound ? rescanFound.number : null;
  }
  return { number, url: created.url };
}

/**
 * shipLane() — the whole sequence (design A1's six steps, `resolve` folded
 * into step 1's own return): collect -> survey -> push -> find -> create ->
 * arm.
 *
 * @param {{
 *   root: string, project: string, tier: string, host: string, date: string,
 *   dryRun?: boolean, identityBound?: boolean,
 *   collect?: typeof collectLane, git?: typeof defaultGit,
 *   vcs: { mrList: Function, mrCreate: Function, mrAutoMerge: Function } | null,
 * }} opts
 * @returns {Promise<object>} the outcome shape — see design.md's module map.
 */
export async function shipLane({
  root,
  project,
  tier,
  host,
  date,
  dryRun = false,
  identityBound = false,
  collect = collectLane,
  git = defaultGit,
  vcs,
}) {
  const collected = collect({ root, host, date, git });
  // #921: `skippedWorktrees` is collectLane()'s own worktree-level failure
  // list — distinct from `skipped` (plan.mjs's per-candidate skip list).
  // Defaulted to [] here so a `collect` fake predating this field (existing
  // tests) never turns into `undefined` in the outcome shape or `--json`.
  const {
    ref, commit, collected: collectedCount, skipped, duplicates, baseFetched,
    skippedWorktrees = [],
  } = collected;
  const branch = ref.replace(/^refs\/heads\//, '');

  const base = {
    ref, branch, host, date,
    commit, collected: collectedCount, skipped, duplicates, baseFetched,
    skippedWorktrees,
    identityBound, dryRun,
  };

  // A7: under --dry-run, steps 3-6 are never reached (vcs:null, no push, no
  // fetch/rev-list survey either — only the diff read below, needed for the
  // plan the operator sees). `collect` above still ran and made its own
  // best-effort `git fetch origin main` — that qualifier is A7's own.
  if (dryRun) {
    const { title, body } = buildTitleAndBody({ git, root, ref, branch });
    return {
      ...base, title, body,
      ahead: null, behind: null, remoteRefPresent: null,
      pushed: false, diverged: false, pr: null, autoMerge: null,
      // R12: shape uniformity only — `vcs: null` under `--dry-run` means a
      // "would reconcile" claim could never consult `mrList`, so this never
      // surveys delivery and never attempts reconciliation (A7).
      delivered: null, deliveredReason: 'dryRun', reconciled: false,
      // D4 (#936): --dry-run never reaches the PR lookup either (vcs:null).
      closedUnmerged: false,
    };
  }

  const { ahead, behind, remoteRefPresent, tip } = surveyRef({ git, root, ref, branch });

  // R2 (#920): `tip === null` is the STRUCTURAL cold-1 no-op — the ref was
  // never created locally, so there is nothing to survey for delivery
  // either. Replaces the old `commit === null && ahead === 0` inference,
  // which also read true for a ref that exists and is simply unreconciled —
  // the exact state #920 repairs (see proposal R2).
  //
  // cold-1 (PR #902 review): `buildTitleAndBody()` is deferred past THIS
  // check — it is only ever called once we already know a push or PR will
  // actually happen (see the call site further down). Before that fix it ran
  // unconditionally right after `collect()`, so a ref that had NEVER been
  // created (first run, nothing to ship: `rev-parse <ref>` fails, `tip` is
  // `null`) made the three-dot diff fail on a bad revision — and that
  // failure was reported as "origin/main could not be fetched", conflating
  // "the local ref never existed" with "the remote base is unreachable".
  // Every path past this `return` already proved the ref exists, so a diff
  // failure reached from here on can only mean a genuinely unfetchable base
  // — see test `C` below for that legitimate case, which is unaffected by
  // this change.
  if (tip === null) {
    // C3 (cold review): `title`/`body` are `null` here, not simply absent
    // from the returned object — the module map (design.md) declares them
    // UNCONDITIONAL in the outcome shape. `null` says "there is nothing to
    // title, by design" without making the key's presence itself the signal
    // a caller has to special-case.
    return {
      ...base, title: null, body: null, ahead, behind, remoteRefPresent,
      pushed: false, diverged: false, pr: null, autoMerge: null,
      delivered: null, deliveredReason: 'noRef', reconciled: false,
      // D4 (#936): a ref that never existed never reaches the PR lookup.
      closedUnmerged: false,
    };
  }

  // R1 (#920): "is anything queued to push?" and "is anything queued to
  // reconcile?" are two independent questions — `pendingPush` is the exact
  // predicate the old single early-return used to gate everything on.
  //
  // Scope boundary this predicate does NOT cover (both filed, both R10 of
  // #920's proposal): #936 tracks that this whole call graph always
  // computes `date = today` (`cli.mjs:488`), so a lane stranded by an
  // outage across midnight is never revisited by anything here — a
  // caller-side sweep of prior-day refs, a different module, is that
  // follow-up's own shape. #930 tracks that the VCS port's `mrList` shape
  // (`{number, title, headBranch}`) carries no merge-state field, so
  // `surveyDelivery` below reads git directly instead of asking the port.
  const pendingPush = commit !== null || ahead > 0;

  // R3/R4/R5 (#920): the delivery read — content containment against
  // `origin/main`, never commit ancestry (a squash-merged lane is never an
  // ancestor of `main` — see surveyDelivery()'s own doc comment).
  const { delivered, reason: deliveredReason } = surveyDelivery({ git, root, ref, baseFetched });

  // R6/R7 (#920): the lane's records are already on `origin/main`'s
  // content — a true no-op regardless of `ahead`/`remoteRefPresent`. This
  // is the row where a naive `--is-ancestor` read would have re-pushed a
  // merged, deleted branch and opened a duplicate PR forever (R3).
  if (delivered === true) {
    return {
      ...base, title: null, body: null, ahead, behind, remoteRefPresent,
      pushed: false, diverged: false, pr: null, autoMerge: null,
      delivered: true, deliveredReason: null, reconciled: false,
      // D4 (#936): a delivered no-op never reaches the PR lookup.
      closedUnmerged: false,
    };
  }

  // Our own pre-check refuses a KNOWN divergence before ever touching the
  // network — "nothing else runs" (A1). An UNKNOWN divergence (behind:null,
  // a degraded fetch) still reaches the real push below, which is the
  // authoritative check (A3).
  if (behind !== null && behind > 0) {
    const err = new Error(`memory.ship.diverged: ${ref} is behind origin's matching ref — refusing to force-push.`);
    err.diverged = true;
    throw err;
  }

  // R8 REVERSAL (#920 -> #936, D4): the PR lookup now runs BEFORE the push
  // (moved from its old position after the push, below `findOrCreatePr`'s
  // former call site). #920's R8 pushed first and only THEN looked up the
  // PR — since that lookup only ever queried `state:'open'`, a closed PR was
  // invisible to it and the branch always got a fresh one. That ordering
  // and that query both changed: `decidePr()` below sees every state for
  // this branch, and a `closedUnmerged` decision must forbid the push
  // itself (a push onto a human-closed PR's branch is a re-ship, which
  // spec.md forbids), not merely skip creating a new PR after already
  // pushing.
  const decision = await decidePr({ vcs, project, branch });

  if (decision.action === 'closedUnmerged') {
    return {
      ...base, title: null, body: null, ahead, behind, remoteRefPresent,
      pushed: false, diverged: false, pr: { number: decision.number, url: null }, autoMerge: null,
      delivered, deliveredReason, reconciled: false, closedUnmerged: true,
    };
  }

  let pushed = false;
  if (pendingPush) {
    const pushResult = git(['push', '--no-verify', 'origin', `${ref}:${ref}`], { cwd: root });
    if (pushResult.status !== 0) {
      if (/non-fast-forward|fetch first|rejected/.test(pushResult.stderr)) {
        const err = new Error(`memory.ship.diverged: push refused — ${pushResult.stderr.trim()}`);
        err.diverged = true;
        throw err;
      }
      const err = new Error(`memory.ship.pushFailed: git push exited ${pushResult.status} — ${pushResult.stderr.trim()}`);
      err.pushFailed = true;
      throw err;
    }
    pushed = true;
  }

  // Reached whenever the lane is not yet delivered, with or without a
  // pending push (R1) — `buildTitleAndBody` stays deferred until here, only
  // once we know a push already happened or a reconcile is about to run.
  const { title, body } = buildTitleAndBody({ git, root, ref, branch });

  const pr = decision.action === 'reuse'
    ? { number: decision.number, url: null }
    : await createPr({ vcs, project, branch, title, body, pushed });

  // Both derivations (URL parse + the one-shot mrList re-scan) failing
  // leaves the PR open and unarmed — NOT fatal, per spec.md's own scenario
  // (exit:0). See design.md's A6 table for the reconciliation against an
  // earlier draft that listed this row as exit:1. The state self-heals:
  // the very next run's `mrList`-based idempotent find recovers `number`
  // from `mrList`'s own shape, the same way an `mrAutoMerge` refusal
  // self-heals one row below it in the same table.
  if (pr.number === null) {
    return {
      ...base, title, body, ahead, behind, remoteRefPresent, pushed, diverged: false, pr, autoMerge: null,
      delivered, deliveredReason, reconciled: true, closedUnmerged: false,
    };
  }

  // E2 (cold review): the port's own contract says `mrAutoMerge` never
  // throws (design A6; both providers catch internally, github.mjs/
  // gitlab.mjs) — but a throw here would otherwise propagate straight
  // through `shipLane` and fail the WHOLE run over an arm-only step, AFTER
  // the push and the PR have already landed durably. Catching here keeps
  // A6's "every mrAutoMerge refusal reason is non-fatal" guarantee true BY
  // CONSTRUCTION, rather than by trusting every current and future provider
  // to honor a contract this module cannot enforce on their behalf.
  let autoMerge;
  try {
    autoMerge = await vcs.mrAutoMerge({ project, number: pr.number, requiredReviews: tierParams(tier).requiredReviews });
  } catch (err) { /* surfaced: folded into `autoMerge: { enabled: false, reason }`, reported on stderr; a refusal is non-fatal by design (A6) */
    autoMerge = { enabled: false, reason: err?.message ?? String(err) };
  }

  return {
    ...base, title, body, ahead, behind, remoteRefPresent, pushed, diverged: false, pr, autoMerge,
    delivered, deliveredReason, reconciled: true, closedUnmerged: false,
  };
}
