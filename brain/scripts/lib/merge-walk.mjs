// merge-walk.mjs — the shared first-parent walk (EVIDENCE + VERDICT
// layers only, design §"Technical Approach", issue #324/M9).
//
// EXTRACTED VERBATIM from brain-audit.mjs (issue #324 Phase 1): the walk that
// enumerates the audited first-parent line and re-derives each commit's governance verdict
// is now the SAME code both `brain-audit` (enforcement) and `brain-metrics`
// (reporting) run — duplicating it would guarantee the exact drift between
// measurement and enforcement the metrics verb exists to prevent (design D1).
//
// This module is I/O-heavy (git subprocess calls, best-effort VCS fetches) but
// contains NO emission (no console.log) and NO process.exit — those stay in
// each CLI (brain-audit.mjs / brain-metrics.mjs), which set their own failure
// policy over this fail-closed core (design D2): brain-audit exits 2 on a
// throw, brain-metrics catches per-merge and counts an `uncomputable` row.
//
// Layer split (design table):
//   EVIDENCE  — listAuditedCommits, readMergeParent, readMergeDiff, fetchPrMeta.
//               Enumerate merges, window anchors, per-merge parents/numstat/
//               changed-files/body, one prView() per merge for labels+body.
//   VERDICT   — evaluateMerge, resolvedSkipLine. Runs the 4 checks,
//               shouldSkipSize, resolvedSkipLine, and the reverter exemption
//               (addedPathsAbsentAt + netAddFull).
//
// Emission ([PASS]/[FAIL]/[SKIP] lines, [FAIL-SHA] dedup + payloadSignature,
// crossCheckExit) stays in brain-audit.mjs — it is a judgment about how to
// REPORT a verdict, not part of computing the verdict itself.

import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getVcs } from '../vcs/cli.mjs';
import { parsePrNumber, shouldSkipSize, selectIssueLinkBody, auditedTip } from './audit-helpers.mjs';
import { gitOrThrow, gitTry } from '../governance/postmerge/git-seam.mjs';
import { diffSize } from '../governance/checks/diff-size.mjs';
import { issueLink } from '../governance/checks/issue-link.mjs';
import { adrPresence } from '../governance/checks/adr-presence.mjs';
import { writesGoverned } from '../governance/checks/writes-governed.mjs';
import { memoryGateVerdict } from '../governance/checks/memory-gate.mjs';
// COMPOSE the frozen net-parity primitives (design §15, PR2b). NEVER import the
// retired direction-blind pairwise `isReverterOf` — a no-import drift-guard test
// (brain-audit.test.mjs) asserts it never reappears in this module.
import { isResolvedAt, netAddFull, addedPathsAbsentAt, revertResurrectsAt } from '../governance/postmerge/resolution.mjs';

/**
 * The subset of the four checks whose PASS/FAIL verdict is a pure function of
 * the commit's TREE (changed paths / the diff itself) — as opposed to its
 * commit/PR body (`issueLink`, free text) or repo-global state at HEAD
 * (`memoryPresence`). Only a tree-keyed check can be causally mirrored by a
 * commit's contribution being the net-inverse of an offender's, so ONLY these
 * classes are ever exempted by the reverter-skip and ONLY these emit the
 * `[FAIL-SHA]` auto-revert signal (design §15.5, REQ-D2-10a).
 */
export const TREE_KEYED_CHECKS = new Set(['adrPresence', 'diffSize']);
// `writesGoverned` (#511) is deliberately ABSENT: it keys on PR metadata — reviews and
// authorship — not on the tree, exactly like `issueLink`. So it is never exempted by the
// reverter-skip and never emits [FAIL-SHA]. Auto-reverting on review evidence would be
// wrong on its face: the remedy for "nobody reviewed this" is a human reviewing it.

/**
 * Does ANY record file exist under `<cwd>/.memory/records/`? One reader for
 * brain-audit and brain-metrics so both hand `evaluateMerge` the same
 * `memoryHistory` (#1188). A missing directory is exactly "no history yet".
 *
 * @param {string} cwd
 * @returns {boolean}
 */
export function readMemoryHistory(cwd) {
  try {
    return readdirSync(join(cwd, '.memory', 'records')).some((f) => f.endsWith('.jsonl'));
  } catch { /* swallow-ok: no .memory/records directory is exactly "no memory history yet" — the early-merge abstention */
    return false;
  }
}

