// memory-gate.mjs — the ONE memory-gate predicate (issue #1188).
//
// The PR-time `memory-gate` (run-check.mjs) and the post-merge audit
// (lib/merge-walk.mjs `evaluateMerge`) both evaluate THIS function. Before
// #1188 the audit called `memoryPresence` directly — repo-wide and tier-blind —
// while the gate ran issue-scoped retrieval and treated `lite` as detection-only.
// The same merge got two verdicts, and a fresh consumer's first real merge
// failed post-merge as `governance:audit-unrevertible` after the gate had
// passed it.
//
// Pure with respect to the VCS port: it reads git only through an injected
// `readDefaultBranchRecords` and imports no port. That is what lets the audit
// share it without inheriting run-check.mjs's port-reach profile
// ("entry point, never a library").

import { memoryPresence } from './memory-presence.mjs';
import { memoryRetrieval } from './memory-retrieval.mjs';
import { CLOSING_RE, CHAIN_RE } from './issue-ref-patterns.mjs';
import { readDefaultBranchRecords, unionRecordsById } from '../default-branch-records.mjs';
import { mapDetectionToWarning } from '../detection-policy.mjs';

/**
 * Extracts the referenced issue number from a PR/MR body, mirroring GitHub
 * bash's OWN branch-conditional precedence (issue #231 CP-A2a review,
 * finding m2 — governance.yml:55-81) rather than a single fixed order:
 *   - Default-branch target (`closingRequired`): the default-branch policy
 *     already requires a closing keyword, so ONLY the closing pattern is
 *     consulted (mirrors governance.yml:56-64 — no Part-of fallback there).
 *   - Slice target (`!closingRequired`): Part-of is tried FIRST, then
 *     closing (mirrors governance.yml:69-76 exactly). This matters when a
 *     body carries BOTH patterns pointing at DIFFERENT issues — bash always
 *     resolves the Part-of issue on a slice target; before m2 this file
 *     always resolved the closing issue instead (a fail-OPEN divergence).
 *
 * @param {string} body
 * @param {boolean} closingRequired  From requiresClosingKeyword(ctx) — true
 *   when ctx.targetBranch === ctx.defaultBranch.
 * @returns {number|null}
 */
export function extractIssueNumber(body, closingRequired) {
  if (typeof body !== 'string') return null;

  if (closingRequired) {
    const closing = body.match(CLOSING_RE);
    return closing ? Number(closing[2]) : null;
  }

  const chain = body.match(CHAIN_RE);
  if (chain) return Number(chain[1]);
  const closing = body.match(CLOSING_RE);
  return closing ? Number(closing[2]) : null;
}

/**
 * Default-branch-conditionality (issue #231 A2 phase 2 ADDENDUM — closes the
 * base-branch parity gap vs GitHub bash, governance.yml:45-70): the platform
 * only runs closing keywords (Closes/Fixes/Resolves) on merges to the
 * DEFAULT branch (GitHub and GitLab alike), so the gate mirrors where the
 * keyword actually has effect, not a naming convention ('main'). The pure
 * issueLink() evaluator stays base-branch-UNAWARE by design (REQ-CIC-4) — the
 * conditionality lives HERE, in the wrapper, fed by ci-context's
 * `defaultBranch` (REQ-CIC-2 delta).
 *
 * @param {{ targetBranch?: string|null, defaultBranch?: string|null }} ctx
 * @returns {boolean|null} true = closing keyword required (default-branch
 *   target); false = "Part of #N" also accepted (slice target); null =
 *   indeterminate — targetBranch or defaultBranch is uncomputable, so the
 *   conditional cannot be decided.
 */
export function requiresClosingKeyword(ctx) {
  if (ctx.targetBranch == null || ctx.defaultBranch == null) return null;
  return ctx.targetBranch === ctx.defaultBranch;
}

/**
 * Steps 2-6 of the memory-gate case (T2.1/#1024, REQ-L3-4/REQ-CIC-3):
 * resolves the scoped/fallback verdict AFTER the override (step 1) has
 * already decided not to short-circuit. Extracted from `runMemoryGateCheck`
 * (Batch 3) so the override's refusal note (`applyOverrideNote`) can wrap
 * EVERY exit point uniformly, instead of duplicating the append at each
 * early return.
 *
 *   2. D6 — a `PR_NUMBER`-bearing but uncomputable `ctx.body`: fails closed
 *      at `standard`/`regulated`, degrades to `path=presence` at `lite`;
 *   3. the pre-existing GLOBAL memoryPresence() fallback when no issue
 *      number can be resolved at all (unchanged — see the ORIGINAL
 *      docstring this replaces: this is a deliberate choice not to
 *      fail-closed on "no issue detectable");
 *   4. D3's LAZY union — the PR tree alone first; the default-branch reader
 *      (`readDefaultBranchRecords`) runs ONLY when the PR tree alone is not
 *      already a clean HIT;
 *   5. D5 — a default-branch read failure fails closed on a miss, but never
 *      overturns an existing PR-tree HIT;
 *   6. D8 — a `regulated` PARTIAL pass carries a visible evidence-gap note.
 *
 * @param {object} ctx
 * @param {Array<object>} records
 * @param {{ readDefaultBranchRecords?: Function, cwd?: string }} deps
 * @param {'lite'|'standard'|'regulated'} tier
 * @returns {{ pass: boolean, reason?: string, path?: string, pathDetail?: string, uncomputable?: boolean }}
 */
