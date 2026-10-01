// poster.mjs — REQ-H1-9: THE security boundary. Posts a rendered `brain-review/1`
// verdict through the COMMENT-only port verbs (ADR-0020) and enforces the two
// §10 failure-mode locks BEFORE any write is attempted. Mirrors the vcs/
// DI-seam house style (D1): a thin async core, `deps.getVcs` / `deps.reResolveHead`
// as the only seams.
//
// R1 (protocol §1-§2, ADR-0020): there is NO APPROVE path on this module —
// structurally, because the port itself (`vcs/cli.mjs`'s VERBS) defines no
// approve verb. `postVerdict` only ever calls `prReviewComment` (PR verdicts,
// `mode !== 'ruling'`) or `issueComment` (issue rulings, `mode === 'ruling'`),
// plus `labelAdd` for `reviewed:stale` (anti-stale) and `needs-decision`
// (escalation inbox, H1-5b, only when `escalate: 'human'` and the post
// actually landed) — both through `guardedLabelAdd`, never bare.
//
// Standing condition 1 (issue #266 comment 5004345710, "the constant is the
// seed, not the fence"): the `reviewed:stale` labelAdd is folded through
// `deny-set.mjs`'s `guardedLabelAdd` — the SAME hardcoded chokepoint every
// reviewer label add (this module's and `board.mjs`'s, H1-5b) passes
// through. Behavior is unchanged (`reviewed:stale` matches `reviewed:*` —
// allowed), but the label now clears the same fence, not a bare provider call.
//
// Escalation inbox, post half (H1-5b, candidate 4993202904, decided IN by
// plan 5011584432): when the verdict being posted carries
// `escalate: 'human'` (rulings always do — REQ-H1-11; `rev >= 3` also forces
// it — REQ-H1-6) AND the post actually lands (not skipped by anti-stale or
// anti-loop — an unposted verdict never touched this head, so nothing to
// escalate), the caller applies `needs-decision` through the same
// `guardedLabelAdd` chokepoint. This is what makes an escalation visible in
// `brain:review:queue`'s pending-escalations section (queue.mjs, REQ-H1-12).
// Removing `needs-decision` once the human decides is OUT OF SCOPE for H1 —
// a human/manual keystroke, not automated here.

import { getVcs } from '../vcs/cli.mjs';
import { guardedLabelAdd } from './deny-set.mjs';
import { hasUsableAnchor } from './verdict.mjs';
import { verdictsAtHead } from './lib/parse-verdict.mjs';

const STALE_LABEL = 'reviewed:stale';
const ESCALATION_LABEL = 'needs-decision';

/**
 * Derives the provider-neutral inline comments from a verdict's findings
 * (issue #405, REQ-405-2). PURE — no I/O, no provider shape beyond the three
 * fields the contract names.
 *
 * A finding yields a comment only when it carries a non-empty `file` AND a `line`
 * that coerces to a POSITIVE INTEGER. A half anchor is not an anchor: GitHub 422s
 * a comment with no line, so passing one would spend the un-anchorable fallback on
 * a finding already known not to attach — and the dropped-count would then report
 * a defect of ours as a defect of the diff.
 *
 * "Positive integer" rather than "present" is the round-10 correction. Presence was
 * all the guard checked, so `line: 'abc'` went out as `line: null` and `line: ''`
 * as `line: 0` — diff lines are 1-based, so both are anchors already known not to
 * attach, which is the exact cost this guard's own contract says it avoids. The
 * coercion is the same one the value needs anyway: `parseVerdict` returns entry
 * scalars as text, so a round-tripped `line` arrives as `'42'`.
 *
 * Returns `[]` when nothing is anchored. The VERB is what decides that an empty
 * array means "no inline requested"; this function does not fabricate a request.
 *
 * @param {Array<{id?:string, evidence?:string, file?:string, line?:number}>} findings
 * @returns {Array<{path:string, line:number, body:string}>}
 */
export function deriveInlineComments(findings = []) {
  const out = [];
  for (const f of findings ?? []) {
    if (!hasUsableAnchor(f)) continue;
    out.push({ path: f.file, line: Number(f.line), body: `${f.id ? `**${f.id}** — ` : ''}${f.evidence ?? ''}` });
  }
  return out;
}