/**
 * The audit's memory verdict (#1188): the SAME predicate the PR-time
 * `memory-gate` runs (`checks/memory-gate.mjs`), not a parallel copy.
 *
 * The audit walks merges already on the default branch, so the tree it reads
 * (`allObservations`, HEAD's `.memory/records/`) already CONTAINS whatever the
 * default branch holds; the gate's second source (`origin/<default>`) is empty
 * by construction here and is stubbed rather than re-read. The body is the
 * merge's `issueLinkBody`, and target === default, because every audited commit
 * is an integration into the default line (the closing-keyword branch of the
 * gate's issue extraction).
 *
 * EARLY MERGES (#1188 req. 2): a repository whose tree holds NO memory record at
 * all has no history the gate's evidence could come from. A merge there is
 * abstained on — a pass carrying a visible `note` — instead of becoming
 * `audit-unrevertible`, which pins the cursor and summons a human over a
 * precondition (a first record) the consumer had no way to have met yet. This is
 * the ONLY difference from the gate, it is keyed on the evidence existing at
 * all, and it ends at the first record: from then on the full predicate applies,
 * tier semantics included. `memoryPresence` is never auto-revertible, so the
 * abstention removes no revert — it removes a false alarm.
 *
 * `memoryHistory` says whether any record FILE exists (the caller's read of
 * `.memory/records/`). Omitted, it is inferred from the observations; supplied,
 * it keeps a tree of only-corrupt records from reading as "no history".
 *
 * @param {{ allObservations: Array, issueLinkBody: string|null, tier: string, memoryHistory?: boolean }} input
 */
export function auditMemoryVerdict({ allObservations, issueLinkBody, tier, memoryHistory }) {
  const records = Array.isArray(allObservations) ? allObservations : [];
  const hasHistory = typeof memoryHistory === 'boolean' ? memoryHistory : records.length > 0;
  if (!hasHistory) {
    return {
      pass: true,
      note: 'no memory history yet — no record exists in .memory/records/, so there is nothing to audit against; '
        + 'the audit abstains until the first record lands (#1188)',
    };
  }
  return memoryGateVerdict(
    {
      prNumber: null,
      body: typeof issueLinkBody === 'string' ? issueLinkBody : '',
      targetBranch: 'default',
      defaultBranch: 'default',
    },
    records,
    { readDefaultBranchRecords: () => ({ records: [], error: null, fetched: false }) },
    tier,
  );
}

/**
 * Resolve the audit baseline ref from `config.governance.auditBaseline`
 * (evidence-layer, design D1 — SHARED with brain-metrics): validates it
 * against the repo and falls back to auditing/measuring ALL merges (no
 * baseline) when the configured ref does not resolve. Fixture ref: issue #324
 * B2 fix round — before this moved here, brain-metrics had NO baseline
 * awareness at all, so it reported gate failures on pre-baseline merges
 * brain-audit itself never evaluated (a divergence between measurement and
 * enforcement the shared-lib extraction exists to prevent).
 *
 * Uses `gitTry` (never throws) — an unresolvable ref is a configuration
 * mistake to warn about and recover from, not a fail-closed infra error.
 * Returns the warning message as DATA rather than writing to stderr directly:
 * emission (deciding WHERE a warning goes) stays with each CLI (design table's
 * "Emission stays local" split), not this shared evidence layer.
 *
 * @param {string|null|undefined} baseline  Raw value from brain.config.json.
 * @param {string} cwd
 * @returns {{ ref: string|null, warning: string|null }}
 */
export function resolveBaseline(baseline, cwd) {
  if (!baseline) return { ref: null, warning: null };
  const result = gitTry(['rev-parse', '--verify', baseline], { cwd });
  if (result.status !== 0 || !result.stdout.trim()) {
    return {
      ref: null,
      warning: `[WARN] audit baseline '${baseline}' does not resolve in this repo — auditing all merges`,
    };
  }
  return { ref: baseline, warning: null };
}

/**
 * Build an isAncestor function backed by real git for production use.
 * Returns a function that answers: is `baseline` an ancestor of `sha`? Shared
 * with brain-metrics (design D1) via the same `resolveBaseline` above — both
 * verbs must agree on which merges are "before the baseline" or metrics
 * measures merges audit never evaluated.
 *
 * @param {string} cwd
 * @returns {(baseline: string, sha: string) => boolean}
 */
export function makeGitIsAncestor(cwd) {
  return function gitIsAncestor(baseline, sha) {
    const result = gitTry(['merge-base', '--is-ancestor', baseline, sha], { cwd });
    return result.status === 0; // exit 0 → baseline IS ancestor → sha is after baseline
  };
}

