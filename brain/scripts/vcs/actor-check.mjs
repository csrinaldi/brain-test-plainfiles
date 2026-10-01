// actor-check.mjs — L5 human-approval actor check: pure evaluator + gh I/O wrapper
// + CLI (design §5, REQ-L5-1, REQ-L5-2). Sibling to phase-order-check.mjs.
//
// Pure evaluator (evaluateActor) takes plain data — no gh, no filesystem — so it
// is fully unit-testable with fixture events. The gh I/O wrapper resolves the
// issue referenced by the PR body (reusing the same Closes/Fixes/Resolves/Part-of
// extraction rules governance.yml's issue-link job already enforces in bash),
// fetches the approved-label labeling history via `gh api .../events`, and
// feeds evaluateActor. All I/O is dependency-injectable via `deps` (same
// CI-fragility discipline as run-check.mjs / phase-order-check.mjs) — no test
// spawns a real gh process.
//
// The approved label is config-driven and provider-resolved (issue #231 A2
// phase 1, design.md Decision 4): `resolveApprovedLabel()` reads
// `governance.approvedLabel` from brain.config.json and maps it per VCS
// provider. This file never hardcodes the label literal.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadBrainConfigOrThrow } from '../lib/brain-config.mjs';
import { loadContext, resolveDetectionBody, gitlabApiConfig } from './ci-context.mjs';
import { getVcs } from './cli.mjs';
import { resolveApprovedLabel } from '../governance/approved-label.mjs';
import { CLOSING_RE, CHAIN_RE } from '../governance/checks/issue-ref-patterns.mjs';
import { resolveTier, tierParams, resolveGatePolicy } from './governance-tiers.mjs';
import { parseDecision } from '../review/lib/decision-block.mjs';
import { extractFencedBlock, scalar } from '../review/lib/yaml-block.mjs';

// ── Pure evaluator (design §5 step 5) ───────────────────────────────────────

/**
 * Compares the approved-label event's timestamp against the PR's head-commit
 * timestamp (issue #358 Q5 Phase 4, REQ-L5-1' `lite` evidence: "distinct
 * act"). Pure — a plain millisecond comparison, no I/O.
 *
 * @param {string|null|undefined} labelCreatedAt  The approved-label add
 *   event's timestamp (ISO 8601).
 * @param {string|null|undefined} headCommitAt  The PR's head commit's
 *   timestamp (ISO 8601, `prCommits()`'s last entry's `at`).
 * @returns {boolean|null}  `true` when the label strictly postdates the head
 *   commit (a satisfiable "distinct act"), `false` when it does not (the
 *   approval predates the code it approves), `null` when either timestamp is
 *   missing — uncomputable, never assumed either way.
 */
export function compareTimestamps(labelCreatedAt, headCommitAt) {
  if (!labelCreatedAt || !headCommitAt) return null;
  return new Date(labelCreatedAt).getTime() > new Date(headCommitAt).getTime();
}

/**
 * Is this commit FOREIGN to the approval? (ADR-0026 Amendment 1, issue #418.)
 *
 * Foreign = authored by neither the approver nor a registered
 * `governance.agentActors` identity. Only a foreign commit re-arms an
 * existing approval at `lite`.
 *
 * `governance.reviewActors` was in that set until #581 (Amendment 5) removed
 * it: a read-only identity has no commits to exempt, so its presence here only
 * ever mattered in the off-nominal case it should have been catching.
 *
 * The test keys off the login the PROVIDER attributes the commit to — never
 * the commit header's name/email, which anyone can spell. An unresolvable
 * login is therefore foreign, not exempt: the relief never extends to an
 * identity the platform cannot vouch for. Two consequences are recorded in
 * the amendment rather than discovered later: GitLab resolves no logins today
 * (`login: null`, prCommits' documented residual) so it keeps the pre-
 * amendment behavior wholesale, and commits attributed to no account at all
 * (e.g. an agent session committing as a bare `noreply@` identity) keep
 * re-arming too.
 *
 * Logins fold case — they are case-insensitive on both providers, and
 * refusing on case alone would be a false positive.
 *
 * @param {{ login?: string|null }} commit
 * @param {string[]} exempt  Approver + agentActors, already collected.
 * @returns {boolean}
 */
function isForeignCommit(commit, exempt) {
  const login = commit?.login;
  if (!login) return true; // unresolvable authorship — fail closed
  return !exempt.some(e => e && String(e).toLowerCase() === String(login).toLowerCase());
}

/**
 * `lite`'s REQ-L5-1' evidence: **distinct act over foreign commits**
 * (ADR-0026 Amendment 1, issue #418) — the approved-label event must be
 * strictly later than the latest FOREIGN commit, rather than than the head
 * commit. Self-approval is NOT checked here by design (design.md §2.A/§4):
 * a solo maintainer applying their own approval satisfies `lite` on its own,
 * evidence-tiered terms.
 *
 * Why the target moved: at `lite` the approver is *allowed* to be the author,
 * so comparing against the head commit asked "did you keep working on your
 * own branch" rather than "did someone slip work past the reviewer" — a
 * question whose cost scales with iteration count and whose value at n=1 is
 * near zero. It also made every automated fix-push demand a fresh human
 * signature, which would defeat the reviewer loop #409 is building toward.
 * The stale-green property #328 fixed is retained in full against every actor
 * whose work the approver has not seen: any third-party push still re-arms.
 *
 * ISSUE #581 REMOVES the `reviewActors` exemption Amendment 1 introduced here
 * (REQ-418-3), on the maintainer's ruling of 2026-08-12 that `reviewActors` is
 * READ-ONLY. Amendment 5 records it. The reasoning, kept because the removal
 * looks like a tightening for its own sake otherwise:
 *
 * A read-only identity authors no commits. That leaves two states and the
 * exemption was wrong in both. In the NORMAL state it exempted a case that
 * cannot arise — dead weight in a security predicate, which is not neutral: it
 * read as "we expect commits from this identity", contradicting the role
 * `reviewer-protocol.md` §4 defines (four COMMENT-only verbs, no git path). In
 * the OFF-NOMINAL state — a commit appearing under a review identity via a
 * compromised token or a misregistration — the re-arm rule is exactly what
 * should fire, and the exemption is what stopped it, carrying an approval over
 * a commit no human saw. Zero value where it was aimed, negative where it fired.
 *
 * The #413 token verification that made the exemption "safe" is not what
 * changed; the ruling is that a read-only identity should never have had
 * commits to exempt in the first place.
 *
 * Fails CLOSED (never warn) once a labeled event exists but the timing cannot
 * be established — spec.md REQ-L5-1': "an unreadable approval is not an
 * approval." (The "no labeled event AT ALL yet" case is handled earlier, by
 * the shared warn+pass branch in `evaluateActor` — REQ-L5-2 — before this
 * function ever runs.)
 *
 * `agentActors` (issue #454, Amendment 3) joins the same exempt set for the same
 * reason, one step further out: the gate's purpose is "the approval postdates work
 * the approver has seen", and it is not served by re-arming on commits the
 * approver's own agent made under their instruction. It is served against commits
 * from OUTSIDE the approved loop, which is what stays foreign. See
 * `defaultReadAgentActors` for why this is a separate key, why it ships absent,
 * and what the exemption does NOT prove.
 *
 * @param {{ actor: string|undefined, labelCreatedAt: string|undefined, commits: Array<{ at?: string, login?: string|null }>|null, agentActors?: string[] }} input
 * @returns {{ level: 'pass'|'fail', reason: string }}
 */