/**
 * @param {object} args
 * @param {string} args.headSha        The run's own anchor (bound at cold boot).
 * @param {string} args.project
 * @param {number} args.number
 * @param {string} [args.provider]
 * @param {'tranche'|'checkpoint'|'ruling'} args.mode  Selects the write verb (design.md §6).
 * @param {string} args.renderedBody   The rendered `brain-review/1` block (verdict.mjs's renderVerdict).
 * @param {string} args.reviewerHandle
 * @param {Array<{head_sha:string, verdict:string, author:string|null}>} [args.priorVerdicts]
 *   Prior `brain-review/1` blocks on the thread, oldest-first (cold-boot's `doctrine.priorVerdicts`).
 * @param {'human'|null} [args.escalate]
 *   The verdict's own `escalate` field (`buildVerdict`'s output, verdict.mjs). When `'human'` AND the
 *   post actually lands, `needs-decision` is applied (escalation inbox, H1-5b).
 * @param {Array<object>} [args.findings]
 *   The BUILT verdict's findings (issue #405) — the population the rendered body actually claims,
 *   not the evaluator's. Ones carrying `file`+`line` become inline comments on the PR path only.
 * @param {{ getVcs?: Function, reResolveHead?: Function }} [args.deps]
 * @returns {Promise<{ posted: true, result: object, inlineDropped?: number }
 *   | { posted: false, skipped: 'anti-loop'|'anti-stale' }
 *   | { posted: false, error: string }>}
 *   `inlineDropped` is ABSENT when no anchor was lost, never 0.
 *   `posted: false` has two shapes and they are different facts: `skipped` is a
 *   DECISION not to post (the guards above), `error` is a post the forge REFUSED
 *   (#766). A caller that collapses them would report a 403 as a policy skip.
 */
/**
 * wouldRepeatLastVerdict() — would posting now repeat THIS reviewer's own last
 * verdict at this head? PURE, and exported because it must have exactly ONE
 * definition (judgment:cold-2 of the third cold review).
 *
 * `postVerdict` is where the answer is ENFORCED, and it is not where the answer
 * is first knowable. Every input — the prior verdicts, the handle, the head SHA —
 * is in hand at `cli.mjs`'s stage spawn, hundreds of lines before the poster is
 * reached. Until this was extracted, a second `brain:review` on an unchanged
 * head paid a full engine run (`STAGE_TIMEOUT_MS` is ten minutes) and then
 * posted nothing: the run did all the work, then discovered it need not have.
 *
 * IT IS ONE FUNCTION RATHER THAN TWO CHECKS BY DESIGN. This file already
 * learned that lesson on the SHA half — `verdictsAtHead` is shared with the rev
 * bound precisely "so the two guards can no longer disagree silently about what
 * the same review iteration means". A second copy of this predicate at the call
 * site would be the same defect one layer up: the cheap early check and the real
 * lock drifting apart, with the early one deciding to skip runs the lock would
 * have posted.
 *
 * The AUTHOR half is what makes it a self-loop guard rather than a rev bound: it
 * refuses to repeat ITSELF, while the bound counts every reviewer's verdicts at
 * this head.
 *
 * THE LOCK READS CONTROLS, NOT EXISTENCE (issue #829). A last verdict that
 * carries `controls_not_applied: ["inferential"]` is HALF a verdict — the
 * judgment half never ran at this head — and a run that WOULD apply that half
 * repeats nothing: there is no reasoned output here, read or unread. Measured
 * on PR #828: two half-runs at one head, and the only way to a full verdict
 * was moving the head with a docs commit whose sole purpose was defeating this
 * lock. Loop safety is preserved on every other arm: a FULL last verdict still
 * locks, a half repeated by another WOULD-BE half still locks, and a legacy
 * verdict with no controls line still locks — absence of the field is not
 * evidence the half was skipped.
 *
 * @param {{priorVerdicts?: Array<{author?: string, controls_not_applied?: string[]}>,
 *          reviewerHandle?: string, headSha?: string,
 *          nextAppliesInferential?: boolean}} args
 * @returns {boolean}
 */
export function wouldRepeatLastVerdict({ priorVerdicts = [], reviewerHandle, headSha, nextAppliesInferential = false } = {}) {
  const list = Array.isArray(priorVerdicts) ? priorVerdicts : [];
  const lastVerdict = list.length > 0 ? list[list.length - 1] : null;
  const mineAtHead = Boolean(
    lastVerdict &&
    lastVerdict.author === reviewerHandle &&
    verdictsAtHead([lastVerdict], headSha).length === 1
  );
  if (
    mineAtHead &&
    nextAppliesInferential &&
    Array.isArray(lastVerdict.controls_not_applied) &&
    lastVerdict.controls_not_applied.includes('inferential')
  ) {
    return false;
  }
  return mineAtHead;
}

