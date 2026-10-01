// run-check.mjs — thin git/IO runner wrapping governance's pure checks (design §4).
//
// Usage: node brain/scripts/governance/run-check.mjs <memory-gate|decision-gate|issue-link|diff-size|base-branch>
//
// All decision logic lives in the already-tested pure functions
// (memoryPresence, adrPresence, issueLink, diffSize, baseBranchRule). This
// file is git/IO glue only:
//   memory-gate    → memoryPresence(readRecordObservations(cwd))
//   decision-gate  → adrPresence(git diff --name-only BASE_SHA...HEAD_SHA)
//   issue-link     → issueLink(ctx.body) + referenced-issue approved-label check
//   diff-size      → diffSize(git diff --numstat BASE_SHA...HEAD_SHA, ignoreList)
//   base-branch    → baseBranchRule(linked issue + parent bodies, ctx branches) (#967)
//
// RECORDS-ONLY (C4/D4, REQ-C4-4): the #227 transitional chunks/records union
// ("Retire the chunks-path once fully decommissioned — tracked for C4/D1") is
// retired here. The memory-gate reads `.memory/records/*.jsonl` alone — the
// chunks reader (`chunk-reader.mjs`) is no longer imported by this file.
//
// CI FRAGILITY: BASE_SHA/HEAD_SHA come from the normalized ci-context seam
// (ADR-0016), never read from process.env directly here — ci-context.mjs is
// the sole module allowed to read pipeline env (a drift-guard test enforces
// this). All I/O is injectable via `deps` so tests never touch the real
// filesystem or spawn a real git process.
//
// FAIL-CLOSED: decision-gate is a REQUIRED gate. If the diff cannot be
// computed (ctx.baseSha/headSha null/uncomputable, or the git command
// throwing), defaultDiffNameOnly() THROWS rather than degrading to `[]` — an
// empty diff would otherwise read as "no architectural change" and let
// adrPresence pass silently. runCheck() catches the throw and fails the gate
// closed instead.
//
// THE GOTCHA (issue #231 A2 phase 2, design.md Decision 2): GitLab exposes no
// CI_MERGE_REQUEST_DESCRIPTION var and its CI_MERGE_REQUEST_LABELS freeze at
// pipeline creation (ADR-0016:45), so issue-link/diff-size cannot be bash on
// GitLab the way they are on GitHub. The MR body + FRESH labels exist only
// behind loadContext()/loadGitlabContext() (one proxy-aware API call). Both
// new cases here call the ALREADY-EXISTING pure evaluators
// (checks/issue-link.mjs#issueLink, checks/diff-size.mjs#diffSize — UNCHANGED,
// ADR-0016 boundary) fed by `ctx`. `size:exception` and the referenced-issue
// approved-label read come from FRESH `ctx.labels`/an injected issue-fetch,
// NEVER from CI_MERGE_REQUEST_LABELS. issue-link is REQUIRED and fails closed
// on `ctx.body === null` — this falls out naturally from issueLink(null)
// itself returning `{ pass: false }` (typeof-string guard), so no special
// casing is needed here; a dedicated test still proves it (never exit 0).
//
// THE ADDENDUM GOTCHA (issue #231 A2 phase 2 ADDENDUM — base-branch parity
// gap): GitHub bash's issue-link job (governance.yml:45-70) is BASE-BRANCH-
// CONDITIONAL — base==default branch requires a CLOSING keyword only; a
// slice target (base!=default) also accepts "Part of #N". The pure
// issueLink() evaluator is NOT base-branch-aware (REQ-CIC-4 — it stays
// UNCHANGED), so without the wrapper-level check below, a "Part of #N"-only
// body would wrongly PASS the Node path even on the default branch — a
// governance hole. `runIssueLinkCheck` closes this with
// `requiresClosingKeyword(ctx)`, fed by ci-context's new `ctx.defaultBranch`
// (REQ-CIC-2 delta): the platform's actual default branch, never a
// hardcoded 'main' literal (platforms only run closing keywords on merges
// to the default branch, GitHub and GitLab alike — this is not a naming
// convention). `ctx.defaultBranch === null` (uncomputable) FAILS CLOSED,
// never falls back to comparing against 'main'.

import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { evaluateMemoryGate, extractIssueNumber, requiresClosingKeyword } from './checks/memory-gate.mjs';
import { adrPresence } from './checks/adr-presence.mjs';
import { issueLink } from './checks/issue-link.mjs';
import { diffSize } from './checks/diff-size.mjs';
import { baseBranchRule } from './checks/base-branch.mjs';
import { LANE_BRANCH_RE, classifyLane } from './checks/lane.mjs';
import { SWEEP_BRANCH_RE, classifySweepDiff } from './checks/archive-sweep.mjs';
import { CLOSING_RE } from './checks/issue-ref-patterns.mjs';
import { resolveApprovedLabel } from './approved-label.mjs';
import { readRecordObservations } from '../memory/lib/store.mjs';
import { parseGraphBlock, declaredParent } from '../status/epic-graph.mjs';
import { resultToExit } from './postmerge/exit-codes.mjs';
import { loadContext, gitlabApiConfig } from '../vcs/ci-context.mjs';
import { loadBrainConfig } from '../lib/brain-config.mjs';
import { getVcs } from '../vcs/cli.mjs';
import { resolveTier, tierParams, sizeExceptionRuling, SIZE_EXCEPTION_LABEL } from '../vcs/governance-tiers.mjs';
import { mapDetectionToWarning } from './detection-policy.mjs';
import { decideMemoryGateOverride, SKIP_MEMORY_GATE_LABEL, toActorList } from './memory-gate-override.mjs';