/**
 * Pre-evaluation resolved-skip (design §3.5/§15.3, REQ-D2-10): a merge whose own
 * first-parent contribution is NET-ABSENT at HEAD under exact-normDiff net-parity
 * accounting is skipped BEFORE any of the four checks run — including
 * memoryPresence. `isResolvedAt` is pure-read and fail-CLOSED: an offender whose
 * own contribution cannot be computed THROWS rather than returning a verdict.
 * This function deliberately does NOT try/catch that throw — swallowing it here
 * would be the ad-hoc silent skip design §5/REQ-D2-12 forbids. The one place the
 * throw is allowed to surface is the CLI's top-level fail-closed catch → exit 2.
 * Anchored at HEAD (§2.2 — every window ends at HEAD).
 */
export function resolvedSkipLine(sha, subject, { git, tip }) {
  // MINOR 1 (ruling rev 3) — the tip is REQUIRED, never defaulted to 'HEAD'.
  // `resolveRange` accepts an arbitrary range, so anchoring liveness at a
  // hardcoded 'HEAD' answers a question about a different commit than the one
  // being audited: an offender reverted PAST the audited tip would be exempted
  // out of a window that never contained the revert. A default would leave that
  // fail-open one careless caller away — and an exported guard whose soundness
  // depends on its caller is unsound by design. So: throw.
  if (!tip) {
    throw new Error('resolvedSkipLine: no audited tip supplied — refused fail-closed (design §2.2)');
  }
  const { resolved } = isResolvedAt(sha, tip, { git });
  return resolved ? `[SKIP] ${sha.slice(0, 7)} ${subject} — resolved by revert` : null;
}

/**
 * Enumerate the commits on the audited first-parent line in `range`, plus the
 * window anchors every skip/exemption predicate shares (design "Data Flow").
 *
 * `--first-parent` AND NOTHING ELSE (issue #518). This used to carry `--merges`
 * as well, which selects commits with MORE THAN ONE PARENT — so a squash merge,
 * landing as a single-parent commit, was never enumerated. Not evaluated and
 * passed: never looked at. None of diffSize / issueLink / adrPresence /
 * memoryPresence / writesGoverned ran on it, the window reported clean by not
 * reporting that commit at all, and the cursor then advanced past it. Because
 * the cursor only moves forward, every such commit became permanently
 * un-re-auditable.
 *
 * Measured on `origin/main` over the 60 days to 2026-08-10: 101 first-parent
 * commits, 70 enumerated, **31 never audited** — 32 of them carrying a `(#N)`
 * PR reference, among them #404, #433, #448, #462 and #401. Governance work.
 *
 * `--first-parent` is still load-bearing and is NOT what was wrong: it keeps the
 * walk on the INTEGRATION line, so a slice merge nested inside a feature branch
 * is not audited as though it had landed on main. Dropping it would fail every
 * `Part of #N` commit inside a merged branch.
 *
 * WHY THIS IS SAFE FOR THE EXEMPTION MODEL, which is what made it a design
 * change rather than a filter edit: every predicate is built on `${sha}^1..${sha}`,
 * and `^1` resolves for ANY non-root commit — for a single-parent commit it is
 * simply its own diff, which is if anything less ambiguous than a merge's
 * contribution against its first parent. `sign`, `netPresent`, `netAddFull` and
 * `addedPathsAbsentAt` therefore need no change. What needed changing is the
 * three ENUMERATORS, and they had to move together: this one on the offender
 * side, and `firstParentMerges{After,Inclusive}` on the revert side
 * (`resolution.mjs`). Widening one alone would leave the two disagreeing about
 * what a window contains.
 *
 * Range-load via the throwing seam (salvaged R-2 exit-2 site, re-derived
 * against git-seam.mjs — never cherry-picked; design §8): a throwing call
 * distinguishes "git could not compute the range" (infra → fail-closed) from
 * "the range genuinely has zero commits" (→ `commits: []`, a caller decision).
 *
 * NAMED for what it enumerates. It was `listMerges` returning `{ merges }`, and
 * keeping that would have propagated the untruth into every caller's
 * destructuring — the audited set is no longer the merges.
 *
 * @param {string} range
 * @param {string} cwd
 * @returns {{ commits: {sha: string, subject: string}[], windowFrom: string|null, windowTo: string }}
 */
export function listAuditedCommits(range, cwd) {
  const log = gitOrThrow(['log', '--first-parent', '--format=%H%x09%s', range], { cwd }).trim();
  const windowTo = auditedTip(range);
  if (!log) return { commits: [], windowFrom: null, windowTo };

  const commits = log.split('\n').filter(Boolean).map(line => {
    const i = line.indexOf('\t');
    return { sha: line.slice(0, i), subject: line.slice(i + 1) };
  });

  // The reverter-skip is FULL-WINDOW (design §15.3): its signed count must see
  // an offender sitting at the window base BEHIND a tip-most cleanup revert.
  // `netAddFull` enumerates `${from}^1..${to}`, so `from` is the OLDEST commit in
  // the window (git log is newest-first) and `from^1` must resolve. It does for
  // every non-root commit; a range reaching the root commit is refused upstream
  // by `readMergeParent`, fail-closed, rather than silently narrowed here.
  const windowFrom = commits[commits.length - 1].sha;
  return { commits, windowFrom, windowTo };
}