export function evaluateMemoryGate(ctx, records, deps, tier) {
  // ── 2. D6 — PR_NUMBER set but body uncomputable ───────────────────────
  if (ctx?.prNumber != null && typeof ctx?.body !== 'string') {
    if (tier === 'lite') {
      return { ...memoryPresence(records), path: 'presence', pathDetail: 'PR description uncomputable' };
    }
    return {
      pass: false,
      uncomputable: true,
      path: 'uncomputable',
      pathDetail: 'PR description uncomputable',
      reason:
        'memory-gate: PR description uncomputable (context API fetch failed) — cannot scope to ' +
        `an issue; failing closed at the "${tier}" tier`,
    };
  }

  // ── 3. No PR context / no issue detectable — global fallback (unchanged) ─
  if (typeof ctx?.body !== 'string') {
    return { ...memoryPresence(records), path: 'presence', pathDetail: 'no PR context — PR_NUMBER not provided' };
  }
  const closingRequired = requiresClosingKeyword(ctx) === true;
  const issueNumber = extractIssueNumber(ctx.body, closingRequired);
  if (issueNumber == null) {
    return { ...memoryPresence(records), path: 'presence', pathDetail: 'no issue reference in the PR description' };
  }

  // ── 4. D3 — lazy union: the PR tree alone first ───────────────────────
  const prOnly = memoryRetrieval(records, issueNumber);
  const prOnlyIsCleanHit = prOnly.pass && !/partial coverage/.test(prOnly.reason ?? '');
  if (prOnlyIsCleanHit) {
    return { ...prOnly, path: `retrieval #${issueNumber}`, pathDetail: 'records: pr-tree' };
  }

  const fetchDefaultBranchRecords = deps.readDefaultBranchRecords ?? readDefaultBranchRecords;
  const defaultBranchResult = fetchDefaultBranchRecords({ defaultBranch: ctx.defaultBranch, cwd: deps.cwd });

  // ── 5. D5 — default-branch read failure ───────────────────────────────
  if (defaultBranchResult.error) {
    const pathDetail = `records: pr-tree only — default branch unreadable: ${defaultBranchResult.error}`;
    if (prOnly.pass) {
      return { ...prOnly, path: `retrieval #${issueNumber}`, pathDetail };
    }
    return {
      pass: false,
      uncomputable: true,
      path: `retrieval #${issueNumber}`,
      pathDetail,
      reason:
        `memory-gate: no record scoped to #${issueNumber} on the PR tree and origin/<default> is ` +
        `unreadable (${defaultBranchResult.error}) — failing closed`,
    };
  }

  const union = unionRecordsById(records, defaultBranchResult.records);
  const unionResult = memoryRetrieval(union, issueNumber);
  // Batch 3 MINOR (visibility): a full clone reads the LOCAL
  // refs/remotes/origin/<default> without ever fetching — that read can be
  // stale (the ref was last updated whenever this clone/worktree last
  // fetched, which may be long before this run). Name the source explicitly
  // so a stale local ref is never mistaken for current evidence.
  const sourceNote = defaultBranchResult.fetched ? 'fetched' : 'local ref, not fetched';
  let result = { ...unionResult, path: `retrieval #${issueNumber}`, pathDetail: `records: pr-tree+origin/<default> (${sourceNote})` };

  // ── 6. D8 — regulated PARTIAL visibility ──────────────────────────────
  if (tier === 'regulated' && unionResult.pass && /partial coverage/.test(unionResult.reason ?? '')) {
    result = {
      ...result,
      reason:
        `${unionResult.reason} — evidence gap: the "regulated" tier declares ` +
        'issue-linked-session-summary; partial coverage passes until that is enforced',
    };
  }

  return result;
}


/**
 * The verdict a consumer acts on: the shared predicate, then the tier's
 * exit-shape mapping (`memory-gate` is `detection` at `lite` — a violation is a
 * pass carrying a `::warning::`; `GATE_MATRIX['memory-gate'].lite`). run-check.mjs
 * applies the same mapping in `main()` after its override note; the audit applies
 * it here, so both sides agree on what `lite` means.
 *
 * @param {object} ctx
 * @param {Array<object>} records
 * @param {{ readDefaultBranchRecords?: Function, cwd?: string }} deps
 * @param {'lite'|'standard'|'regulated'} tier
 * @returns {{ pass: boolean, reason?: string, path?: string, pathDetail?: string, uncomputable?: boolean }}
 */
export function memoryGateVerdict(ctx, records, deps, tier) {
  return mapDetectionToWarning(evaluateMemoryGate(ctx, records, deps, tier), tier, 'memory-gate');
}