/**
 * Default `readRecords` dep for the memory-gate (issue #222 cutover fix):
 * best-effort reads `<cwd>/.memory/records/*.jsonl` via the transitional
 * `readRecordObservations`. Never throws — see that function's contract.
 *
 * @param {string} cwd
 * @returns {Array<{type?: string, [key: string]: unknown}>}
 */
function defaultReadRecords(cwd) {
  return readRecordObservations({ recordsDir: join(cwd, '.memory', 'records') });
}

/**
 * Computes `git diff --name-only $baseSha...$headSha` from the normalized
 * ci-context (`ctx.baseSha`/`ctx.headSha`). Throws when either is null/absent
 * or the git command fails — the diff-gate must fail closed rather than
 * silently treat an uncomputable diff as an empty (harmless) one.
 *
 * @param {{ baseSha?: string|null, headSha?: string|null }} ctx
 * @returns {string[]}
 */
/**
 * Computes `git diff --diff-filter=A --name-only $base...$head` — the ADDED half of
 * the same diff. Separate from defaultDiffNameOnly so both fail closed identically:
 * an uncomputable added-list must never degrade into an empty one, which would make
 * every added ADR look modified and re-open #510 from the other side.
 *
 * @param {{ baseSha?: string|null, headSha?: string|null }} ctx
 * @returns {string[]}
 */