/**
 * Resolve an audited commit's first parent.
 *
 * Every non-root commit has one, whatever its shape (issue #518) — this used to
 * say "a `--merges`-qualified commit always has ≥2 parents", which was true of
 * the old walk and is not of this one. The guarantee it rests on is weaker and
 * still sufficient: `%P` is empty ONLY for the root commit. So the throw below
 * now fires exactly when the range reaches the root, which is genuinely
 * uncomputable for a diff-against-parent model — never a silent skip (design
 * §5). Fail-closed: throws with the exact
 * message brain-audit's top-level catch prints (byte-identical to pre-
 * extraction output — the catch prepends `[FAIL] governance:audit-uncomputable
 * — ` to `err.message`).
 *
 * @param {string} sha
 * @param {string} subject
 * @param {string} cwd
 * @returns {string} parent1 sha
 */
export function readMergeParent(sha, subject, cwd) {
  const parents = gitOrThrow(['log', '-1', '--format=%P', sha], { cwd })
    .trim().split(/\s+/).filter(Boolean);
  const parent1 = parents[0];
  if (!parent1) {
    throw new Error(`${sha.slice(0, 7)} ${subject}: no resolvable parent`);
  }
  return parent1;
}

/**
 * Read a merge's diff evidence (numstat, changed files, commit body).
 *
 * MINOR 2 (external ruling rev 3 on #297): there is deliberately NO
 * error-swallowing `git()` helper here. Every read goes through `gitOrThrow`,
 * so a transient git failure THROWS instead of returning an EMPTY diff that
 * would make diffSize and adrPresence PASS silently. Returning '' on failure
 * was a silent fail-open inside the one slice whose thesis is "never a silent
 * PASS". A source-scan test in brain-audit.test.mjs keeps the helper from
 * returning.
 *
 * @param {string} parent1
 * @param {string} sha
 * @param {string} cwd
 * @returns {{ numstat: string, changedFiles: string[], body: string }}
 */
export function readMergeDiff(parent1, sha, cwd) {
  const numstat = gitOrThrow(['diff', '--numstat', parent1, sha], { cwd }).trim();
  const changedFiles = gitOrThrow(['diff', '--name-only', parent1, sha], { cwd })
    .split('\n').filter(Boolean);
  // #510: the ADDED half, through the SAME gitOrThrow — the audit must reach the
  // identical verdict CI reached on the same merge, and it can only do that from the
  // identical evidence. A cheaper read here (or a null default) would put measurement
  // and enforcement on different rules, which is the drift #340 already records.
  const addedFiles = gitOrThrow(['diff', '--diff-filter=A', '--name-only', parent1, sha], { cwd })
    .split('\n').filter(Boolean);
  const body = gitOrThrow(['log', '-1', '--format=%B', sha], { cwd }).trim();
  return { numstat, changedFiles, addedFiles, body };
}