function evaluateDistinctAct({ actor, labelCreatedAt, commits, agentActors = [] }) {
  // An approval whose own timestamp is unreadable is not an approval —
  // checked BEFORE the foreign-commit search, which would otherwise let a
  // timestamp-less label through the no-foreign-commit branch below. Pre-
  // Amendment-1 this was implicit (compareTimestamps returned null and the
  // comparison failed); Amendment 1 adds a path that never reaches that
  // comparison, so the invariant has to be stated outright.
  if (!labelCreatedAt) {
    return {
      level: 'fail',
      reason:
        'the approved-label event carries no timestamp — cannot verify the "lite" tier\'s distinct-act ' +
        'evidence (REQ-L5-1′, ADR-0026 Amendment 1); an unreadable approval is not an approval.',
    };
  }

  // Uncomputable commit data is unreadable evidence, not "no foreign commit" —
  // it must not fall through to the satisfied-by-default branch below.
  if (!Array.isArray(commits) || commits.length === 0) {
    return {
      level: 'fail',
      reason:
        'the PR\'s commit list is unreadable — cannot verify the "lite" tier\'s distinct-act ' +
        'evidence (REQ-L5-1′, ADR-0026 Amendment 1); an unreadable approval is not an approval.',
    };
  }

  const exempt = [actor, ...agentActors].filter(Boolean);
  const foreign = commits.filter(c => isForeignCommit(c, exempt));

  // No foreign commit: every commit on the branch is the approver's or a
  // verified reviewer identity's, so there is nothing the approval has not
  // already seen. Any approval event satisfies the evidence (REQ-418-5).
  if (foreign.length === 0) {
    return {
      level: 'pass',
      reason:
        `the approved label was applied by "${actor ?? 'unknown'}" at ${labelCreatedAt ?? 'an unreadable time'}; ` +
        'every commit on the branch is authored by the approver or a registered governance.agentActors ' +
        'identity, so no push re-arms the approval — distinct-act evidence satisfied at the "lite" tier ' +
        '(REQ-L5-1′, ADR-0026 Amendments 1, 3 and 5).',
    };
  }

  const latestForeign = foreign[foreign.length - 1];
  const foreignAt = latestForeign?.at;

  if (!foreignAt) {
    return {
      level: 'fail',
      reason:
        `the latest foreign commit (authored by "${latestForeign?.login ?? 'an unresolvable identity'}") has an ` +
        'unreadable timestamp — cannot verify the "lite" tier\'s distinct-act evidence (REQ-L5-1′, ' +
        'ADR-0026 Amendment 1); an unreadable approval is not an approval.',
    };
  }

  const distinctAct = compareTimestamps(labelCreatedAt, foreignAt);
  if (distinctAct !== true) {
    return {
      level: 'fail',
      reason:
        `the approved label was applied at ${labelCreatedAt ?? 'an unreadable time'}, not strictly after the ` +
        `latest foreign commit — authored by "${latestForeign.login ?? 'an unresolvable identity'}" and pushed at ` +
        `${foreignAt} — so the approval predates work the approver has not seen. Re-apply the approved label ` +
        'after reviewing that commit (REQ-L5-1′ "lite" evidence, ADR-0026 Amendment 1).',
    };
  }

  return {
    level: 'pass',
    reason:
      `the approved label was applied by "${actor ?? 'unknown'}" at ${labelCreatedAt}, strictly after the latest ` +
      `foreign commit — authored by "${latestForeign.login ?? 'an unresolvable identity'}" and pushed at ` +
      `${foreignAt} — distinct-act evidence satisfied at the "lite" tier (REQ-L5-1′, ADR-0026 Amendment 1).`,
  };
}

const DECISION_PROTOCOL_PREFIX_RE = /^brain-decision\//;
const SUPPORTED_DECISION_PROTOCOL = 'brain-decision/1';

/**
 * Peeks at a review body's raw `protocol` scalar WITHOUT validating the rest
 * of the block — used only to distinguish "not addressed to this reader"
 * (design.md §E2 rule 3, silent) from "addressed but an unsupported version"
 * (rule 4, refuse). Reuses the SAME fence/scalar primitives `parseDecision`
 * itself uses (`yaml-block.mjs`), never a second, divergent reader.
 *
 * @param {unknown} body
 * @returns {string|null}
 */
function sniffDecisionProtocol(body) {
  if (typeof body !== 'string' || body.length === 0) return null;
  const block = extractFencedBlock(body);
  return block === null ? null : scalar(block, 'protocol');
}

/**
 * Pure: which config key put this identity in the deny-set, phrased for an
 * operator (#124).
 *
 * ONE helper, because there are TWO places a deny is reported — the label
 * branch and rule 15's signed-decision note — and the first cut of #124 taught
 * only the first one to name the key. Round 1 of the review measured the
 * second still saying `governance.reviewActors` for an identity that is only in
 * `governance.agentActors`: the same message repaired on one path and left
 * wrong on the other, which is the shape this session keeps paying for.
 *
 * @param {string} actor
 * @param {string[]} agentActors
 * @returns {{key: string, clause: string}}
 */
/**
 * Pure: is this actor in the deny-set? (#124 review round 5.)
 *
 * EXPORTED because the deny is asked in TWO places — L5's read gate here and
 * `approve/cli.mjs`'s write-side lock — and this PR fixed the case-folding on
 * one of them three separate times before extracting the predicate. A rule
 * asked twice is a rule that will be answered differently; a scalar where a
 * list was configured becomes a one-element list rather than an empty one, so
 * a missing bracket cannot silently disable the gate.
 *
 * @param {string|undefined} actor
 * @param {string[]|string} denyActors
 * @returns {boolean}
 */
export function isDeniedActor(actor, denyActors) {
  if (!actor) return false;
  const list = Array.isArray(denyActors)
    ? denyActors
    : (typeof denyActors === 'string' && denyActors ? [denyActors] : []);
  const a = String(actor).toLowerCase();
  return list.some((d) => d && String(d).toLowerCase() === a);
}

export function denyingList(actor, agentActors = []) {
  const isAgent = Array.isArray(agentActors)
    && agentActors.some((a) => a && String(a).toLowerCase() === String(actor).toLowerCase());
  return isAgent
    ? { key: 'governance.agentActors', clause: 'an agent identity' }
    : { key: 'governance.reviewActors', clause: 'a review identity' };
}

/**
 * `brain-decision/1` as a PEER `lite` evidence source (design.md §C2, issue
 * #473). A sibling of `evaluateDistinctAct`, not a branch inside it — this
 * function speaks its own vocabulary (which diff did a human sign, and who)
 * and never returns a verdict shape (`{level,reason}`), only `{admitted}`
 * (design.md §C3): a verdict-shaped return is exactly what a careless caller
 * would pass straight through, and a stray `level:'fail'` escaping from a
 * NON-admissible block would break the composite's monotonicity guarantee
 * (§C4 — refusal ANNOTATES, it never blocks).
 *
 * Every review in `decisions` addressed to this reader (protocol starts
 * `brain-decision/`) is evaluated in order — design.md §E2 rule 16: admit if
 * ANY is admissible, collect the others' notes. Reviews carrying no fence, or
 * a fence for a DIFFERENT protocol family entirely, are silent (rules 2/3) —
 * they contribute nothing, not even a note.
 *
 * @param {object} input
 * @param {Array<{state?:string, author?:string|null, body?:string}>|null} input.decisions
 *   `prReviews()`'s normalized shape, or `null` when the review list itself
 *   is uncomputable.
 * @param {string|null} input.headSha  The PR's current head SHA
 *   (`resolveHeadSha(commits)`), or `null` when uncomputable.
 * @param {string[]} [input.agentActors]  `governance.agentActors` — consulted
 *   ONLY to name which config key denied the signer (#124). The verdict is the
 *   deny-set's; this picks the sentence.
 * @param {string[]} [input.denyActors]  the approval deny-set —
 *   `governance.reviewActors` ∪ `governance.agentActors` since #124 — a review
 *   identity may never SIGN an approval either (design.md §E2 rule 15,
 *   mirrors the label's own deny-before-allow rule, `actor-check.mjs:358`).
 * @returns {{admitted:true,reason:string}|{admitted:false,note:string}|null}
 */
