// cold-boot.mjs — REQ-H1-2, REQ-H1-3: resolve headRefOid, checkout detached,
// load doctrine from durable sources only, abstain on self-review (protocol
// §8, §10 Self-review row; design.md §4). Fork A (D2, comment 4993202904):
// H1-1 shipped an interim cold-boot DI-seam reader for the head sha; ADR-0021
// Decision 3 (Fork A condition 2) RETIRED it once the port itself exposed
// `headRefOid` on `prView` — no parallel mini-port survives. `headRefOid` now
// comes straight from the `prView` fetch below (`fetchPr`), already made for
// the self-review check. No resume.md/branch-name seam exists — absent BY
// CONSTRUCTION (R2).

import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { getVcs } from '../vcs/cli.mjs';
import { gitlabApiConfig } from '../vcs/ci-context.mjs';
import { readRecordObservations } from '../memory/lib/store.mjs';
import { parseVerdict } from './lib/parse-verdict.mjs';
import { parseDecision } from './lib/decision-block.mjs';

const DOCTRINE_TYPES = new Set(['decision', 'architecture']);
/** Pure guard (REQ-H1-3): a reviewer whose handle equals the PR author abstains. */
export function evaluateSelfReview({ reviewerHandle, author }) {
  return Boolean(reviewerHandle) && Boolean(author) && reviewerHandle === author;
}

function defaultFetchPr({ getVcs: getVcsFn = getVcs } = {}) {
  return async ({ project, number, provider }) => (await getVcsFn({ provider })).prView({ project, number });
}

// COLDBOOT-CWD fix (protocol §8 "own clone/worktree"): NEVER `git checkout` in
// the operator's cwd — that moves their HEAD (state-loss). Fetch the shas into
// the operator's object db, then check the head out in a SEPARATE detached
// worktree. `fetch`/`tmp` are seams so the isolation logic is testable without
// a remote.
//
// COLDBOOT-DEPTH fix (issue #291, I291-AMBIENT-STATE): fetch WITH history (NO
// `--depth 1`) and fetch BOTH the head AND the base. A shallow head graft has
// no ancestors, so the three-dot `git diff base...head` (cli.mjs
// getChangedFiles) finds no merge-base and the §10.4 reversion has no base
// tree — the #290 crasher. Cold boot must be self-sufficient: bring both prView
// shas explicitly, never leaning on whatever the operator's clone happens to
// contain (Law 2 at the plumbing layer). Full-history-both is the obvious
// simple choice at this repo's size (reviewer ruling #291); revisit only if
// fetch cost bites on CI shallow clones.
// ONE exit listener per process, however many shas get reviewed (#843 round 1,
// editorial): a per-checkout `process.on('exit', ...)` would cross Node's
// MaxListenersExceededWarning threshold on the 11th review in a single process.
const exitCleanups = [];
function defaultRegisterCleanup(fn) {
  if (exitCleanups.length === 0) {
    process.on('exit', () => {
      for (const f of exitCleanups) {
        try { f(); } catch { /* best effort — teardown never masks the exit */ }
      }
    });
  }
  exitCleanups.push(fn);
}