/**
 * Best-effort PR metadata fetch (single call for labels + body). Parse the PR
 * number from the merge subject, then fetch the PR once for:
 *   • labels  → size:exception check (diffSize skip)
 *   • body    → issueLink check (PR description has Closes/Part of #N;
 *               merge commit body is typically "Merge pull request #N")
 *
 * NEVER crash, and NEVER collapse a fetched-but-null value back into a
 * fabricated [] / '' default — `shouldSkipSize()`/`selectIssueLinkBody()`
 * already treat null as "no evidence" correctly; re-fabricating an empty
 * default here would re-introduce the exact fail-open the seam removes, just
 * on a parallel path (prView fix-at-source disposition).
 *
 * `prMetaError` (issue #474, REQ-TS-1) is the fourth field, and it is the whole
 * point of this function's error handling. The bare `catch {}` this replaces
 * KNEW the fetch had failed and threw that knowledge away, so
 * `selectIssueLinkBody(null, commitBody)` fell back to the auto-generated merge
 * commit body — where `Closes #N` never lives — and `issueLink` rendered a
 * CONFIDENT FAIL. "I could not reach the API" and "this gate failed" became the
 * same verdict: `brain/core/anti-patterns/evidence-reader-empty-on-failure.md`
 * in the authentication layer, and the reason #467 reported a governance
 * verdict instead of an outage.
 *
 * Three states, deliberately distinguished (REQ-TS-1/-3 — see the change's
 * design.md §4; #474 asked for exactly this to be stated):
 *
 *   • fetch attempted and FAILED  → `prMetaError` set. UNCOMPUTABLE: the caller
 *     must refuse to render a verdict from evidence it could not read.
 *   • `prNum === null`            → `prMetaError` null. The subject references
 *     no PR (squash/direct merge); there is nothing to fetch. The ABSENCE of a
 *     PR is real evidence, not missing evidence — audit from the commit body.
 *   • `vcs === null`              → `prMetaError` null. No adapter configured: a
 *     deliberate configuration, uniform across every merge and therefore
 *     visible, not a selective per-PR outage. Callers surface it once as a
 *     [WARN] rather than failing the window closed, so a consumer repo with no
 *     VCS adapter keeps auditing.
 *
 * `sha` (issue #1086, D4) is the fourth positional argument, NOT an options
 * object — #474's REQ-TS pins destructure the first three positionally and
 * must stay byte-identical. It is consulted ONLY when `prView` reports a
 * definitive `absent: true` on the subject's own number: the shared
 * `commitPrs({ project, sha })` verb then answers which pull requests contain
 * the merge commit, and the dispatch table in spec.md decides the rest. The
 * gate is structural — `absent` is `null`/`false` on every OTHER failure or
 * success, so a transport failure can reach `commitPrs` by no path at all
 * (the fail-closed proof in `merge-walk.test.mjs`).
 *
 * Two additive return fields (design D5): `subjectRef` is what `parsePrNumber`
 * saw in the subject, unconditionally; `prSource` is `'subject'` (the
 * unchanged today-path), `'commit-sha'` (resolved via `commitPrs`), or `null`
 * (no PR audited — either the subject named none, or the commit-sha lookup
 * definitively found none, both "commit body" outcomes). `prNum` stays
 * `subjectRef` on the LEGACY unreadable path (today's behavior, byte-
 * identical); it is `null` on every ambiguous/unresolvable dispatch outcome,
 * so `prMetaError !== null && prNum !== null` IS the legacy case and needs no
 * third field to distinguish it.
 *
 * @param {string} subject
 * @param {object|null} vcs
 * @param {object} config
 * @param {string} [sha] Required only for the commit-sha dispatch branch.
 * @returns {Promise<{ prNum: number|null, subjectRef: number|null, prLabels: string[]|null, prBody: string|null, prAuthor: string|null, prReviews: Array|null, prMetaError: string|null, prSource: 'subject'|'commit-sha'|null }>}
 */
export async function fetchPrMeta(subject, vcs, config, sha) {
  let prLabels = null;
  let prBody = null;
  let prAuthor = null;
  let prReviews = null;
  let prMetaError = null;
  let prSource = null;
  const subjectRef = parsePrNumber(subject);
  let prNum = subjectRef;
  if (subjectRef !== null && vcs) {
    try {
      const pr = await vcs.prView({
        project: config?.project?.slug,
        number: subjectRef,
      });
      if (pr.absent === true) {
        // ── The definitive negative (issue #1086, D1/D4) ────────────────────
        // The subject's number is NOT a pull request — the provider said so
        // affirmatively, not "could not tell". This is the ONLY branch that
        // opens the commit-sha lookup; every other outcome of this call
        // (`absent: false` success, `absent: null` any other failure) never
        // reaches `resolveByCommitSha` at all.
        const dispatch = await resolveByCommitSha({ vcs, config, sha, subjectRef });
        prNum = dispatch.prNum;
        prSource = dispatch.prSource;
        prLabels = dispatch.prLabels;
        prBody = dispatch.prBody;
        prAuthor = dispatch.prAuthor;
        prReviews = dispatch.prReviews;
        prMetaError = dispatch.prMetaError;
      } else {
        prLabels = pr.labels;
        prBody = pr.body;
        prAuthor = pr.author;
        // ── REQ-CIC-2's uncomputable sentinel — the path #467 ACTUALLY took ──
        // `prView` NEVER THROWS (ci-context.mjs: "an internal failure yields
        // `null` on the affected fields only, never an exception"). On a failed
        // `gh` call it RETURNS `{ labels: null, body: null }`
        // (axes/vcs/adapters/github.mjs:186 and :203; gitlab.mjs mirrors it). On SUCCESS
        // it always returns an array and a string (`data.labels ?? []`,
        // `data.body ?? ''`), so null/null is unambiguous and can only mean the
        // fetch failed.
        //
        // This — not the `catch` below — is the seam the #467 outage came
        // through, and reading #474's issue text alone would have missed it: the
        // bare `catch {}` it names is real, but it only fires if `prView` itself
        // throws (a module/adapter error), which the unauthenticated case does
        // not do. REQ-CIC-2 says consumers MUST fail closed on `null`; until now
        // the audit passed the nulls to the pure helpers and then let
        // `selectIssueLinkBody(null, commitBody)` render a confident verdict from
        // the merge commit body. Failing closed is what that requirement asks for.
        //
        // Byte-identical to pre-#1086: `absent` is `false`/`null` here, never
        // `true`, so this message and `prNum === subjectRef` are unchanged.
        if (prLabels === null && prBody === null) {
          prMetaError = `PR metadata unreadable (prView returned the REQ-CIC-2 uncomputable sentinel for #${subjectRef}) `
            + '— the API call failed; the evaluator has no evidence, not empty evidence';
        } else {
          prSource = 'subject';
          prReviews = await fetchReviews(vcs, config, subjectRef, (msg) => { prMetaError = msg; });
        }
      }
    } catch (err) {
      // The fetch was attempted and threw. Surface it as DATA — never swallow,
      // never re-fabricate an empty default, and never let the caller mistake
      // this for "the PR has no body". Emission stays with each CLI (design D2):
      // brain-audit fails the window closed, brain-metrics counts it visibly.
      prMetaError = err?.message ? String(err.message) : String(err);
    }
  }
  return { prNum, subjectRef, prLabels, prBody, prAuthor, prReviews, prMetaError, prSource };
}