export function evaluateSignedDecision({ decisions, headSha, denyActors = [], agentActors = [] } = {}) {
  // `decisions === undefined` means the caller never threaded the field at
  // all — a LEGACY caller predating issue #473 (PR #503 cold-review round 1,
  // finding 3). That is not "a fetch was attempted and came back
  // uncomputable" (`decisions === null`, which DOES warrant the note below);
  // it is silence, exactly like rules 2/3's "nothing addressed to this
  // reader". Treating it as `null` would append a `(brain-decision/1: ...)`
  // annotation onto every pre-existing caller's verdict, breaking the
  // byte-for-byte reason-string identity the spec promises for callers this
  // change never touched.
  if (decisions === undefined) return null;

  if (decisions === null) {
    return {
      admitted: false,
      note: '(brain-decision/1: the PR review list is unreadable — a signature could not be verified.)',
    };
  }

  if (!Array.isArray(decisions) || decisions.length === 0) return null;

  const notes = [];
  let addressed = false;

  for (const review of decisions) {
    const body = review?.body;
    const protocol = sniffDecisionProtocol(body);
    if (protocol === null || !DECISION_PROTOCOL_PREFIX_RE.test(protocol)) continue; // rules 2/3: silent

    addressed = true;

    if (protocol !== SUPPORTED_DECISION_PROTOCOL) {
      notes.push(
        `(brain-decision/1: unsupported protocol version "${protocol}" — this reader only understands "${SUPPORTED_DECISION_PROTOCOL}".)`,
      );
      continue; // rule 4
    }

    const parsed = parseDecision({ body });
    if (parsed === null) {
      notes.push('(brain-decision/1: the block is missing a required field, or is otherwise malformed — not admissible.)');
      continue; // rules 5, 6, 7, 8, 9, 12
    }

    // Fail-closed on ANY non-string headSha (PR #503 cold-review round 1,
    // finding 2), not just `null` — `undefined` (never resolved/threaded) or
    // a non-string (e.g. a number, from a malformed caller) reached
    // `.toLowerCase()` below and THREW instead of refusing. The contract is
    // "never throws, refuse instead"; null semantics are preserved exactly
    // (typeof null !== 'string').
    if (typeof headSha !== 'string') {
      notes.push('(brain-decision/1: cannot resolve the PR head — the signature could not be verified.)');
      continue; // rule 11
    }

    if (parsed.head_sha.toLowerCase() !== headSha.toLowerCase()) {
      notes.push(
        `(brain-decision/1: the signature names ${parsed.head_sha}, the PR head is ${headSha} — re-sign the current head.)`,
      );
      continue; // rule 10
    }

    const author = review?.author;
    if (!author) {
      notes.push('(brain-decision/1: the review has no resolvable author — an unresolvable identity is not an identity.)');
      continue; // rule 13
    }

    if (String(parsed.actor).toLowerCase() !== String(author).toLowerCase()) {
      notes.push(
        `(brain-decision/1: the block claims to be signed by "${parsed.actor}" but was posted by "${author}".)`,
      );
      continue; // rule 14
    }

    // Deny if EITHER the review author OR the block's claimed actor is in
    // the deny set (PR #503 cold-review round 1, finding 4) — this invariant
    // must not depend on rule ordering. Today rule 14 (above) already forces
    // `parsed.actor === author` case-folded before this runs, so checking
    // only `author` is currently equivalent to checking both; a future
    // reorder or relaxation of rule 14 must not silently reopen this deny
    // check to a mutation that targets `parsed.actor` instead of `author`.
    if (
      denyActors.some(
        d => d && (String(d).toLowerCase() === String(author).toLowerCase() || String(d).toLowerCase() === String(parsed.actor).toLowerCase()),
      )
    ) {
      const denied = denyingList(author, agentActors);
      notes.push(
        `(brain-decision/1: "${author}" is registered in ${denied.key} — ${denied.clause} may never sign an approval.)`,
      );
      continue; // rule 15
    }

    return {
      admitted: true,
      reason:
        `a brain-decision/1 APPROVE block signed by "${author}" at head ${headSha} is admissible evidence ` +
        '(REQ-473-1, issue #473).',
    };
  }

  if (!addressed) return null; // rules 2/3, aggregate: nothing addressed to this reader

  return { admitted: false, note: notes.join(' ') };
}

/**
 * The pluggable `lite` evidence-source list (design.md §C2). A future peer
 * source (e.g. a real approving review, issue #454) appends here and touches
 * nothing else in `evaluateActor` — that is the whole reason (b) is a swap.
 * Frozen: the default list is never mutated in place.
 */
export const LITE_SIGNED_EVIDENCE_SOURCES = Object.freeze([evaluateSignedDecision]);

/**
 * The scope note the deny branch appends: WHAT signed evidence it did not look
 * at (issue #673). It reports; it never votes.
 *
 * The deny branch returns before the tier branch — deliberately, and the
 * ordering does not change here (issue #358 Q5: a denied identity must not slip
 * through `lite`'s narrower evidence either). The defect was that its refusal
 * therefore could not mention a signature even in principle, so
 * *"your signed decision was read and is not sufficient"* and *"your signed
 * decision was never read at all"* came out byte-identical. It is always the
 * second, and the operator had no way to know.
 *
 * FOUR states, kept distinct on purpose:
 *
 *   1. The review list is UNCOMPUTABLE (`decisions === null`) → say the
 *      existence of a block is UNKNOWN. This branch exists because the first
 *      version of this function did not have it, and a cold review caught what
 *      that cost: `null` fell through to state 3 and was rendered as "a block
 *      is present but is NOT admissible", telling an operator who may never
 *      have signed anything to go correct a block that may not exist. That is
 *      `evidence-reader-empty-on-failure` — the exact family this function was
 *      written to close — reintroduced one state to the left. `null` is not a
 *      determinate value and must never be reported as one (#604: "could not
 *      establish" is not "established clean"). It is reachable by construction,
 *      not only on failure: `gatherActorCheckInputs` threads `null` whenever
 *      `prNumber` does not resolve.
 *   2. An admissible block exists → say it was NOT EVALUATED (never "not
 *      sufficient" — that is the confusion this exists to end) and name the
 *      remedy that actually works: re-apply the label as a human.
 *   3. A block addressed to this reader exists but is not admissible → say
 *      that, carrying the source's own note, and stop there. Promising it "will
 *      be read" would be false; so is a universal "correct the block", because
 *      in three of the source's own refusal rules there is nothing about the
 *      block to correct — the head is unresolvable (rule 11), the review's
 *      author metadata is (rule 13), or the block is structurally perfect and
 *      signed by a review identity, whose only remedy is a DIFFERENT signer
 *      (rule 15). The source's note already states the specific remedy where
 *      one exists; this sentence defers to it instead of overriding it.
 *   4. Nothing addressed to this reader → RETURN EMPTY. A message implying an
 *      ignored signature where none exists is the same defect pointed the other
 *      way, and `decisions === undefined` (a legacy caller that never threaded
 *      the field) lands here too, so those callers' reason strings stay
 *      byte-for-byte what they were.
 *
 * Silent outside `lite` for the same honesty reason: no other tier consults
 * `signedEvidenceSources` at all, so at `standard`/`regulated` a signature is
 * not evidence that was skipped — it is not evidence. "Re-apply as a human and
 * this will be read" would be a confident answer about the wrong subject.
 *
 * Reads through the SAME `signedEvidenceSources` list the `lite` branch uses,
 * so a source added tomorrow is described here without a second edit, and this
 * note can never describe an admissibility rule the evidence branch no longer
 * applies.
 *
 * @param {object} input
 * @param {'lite'|'standard'|'regulated'} input.tier
 * @param {Array<{state?:string, author?:string|null, body?:string}>|null} [input.decisions]
 * @param {string|null} [input.headSha]
 * @param {string[]} [input.denyActors]
 * @param {Function[]} [input.signedEvidenceSources]
 * @returns {string}  A note to append to the deny reason, or `''` for silence.
 */
export function describeUnevaluatedSignedEvidence({
  tier,
  decisions,
  headSha = null,
  denyActors = [],
  agentActors = [],
  signedEvidenceSources = LITE_SIGNED_EVIDENCE_SOURCES,
} = {}) {
  if (tier !== 'lite') return '';

  // State 1 — an unreadable review list is not evidence of anything, in either
  // direction. Answered before the sources are consulted because this is a fact
  // about the INPUT, not a verdict any source returns.
  if (decisions === null) {
    return (
      ' Whether a signed brain-decision/1 block exists on this PR is UNKNOWN — the PR review list could not ' +
      'be read, so this refusal weighs it neither way. The deny above precedes the tier\'s evidence forms ' +
      'regardless (#358 Q5).'
    );
  }

  // A non-array `denyActors` (a scalar where a list was configured) reached
  // `.some()` here and THREW, on a path that returned a clean `fail` before
  // this function existed — a reporting helper must not be able to convert a
  // verdict into a crash. `defaultReadDenyActors` already guards the shipped
  // path; this keeps the guarantee for every other caller.
  const denies = Array.isArray(denyActors) ? denyActors : [];

  const notes = [];
  for (const source of signedEvidenceSources) {
    const signed = source({ decisions, headSha, denyActors: denies, agentActors });
    if (signed?.admitted) {
      return (
        ' A signed brain-decision/1 block IS present on this PR and was NOT evaluated: the deny-set is a ' +
        'tier-agnostic identity gate and precedes the tier\'s evidence forms (#358 Q5). Re-apply the label ' +
        'as a human and this signature will be read.'
      );
    }
    if (signed?.note) notes.push(signed.note);
  }

  if (notes.length === 0) return '';

  return (
    ' A brain-decision/1 block is present on this PR but is NOT admissible as it stands, and the deny above ' +
    `precedes the tier's evidence forms in any case (#358 Q5): ${notes.join(' ')} Re-apply the label as a ` +
    'human; the note above is what the block itself would need for it to be read.'
  );
}