function defaultDiffNameOnlyAdded(ctx = {}) {
  const base = ctx.baseSha;
  const head = ctx.headSha;
  if (!base || !head) {
    throw new Error('BASE_SHA/HEAD_SHA not set — cannot compute diff');
  }
  try {
    const out = execFileSync('git', ['diff', '--diff-filter=A', '--name-only', `${base}...${head}`], {
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    throw new Error(`git diff failed: ${err.message}`);
  }
}

function defaultDiffNameOnly(ctx = {}) {
  const base = ctx.baseSha;
  const head = ctx.headSha;
  if (!base || !head) {
    throw new Error('BASE_SHA/HEAD_SHA not set — cannot compute diff');
  }
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${base}...${head}`], {
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    throw new Error(`git diff failed: ${err.message}`);
  }
}

/**
 * Computes `git diff -M100% --name-status $baseSha...$headSha` — the
 * archive-sweep exemption's evidence (checks/archive-sweep.mjs's
 * `classifySweepDiff`, #557 phase 9 gap-close). `-M100%` requests git's OWN
 * exact-similarity rename detection: a folder move whose content changed
 * even by one byte is reported as a separate delete+add pair, never as
 * `R100` — the predicate relies on this to prove "moved, not modified"
 * without reading file content itself. Throws when base/head are
 * null/absent or the git command fails — mirrors defaultDiffNameOnly's
 * fail-closed contract; `runIssueLinkCheck` demotes a throw here to "not a
 * sweep" rather than `uncomputable: true` (mirrors the lane block's
 * Property 2 — an unverifiable sweep diff falls through to standard rules).
 *
 * @param {{ baseSha?: string|null, headSha?: string|null }} ctx
 * @returns {string[]}
 */
function defaultDiffNameStatus(ctx = {}) {
  const base = ctx.baseSha;
  const head = ctx.headSha;
  if (!base || !head) {
    throw new Error('BASE_SHA/HEAD_SHA not set — cannot compute diff');
  }
  try {
    const out = execFileSync('git', ['diff', '-M100%', '--name-status', `${base}...${head}`], {
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    throw new Error(`git diff failed: ${err.message}`);
  }
}

/**
 * Computes `git diff -M100% --numstat $baseSha...$headSha` — paired with
 * `defaultDiffNameStatus` for the archive-sweep exemption: `classifySweepDiff`
 * reads this to assert an `M`-status `openspec/specs/<cap>/spec.md` is a
 * PURE addition (zero deletions), never by path shape alone. Same `-M100%` flag,
 * same fail-closed contract.
 *
 * @param {{ baseSha?: string|null, headSha?: string|null }} ctx
 * @returns {string[]}
 */
function defaultDiffNumstatRenames(ctx = {}) {
  const base = ctx.baseSha;
  const head = ctx.headSha;
  if (!base || !head) {
    throw new Error('BASE_SHA/HEAD_SHA not set — cannot compute diff');
  }
  try {
    const out = execFileSync('git', ['diff', '-M100%', '--numstat', `${base}...${head}`], {
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  } catch (err) {
    throw new Error(`git diff failed: ${err.message}`);
  }
}

/**
 * Computes `git diff --numstat $baseSha...$headSha` from the normalized
 * ci-context (`ctx.baseSha`/`ctx.headSha`). Throws when either is null/absent
 * or the git command fails — mirrors defaultDiffNameOnly's fail-closed
 * contract (diff-size is REQUIRED too).
 *
 * @param {{ baseSha?: string|null, headSha?: string|null }} ctx
 * @returns {string}
 */
function defaultDiffNumstat(ctx = {}) {
  const base = ctx.baseSha;
  const head = ctx.headSha;
  if (!base || !head) {
    throw new Error('BASE_SHA/HEAD_SHA not set — cannot compute diff');
  }
  try {
    return execFileSync('git', ['diff', '--numstat', `${base}...${head}`], {
      encoding: 'utf8',
    });
  } catch (err) {
    throw new Error(`git diff failed: ${err.message}`);
  }
}

/**
 * Default `readConfig` dep for issue-link/diff-size: reads brain.config.json
 * via the shared loader. Never throws — an unreadable/missing config degrades
 * to `{}` (resolveApprovedLabel/ignoreList both tolerate an empty config).
 *
 * @returns {object}
 */
function defaultReadConfig() {
  try {
    return loadBrainConfig();
  } catch {
    return {};
  }
}

/**
 * Default `fetchIssue` dep for issue-link: fetches the referenced issue via
 * the active VCS provider's `issueView` verb (github → gh CLI; gitlab →
 * direct API v4 fetch, issue #231 CP-A2b finding #12 — the `glab` CLI is
 * absent from the node:22 CI image). Never called in tests — always injected
 * there (design.md Decision 2: "no real network in tests").
 *
 * `gitlabApiConfig()` sources { apiBase, token, proxyUrl } from the
 * sanctioned env reader (ci-context.mjs) — run-check.mjs itself is a
 * GATE_FILE and must never read the GitLab API base URL pipeline var
 * directly (ci-context-drift-guard.test.mjs forbids it). github.mjs's
 * issueView ignores the extra keys (destructures only `{ project, number }`),
 * so passing them unconditionally is harmless for GitHub.
 *
 * @param {{ repo?: string|null }} ctx
 * @returns {(issueNumber: number) => Promise<{ labels?: string[] }>}
 */
function defaultFetchIssue(ctx, { getVcs: getVcsFn = getVcs } = {}) {
  return async (issueNumber) => {
    // finding #14: dispatch on the RUNTIME-detected ctx.provider (the platform
    // hosting the MR), NOT the repo config default — a GitLab MR's referenced
    // issue lives on GitLab even when this repo's config says github. Without
    // this, a GitLab CI job fetched the issue via `gh` and failed.
    const vcs = await getVcsFn({ provider: ctx.provider });
    const { apiBase, token, proxyUrl } = gitlabApiConfig();
    return vcs.issueView({ project: ctx.repo, number: issueNumber, apiBase, token, proxyUrl });
  };
}

// CLOSING_RE/CHAIN_RE come from the shared checks/issue-ref-patterns.mjs
// (issue #231 CP-A2a review, finding M1 — this file previously duplicated
// its OWN narrower CLOSING_NUM_RE; deleted in favor of the one shared
// constant, now imported by issueLink(), this file, AND actor-check.mjs).
// The pure issueLink() evaluator stays UNCHANGED in shape (per ADR-0016) —
// this file needs the matched NUMBER, not just pass/fail, to know which
// issue's labels to verify, so it matches the same shared regex again here.

/**
 * Default `fetchPrLabelEvents` dep for the memory-gate override (D9): the
 * ONE place this file's memory-gate handler reaches the VCS port — a NAMED
 * function declaration (never an inline arrow), so the T7b static-analysis
 * mutation tests (run-check.test.mjs) can resolve it by name, mirroring
 * `defaultFetchIssue`'s existing pattern for issue-link/base-branch.
 *
 * `kind: 'mr'` (Batch 3 BLOCKER fix, #1024): `ctx.prNumber` is always the
 * PR/MR's OWN number, never an issue's — on GitLab, omitting `kind` reads
 * ISSUE label events for that same numeric IID instead of the MR's own
 * label events, so the applier could never be resolved and the override
 * could never be honored there. `gitlabApiConfig()` threading mirrors
 * `defaultFetchIssue` — this file is a GATE_FILE and must never read
 * `CI_API_V4_URL` directly (ci-context-drift-guard.test.mjs forbids it).
 * `github.mjs`'s `labelEvents` ignores the extra keys, so passing them
 * unconditionally is harmless for GitHub.
 *
 * @param {{ provider?: string, repo?: string|null, prNumber?: number|null }} ctx
 * @returns {() => Promise<Array<object>|null>}
 */
function defaultFetchPrLabelEvents(ctx, { getVcs: getVcsFn = getVcs } = {}) {
  return async () => {
    const vcs = await getVcsFn({ provider: ctx.provider });
    const { apiBase, token, proxyUrl } = gitlabApiConfig();
    return vcs.labelEvents({ project: ctx.repo, number: ctx.prNumber, kind: 'mr', apiBase, token, proxyUrl });
  };
}

/**
 * Surfaces the `skip:memory-gate` override's decision on the FINAL result,
 * on every outcome — pass, warning (softened later by `mapDetectionToWarning`),
 * fail, or uncomputable (Batch 3 MAJOR fix, REQ-L3-5/REQ-L3-4). Before this,
 * `override.reason` was discarded whenever the override was NOT honored — a
 * regulated refusal, an author/deny-listed applier, or a `lite` not-consulted
 * note were computed but never appended anywhere, the same defect
 * `runDiffSizeCheck`'s own tier-refusal append (D5, `size:exception`) already
 * avoids.
 *
 * Two cases:
 *   - `override.present` (the label WAS present, decided but not honored):
 *     append `override.reason` unconditionally — this already covers the
 *     `lite` not-consulted note, the `regulated` refusal, the author
 *     refusal, the deny-listed refusal, and the unreadable-applier note.
 *   - No label present at all: at the `standard` tier, a genuine SCOPED MISS
 *     (`path` starts with `retrieval`, `pass: false`, not `uncomputable`)
 *     must still name `skip:memory-gate` as available (REQ-L3-5 scenario
 *     "Unlabeled PR still fails a scoped miss at standard"). If `labels`
 *     itself was uncomputable (explicitly `null` — a real fetch failure, not
 *     merely unset in a hand-built ctx), the D7 degradation-table note
 *     ("labels uncomputable...") is appended instead, at any tier.
 *
 * @param {{ pass: boolean, reason?: string, path?: string, uncomputable?: boolean }} result
 * @param {{ present: boolean, reason: string|null }} override
 * @param {'lite'|'standard'|'regulated'} tier
 * @param {string[]|null|undefined} labels
 * @returns {object}
 */
function applyOverrideNote(result, override, tier, labels) {
  if (override.present) {
    return { ...result, reason: result.reason ? `${result.reason} — ${override.reason}` : override.reason };
  }

  const isScopedMiss = typeof result.path === 'string' && result.path.startsWith('retrieval')
    && result.pass === false && !result.uncomputable;
  if (isScopedMiss) {
    if (labels === null) {
      // A real fetch failure (D7 degradation table), not merely unset.
      return { ...result, reason: `${result.reason} — ${override.reason}` };
    }
    if (tier === 'standard') {
      return {
        ...result,
        reason:
          `${result.reason} — skip:memory-gate is available (honored when applied by someone ` +
          'other than the PR author, at the "standard" tier)',
      };
    }
  }
  return result;
}

/**
 * memory-gate case (T2.1/#1024, REQ-L3-4/REQ-L3-5/REQ-CIC-3): resolves the
 * `skip:memory-gate` override first (REQ-L3-5) — short-circuits BEFORE
 * scoped evaluation when honored — then delegates to
 * `evaluateMemoryGate` (checks/memory-gate.mjs, shared with the post-merge audit, #1188) for steps 2-6, and finally surfaces the
 * override's decision on the result via `applyOverrideNote` (Batch 3),
 * regardless of which step produced it.
 *
 * Every branch returns `path`/`pathDetail` alongside `pass`/`reason` (REQ-
 * L3-4's "every run MUST name the path it took") — `main()` prints them.
 *
 * @param {{ body?: string|null, prNumber?: number|null, labels?: string[]|null, author?: string|null, provider?: string, repo?: string|null, targetBranch?: string|null, defaultBranch?: string|null }} ctx
 * @param {Array<{type?: string, issue?: number|string, id?: string, [key: string]: unknown}>} records
 * @param {{ readConfig?: () => object, readDefaultBranchRecords?: Function, fetchPrLabelEvents?: () => Promise<Array<object>|null>, cwd?: string }} [deps]
 * @returns {Promise<{ pass: boolean, reason?: string, path?: string, pathDetail?: string, uncomputable?: boolean }>}
 */
async function runMemoryGateCheck(ctx, records, deps = {}) {
  const readConfig = deps.readConfig ?? defaultReadConfig;
  const config = readConfig();
  const tier = resolveTier(config);
  const reviewActors = toActorList(config?.governance?.reviewActors);
  const agentActors = toActorList(config?.governance?.agentActors);

  // ── 1. skip:memory-gate override (REQ-L3-5) ───────────────────────────
  const labels = ctx?.labels;
  const labelPresent = Array.isArray(labels) && labels.includes(SKIP_MEMORY_GATE_LABEL);
  let labelEvents = null;
  if (labelPresent && tier === 'standard') {
    const fetchPrLabelEvents = deps.fetchPrLabelEvents ?? defaultFetchPrLabelEvents(ctx, deps);
    try {
      labelEvents = await fetchPrLabelEvents();
    } catch {
      labelEvents = null;
    }
  }
  const override = decideMemoryGateOverride({
    labels, labelEvents, prAuthor: ctx?.author, tier, reviewActors, agentActors,
  });
  if (override.honored) {
    return {
      pass: true,
      path: 'skipped',
      pathDetail: override.reason,
      reason: `::notice::memory-gate: skipped by override (@${override.applier})`,
    };
  }

  const result = evaluateMemoryGate(ctx, records, deps, tier);
  return applyOverrideNote(result, override, tier, labels);
}

/**
 * issue-link case (REQUIRED, THE GOTCHA — design.md Decision 2, extended by
 * the A2 phase 2 ADDENDUM): calls the pure issueLink(ctx.body) for the
 * reference pattern, applies the default-branch-conditional closing-keyword
 * policy (see requiresClosingKeyword — FAIL-CLOSED, never assumes 'main' when
 * `ctx.defaultBranch` is uncomputable), then verifies the referenced issue
 * carries the resolved approved label via an injectable `fetchIssue`. Fails
 * closed with a DISTINCT self-diagnostic reason on a non-string body (the
 * wrapper catches it before issueLink() — "context API fetch failed", vs the
 * "no issue reference found" of a string with no link), on an uncomputable
 * target/default branch, and on a fetch failure.
 *
 * @param {{ body?: string|null, provider?: string, repo?: string|null, targetBranch?: string|null, defaultBranch?: string|null }} ctx
 * @param {{ fetchIssue?: Function, readConfig?: () => object }} deps
 * @returns {Promise<{ pass: boolean, reason?: string }>}
 */
async function runIssueLinkCheck(ctx, deps) {
  // Self-diagnostic distinction (finding #12 follow-up): a NON-STRING body means
  // ci-context could not fetch the MR description (token/endpoint/API failure) —
  // an INFRA fail-closed, not a governance miss. Distinguish it in the message so
  // a failing pipeline log discriminates (A) "no issue link" from (B) "couldn't
  // read the MR body". The pure issueLink() evaluator stays UNCHANGED (REQ-CIC-4);
  // it only ever sees a string below.
  if (typeof ctx.body !== 'string') {
    return {
      pass: false,
      uncomputable: true,
      reason: 'issue-link: MR body uncomputable (context API fetch failed) — failing closed',
    };
  }

  // Lane recomputation (D1a, design.md A4): a `memory/*` head is NEVER
  // trusted by branch name alone — the wrapper recomputes classifyLane's
  // predicate itself, before deciding whether to skip the closing-keyword
  // requirement. Property 1: short-circuit on the branch regex BEFORE
  // touching git — a non-`memory/*` head (every PR today) never calls the
  // diff closures at all, so a diff failure can never affect it.
  if (LANE_BRANCH_RE.test(ctx.sourceBranch ?? '')) {
    const diffNameOnly = deps.diffNameOnly ?? (() => defaultDiffNameOnly(ctx));
    const diffNameOnlyAdded = deps.diffNameOnlyAdded ?? (() => defaultDiffNameOnlyAdded(ctx));
    let laneResult = { lane: false };
    try {
      const changedFiles = diffNameOnly();
      const addedFiles = diffNameOnlyAdded();
      laneResult = classifyLane({ sourceBranch: ctx.sourceBranch, changedFiles, addedFiles });
    } catch {
      // Property 2: an uncomputable diff is demoted to "not a lane", NEVER
      // returned/reported as `uncomputable: true` — falling through to the
      // standard rules refuses it with the message the repo already
      // understands, rather than turning every shallow-clone `memory/*` PR
      // into exit 2.
    }
    if (laneResult.lane) {
      return { pass: true };
    }
  }

  // Archive-sweep recomputation (#557 phase 9 gap-close, design.md D6
  // amendment): an `auto-archive/*` head is NEVER trusted by branch name
  // alone either — same discipline as the memory lane above. Property 1:
  // short-circuit on the branch regex BEFORE touching git — a non-
  // `auto-archive/*` head never calls the diff closures. Property 2: an
  // uncomputable diff demotes to "not a sweep", never `uncomputable: true`
  // — falls through to the standard rules below.
  if (SWEEP_BRANCH_RE.test(ctx.sourceBranch ?? '')) {
    const diffNameStatus = deps.diffNameStatus ?? (() => defaultDiffNameStatus(ctx));
    const diffNumstatRenames = deps.diffNumstatRenames ?? (() => defaultDiffNumstatRenames(ctx));
    let sweepResult = { exempt: false };
    try {
      const nameStatusLines = diffNameStatus();
      const numstatLines = diffNumstatRenames();
      sweepResult = classifySweepDiff({ nameStatusLines, numstatLines });
    } catch {
      // Uncomputable diff — demoted to "not exempt", never surfaced as
      // uncomputable:true (mirrors the lane block immediately above).
    }
    if (sweepResult.exempt) {
      return { pass: true };
    }
  }

  const issueLinkFn = deps.issueLink ?? issueLink;
  const linkResult = issueLinkFn(ctx.body);
  if (!linkResult.pass) return linkResult;

  const closingRequired = requiresClosingKeyword(ctx);
  if (closingRequired === null) {
    return {
      pass: false,
      uncomputable: true,
      reason:
        'issue-link: cannot determine whether the PR targets the default branch ' +
        '(ctx.targetBranch or ctx.defaultBranch is null/uncomputable) — failing ' +
        'closed rather than assuming "main".',
    };
  }
  if (closingRequired && !CLOSING_RE.test(ctx.body)) {
    return {
      pass: false,
      reason:
        'issue-link: PR targets the default branch and must use a closing ' +
        'keyword (Close(s|d)|Fix(es|ed)|Resolve(s|d) #N) — "Part of #N" alone ' +
        'is only accepted on non-default (slice) targets.',
    };
  }

  const issueNumber = extractIssueNumber(ctx.body, closingRequired);
  if (issueNumber == null) {
    return {
      pass: false,
      reason: 'issue-link: matched a reference pattern but could not extract an issue number',
    };
  }

  const fetchIssue = deps.fetchIssue ?? defaultFetchIssue(ctx, deps);
  let issue;
  try {
    issue = await fetchIssue(issueNumber);
  } catch (err) {
    return {
      pass: false,
      uncomputable: true,
      reason: `issue-link: could not fetch issue #${issueNumber} — failing closed (uncomputable): ${err.message}`,
    };
  }

  const readConfig = deps.readConfig ?? defaultReadConfig;
  const approvedLabel = resolveApprovedLabel(readConfig(), ctx.provider);
  const issueLabels = issue?.labels ?? [];
  if (!issueLabels.includes(approvedLabel)) {
    return {
      pass: false,
      reason: `issue-link: issue #${issueNumber} is not labeled ${approvedLabel}`,
    };
  }
  return { pass: true };
}

/**
 * diff-size case (REQUIRED, never-tiered by position — REQ-TIER-2): reads
 * `size:exception` from FRESH `ctx.labels` (never CI_MERGE_REQUEST_LABELS —
 * design.md Decision 2) and, per REQ-TIER-6, honors it ONLY when the
 * resolved tier's `honorSizeException` allows it (`lite`/`standard` — never
 * `regulated`, which refuses the waiver and states so in the verdict rather
 * than failing silently as if the label were absent). Otherwise computes
 * `git diff --numstat` (via an injectable `diffNumstat` dep) and delegates to
 * the pure diffSize() with the tier-resolved budget (issue #358 Q5,
 * `tierParams(tier).diffBudget` — REQ-TIER-9, replacing the old hardcoded
 * 400-line default at every call site).
 *
 * @param {{ labels?: string[]|null, baseSha?: string|null, headSha?: string|null }} ctx
 * @param {{ diffNumstat?: Function, readConfig?: () => object }} deps
 * @returns {Promise<{ pass: boolean, reason?: string }>}
 */
async function runDiffSizeCheck(ctx, deps) {
  const readConfig = deps.readConfig ?? defaultReadConfig;
  const config = readConfig();
  const tier = resolveTier(config);
  const params = tierParams(tier);

  // #1072: the reading of `size:exception` is `governance-tiers.mjs`'s, not
  // this file's. It used to be decided here, and `review/evaluators/tranche
  // .mjs` decided the same question by not asking it — so the gate and the
  // reviewer gave opposite answers about the same PR. One function now, read
  // by both.
  const ruling = sizeExceptionRuling({ labels: ctx.labels, tier });
  if (ruling.honored) {
    return {
      pass: true,
      reason: `${SIZE_EXCEPTION_LABEL} label present — skipping diff-size gate (honored at the "${tier}" tier).`,
    };
  }

  const diffNumstat = deps.diffNumstat ?? (() => defaultDiffNumstat(ctx));
  let numstat;
  try {
    numstat = diffNumstat();
  } catch (err) {
    return {
      pass: false,
      uncomputable: true,
      reason: `cannot compute diff — failing closed (uncomputable): ${err.message}`,
    };
  }

  const ignoreList = Array.isArray(config?.governance?.ignoreList) ? config.governance.ignoreList : [];
  const result = diffSize(numstat, ignoreList, params.diffBudget);

  if (!result.pass && ruling.refusedByTier) {
    // REQ-TIER-6: a tier-refused waiver must be reported, never treated as
    // absent — the label WAS present; the tier is what refused it.
    return {
      ...result,
      reason: `${result.reason} — ${SIZE_EXCEPTION_LABEL} is not honored at the "${tier}" tier; the change must be sliced.`,
    };
  }

  return result;
}

/**
 * base-branch case (REQUIRED at every tier including `lite` — ruling 1,
 * design.md D9): a separate CI job, so it makes its own `fetchIssue` calls —
 * one, or two when a parent exists (D10, R967-7 S6's bounded fan-out; never
 * an `issueList`). The DECISION lives entirely in the pure `baseBranchRule`
 * (checks/base-branch.mjs); this wrapper is IO glue — same split
 * `runIssueLinkCheck` uses, same module-private `requiresClosingKeyword` and
 * `extractIssueNumber` reused in place (D10: "the reuse is code, not calls").
 *
 * `requiresClosingKeyword(ctx) === null` doubles here as "is the base itself
 * computable" — the base *is* the subject of this gate, so an uncomputable
 * target/default branch can never be a pass (D10 step 2).
 *
 * @param {{body?: string|null, sourceBranch?: string|null, targetBranch?: string|null, defaultBranch?: string|null}} ctx
 * @param {{fetchIssue?: Function}} deps
 * @returns {Promise<{ pass: boolean, reason?: string, uncomputable?: boolean }>}
 */
async function runBaseBranchCheck(ctx, deps) {
  // Step 1 — the wrapper's own self-diagnostic (mirrors runIssueLinkCheck).
  if (typeof ctx.body !== 'string') {
    return {
      pass: false,
      uncomputable: true,
      reason: 'base-branch: PR body uncomputable (context API fetch failed) — failing closed',
    };
  }

  // Step 2 — the base is the subject here; an unreadable target/default
  // branch can never be a pass.
  if (requiresClosingKeyword(ctx) === null) {
    return {
      pass: false,
      uncomputable: true,
      reason:
        'base-branch: cannot determine target/default branch (ctx.targetBranch or ' +
        'ctx.defaultBranch is null/uncomputable) — failing closed rather than assuming a base.',
    };
  }

  const headBranch = ctx.sourceBranch ?? null;

  // Step 3 — a tracker's own integration PR is now decided inside the
  // predicate, from the LINKED ISSUE's own declaration (`kind: epic` +
  // `tracker:` naming `headBranch`), not from `headBranch`'s spelling alone
  // (PR D review round 2: the prior no-port-call shortcut here trusted any
  // `feature/…`-named head as a tracker before a declaration was ever read,
  // the same bug `checks/base-branch.mjs` closed in its own predicate — this
  // wrapper duplicated it via a separate branch-name-only fast path). There
  // is no cheaper read left to skip: whether `headBranch` really is the
  // linked issue's declared tracker can only be known from that issue's
  // body, so this case now falls straight through to the same fetch every
  // other head takes below.

  // Step 4 — no linked issue is the standing case (memory-lane / no-issue PRs).
  // A `feature/…`-spelled head is not itself a decision (step 3 above: only
  // the linked issue's own `tracker:` declaration can say a head IS a
  // tracker), but with no issue linked there is no declaration left to read,
  // so a `feature/…` head that targets anything but the default branch is
  // evidence the gate cannot resolve either way — R967-7 makes a tracker's
  // own integration PR unconditional, so this must fail closed and demand
  // the issue link rather than pass silently (PR #1006 review round 2).
  const closingRequired = requiresClosingKeyword(ctx);
  const issueNumber = extractIssueNumber(ctx.body, closingRequired);
  if (issueNumber == null) {
    if (headBranch?.startsWith('feature/') && ctx.targetBranch !== ctx.defaultBranch) {
      return {
        pass: false,
        uncomputable: true,
        reason:
          `base-branch: head "${headBranch}" looks like a tracker branch and targets ` +
          `"${ctx.targetBranch}", not "${ctx.defaultBranch}" — link the issue whose epic ` +
          'declares (or does not declare) this head as its tracker; without it the gate ' +
          'cannot tell a tracker from a slice and fails closed',
      };
    }
    return { pass: true };
  }

  // Step 5 — the linked issue, fail closed on a throw or an unreadable body.
  const fetchIssue = deps.fetchIssue ?? defaultFetchIssue(ctx, deps);
  let issue;
  try {
    issue = await fetchIssue(issueNumber);
  } catch (err) {
    return {
      pass: false,
      uncomputable: true,
      reason: `base-branch: could not fetch issue #${issueNumber} — failing closed (uncomputable): ${err.message}`,
    };
  }
  if (!issue || typeof issue.body !== 'string') {
    return {
      pass: false,
      uncomputable: true,
      reason: `base-branch: issue #${issueNumber} could not be read — failing closed (uncomputable)`,
    };
  }

  // Step 6 — the linked issue's own declaration decides whether a second
  // read is owed at all: no block, an unreadable block, the issue itself
  // `kind: epic`, or no parent all resolve WITHOUT fetching a parent. The
  // parent itself is read through `declaredParent` (PR #1006 review round 1,
  // finding 1), not `issueBlock.parent` alone — `parseGraphBlock` only ever
  // resolves a `brain-graph/1` block, so a parent declared only via prose
  // (no block at all, `issueBlock` is `null`) was never fetched, and the
  // exact slice-on-main case this gate exists for passed silently.
  const issueBlock = parseGraphBlock(issue.body);
  const dp = declaredParent(issue.body);
  const needsParentRead = issueBlock?.ok !== false && issueBlock?.kind !== 'epic' && dp.parent !== null;
  if (!needsParentRead) {
    return baseBranchRule({
      issueBody: issue.body,
      targetBranch: ctx.targetBranch,
      defaultBranch: ctx.defaultBranch,
      headBranch,
    });
  }

  // Step 7 — the parent, the one further read this gate ever makes.
  const parentNumber = dp.parent;
  let epic;
  try {
    epic = await fetchIssue(parentNumber);
  } catch (err) {
    return {
      pass: false,
      uncomputable: true,
      reason: `base-branch: could not fetch parent #${parentNumber} — failing closed (uncomputable): ${err.message}`,
    };
  }
  const epicBody = epic && typeof epic.body === 'string' ? epic.body : undefined;

  // Step 8 — the final comparison lives in the predicate.
  return baseBranchRule({
    issueBody: issue.body,
    epicBody,
    targetBranch: ctx.targetBranch,
    defaultBranch: ctx.defaultBranch,
    headBranch,
  });
}

/**
 * Declares, per subcommand, whether THIS FILE'S OWN HANDLER reaches the VCS
 * port (issue #535, Requirement 3/5). Read from source text — never imported
 * — by workflow-auth.mjs's `parseSubcommandManifest`, which recognizes this
 * file as a multiplexer by the presence of this exported const, never by path
 * spelling. Values describe the HANDLER's own port use, not the file's whole
 * import closure: `diff-size: false` because `runDiffSizeCheck` never calls
 * `getVcs` itself — the bootstrap reach through `ci-context.mjs` is a
 * separate, `PR_NUMBER`-gated rule in the guard, not baked opaquely in here.
 * A test (run-check.test.mjs T7) asserts this key set sorted-equals the
 * checkNames actually dispatched below, in both directions — a manifest that
 * drifts from the dispatch is a violation the workflow-auth guard cannot see.
 *
 * `memory-gate` flips to `true` as of #1024 (D9): the skip:memory-gate
 * override's applier can only be read through `labelEvents`, fetched by
 * `defaultFetchPrLabelEvents` — a named function the handler calls, mirroring
 * `defaultFetchIssue`'s existing pattern. The T7b mutation tests that used to
 * pin memory-gate as a FALSE-declared handler are retargeted to
 * `decision-gate`, which stays `false`.
 */
export const SUBCOMMAND_PORT_REACH = {
  'memory-gate': true,    // runMemoryGateCheck → defaultFetchPrLabelEvents → getVcs (D9, #1024)
  'decision-gate': false, // adrPresence — git diff only
  'issue-link': true,     // runIssueLinkCheck → defaultFetchIssue → getVcs
  'diff-size': false,     // runDiffSizeCheck — ctx.labels/diffNumstat only
  'base-branch': true,    // runBaseBranchCheck → defaultFetchIssue → getVcs
};

/**
 * Runs a named governance check via its pure function, computing inputs from
 * git/IO (or from injected `deps` in tests).
 *
 * @param {'memory-gate'|'decision-gate'|'issue-link'|'diff-size'} checkName
 * @param {{ cwd?: string, ctx?: object, readRecords?: (cwd: string) => unknown[], diffNameOnly?: () => string[], diffNameOnlyAdded?: () => string[], fetchIssue?: Function, diffNumstat?: Function, readConfig?: () => object }} [deps]
 * @returns {Promise<{ pass: boolean, reason?: string }>}
 */
export async function runCheck(checkName, deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const readRecords = deps.readRecords ?? defaultReadRecords;
  const ctx = deps.ctx ?? {};
  const diffNameOnly = deps.diffNameOnly ?? (() => defaultDiffNameOnly(ctx));
  const diffNameOnlyAdded = deps.diffNameOnlyAdded ?? (() => defaultDiffNameOnlyAdded(ctx));

  if (checkName === 'memory-gate') {
    // A THROWING read (IO/permission failure) is UNCOMPUTABLE (→2) — never a
    // false "resolved". An EMPTY read is a genuine violation (→1): memoryPresence
    // returns pass:false. This is the code-level proof of memoryPresence's
    // "re-eval only, never a tree-effect, never a false resolved" property
    // (design §3.5 / REQ-D2-10a).
    let records;
    try {
      records = readRecords(cwd);
    } catch (err) {
      return {
        pass: false,
        uncomputable: true,
        reason: `memory-gate: cannot read records — failing closed (uncomputable): ${err.message}`,
      };
    }
    return runMemoryGateCheck(ctx, records, { ...deps, cwd });
  }
  if (checkName === 'decision-gate') {
    let changedFiles;
    let addedFiles;
    try {
      changedFiles = diffNameOnly();
      // #510: added vs modified. Inside the SAME try — an added-list that failed to
      // compute must fail closed with the rest, never fall back to null (which reads
      // as "assume everything touched is new") or to [] (which reads as "nothing was
      // added"). Both defaults are a silent verdict about evidence we do not have.
      addedFiles = diffNameOnlyAdded();
    } catch (err) {
      return {
        pass: false,
        uncomputable: true,
        reason: `cannot compute diff — failing closed (uncomputable): ${err.message}`,
      };
    }
    return adrPresence(changedFiles, addedFiles);
  }
  if (checkName === 'issue-link') {
    return runIssueLinkCheck(ctx, deps);
  }
  if (checkName === 'diff-size') {
    return runDiffSizeCheck(ctx, deps);
  }
  if (checkName === 'base-branch') {
    return runBaseBranchCheck(ctx, deps);
  }
  throw new Error(`run-check.mjs: unknown check "${checkName}"`);
}

/**
 * The verdict CI ACTS ON: `runCheck`'s evaluation routed through the tier policy
 * (`mapDetectionToWarning`, #603). `main()` exits on this, and the local gates
 * (`brain:check`, #1187) call it too — so a check the tier demotes to detection is
 * demoted in both places from ONE composition, not from a second copy of "run, then
 * look up the tier". Before this, brain:check evaluated `runCheck` bare and was stricter
 * than CI for every `lite` consumer, which is every fresh one.
 *
 * `deps.readConfig` decides the tier (the same dep `runCheck` reads the approved label
 * and ignore list through), so a caller that injects a config gets one tier everywhere.
 *
 * @param {string} checkName
 * @param {object} [deps]
 * @returns {Promise<{ pass: boolean, reason?: string, uncomputable?: boolean, path?: string, pathDetail?: string }>}
 */
export async function runCheckWithPolicy(checkName, deps = {}) {
  const result = await runCheck(checkName, deps);
  const readConfig = deps.readConfig ?? defaultReadConfig;
  const tier = resolveTier(readConfig());
  return mapDetectionToWarning(result, tier, checkName);
}

/**
 * Runs the named check, prints the reason (if any), and returns the process
 * exit code via the shared 0/1/2 contract (`resultToExit`, REQ-D2-6) — kept
 * separate from `process.exit()` itself so it stays testable. An infra failure
 * (`uncomputable: true`) is 2, never a false 0/1.
 *
 * @param {string} checkName
 * @param {object} [deps]
 * @returns {Promise<0|1|2>}
 */
export async function main(checkName, deps = {}) {
  // #603 — the tier decides the exit code, and it decides it HERE, once.
  // REQ-TIER-3's scenario is normative: "every job whose lite policy is
  // detection exits 0 with a warning annotation stating the tier as the
  // reason". `phase-order-check.mjs` and `actor-check.mjs` already routed
  // through this helper; this entrypoint — which owns memory-gate,
  // decision-gate, issue-link and diff-size — did not, so a failing
  // `memory-gate` exited 1 at `lite`. GitHub's branch protection filtered that
  // out of the merge decision; GitLab has no such layer, so the MR was blocked
  // by a gate the tier calls advisory (#603's compounding finding).
  //
  // In `main`, not in `runCheck`: `runCheck` returns the EVALUATION, and a
  // caller wanting the raw verdict must be able to have it. Softening is an
  // exit-code policy, so it lives where the exit code is computed — the same
  // split phase-order-check.mjs makes.
  //
  // The helper carries its own three guards: it softens nothing that passed,
  // nothing marked `uncomputable` (absent evidence is not a passing gate), and
  // nothing whose policy at this tier is `required`.
  const policied = await runCheckWithPolicy(checkName, deps);
  // #1024, REQ-L3-4: "every run MUST name the path it took... including a
  // clean pass, which named nothing before this change." Only the memory-gate
  // result ever carries a `path` field today — printed generically here (not
  // keyed on a literal checkName comparison) so the drift-guard's
  // dispatch-count scan (T7/T7b, which counts textual `checkName === '...'`
  // occurrences) is not doubled by this print site.
  if (typeof policied.path === 'string') {
    console.log(`memory-gate: path=${policied.path}${policied.pathDetail ? ` (${policied.pathDetail})` : ''}`);
  }
  if (policied.reason) console.log(policied.reason);
  return resultToExit(policied);
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────
import { fileURLToPath } from 'node:url';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ctx = await loadContext();
  process.exit(await main(process.argv[2], { ctx }));
}