/**
 * Reviews, for the human-gate invariant on merged history (#511). Only called
 * once evidence has been read successfully (from either the subject PR or a
 * commit-sha-resolved PR) — asking for reviews on a PR whose metadata is
 * already uncomputable would produce a second, weaker sentinel for the same
 * failure. `prReviews` returns null on a failed call and an array on success —
 * null is preserved as "no evidence", never flattened to `[]`, which would
 * read as "reviewed by nobody" and is a verdict. Three outcomes, and they are
 * NOT the same thing:
 *   verb absent   → the adapter cannot answer this question at all. A capability
 *                   gap, not a failed read: the check abstains and the window
 *                   stays clean. (Every real provider implements it — VERBS —
 *                   so this is the injected/partial-adapter case.)
 *   returns null  → the verb exists and the call FAILED. That rides the SAME
 *                   uncomputable channel prView's sentinel does; inventing a
 *                   second one inside the check is what turned 16 tests red.
 *   returns array → evidence.
 *
 * @param {object} vcs
 * @param {object} config
 * @param {number} number
 * @param {(msg: string) => void} onError
 * @returns {Promise<Array|null>}
 */
async function fetchReviews(vcs, config, number, onError) {
  if (typeof vcs.prReviews !== 'function') return null;
  const prReviews = await vcs.prReviews({ project: config?.project?.slug, number });
  if (prReviews === null) {
    onError(`PR reviews unreadable for #${number} — the API call failed; `
      + 'the evaluator has no evidence, not empty evidence');
  }
  return prReviews;
}

/**
 * A one-level re-read of `prView`/`prReviews` for a pull request resolved by
 * commit sha (issue #1086, D4's Data Flow: "a one-level re-read through a
 * local `readPr(number)` helper, never recursion"). Fetches EXACTLY what the
 * subject path fetches, through the SAME calls, so a merge resolved by commit
 * sha is evaluated identically to one resolved by subject — no second
 * evidence shape exists. Never dispatches on the re-read PR's own `absent`
 * field: that would be a second attempt, which the design explicitly refuses.
 *
 * @param {object} vcs
 * @param {object} config
 * @param {number} number
 * @returns {Promise<{ prLabels, prBody, prAuthor, prReviews, error: string|null }>}
 */
async function readPr(vcs, config, number) {
  const pr = await vcs.prView({ project: config?.project?.slug, number });
  const prLabels = pr.labels;
  const prBody = pr.body;
  const prAuthor = pr.author;
  if (prLabels === null && prBody === null) {
    return {
      prLabels: null, prBody: null, prAuthor: null, prReviews: null,
      error: `PR metadata unreadable (prView returned the REQ-CIC-2 uncomputable sentinel for #${number}) `
        + '— the API call failed; the evaluator has no evidence, not empty evidence',
    };
  }
  let error = null;
  const prReviews = await fetchReviews(vcs, config, number, (msg) => { error = msg; });
  return { prLabels, prBody, prAuthor, prReviews, error };
}

/**
 * The commit-sha dispatch (issue #1086, D3/D4): reachable ONLY from a
 * definitive `absent: true` on the subject's own number (the caller's
 * structural gate). Resolves `commitPrs({ project, sha })` and dispatches per
 * spec.md's table — never a guess between multiple candidates, never a
 * fabricated empty on a lookup failure.
 *
 * @param {{ vcs: object, config: object, sha: string|undefined, subjectRef: number }} args
 * @returns {Promise<{ prNum: number|null, prSource: 'commit-sha'|null, prLabels, prBody, prAuthor, prReviews, prMetaError: string|null }>}
 */