/**
 * `regulated`'s additional REQ-L5-1' evidence beyond `standard`'s distinct
 * actor: the approver must have authored NO commit on the branch. Returns
 * `null` when the evidence is satisfied (no additional verdict — the caller
 * falls through to its own pass), or a verdict object when it is not.
 *
 * Never fails on genuinely uncomputable commit-authorship data (e.g. a
 * provider — today, GitLab — that cannot resolve commit authors to an
 * account, `prCommits()`'s documented `login: null` residual) — warns
 * instead, the same zero-false-positive discipline REQ-L5-2 established for
 * missing labeled-event evidence.
 *
 * @param {{ actor: string|undefined, commits: Array<{ login: string|null }>|null }} input
 * @returns {{ level: 'warn'|'fail', reason: string }|null}
 */
function evaluateNoCommitOnBranch({ actor, commits }) {
  const resolvable = Array.isArray(commits) && commits.some(c => c.login != null);
  if (!resolvable) {
    return {
      level: 'warn',
      reason:
        `cannot verify whether "${actor ?? 'the approver'}" authored a commit on this branch — commit ` +
        'authorship is unreadable at the "regulated" tier (e.g. the provider cannot resolve commit authors ' +
        'to an account); never failing on missing evidence.',
    };
  }

  const authoredByApprover = commits.some(c => c.login === actor);
  if (authoredByApprover) {
    return {
      level: 'fail',
      reason:
        `"${actor}" authored at least one commit on this branch — the "regulated" tier requires the ` +
        'approver to have authored NO commit on the branch (REQ-L5-1′).',
    };
  }

  return null;
}

/**
 * Evaluates whether the approved-label actor satisfies REQ-L5-1's
 * tier-scoped evidence form (issue #358 Q5 Phase 4, REQ-L5-1'). Pure — no
 * gh, no filesystem access (fully testable with fixtures).
 *
 * Decision order (design §5 step 5, extended by design.md §2.A/REQ-L5-1' and
 * issue #375's deny-set):
 *   1. No `labeled` event found → warn + pass (cannot prove self-approval on
 *      missing evidence — REQ-L5-2, keeps false positives ~0). This is the
 *      "no approval yet" case, distinct from `lite`'s own fail-closed rule
 *      below, which only applies once a labeled event exists.
 *   2. `adminOverride` (an allow-listed `override:*` label is present, and
 *      honored at this tier) → pass, logged.
 *   3. Actor in `denyActors` (`config.governance.reviewActors`) → fail — a
 *      review identity may never apply the approved label (issue #375;
 *      reviewer-protocol.md §9), at ANY tier. Evaluated BEFORE the allow-list
 *      so a contradictory config resolves fail-closed, and BEFORE the tier
 *      branch below so `lite`'s narrower distinct-act evidence can never
 *      admit a denied identity either. The refusal NAMES the signed evidence
 *      that ordering skipped (issue #673,
 *      `describeUnevaluatedSignedEvidence`) — a scope note on the reason, not
 *      a change to the verdict.
 *   4. Actor in `botAllowlist` (e.g. automation acting on a human's explicit
 *      instruction) → pass.
 *   5. `lite`: distinct-act ONLY (`evaluateDistinctAct`) — self-approval is
 *      not evaluated; a solo maintainer's own late approval passes.
 *   6. `standard`/`regulated`: distinct actor — actor === author OR actor ===
 *      issueAuthor → fail (self-approval). REQ-L5-1 requires comparing
 *      against BOTH the PR author and the issue author (spec.md:398-400):
 *      the PR author and the issue author can be two different people (e.g.
 *      Bob files the issue, Alice opens the PR), and either one self-labeling
 *      their own issue counts as self-approval. This is UNCHANGED from the
 *      pre-tiering behavior (REQ-TIER-10's no-op-migration guarantee for the
 *      default `standard` tier).
 *   7. `regulated` only: additionally requires the approver authored no
 *      commit on the branch (`evaluateNoCommitOnBranch`) — REQ-L5-1'.
 *   8. Otherwise → pass (approval by an identity that is neither an author nor
 *      deny-listed). NOTE: this branch cannot verify that the actor is human —
 *      it verifies only that it is not one this repo has named. Step 3 is what
 *      keeps a known non-human out of it (issue #375).
 *
 * The "most recent" labeled event wins (handles re-labeling: remove → re-add
 * uses the latest add) — `labeledEvents` is assumed to be in the same
 * chronological order `gh api .../events` returns (ascending), so this simply
 * reads the last element.
 *
 * @param {object} input
 * @param {string} input.author  PR author login (design §5 step 1).
 * @param {string} [input.issueAuthor]  Issue author login (the issue the PR
 *   closes/references) — REQ-L5-1 requires failing on either author matching.
 * @param {Array<{ actor: { login: string }, at?: string }>} input.labeledEvents
 *   `labeled` events for the resolved approved label, chronologically
 *   ordered. `at` (the label-add timestamp) is required for `lite`'s
 *   distinct-act evidence.
 * @param {string[]} [input.botAllowlist]  Allow-listed actor logins / override
 *   label strings (`config.governance.approvalActors`).
 * @param {string[]} [input.denyActors]  DENY-listed actor logins
 *   (`config.governance.reviewActors`, issue #375) — a review identity may
 *   never apply the approved label, at any tier. Checked before
 *   `botAllowlist` and before the tier branch.
 * @param {boolean} [input.adminOverride]  Whether an allow-listed `override:*`
 *   label is present on the issue AND honored at this tier (resolved by the
 *   wrapper against `botAllowlist` — never a blanket bypass, REQ-L5-2).
 * @param {boolean} [input.overrideRefused]  Whether an allow-listed
 *   `override:*` label was present but NOT honored at this tier (issue #358
 *   Q5, REQ-TIER-6 — `regulated` refuses the label). When true, the verdict
 *   NAMES the refusal rather than silently proceeding as if the label were
 *   absent.
 * @param {'lite'|'standard'|'regulated'} [input.tier]  Selects the evidence
 *   form (REQ-L5-1') AND the `overrideRefused` message text.
 * @param {Array<{ sha: string, login: string|null, at?: string }>|null} [input.commits]
 *   The PR's commits, ascending (`prCommits()`'s normalized shape), or `null`
 *   when uncomputable. Consumed by `lite` (head-commit timestamp) and
 *   `regulated` (approver-authored-commit check) only.
 * @param {Array<{state?:string, author?:string|null, body?:string}>|null} [input.decisions]
 *   `prReviews()`'s normalized shape (issue #473), or `null` when
 *   uncomputable — this DOES annotate the fallback verdict (rule 1).
 *   `undefined`/omitted means the caller never threaded the field at all
 *   (a legacy caller) and stays silent, no annotation — PR #503 cold-review
 *   round 1, finding 3. Consumed by `lite`'s signed-evidence sources, and by
 *   the deny branch's scope note (issue #673), which reads through the same
 *   sources and likewise stays silent when the field was never threaded.
 * @param {string|null} [input.headSha]  The PR's current head SHA
 *   (`resolveHeadSha(commits)`, issue #473) — a signed decision block binds
 *   to this.
 * @param {Function[]} [input.signedEvidenceSources]  The pluggable `lite`
 *   evidence-source list (design.md §C2) — defaults to
 *   `LITE_SIGNED_EVIDENCE_SOURCES`. A test drives a fake source to prove the
 *   composite honors the LIST (order, first-admitted-wins), not a hardcoded
 *   call.
 * @returns {{ level: 'pass'|'warn'|'fail', reason: string }}
 */