export function defaultCloneDetached({ cwd = process.cwd(), fetch, tmp = tmpdir(), _registerCleanup = defaultRegisterCleanup } = {}) {
  const doFetch = fetch ?? (sha => execFileSync('git', ['fetch', 'origin', sha], { cwd, encoding: 'utf8' }));
  return ({ sha, baseSha } = {}) => {
    if (baseSha) doFetch(baseSha);
    doFetch(sha);
    // COLDBOOT-SHALLOW fix (issue #293): a shallow operator clone truncates
    // history — `base...head` has no reachable merge-base (and the §10.4
    // reversion no base tree) even with both tips fetched, because re-fetching
    // an already-present graft never deepens. Unshallow so full history
    // connects them. Guarded: on a complete clone `--unshallow` errors by
    // design, so only run it when the repo is actually shallow. This carries
    // I291-AMBIENT-STATE to its conclusion — cold boot is robust to the
    // operator's clone depth, not just its fetch state.
    try {
      const shallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd, encoding: 'utf8' }).trim();
      if (shallow === 'true') execFileSync('git', ['fetch', '--unshallow', 'origin'], { cwd, encoding: 'utf8' });
    } catch { /* best effort: a complete clone, or nothing left to deepen */ }
    const worktreePath = join(tmp, `brain-review-${sha}`);
    // Clear any prior worktree at this path so `worktree add` never fails:
    // `remove` unregisters a registered one; `prune` + rm clears a bare
    // leftover dir (the "is not a working tree" noise, issue #291 secondary).
    try { execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd, encoding: 'utf8' }); } catch { /* not a registered worktree */ }
    try { execFileSync('git', ['worktree', 'prune'], { cwd, encoding: 'utf8' }); } catch { /* best effort */ }
    if (existsSync(worktreePath)) rmSync(worktreePath, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '--detach', worktreePath, sha], { cwd, encoding: 'utf8' });
    // #842: the checkout dies with the review process. The clear-before-add
    // above keeps reruns idempotent, but clearing only on the NEXT run left
    // one full checkout per reviewed sha behind forever — 64 dirs, 464M,
    // measured the day /tmp became the test failure.
    _registerCleanup(() => {
      try {
        execFileSync('git', ['worktree', 'remove', '--force', worktreePath], { cwd, encoding: 'utf8' });
      } catch {
        // The remove failed — a checkout someone rm'd by hand, a path git no
        // longer recognizes. The dir AND the .git/worktrees/ registration must
        // both still die (#843 round 2): a bare rm alone leaves the operator's
        // real repo holding a stale entry.
        try { rmSync(worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
        try { execFileSync('git', ['worktree', 'prune'], { cwd, encoding: 'utf8' }); } catch { /* best effort */ }
      }
    });
    return { detached: true, sha, baseSha: baseSha ?? null, worktreePath };
  };
}

/**
 * RULING (issue #634): the reviewer reads the DEDUPED records and deliberately
 * does NOT carry the duplicate accounting into its verdict. Recorded here as a
 * decision rather than left as an omission — which is what #634 asks for.
 *
 * The reasoning is about what a verdict is ABOUT. These records are doctrine
 * (`DOCTRINE_TYPES`), loaded to inform a judgement on someone's pull request.
 * How many physical lines the store spends on that doctrine is a fact about
 * repository HYGIENE — a `merge=union` residual (ADR-0017, REQ-MF-3) arriving
 * from unrelated branches. Surfacing it here would let it colour a verdict it
 * has no bearing on, and the PR author could do nothing about it.
 *
 * Deduping is not merely acceptable here, it is REQUIRED: a doctrine record
 * appearing twice would otherwise be weighed twice, purely because two branches
 * both appended to the month file it happens to live in.
 *
 * So this silence is deliberate — and it is not the silence #634 is about. The
 * store's duplicates ARE reported, on the surfaces that own store hygiene:
 * every `memory/cli.mjs` op that reads the store (#574), and `brain:metrics`'
 * coverage line (#634). If that ever stops being true, this ruling is wrong and
 * should be revisited rather than quietly inherited.
 */
function defaultReadRecords({ cwd = process.cwd() } = {}) {
  return () => readRecordObservations({ recordsDir: join(cwd, '.memory', 'records') });
}

// `prReviews` normalizes to `{ state, author, body }` on BOTH providers (issue
// #317). `body` is what `parseVerdict` needs, so `priorVerdicts` below is now
// populated from the real adapters — before #317 the shape was `{ state,
// author }` only and this whole doctrine load was inert in production, green
// solely because the tests injected a `body` no adapter ever emitted. The
// contract suite (vcs.contract.test.mjs) now pins `body` on the REAL
// normalizer output and runs it through `parseVerdict`, so that masking
// cannot return.
function defaultFetchReviews({ getVcs: getVcsFn = getVcs } = {}) {
  return async ({ project, number, provider }) => {
    const vcs = await getVcsFn({ provider });
    const { apiBase, token, proxyUrl } = gitlabApiConfig();
    const reviews = await vcs.prReviews({ project, number, apiBase, token, proxyUrl });
    return reviews ?? [];
  };
}