async function resolveByCommitSha({ vcs, config, sha, subjectRef }) {
  const uncomputable = (reason) => ({
    prNum: null, prSource: null, prLabels: null, prBody: null, prAuthor: null, prReviews: null,
    prMetaError: `subject's #${subjectRef} is not a pull request; ${reason} `
      + '— the evaluator has no evidence, not empty evidence',
  });

  if (typeof vcs.commitPrs !== 'function' || !sha) {
    return uncomputable('the commit-sha pull request lookup is unavailable on this provider');
  }

  const prs = await vcs.commitPrs({ project: config?.project?.slug, sha });
  if (prs === null) {
    return uncomputable('the commit-sha pull request lookup failed');
  }
  if (prs.length === 0) {
    // Real evidence: no pull request contains this commit — audit the commit
    // body, exactly the existing no-PR path (spec: "Absent; no pull request
    // contains the merge"). Not an error: `prMetaError` stays null.
    return {
      prNum: null, prSource: null, prLabels: null, prBody: null, prAuthor: null, prReviews: null, prMetaError: null,
    };
  }
  if (prs.length > 1) {
    return uncomputable(
      `${prs.length} pull requests contain the merge commit (${prs.join(', ')}) and none can be chosen`,
    );
  }

  const [number] = prs;
  const read = await readPr(vcs, config, number);
  if (read.error) {
    return uncomputable(`the commit-sha-resolved pull request #${number} could not be read — ${read.error}`);
  }
  return {
    prNum: number, prSource: 'commit-sha',
    prLabels: read.prLabels, prBody: read.prBody, prAuthor: read.prAuthor, prReviews: read.prReviews,
    prMetaError: null,
  };
}

/**
 * VCS adapter resolution for the size:exception label check (best-effort). If
 * the adapter is unavailable or misconfigured, callers proceed without the
 * size:exception bypass — never crash on a missing VCS config.
 *
 * @param {object} config
 * @returns {Promise<object|null>}
 */
export async function resolveVcs(config) {
  try {
    return await getVcs({ config });
  } catch {
    return null;
  }
}

/**
 * Evaluate a single merge's governance verdict — the VERDICT layer (design
 * table). Runs the 4 checks, applies the size:exception skip, then the
 * reverter exemption (tree-keyed only), and finally decides whether a
 * surviving tree-keyed failure is auto-revert-nominable.
 *
 * Returns BOTH `realResults` (the four checks evaluated UNCONDITIONALLY,
 * ignoring the size:exception label — the "raw" signal brain-metrics' D5
 * raw/enforced split needs) and `results` (the label-adjusted view
 * brain-audit's own emission uses, where `diffSize` is force-passed when
 * `size:exception` is present).
 *
 * @param {string} sha
 * @param {object} ctx
 * @param {string} ctx.numstat
 * @param {string[]} ctx.changedFiles
 * @param {string[]} [ctx.addedFiles]  #510: the added-only half; omit for pre-#510 behaviour
 * @param {string} ctx.issueLinkBody
 * @param {string[]|null} ctx.prLabels
 * @param {string[]} ctx.ignoreList
 * @param {Array} ctx.allObservations
 * @param {{orThrow: Function}} ctx.resolutionGit
 * @param {string} ctx.windowFrom
 * @param {string} ctx.windowTo
 * @param {number} [ctx.diffBudget=400]  Tier-resolved diff-size budget (issue
 *   #358 Q5, REQ-TIER-9) — replaces the old module-level `DEFAULT_BUDGET`
 *   this function used to fall back to silently. This layer stays pure and
 *   tier-agnostic: it takes the budget as data. Callers (brain-audit.mjs,
 *   brain-metrics.mjs) MUST resolve `tierParams(resolveTier(config)).diffBudget`
 *   and pass it through explicitly. The `400` default here exists only so a
 *   caller that has not yet been migrated degrades to the pre-tier behaviour
 *   instead of silently changing it.
 * @param {boolean} [ctx.honorSizeException=true]  Whether the resolved tier
 *   honors `size:exception` (REQ-TIER-6) —
 *   `tierParams(resolveTier(config)).honorSizeException`. `regulated` MUST
 *   pass `false` here so the audit path refuses the waiver exactly like the
 *   CI/hook path (`run-check.mjs`'s `runDiffSizeCheck`) already does.
 * @param {boolean} [ctx.memoryHistory]  #1188: whether any `.memory/records` file exists (see `auditMemoryVerdict`).
 * @param {string} [ctx.tier]  Declared tier name, used ONLY to name the tier
 *   in the refusal message when a size:exception label is present but not
 *   honored — never consulted for policy (that is `honorSizeException`'s job).
 * @returns {{
 *   kind: 'pass'|'reverter-skip'|'fail',
 *   results: object,
 *   realResults: object,
 *   sizeSkipped: boolean,
 *   failures?: [string, object][],
 *   surviving?: [string, object][],
 *   exempt?: boolean,
 *   survivesTreeKeyed?: boolean,
 *   nominable?: boolean,
 * }}
 */