export function evaluateActor({
  author,
  issueAuthor,
  labeledEvents = [],
  botAllowlist = [],
  denyActors = [],
  agentActors = [],
  adminOverride = false,
  overrideRefused = false,
  tier = 'standard',
  commits = null,
  // No default here (PR #503 cold-review round 1, finding 3): defaulting to
  // `null` would collapse "the caller never threaded this field"
  // (`undefined`) into "a fetch was attempted and came back uncomputable"
  // (`null`), and `evaluateSignedDecision` treats those two states
  // differently — see its own comment. `gatherActorCheckInputs` always
  // threads `decisions` explicitly (both return sites), so production
  // behavior is unaffected; only a hand-built input object that omits the
  // key stays silent, as it did before issue #473.
  decisions,
  headSha = null,
  signedEvidenceSources = LITE_SIGNED_EVIDENCE_SOURCES,
} = {}) {
  // ONE normalisation, here, because everything downstream inherits it — the
  // deny gate, rule 15's own `.some()`, and the report helpers. A scalar
  // `denyActors` (a string where a list was configured) used to survive the
  // gate's `.includes()` by accident and exit early; when the gate learned to
  // fold case, that accident disappeared and the scalar reached rule 15, which
  // threw. #673's test caught it in one run. A reporting helper may never turn
  // a fail into a throw, and the way to keep that true is to make the shape
  // right once rather than guard it at each use.
  //
  // A scalar STRING becomes a one-element list rather than an empty one, and
  // that direction is deliberate: `governance.reviewActors: "csrinaldibot"` is
  // a typo whose obvious meaning is that one identity. Reading it as empty
  // would silently DISABLE the deny gate on a misconfiguration — the exact
  // failure this gate exists to prevent, arriving through a missing bracket.
  // #673's test pins the fail; this keeps it for the right reason instead of
  // by way of `String#includes` matching a substring.
  denyActors = Array.isArray(denyActors)
    ? denyActors
    : (typeof denyActors === 'string' && denyActors ? [denyActors] : []);

  const withRefusalNote = result => {
    if (!overrideRefused || result.level === 'warn') return result;
    return {
      ...result,
      reason: `${result.reason} (an override:* label was present but is not honored at the "${tier}" tier — refusing the bypass, REQ-TIER-6.)`,
    };
  };

  if (labeledEvents.length === 0) {
    return {
      level: 'warn',
      reason:
        'no labeled event found for the approved label — cannot verify the approval actor; ' +
        'never failing on missing evidence (REQ-L5-2).',
    };
  }

  const lastEvent = labeledEvents[labeledEvents.length - 1];
  const actor = lastEvent?.actor?.login;
  const labelCreatedAt = lastEvent?.at;

  if (adminOverride) {
    return {
      level: 'pass',
      reason: `admin override present (allow-listed override:* label) — approval actor check bypassed (actor: ${actor ?? 'unknown'}).`,
    };
  }

  // DENY before ALLOW (issue #375). `denyActors` comes from
  // `governance.reviewActors` — the same key L6 reads to exclude an identity
  // from the human-approver count. Both readings are restrictive and say the
  // same thing: this identity is not a human authority. See the ADR for why
  // ruling R2 ("no key feeds two gates") is knowingly excepted here.
  //
  // Placed ABOVE the allow-list on purpose: `reviewer-identity-config.test.mjs`
  // already asserts the two lists never overlap in the shipped config, so this
  // ordering only decides a contradictory config — and it must resolve
  // fail-CLOSED. A misregistration must not hand the reviewer the merge
  // keystroke.
  //
  // Deliberately BELOW `adminOverride`: that is the documented, logged human
  // recovery path (workflow-governance.md), and #375 scopes rule 2 out.
  //
  // Deliberately ABOVE the tier branch (issue #358 Q5): a denied identity must
  // never slip through `lite`'s narrower distinct-act evidence either — the
  // deny-set is a tier-agnostic identity gate, not part of REQ-L5-1's
  // evidence form.
  //
  // The refusal STATES ITS SCOPE (issue #673). The verdict is unchanged and
  // correct — `describeUnevaluatedSignedEvidence` reports, it never votes — but
  // a deny that cannot mention the signature reads identically whether the
  // signature was weighed and found wanting or never read at all. It is always
  // the latter, and on PR #665 that cost the maintainer a debugging loop on the
  // one act the three-lock architecture reserves for humans.
  // Case-FOLDED, like every other identity comparison in this file
  // (`isForeignCommit`, `denyingList`, rule 15). Logins fold case on both
  // providers, so an exact match let a differently-cased spelling of a
  // registered identity walk past the deny-set holding it — a bypass of the
  // very gate #124 builds, which predated this change only because the
  // deny-set had never contained an agent identity before. (#454's guard
  // keeps this file from naming any consumer's agent: the identity lives in
  // `governance.agentActors`, and this gate must not know which platform its
  // user runs. My first draft of this comment spelled one out, and that guard
  // caught it.)
  // Review round 4 named the divergence; it is closed rather than noted.
  if (isDeniedActor(actor, denyActors)) {
    // WHICH list caught it (#124). The deny-set is the union of
    // `governance.reviewActors` and `governance.agentActors`, and an operator
    // told only "denied" has to read the source to learn which of two keys to
    // edit. `agentActors` is consulted for the MESSAGE only — the verdict is
    // the deny-set's, and the two lists stay separate at their readers because
    // they answer opposite questions about the same identity (ADR-0026
    // Amendment 3 exempts an agent's COMMITS; #124 refuses its APPROVAL).
    // The canonical clause "may never apply the approved label" is kept in BOTH
    // branches: an existing test (#454, §9) matches on it, and it is the
    // sentence the ecosystem reads. Only the KEY and the authority differ, and
    // `denyingList` is the one place that decides which.
    const denied = denyingList(actor, agentActors);
    return withRefusalNote({
      level: 'fail',
      reason:
        `the approved label was applied by "${actor}", which is registered in ${denied.key} — ` +
        (denied.key === 'governance.agentActors'
          ? 'an agent identity may never apply the approved label (ADR-0026 "What is unchanged" §9; '
            + 'human-only). Exemption from re-arming an approval and permission to grant one are '
            + 'different powers; #454 grants only the first. Re-apply it as a human.'
          : 'a review identity may never apply the approved label (reviewer-protocol.md §9; that '
            + 'label is human-only).') +
        describeUnevaluatedSignedEvidence({ tier, decisions, headSha, denyActors, agentActors, signedEvidenceSources }),
    });
  }

  if (actor && botAllowlist.includes(actor)) {
    return withRefusalNote({
      level: 'pass',
      reason: `the approved label was applied by allow-listed automation identity "${actor}".`,
    });
  }

  // `denyActors` is the UNION of `governance.reviewActors` and `governance.agentActors` (#124; see the deny branch above).
  // Amendment 1 reuses that same set as `lite`'s non-re-arming push identity
  // set — no new config key. The two readings do not conflict: a review
  // identity may never APPLY the approval (denied above), and its pushes do
  // not INVALIDATE one (here).
  //
  // issue #473 (design.md §C2): `signedEvidenceSources` is tried FIRST, in
  // order — a `brain-decision/1` block is an ADDITIONAL sufficient form of
  // evidence, OR-composed with the existing distinct-act check below. A
  // non-admissible block never blocks; it only annotates the fallback
  // verdict's reason (§C4 — monotonicity: no PR passes on LESS evidence than
  // today, and the block grants nothing on unreadable/broken evidence).
  if (tier === 'lite') {
    const signedNotes = [];
    for (const source of signedEvidenceSources) {
      const signed = source({ decisions, headSha, denyActors, agentActors });
      if (signed?.admitted) return withRefusalNote({ level: 'pass', reason: signed.reason });
      if (signed?.note) signedNotes.push(signed.note);
    }
    const base = evaluateDistinctAct({ actor, labelCreatedAt, commits, agentActors });
    return withRefusalNote(
      signedNotes.length ? { ...base, reason: `${base.reason} ${signedNotes.join(' ')}` } : base,
    );
  }

  if (actor === author || (issueAuthor && actor === issueAuthor)) {
    const matched = actor === author ? 'PR author' : 'issue author';
    return withRefusalNote({
      level: 'fail',
      reason: `the approved label was self-applied by "${actor}" (matches the ${matched}) — self-approval is not allowed.`,
    });
  }

  if (tier === 'regulated') {
    const commitVerdict = evaluateNoCommitOnBranch({ actor, commits });
    if (commitVerdict) return withRefusalNote(commitVerdict);
  }

  return withRefusalNote({
    level: 'pass',
    reason: `the approved label was applied by "${actor}", distinct from the PR author "${author}" and the issue author "${issueAuthor ?? 'n/a'}".`,
  });
}

// ── Issue-number extraction (reused rules from governance.yml's issue-link job) ─
//
// Mirrors the bash regexes in .github/workflows/governance.yml's issue-link job
// exactly: base=main requires a closing keyword; a slice PR (base!=main) also
// accepts "Part of #N". CLOSING_RE/CHAIN_RE come from the shared
// checks/issue-ref-patterns.mjs (issue #231 CP-A2a review, finding M1) —
// this file's own CLOSING_KEYWORD_RE/PART_OF_RE were already the BROAD
// 9-form vocabulary (identical in behavior to the shared pattern), deleted
// here in favor of the one shared constant now imported by issueLink(),
// run-check.mjs, AND this file.

/**
 * Extracts the issue number referenced by a PR body, following the same rules
 * governance.yml's issue-link job enforces in bash.
 *
 * @param {string} prBody
 * @param {string} baseBranch
 * @returns {number|null}
 */