export async function postVerdict({
  headSha,
  project,
  number,
  provider,
  mode,
  renderedBody,
  reviewerHandle,
  nextAppliesInferential = false,
  priorVerdicts = [],
  findings = [],
  escalate = null,
  deps = {},
} = {}) {
  // Anti-loop FIRST (protocol §10, "comment loop"): purely computed from
  // already-loaded cold-boot data — actor lock AND sha lock, both. No vcs
  // call is made at all when it fires (cheapest check, and "skip" means
  // exactly that: not even a re-fetch).
  //
  // The ACTOR half rests on an invariant established elsewhere, and it is named
  // here because it was false in production (issue #501). `reviewerHandle` is the
  // CONFIGURED handle; `lastVerdict.author` is whoever actually wrote. They are
  // the same identity only because `identity.mjs` verifies the handle against the
  // reviewer token (#413) AND the port is bound to that same token, so the writes
  // carry it (#501). Before the second half existed the reviewer verified as
  // `csrinaldibot` and posted under the operator's ambient gh login, so this
  // comparison could never be true: the lock SAW its own prior verdict — `rev: 2`
  // proves `prReviews` returned it and `parseVerdict` parsed it — and disowned it.
  // Measured on PR #500: two identical verdicts at `663d850`, and `rev` climbing
  // on every further run until §7 escalates to a human on a PR nothing changed on.
  // The SHA half is `verdictsAtHead`'s definition (#506) — the rev bound now cites
  // the same one, so the two guards can no longer disagree silently about what "the
  // same review iteration" means. The AUTHOR half is this lock's own addition and is
  // the difference between them: the bound counts every reviewer's verdicts at this
  // head, while the lock only refuses to repeat ITSELF.
  if (wouldRepeatLastVerdict({ priorVerdicts, reviewerHandle, headSha, nextAppliesInferential })) {
    return { posted: false, skipped: 'anti-loop' };
  }

  const getVcsFn = deps.getVcs ?? getVcs;
  const vcs = await getVcsFn({ provider });

  // Anti-stale (protocol §10, "stale verdict"): re-resolve the head against
  // the server; if it moved since cold boot captured `headSha`, the verdict
  // is bound to a tree that no longer exists at the tip — post nothing, mark
  // the run `reviewed:stale` (the ONLY label this module ever applies).
  const reResolveHead = deps.reResolveHead ?? (async () => (await vcs.prView({ project, number })).headRefOid);
  const currentHead = await reResolveHead();
  if (currentHead !== headSha) {
    await guardedLabelAdd(vcs, { project, number, labels: [STALE_LABEL] });
    return { posted: false, skipped: 'anti-stale' };
  }

  // R1: mode === 'ruling' → issueComment (rulings post on the issue thread);
  // every other mode → prReviewComment. Neither verb has an APPROVE state, on
  // either provider — but NOT by the same mechanism, and saying "hardcodes
  // `event: 'COMMENT'` on both providers" (as this comment did until #580) is
  // false for one of them. GitHub hardcodes `event: 'COMMENT'` at every call
  // site in `axes/vcs/adapters/github.mjs`. GitLab has no review-event concept at all:
  // a plain note is posted and there is no APPROVE state for it to reach —
  // structurally stronger, and a different fact (REQ-266-3, and gitlab.mjs's
  // own `prReviewComment` JSDoc, which had it right all along).
  // #405: anchored findings ride the SAME call as the body on the PR path.
  // `issueComment` (rulings) has no inline surface, so nothing is passed there —
  // a silently-ignored argument is worse than an absent one.
  const postFn = mode === 'ruling' ? vcs.issueComment : vcs.prReviewComment;
  const comments = mode === 'ruling' ? [] : deriveInlineComments(findings);
  const result = await postFn(
    comments.length > 0
      ? { project, number, body: renderedBody, comments }
      : { project, number, body: renderedBody },
  );

  // #766: READ the answer. `prReviewComment` and `issueComment` are never-throws
  // and return `{ url } | { url: null, error }` (vcs-contract.md) — a refused
  // write is a VALUE here, not an exception, so a caller that does not branch on
  // it reports a post that never happened. Measured on PR #765: a fine-grained
  // PAT that could read and not write returned HTTP 403, and the run printed a
  // complete verdict and exited 0 while the server held `reviews=0`.
  //
  // This is `evidence-reader-empty-on-failure` inverted: there a READER turns
  // "could not obtain" into "genuinely empty"; here a WRITER turned "refused"
  // into "posted". It was also the one branch in this module that did not fail
  // closed — anti-loop and anti-stale above both already return `posted: false`.
  //
  // The test is `!result?.url` and not `result?.error`, deliberately: an
  // off-contract answer carrying NEITHER field is silence, and reading silence
  // as success is the defect this closes. The cost is stated rather than hidden —
  // GitHub's `prReviewComment` also answers `{ url: null, error }` when the POST
  // SUCCEEDED and its echo would not parse, so that case now reports a failure
  // over a write that landed. That direction is the safe one: the next run
  // re-reads `priorVerdicts`, and the anti-loop lock above refuses the duplicate.
  // The inverse — silence over a 403 — has no such guard anywhere.
  if (!result?.url) {
    return {
      posted: false,
      error: result?.error ?? 'the write verb returned neither a url nor an error',
    };
  }

  // Escalation inbox, post half: only reachable once the verdict actually
  // landed at this head (past anti-stale, anti-loop, AND a refused write — #766
  // added the third; `needs-decision` over a verdict nobody can read points a
  // human at an empty thread) — an unposted verdict never bound to the current
  // tree, so nothing to escalate yet.
  if (escalate === 'human') {
    await guardedLabelAdd(vcs, { project, number, labels: [ESCALATION_LABEL] });
  }

  // REQ-405-4: surface the dropped-anchor count to the caller. ABSENT when
  // nothing was dropped, never 0 — the poster must not turn the verb's honest
  // distinction into "no inline comments appeared" one layer up.
  return result?.inlineDropped
    ? { posted: true, result, inlineDropped: result.inlineDropped }
    : { posted: true, result };
}