export function evaluateMerge(sha, ctx) {
  const {
    numstat, changedFiles, addedFiles = null, issueLinkBody, prLabels, ignoreList,
    prReviews = null, prAuthor = null, prResolved = false, botAllowlist = [],
    allObservations, resolutionGit, windowFrom, windowTo,
    diffBudget = 400, honorSizeException = true, tier, memoryHistory,
  } = ctx;

  const exceptionLabelPresent = shouldSkipSize(prLabels);
  // REQ-TIER-6: the waiver is resolved through the tier, never honored
  // unconditionally. `regulated` (honorSizeException: false) must NOT force-pass
  // diffSize even when the label is present.
  const sizeSkipped = exceptionLabelPresent && honorSizeException;

  // `realResults` is the UNCONDITIONAL check — always run, regardless of the
  // size:exception label. brain-audit's own `results` (below) is the
  // label-adjusted view it emits from; brain-metrics' raw/enforced split
  // (design D5) needs BOTH views simultaneously.
  const realResults = {
    diffSize: diffSize(numstat, ignoreList, diffBudget),
    issueLink: issueLink(issueLinkBody),
    adrPresence: adrPresence(changedFiles, addedFiles),
    memoryPresence: auditMemoryVerdict({ allObservations, issueLinkBody, tier: tier ?? 'standard', memoryHistory }),
  };
  // Abstention is ABSENCE. A check that has nothing to say about this merge is simply
  // not in the result set — the walk, the reverter-skip, the metrics parity and the
  // exit contract all keep working on the states they already know.
  const governed = writesGoverned({
    changedFiles, reviews: prReviews, author: prAuthor,
    prResolved, botAllowlist, tier: tier ?? 'standard',
  });
  if (!governed.abstain) realResults.writesGoverned = governed;

  const tierRefusedDiffSize = exceptionLabelPresent && !honorSizeException && !realResults.diffSize.pass;

  const results = {
    ...realResults,
    diffSize: sizeSkipped
      ? { pass: true, note: 'size:exception label present — diffSize skipped' }
      : tierRefusedDiffSize
        ? {
            ...realResults.diffSize,
            reason: `${realResults.diffSize.reason} — size:exception is not honored${tier ? ` at the "${tier}" tier` : ' at this tier'}; the change must be sliced.`,
          }
        : realResults.diffSize,
  };

  const failures = Object.entries(results).filter(([, r]) => !r.pass);

  if (failures.length === 0) {
    return { kind: 'pass', results, realResults, sizeSkipped };
  }

  // ── Reverter-skip (design §15.3, REQ-D2-10a; guard (c′) per the external
  // ruling rev 4 on #297) — evaluated ONLY for a merge that already failed, so
  // the happy path pays zero extra cost. See brain-audit.mjs's history for the
  // full rationale (verbatim, unchanged by extraction).
  const failingNames = failures.map(([name]) => name);
  const hasTreeKeyed = failingNames.some((name) => TREE_KEYED_CHECKS.has(name));
  const exempt = hasTreeKeyed
    && addedPathsAbsentAt(sha, windowTo, { git: resolutionGit })
    && netAddFull(sha, { git: resolutionGit, from: windowFrom, to: windowTo }) <= 0;

  const surviving = failures.filter(([name]) => !(exempt && TREE_KEYED_CHECKS.has(name)));

  if (surviving.length === 0) {
    return { kind: 'reverter-skip', results, realResults, failures, sizeSkipped, exempt };
  }

  const survivingNames = surviving.map(([name]) => name);
  const survivesTreeKeyed = survivingNames.some((name) => TREE_KEYED_CHECKS.has(name));
  // `revertResurrectsAt` is only ever consulted when a tree-keyed failure
  // survives (short-circuit) — mirrors the original one-git-call-only-when-
  // needed shape verbatim.
  const nominable = survivesTreeKeyed && !revertResurrectsAt(sha, windowTo, { git: resolutionGit });

  return {
    kind: 'fail', results, realResults, failures, surviving, sizeSkipped, exempt, survivesTreeKeyed, nominable,
  };
}