export function extractIssueNumber(prBody, baseBranch) {
  const body = prBody ?? '';

  if (baseBranch === 'main') {
    const m = body.match(CLOSING_RE);
    return m ? Number(m[2]) : null;
  }

  const partOf = body.match(CHAIN_RE);
  if (partOf) return Number(partOf[1]);

  const closing = body.match(CLOSING_RE);
  return closing ? Number(closing[2]) : null;
}

// ── gh I/O wrapper ───────────────────────────────────────────────────────────

/**
 * Filters the `labelEvents()` CONTRACT verb's normalized output (issue #239
 * A3, D1) down to `add` events for the resolved approved label — the SHARED
 * post-filter applied to EITHER provider's normalized shape (`action`,
 * `label`), AFTER the verb normalizes. Pure — exported for unit testing the
 * provider-resolved wiring without spawning a real `gh`/API call (issue #231
 * A2 phase 1). `events === null` (labelEvents' uncomputable signal) passes
 * through as `[]`, feeding evaluateActor's existing "no labeled event found"
 * → `warn` branch (REQ-L5-2 — never fail on missing evidence).
 *
 * @param {Array<{ action?: string, label?: string }>|null} events
 * @param {string} approvedLabel
 * @returns {Array<{ actor: { login: string }, action: string, label: string, at: string }>}
 */
export function filterLabeledEvents(events, approvedLabel) {
  if (!events) return [];
  return events.filter(e => e.action === 'add' && e.label === approvedLabel);
}

/**
 * Default `fetchLabeledEvents` dep: dispatches the `labelEvents` CONTRACT
 * verb (issue #239 A3, D1 — the m3 close) via `getVcs({ provider })` on the
 * RUNTIME-detected `ctx.provider` — the same finding-#14 pattern
 * `run-check.mjs#defaultFetchIssue` already uses (`run-check.mjs:167-177`):
 * a GitLab MR's referenced issue lives on GitLab even when this repo's own
 * config says github. `{ apiBase, token, proxyUrl }` are threaded in from
 * `gitlabApiConfig()` (harmless no-op params for the GitHub provider).
 * `getVcs` is injectable via `{ getVcs }` for tests, mirroring
 * `defaultFetchIssue`'s own `{ getVcs: getVcsFn = getVcs }` shape.
 *
 * @param {string} repo
 * @param {string|undefined} provider
 * @param {string} approvedLabel
 * @param {{ getVcs?: Function }} [deps]
 * @returns {(issueNumber: number) => Promise<Array<{ actor: { login: string }, action: string, label: string, at: string }>>}
 */
function defaultFetchLabeledEvents(repo, provider, approvedLabel, { getVcs: getVcsFn = getVcs } = {}) {
  return async issueNumber => {
    const vcs = await getVcsFn({ provider });
    const { apiBase, token, proxyUrl } = gitlabApiConfig();
    const events = await vcs.labelEvents({ project: repo, number: issueNumber, apiBase, token, proxyUrl });
    return filterLabeledEvents(events, approvedLabel);
  };
}

/**
 * Default `fetchIssue` dep: dispatches `getVcs({ provider }).issueView(...)`
 * on the RUNTIME-detected `ctx.provider` (issue #239 A3 TASK1 — a
 * fresh-context review finding, closing the SAME defect class as
 * `defaultFetchLabeledEvents` above and finding #14/`run-check.mjs`'s
 * `defaultFetchIssue`, mirrored EXACTLY here). Pre-fix, this wrapper called
 * the `gh` CLI (via `execFileSync`) UNCONDITIONALLY regardless of provider —
 * on GitLab CI (no `gh` binary) it threw ENOENT, masking R3 behind a permanent
 * `warn` even though `labelEvents` had already been migrated. Both providers'
 * `issueView` (migrated to direct API v4 in A2 finding #12 for GitLab)
 * expose `author` as of A3 TASK1, so `labels`/`author` both come from the
 * SAME dispatched call — no second round-trip. `getVcs` is injectable via
 * `{ getVcs }` for tests, mirroring `defaultFetchLabeledEvents`'s own shape.
 *
 * @param {string} repo
 * @param {string|undefined} provider
 * @param {{ getVcs?: Function }} [deps]
 * @returns {(issueNumber: number) => Promise<{ labels: string[], author: string|null }>}
 */
function defaultFetchIssue(repo, provider, { getVcs: getVcsFn = getVcs } = {}) {
  return async issueNumber => {
    const vcs = await getVcsFn({ provider });
    const { apiBase, token, proxyUrl } = gitlabApiConfig();
    const issue = await vcs.issueView({ project: repo, number: issueNumber, apiBase, token, proxyUrl });
    return {
      labels: issue?.labels ?? [],
      author: issue?.author ?? null,
    };
  };
}

/**
 * Whether a tier's REQ-L5-1' evidence form needs the PR's commit list
 * (issue #358 Q5 Phase 4): `lite` needs the head commit's timestamp
 * (distinct-act); `regulated` needs the full commit-author list (no-commit
 * -on-branch). `standard` needs neither — REQ-TIER-10's no-op-migration
 * guarantee means `standard` makes no additional API call it did not make
 * before tiering.
 *
 * @param {string} tier
 * @returns {boolean}
 */
function needsCommitEvidence(tier) {
  return tier === 'lite' || tier === 'regulated';
}

/**
 * Default `fetchCommits` dep: dispatches the `prCommits` CONTRACT verb
 * (issue #358 Q5 Phase 4) via `getVcs({ provider })` on the
 * RUNTIME-detected `ctx.provider` — the same finding-#14 pattern
 * `defaultFetchLabeledEvents`/`defaultFetchIssue` use. `getVcs` is
 * injectable via `{ getVcs }` for tests, mirroring their shape.
 *
 * @param {string} repo
 * @param {string|undefined} provider
 * @param {{ getVcs?: Function }} [deps]
 * @returns {(prNumber: number) => Promise<Array<{ sha: string, login: string|null, at?: string }>|null>}
 */
function defaultFetchCommits(repo, provider, { getVcs: getVcsFn = getVcs } = {}) {
  return async prNumber => {
    const vcs = await getVcsFn({ provider });
    const { apiBase, token, proxyUrl } = gitlabApiConfig();
    return vcs.prCommits({ project: repo, number: prNumber, apiBase, token, proxyUrl });
  };
}

/**
 * Whether a tier's evidence form needs the PR's reviews (issue #473,
 * design.md §D3): only `lite`'s `evaluateSignedDecision` reads them.
 * `standard`/`regulated` make ZERO additional API calls (REQ-473-10's
 * no-op-migration guarantee, the same discipline `needsCommitEvidence`
 * already established).
 *
 * @param {string} tier
 * @returns {boolean}
 */
function needsDecisionEvidence(tier) {
  return tier === 'lite';
}

/**
 * Default `fetchDecisions` dep: dispatches the `prReviews` CONTRACT verb
 * (issue #473) via `getVcs({ provider })`, mirroring
 * `defaultFetchCommits`/`defaultFetchLabeledEvents`'s `{ getVcs }` shape
 * exactly. Unlike `defaultFetchReviews` (`brain-writes-reviewed.mjs`), this
 * does NOT map `null` → `[]` — design.md §D2: `prReviews` returns `null` on
 * an uncomputable review list, and that must stay `null` so
 * `evaluateSignedDecision` can emit its own "review list unreadable" NOTE
 * (rule 1) rather than being indistinguishable from "genuinely zero
 * reviews" (rule 2).
 *
 * @param {string} repo
 * @param {string|undefined} provider
 * @param {{ getVcs?: Function }} [deps]
 * @returns {(prNumber: number) => Promise<Array<{state:string,author:string|null,body:string}>|null>}
 */
function defaultFetchDecisions(repo, provider, { getVcs: getVcsFn = getVcs } = {}) {
  return async prNumber => {
    const vcs = await getVcsFn({ provider });
    const { apiBase, token, proxyUrl } = gitlabApiConfig();
    return vcs.prReviews({ project: repo, number: prNumber, apiBase, token, proxyUrl });
  };
}

/**
 * The PR's head SHA, derived from the commit list already in hand
 * (`prCommits()`'s normalized shape, ascending) — issue #473, design.md §D4.
 * Deliberately NOT a second `prView` round-trip: that would introduce a
 * second source of truth for "the head" that could disagree with the commit
 * list `evaluateSignedDecision` reads. Residual (recorded): GitHub's
 * `/pulls/N/commits` caps at 250 commits, so a >250-commit PR resolves the
 * wrong head — the fail-closed direction (a mismatched head never admits).
 *
 * @param {Array<{ sha: string }>|null} commits
 * @returns {string|null}
 */