/** Self-review guard, then headRefOid + detached checkout + doctrine load.
 * `headRefOid` (ADR-0021 Decision 1/3) comes straight from `prView` — the
 * same fetch already made for the self-review check above; no separate
 * DI-seam reader exists for it anymore.
 * Returns `{ abstain: true, reason, author }` on self-review, else
 * `{ abstain: false, headSha, prView, doctrine: { records, priorVerdicts } }`. */
export async function gatherColdBoot({ project, number, provider, reviewerHandle, deps = {} } = {}) {
  const fetchPr = deps.fetchPr ?? defaultFetchPr(deps);
  const prView = await fetchPr({ project, number, provider });

  if (evaluateSelfReview({ reviewerHandle, author: prView.author })) {
    return { abstain: true, reason: 'self-review: reviewer handle equals PR author', author: prView.author };
  }

  const cloneDetached = deps.cloneDetached ?? defaultCloneDetached(deps);
  const readRecords = deps.readRecords ?? defaultReadRecords(deps);
  const fetchReviews = deps.fetchReviews ?? defaultFetchReviews(deps);

  const headSha = prView.headRefOid;
  // Fetch the PR's base tip too (issue #291): the diff/reversion downstream need
  // it present with history. `null` when the port can't compute it — cloneDetached
  // then skips the base fetch (same as before), no regression.
  const baseSha = prView.baseRefOid ?? null;
  const clone = await cloneDetached({ sha: headSha, baseSha });

  const records = readRecords().filter(r => DOCTRINE_TYPES.has(r?.type));
  const reviews = await fetchReviews({ project, number, provider });
  const priorVerdicts = reviews.map(r => parseVerdict(r)).filter(Boolean);

  // #506 — the escalation's EXIT. §7 summons a human to rule; the ruling needs
  // somewhere to land, and until now there was nowhere: past the bound every run
  // returned STOP, and the only way out was closing the PR and discarding the
  // history the escalation exists to summarise. That is a trapdoor, not a
  // decision point.
  //
  // The ruling lands on the surface the signature already lives on. `brain:approve`
  // posts a `brain-decision/1` block bound to a head (#473), read from this SAME
  // review list — a human clearing an escalation is that act with a different
  // consequence, so it needs no new mechanism, no new label and no new port verb.
  // A label would be the wrong home: labels are the derived index, verdicts are truth.
  //
  // Bound to the head, like everything else here. A push is new work the human has
  // not ruled on, and it re-arms — the same reasoning `actor-check` applies to an
  // approval that predates a commit.
  const priorDecisions = reviews.map(r => parseDecision(r)).filter(Boolean);

  // #477, second half of the maintainer ruling — three states, not two: clean,
  // has-findings, and UNREADABLE. `parseVerdict` records the fields it could
  // not read on each verdict's `malformed`; carrying that through
  // `priorVerdicts` is necessary and not sufficient, because nothing walks the
  // list asking the question. A verdict whose findings list was garbage sits in
  // `priorVerdicts` looking exactly like one that found nothing, which is the
  // conflation the ticket exists to end, moved one layer up.
  //
  // `priorVerdicts` itself is deliberately NOT filtered. An unreadable verdict
  // is still a review iteration: it must keep counting toward §7's rev bound
  // and the anti-loop lock, or posting an unreadable block would become a way
  // to reset them.
  const unreadableVerdicts = priorVerdicts
    .filter(v => Array.isArray(v?.malformed) && v.malformed.length > 0)
    .map(v => ({ head_sha: v.head_sha, author: v.author, malformed: v.malformed }));

  // worktreePath: the isolated detached worktree (H1-2 evaluators operate inside it).
  return {
    abstain: false,
    headSha,
    worktreePath: clone?.worktreePath,
    prView,
    doctrine: { records, priorVerdicts, priorDecisions, unreadableVerdicts },
  };
}