export function resolveHeadSha(commits) {
  return Array.isArray(commits) && commits.length > 0 ? (commits[commits.length - 1].sha ?? null) : null;
}

function defaultReadBotAllowlist(cwd) {
  return () => {
    try {
      const config = JSON.parse(readFileSync(join(cwd, 'brain.config.json'), 'utf8'));
      return Array.isArray(config?.governance?.approvalActors) ? config.governance.approvalActors : [];
    } catch {
      return [];
    }
  };
}

/**
 * Pure: the APPROVAL deny-set a config declares — `governance.reviewActors` ∪
 * `governance.agentActors` (#124).
 *
 * EXPORTED because it is one rule with two callers, and round 2 of the review
 * measured what happened when it was not: `approve/cli.mjs` carried its own
 * `defaultReadDenyActors` reading `reviewActors` alone, documented as "the
 * write-side twin of L5's read rule 15". Widening only the read side left the
 * write-side lock claiming a mirror it no longer was — `brain:approve` would
 * have let a registered agent post a signed block, and only the PR gate would
 * have caught it afterwards. My own design said "the single source"; it was
 * two, and I had not verified it.
 *
 * The COMMIT exemption still reads `agentActors` alone through its own reader.
 * Opposite answers to different questions about one identity (ADR-0026
 * Amendment 3 vs the same ADR's §9) may never share a list.
 */
export function approvalDenySet(config) {
  const review = Array.isArray(config?.governance?.reviewActors) ? config.governance.reviewActors : [];
  const agents = Array.isArray(config?.governance?.agentActors) ? config.governance.agentActors : [];
  return [...new Set([...review, ...agents])];
}

/**
 * L5's DENY list (issue #375, widened by #124): `governance.reviewActors` ∪ `governance.agentActors` — the SAME key L6
 * reads to exclude an identity from the human-approver count. Both readings are
 * restrictive and co-directional ("not a human authority"), which is why ruling
 * R2 is excepted here; see the ADR. Kept as a separate reader from
 * `defaultReadBotAllowlist` so the two keys never merge at the source.
 *
 * DENY-DIRECTION (issue #942, R1): calls `loadBrainConfigOrThrow(cwd)` and does
 * NOT catch. An absent config still resolves to `{}` → `[]` (R11, unchanged) —
 * only a PRESENT-but-unreadable/unparseable config throws, and that throw
 * propagates out of `gatherActorCheckInputs` into `runActorCheck`'s existing
 * tiered catch (`resolveTierForFailure` + `resolveGatePolicy` → `fail` at
 * `required` tiers). A deny reader that swallows a config-read failure denies
 * nobody, which is the exact fail-open this hardening closes.
 */
function defaultReadDenyActors(cwd) {
  return () => approvalDenySet(loadBrainConfigOrThrow(cwd));
}

/**
 * `lite`'s AGENT identity set (issue #454, ADR-0026 Amendment 3):
 * `governance.agentActors` — identities acting inside the approved loop under the
 * approver's instruction, whose commits therefore do NOT re-arm an existing
 * approval. Read with `?? []`, ABSENT by default, and deliberately NOT added to
 * `config-migrations.mjs`: a key that WEAKENS a gate may never arrive by upgrade.
 * `governance.reviewActors` set that precedent — its 0.8.0 migration says outright
 * that it "stays absent" — and a consumer who never declares the key keeps today's
 * behaviour byte for byte.
 *
 * A THIRD reader rather than a reuse of `readDenyActors`, and the reason is not
 * tidiness. `reviewActors` means "acts as the cold reviewer". Reusing it would get
 * every behaviour right for an agent and the MEANING wrong, and the wrongness
 * surfaces as a lying refusal: a consumer who runs an agent but has no cold
 * reviewer would have to register their coding agent there, and `brain:approve`
 * would then refuse it with "a review identity may never sign an approval" — said
 * about something that reviews nothing. Correct refusal, false reason. Ruling R2
 * ("no key feeds two gates") was already knowingly excepted once, in #375; twice
 * is how an exception becomes the rule.
 *
 * PLATFORM-AGNOSTIC BY CONSTRUCTION. No vendor name appears here or anywhere else
 * under `brain/scripts/**` or `brain/core/**` — the identity lives in the
 * CONSUMER's `brain.config.json`, which `brain:upgrade` never touches (ADR-0003 /
 * ADR-0006's golden rule). Today's agent platform is not tomorrow's; swapping it
 * is editing one array, not editing brain. `agnostic-identity.test.mjs` holds that
 * as a structural lock rather than an intention.
 *
 * WHAT THIS IS NOT. An identity string in a config file is not an authenticated
 * identity: the provider attributes a commit by matching the author email against
 * an account, and git authorship is unauthenticated by construction, so anyone
 * with push access can spell it. That is a `lite`-tier trade, signed as one in
 * Amendment 3, and it is exactly the basis on which `reviewActors` is already
 * exempt here — #413 verified the reviewer identity at the review-POSTING seam,
 * never at the authorship seam. The `standard`-tier upgrade is signature
 * verification normalized through the port (#454's option B), not a longer list.
 */
function defaultReadAgentActors(cwd) {
  return () => {
    try {
      const config = JSON.parse(readFileSync(join(cwd, 'brain.config.json'), 'utf8'));
      return Array.isArray(config?.governance?.agentActors) ? config.governance.agentActors : [];
    } catch {
      return [];
    }
  };
}

function defaultReadConfig(cwd) {
  return () => {
    try {
      return JSON.parse(readFileSync(join(cwd, 'brain.config.json'), 'utf8'));
    } catch {
      return {};
    }
  };
}

/**
 * Resolves the tier to attribute an API-failure verdict to (issue #358 Q5
 * Phase 5 review finding 1), WITHOUT ever throwing itself — this runs from
 * inside `runActorCheck`'s catch block, after `gatherActorCheckInputs` has
 * already failed, so a second failure here (a corrupt config, an unknown
 * `governance.tier`) must degrade rather than escape. Defaults to
 * `'standard'` on any resolution failure — `'standard'` also resolves
 * `actor-check` to `required` (REQ-TIER-2's never-tiered core), so this
 * default is fail-closed-safe regardless of the repo's real tier.
 *
 * @param {string} cwd
 * @param {{ tier?: string, readConfig?: () => object }} deps
 * @returns {'lite'|'standard'|'regulated'}
 */
function resolveTierForFailure(cwd, deps) {
  try {
    if (deps.tier) return deps.tier;
    const readConfig = deps.readConfig ?? defaultReadConfig(cwd);
    return resolveTier(readConfig());
  } catch {
    return 'standard';
  }
}

/**
 * Gathers evaluateActor()'s inputs from the PR body + gh API (or from injected
 * `deps` in tests). `adminOverride` is resolved here — an override:* label is
 * only honored when it is BOTH present on the issue AND listed in
 * `botAllowlist` (`config.governance.approvalActors`); an unlisted override:*
 * label grants nothing (REQ-L5-2 — no blanket bypass). `issueAuthor` is
 * surfaced from the same issue-object fetch used for labels (`fetchIssue`) —
 * no second gh round-trip — so evaluateActor can compare the approving actor
 * against BOTH the PR author and the issue author (REQ-L5-1).
 *
 * `provider` (github|gitlab, from `ctx.provider`) both resolves the approved
 * label (`governance.approvedLabel`, issue #231 A2 phase 1) AND selects the
 * VCS adapter (`getVcs({ provider })`, issue #239 A3 D1 — the m3 close) for
 * the default `fetchLabeledEvents` wrapper; an injected
 * `deps.fetchLabeledEvents` bypasses resolution entirely (as tests do). This
 * function is async as of A3 (the default wrapper awaits the `labelEvents`
 * CONTRACT verb, a Promise-returning dispatch); an injected sync
 * `deps.fetchLabeledEvents` still works unchanged (`await` on a
 * non-Promise resolves immediately to that same value).
 *
 * `adminOverride` is tier-scoped (issue #358 Q5, REQ-TIER-6): honored at
 * `lite`/`standard`, refused at `regulated` (`tierParams(tier).honorOverride`).
 * A present-but-refused override sets `overrideRefused: true` instead of
 * silently vanishing — evaluateActor() names the refusal in its verdict.
 *
 * `commits` (issue #358 Q5 Phase 4, REQ-L5-1') is fetched via `prCommits`
 * ONLY when the resolved tier's evidence form needs it (`lite`/`regulated`,
 * `needsCommitEvidence`) and a PR number is available — `standard` makes no
 * additional API call (REQ-TIER-10's no-op-migration guarantee).
 *
 * `denyActors` (issue #375) is sourced from `governance.reviewActors` via a
 * reader kept separate from `readBotAllowlist` (`config.governance.
 * approvalActors`) — the two keys must never merge at the source (design §3
 * two-key split). Threaded through unconditionally, at every tier.
 *
 * @param {{ author: string, prBody: string, baseBranch: string, repo: string, provider?: string, prNumber?: number, cwd?: string, tier?: string, deps?: object }} args
 * @returns {Promise<{ author: string, issueAuthor: string|null, labeledEvents: Array, botAllowlist: string[], denyActors: string[], adminOverride: boolean, overrideRefused: boolean, tier: string, commits: Array|null }>}
 */
export async function gatherActorCheckInputs({ author, prBody, baseBranch, repo, provider, prNumber, cwd = process.cwd(), tier: tierOverride, deps = {} } = {}) {
  const readConfig = deps.readConfig ?? defaultReadConfig(cwd);
  const config = readConfig();
  const approvedLabel = resolveApprovedLabel(config, provider);
  const tier = tierOverride ?? deps.tier ?? resolveTier(config);
  const { honorOverride } = tierParams(tier);

  const fetchLabeledEvents = deps.fetchLabeledEvents ?? defaultFetchLabeledEvents(repo, provider, approvedLabel, deps);
  const fetchIssue = deps.fetchIssue ?? defaultFetchIssue(repo, provider, deps);
  const readBotAllowlist = deps.readBotAllowlist ?? defaultReadBotAllowlist(cwd);
  const readDenyActors = deps.readDenyActors ?? defaultReadDenyActors(cwd);
  const readAgentActors = deps.readAgentActors ?? defaultReadAgentActors(cwd);
  const fetchCommits = deps.fetchCommits ?? defaultFetchCommits(repo, provider, deps);
  const fetchDecisions = deps.fetchDecisions ?? defaultFetchDecisions(repo, provider, deps);

  const botAllowlist = readBotAllowlist();
  const denyActors = readDenyActors();
  const agentActors = readAgentActors();
  const issueNumber = extractIssueNumber(prBody, baseBranch);

  const commits = needsCommitEvidence(tier) && prNumber != null ? await fetchCommits(prNumber) : null;
  const decisions = needsDecisionEvidence(tier) && prNumber != null ? await fetchDecisions(prNumber) : null;
  const headSha = resolveHeadSha(commits);

  if (issueNumber == null) {
    return { author, issueAuthor: null, labeledEvents: [], botAllowlist, denyActors, agentActors, adminOverride: false, overrideRefused: false, tier, commits, decisions, headSha };
  }

  const labeledEvents = await fetchLabeledEvents(issueNumber);
  const { labels: issueLabels, author: issueAuthor } = await fetchIssue(issueNumber);
  const overrideLabelPresent = issueLabels.some(l => l.startsWith('override:') && botAllowlist.includes(l));
  const adminOverride = honorOverride && overrideLabelPresent;
  const overrideRefused = overrideLabelPresent && !honorOverride;

  return { author, issueAuthor, labeledEvents, botAllowlist, denyActors, agentActors, adminOverride, overrideRefused, tier, commits, decisions, headSha };
}

/**
 * Runs the full L5 actor check: gathers inputs (gh API + PR body), evaluates the
 * pure rule. Never throws — but a gh API failure inside `gatherActorCheckInputs`
 * no longer unconditionally degrades to `warn` (issue #358 Q5 Phase 5 review
 * finding 1). `actor-check` is `required` at EVERY tier (REQ-TIER-2's
 * never-tiered core, `GATE_MATRIX['actor-check']` — promoted out of
 * `PENDING_PROMOTION` in Phase 5): when the gate is required, an API failure
 * means the approval CANNOT BE VERIFIED, which is not the same thing as "no
 * approval yet" (REQ-L5-2's warn+pass branch, still handled inside
 * `evaluateActor` for the genuinely-computed "no labeled event" case). Failing
 * open on an unverifiable required gate would let a flaky `gh`/API outage
 * silently pass a check the doctrine says must block merge — the EXACT
 * asymmetry this fix closes against `evaluateDistinctAct`'s existing
 * fail-closed `prCommits: null` handling (same file, above): both paths now
 * agree that "cannot verify, required gate" fails, never warns. Only when the
 * resolved tier demotes this gate's POSITION to `detection` (not currently
 * true for `actor-check` — reserved for a future matrix change) does an API
 * failure still degrade to `warn`, mirroring `run-check.mjs`'s
 * `mapDetectionToWarning` discipline for detection-tier gates.
 *
 * Missing PR author/repo CONTEXT (the branch below, before any gh call is even
 * attempted) is a distinct case — this is not an API failure, it is "this run
 * has no PR to check" (e.g. a local/non-CI invocation) — and stays `warn`.
 *
 * `author`/`baseBranch`/`repo` source from the normalized ci-context (`ctx.*`,
 * ADR-0016) — never from process.env directly (a drift-guard test enforces
 * this). Per CP-A0 ruling 1, `author` is the PR author from the API payload
 * (`ctx.author`), NOT the pipeline-trigger env identity.
 * `prBody` is DETECTION-only: it falls back to PR_BODY via
 * `resolveDetectionBody()` when `ctx.body` is uncomputable (amendment 2 — this
 * fallback is sanctioned ONLY for DETECTION consumers like this check).
 *
 * This function is async as of issue #239 A3 — `gatherActorCheckInputs`
 * dispatches the `labelEvents` CONTRACT verb via `getVcs({ provider })`, a
 * Promise-returning call.
 *
 * @param {{ author?: string, prBody?: string, baseBranch?: string, repo?: string, cwd?: string, ctx?: object } & object} [deps]
 * @returns {Promise<{ level: 'pass'|'warn'|'fail', reason: string }>}
 */
export async function runActorCheck(deps = {}) {
  const ctx = deps.ctx ?? {};
  const author = deps.author ?? ctx.author ?? undefined;
  const prBody = deps.prBody ?? resolveDetectionBody(ctx, deps) ?? '';
  const baseBranch = deps.baseBranch ?? ctx.targetBranch ?? undefined;
  const repo = deps.repo ?? ctx.repo ?? undefined;
  const provider = deps.provider ?? ctx.provider ?? undefined;
  const prNumber = deps.prNumber ?? ctx.prNumber ?? undefined;
  const cwd = deps.cwd ?? process.cwd();

  if (!author || !repo) {
    return {
      level: 'warn',
      reason: 'PR_AUTHOR/GITHUB_REPOSITORY not set — cannot verify approval actor; skipping actor-check.',
    };
  }

  let inputs;
  try {
    inputs = await gatherActorCheckInputs({ author, prBody, baseBranch, repo, provider, prNumber, cwd, deps });
  } catch (err) {
    const tier = resolveTierForFailure(cwd, deps);
    if (resolveGatePolicy('actor-check', tier) === 'required') {
      return {
        level: 'fail',
        reason:
          `actor-check: could not gather inputs (gh/api or brain.config.json failure) — ${err.message} — ` +
          `failing closed: actor-check is required at the "${tier}" tier (REQ-TIER-2's never-tiered core) ` +
          'and an unverifiable failure cannot be treated as a pass (matches evaluateDistinctAct\'s existing ' +
          'fail-closed handling of an unreadable prCommits — issue #358 Q5 Phase 5 review finding 1; widened ' +
          'to a config-read/parse failure by issue #942, R1).',
      };
    }
    return {
      level: 'warn',
      reason: `actor-check: could not gather inputs (gh/api or brain.config.json failure) — ${err.message} (detection-tier at "${tier}").`,
    };
  }

  return evaluateActor(inputs);
}

/**
 * Runs the check, prints the verdict + reason, and returns the process exit
 * code — kept separate from `process.exit()` itself so it stays testable
 * (mirrors run-check.mjs / phase-order-check.mjs's main()). Exit 0 on
 * pass/warn, 1 on fail. Async as of A3 (awaits `runActorCheck`).
 *
 * @param {object} [deps]
 * @returns {Promise<0|1>}
 */
export async function main(deps = {}) {
  const result = await runActorCheck(deps);
  console.log(`actor-check: ${result.level}`);
  if (result.reason) console.log(`  ${result.reason}`);
  return result.level === 'fail' ? 1 : 0;
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ctx = await loadContext();
  process.exit(await main({ ctx }));
}
