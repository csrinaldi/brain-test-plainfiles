#!/usr/bin/env node
// brain-metrics.mjs — governance-effectiveness metrics, re-derived from
// brain's own merged git history (issue #324, M9).
//
// Usage: node brain/scripts/brain-metrics.mjs [<git-range>] [--json] [--period=month|week]
// Default range: origin/main..HEAD (falls back to HEAD if origin/main is absent) — audit parity.
// Default period: month.
//
// Read-only reporting verb, detection-only: introduces ZERO new governance
// gates, invariants, or CI-blocking behavior. Re-executes the SAME pure check
// functions brain-audit runs (via lib/merge-walk.mjs's shared evidence +
// verdict layers), over the same first-parent merge walk — measurement can
// never drift from enforcement because it is the same code (design D1).
//
// Per period bucket: changes-merged count, median lead time (issue's last
// `status:approved` label-add before merge → merge date — an ISSUE-APPROVAL
// PROXY, not PR-review-approval time), raw/enforced failure counts for
// diff-size/issue-link/decision-gate (decision-gate counts only PRs labeled
// "decision" — mixed enforcement), bypass usage (size:exception,
// skip:memory-gate — RAW label counts, size:exception is subtracted to form
// "enforced" but skip:memory-gate NEVER is: it is documented, not enforced
// anywhere in code), and DETECTION_JOBS as a single pass/fail column (never
// blocking, no raw/enforced split).
//
// memory-gate (memoryPresence) and memory-records coverage are BOTH
// repo-level, not per-period signals (design D3 / spec's Memory-record
// coverage requirement) — printed once, separately from the period table.
//
// Exit: 0 on a normal report (including "no data for this range") — this is
// a reporting tool, not an enforcement gate. Non-zero ONLY when the range
// itself cannot be resolved (E3 — an actionable CLI usage error, not a
// governance verdict).

import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  listAuditedCommits, readMergeParent, readMergeDiff, fetchPrMeta, resolveVcs, evaluateMerge, resolvedSkipLine,
  resolveBaseline, makeGitIsAncestor, readMemoryHistory,
} from './lib/merge-walk.mjs';
// Tier resolution (issue #358 Q5, REQ-TIER-9): metrics re-derives the SAME
// verdict brain-audit computes (design D1) — it MUST resolve the same
// tier-scoped diff budget and size:exception policy, never its own default.
import { resolveTier, tierParams } from './vcs/governance-tiers.mjs';
import { isAfterBaseline } from './lib/audit-helpers.mjs';
import { selectIssueLinkBody, parsePrNumber } from './lib/audit-helpers.mjs';
import { readRecordObservations } from './memory/lib/store.mjs';
import { makeGit } from './governance/postmerge/resolution.mjs';
import { gitOrThrow } from './governance/postmerge/git-seam.mjs';
import { memoryPresence } from './governance/checks/memory-presence.mjs';
import { CLOSING_RE, CHAIN_RE } from './governance/checks/issue-ref-patterns.mjs';
import { resolveApprovedLabel } from './governance/approved-label.mjs';
import {
  emptyRows, foldMerge, finalizeRows, PER_PERIOD_GATES, detectionJobNames,
} from './lib/metrics-aggregate.mjs';
import { leadTimeDays, selectApprovalEvent } from './lib/lead-time.mjs';
import { decideMemoryGateOverride, toActorList } from './governance/memory-gate-override.mjs';
import { computeMemoryCoverage } from './lib/memory-coverage.mjs';

// ── Argument parsing (Phase 4.1) ─────────────────────────────────────────────

/**
 * Parse CLI arguments. Positional `<git-range>` (design D7 — mirrors
 * `brain:audit`'s own positional arg, never a `--range=` flag), `--json`,
 * `--period=month|week`.
 *
 * @param {string[]} argv  `process.argv.slice(2)`.
 * @returns {{ range: string|undefined, json: boolean, period: 'month'|'week' }}
 */
export function parseArgs(argv) {
  let range;
  let json = false;
  let period = 'month';
  for (const arg of argv) {
    if (arg === '--json') { json = true; continue; }
    if (arg.startsWith('--period=')) { period = arg.slice('--period='.length); continue; }
    if (arg.startsWith('--')) {
      throw new Error(`brain-metrics: unrecognized flag "${arg}"`);
    }
    if (range !== undefined) {
      throw new Error(`brain-metrics: unexpected extra argument "${arg}" (only one <git-range> is accepted)`);
    }
    range = arg;
  }
  if (period !== 'month' && period !== 'week') {
    throw new Error(`brain-metrics: --period must be "month" or "week" (got "${period}")`);
  }
  return { range, json, period };
}

/** `--help` usage text (issue #324 C3 review finding). */
export const HELP_TEXT = `Usage: brain:metrics [<git-range>] [--json] [--period=month|week]

Read-only governance-effectiveness reporting verb, re-derived from brain's
own merged git history (issue #324, M9). Introduces zero new governance
gates, invariants, or CI-blocking behavior.

Arguments:
  <git-range>          Optional positional git range (e.g. "HEAD~30..HEAD",
                        "origin/main..HEAD"). Defaults to "origin/main..HEAD"
                        (falls back to "HEAD" when origin/main is absent).

Options:
  --json                Emit a flat JSON array (one object per period
                        bucket) instead of a markdown table.
  --period=month|week   Bucket period. Defaults to "month".
  --help                Show this help text and exit 0.
`;

/** Default range resolution — audit parity (origin/main..HEAD, else HEAD). */
function resolveDefaultRange(cwd) {
  try {
    execSync('git rev-parse origin/main', { encoding: 'utf8', cwd, stdio: 'pipe' });
    return 'origin/main..HEAD';
  } catch {
    return 'HEAD';
  }
}

/** Load brain.config.json; returns {} on any error (never throws). */
function loadConfig(cwd) {
  try {
    return JSON.parse(readFileSync(join(cwd, 'brain.config.json'), 'utf8'));
  } catch {
    return {};
  }
}

/**
 * Extract the issue number a merge references (shared CLOSING_RE/CHAIN_RE
 * vocabulary, issue-ref-patterns.mjs) — the issue whose `status:approved`
 * label-add timestamp anchors lead time (design D4). Distinct from the PR
 * number `fetchPrMeta` resolves — `subjectRef` when parsed from the subject,
 * or `prNum` when resolved via the commit-sha fallback (issue #1086, D4).
 *
 * @param {string} body
 * @returns {number|null}
 */
export function extractIssueNumber(body) {
  if (typeof body !== 'string') return null;
  const closing = CLOSING_RE.exec(body);
  if (closing) return Number(closing[2]);
  const chain = CHAIN_RE.exec(body);
  if (chain) return Number(chain[1]);
  return null;
}

/**
 * Map a `prStatusRollup()` entry's raw `conclusion` to a DETECTION_JOBS
 * pass/fail signal. `null` (job absent from the rollup, or a non-terminal
 * conclusion like `neutral`/`cancelled`/in-progress) is NEVER coerced into
 * pass or fail — it is silently uncounted by `foldMerge` (D2-style honesty
 * for a non-blocking signal: current CI state, not a historical verdict, D6).
 *
 * `conclusion` is normalized to lowercase before comparison — GitHub's real
 * GraphQL/REST rollup returns uppercase enum values (`SUCCESS`, `FAILURE`),
 * not the lowercase `success`/`failure` this originally compared against.
 * Mirrors `review/evaluators/tranche.mjs`'s `isGateGreen()` normalization
 * (the established pattern for provider `conclusion` values in this codebase).
 *
 * GitLab fallback (issue #324 C2 review finding): `gitlab.mjs#prStatusRollup`
 * ALWAYS normalizes `conclusion: null` by contract (vcs-contract.md —
 * GitLab's commit-status model has no separate "conclusion" field distinct
 * from its terminal `status`). Reading `conclusion` alone made every GitLab
 * repo silently report 0/0 for all three detection jobs, forever. When
 * `conclusion` is `null`, this falls back to `status`, mapping GitLab's own
 * terminal vocabulary — `success` → pass, `failed` → fail (NOTE: GitLab uses
 * `failed`, not GitHub's `failure`) — anything else (`pending`, `running`,
 * `canceled`, `skipped`, `created`, `manual`, ...) stays uncounted `null`,
 * same fail-closed honesty as the `conclusion` path. A genuinely terminal-
 * but-neither GitHub `conclusion` (e.g. `NEUTRAL`) is NOT `null`, so it never
 * reaches this fallback and correctly stays `null` too.
 *
 * @param {Array<{name: string|null, status: string|null, conclusion: string|null}>|null} rollup
 * @param {string} jobName
 * @returns {'pass'|'fail'|null}
 */
export function detectionConclusion(rollup, jobName) {
  if (!Array.isArray(rollup)) return null;
  const entry = rollup.find((c) => c.name === jobName);
  if (!entry) return null;
  const conclusion = (entry.conclusion ?? '').toLowerCase();
  if (conclusion === 'success') return 'pass';
  if (conclusion === 'failure') return 'fail';
  if (entry.conclusion == null) {
    const status = (entry.status ?? '').toLowerCase();
    if (status === 'success') return 'pass';
    if (status === 'failed') return 'fail';
  }
  return null;
}

// ── Renderers (Phase 4.2/4.3) ────────────────────────────────────────────────

function fmtPct(n) {
  return `${n}%`;
}

function fmtLeadTime(days) {
  return days === null || days === undefined ? 'N/A' : `${days.toFixed(1)}d`;
}

function fmtGate(cell) {
  return `${cell.raw}/${cell.enforced}`;
}

/**
 * Render the markdown report: one row per period bucket, an "Exception usage
 * by author" breakdown (spec's Bypass usage requirement — `size:exception`
 * broken down by author and period; `unknown` when the label-adding actor
 * cannot be resolved), plus the two repo-level lines (memory-gate at HEAD,
 * memory-records coverage) — both deliberately OUTSIDE the per-period table
 * (design D3 / Phase 5).
 *
 * @param {{ rows: object[], memGate: {pass: boolean}, memCoverage: object, range: string, period: string }} opts
 * @returns {string}
 */
export function renderMarkdown({
  rows, memGate, memCoverage, range, period,
}) {
  const lines = [];
  lines.push(`# brain:metrics — ${range} (${period}ly)`, '');

  if (rows.length === 0) {
    lines.push('No data for this period.');
  } else {
    // Detection column names come from the ROWS themselves (issue #358 Q5
    // Phase 5 review finding 2) — `foldMerge` already built each row's
    // `detection` map keyed by the tier-scoped `detectionJobNames(tier)` list
    // (`runMetrics` resolves it once from THIS repo's own declared tier), so
    // reading it back here is a single source of truth: it can never drift
    // from the stale, tier-blind DETECTION_JOB_NAMES literal.
    const detectionJobs = Object.keys(rows[0].detection);
    const header = [
      'Period', 'Changes Merged', 'Median Lead Time',
      'diff-size (raw/enf)', 'issue-link (raw/enf)', 'decision-gate (raw/enf)',
      'size:exception', 'skip:memory-gate (raw/honored)',
      ...detectionJobs,
      'Uncomputable',
    ];
    lines.push(`| ${header.join(' | ')} |`);
    lines.push(`| ${header.map(() => '---').join(' | ')} |`);
    for (const row of rows) {
      const cells = [
        row.period,
        String(row.changesMerged),
        fmtLeadTime(row.medianLeadTimeDays),
        ...PER_PERIOD_GATES.map((g) => fmtGate(row.gates[g])),
        String(row.bypass.sizeException),
        `${row.bypass.skipMemoryGate}/${row.bypass.skipMemoryGateHonored ?? 0}`,
        ...detectionJobs.map((j) => `${row.detection[j].pass}/${row.detection[j].fail}`),
        String(row.uncomputable),
      ];
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }

  lines.push('');
  lines.push('## Exception usage by author');
  lines.push('');
  if (rows.length === 0) {
    lines.push('No `size:exception` usage recorded in this window.');
  } else {
    const authorRows = [];
    for (const row of rows) {
      for (const [author, count] of Object.entries(row.bypassByAuthor ?? {})) {
        authorRows.push({ period: row.period, author, count });
      }
    }
    if (authorRows.length === 0) {
      lines.push('No `size:exception` usage recorded in this window.');
    } else {
      authorRows.sort((a, b) => {
        if (a.period !== b.period) return a.period < b.period ? -1 : 1;
        return a.author.localeCompare(b.author);
      });
      lines.push('| Period | Author | size:exception |');
      lines.push('| --- | --- | --- |');
      for (const { period: p, author, count } of authorRows) {
        lines.push(`| ${p} | ${author} | ${count} |`);
      }
    }
  }

  // #1024 (design item 7): skip:memory-gate's HONORED usage by author — the
  // by-author table gains this label, mirroring size:exception's own
  // breakdown above (never the RAW count, which is already the table's
  // "skip:memory-gate (raw/honored)" column).
  lines.push('');
  lines.push('## skip:memory-gate usage by author (honored only)');
  lines.push('');
  if (rows.length === 0) {
    lines.push('No `skip:memory-gate` usage honored in this window.');
  } else {
    const skipAuthorRows = [];
    for (const row of rows) {
      for (const [author, count] of Object.entries(row.skipMemoryGateByAuthor ?? {})) {
        skipAuthorRows.push({ period: row.period, author, count });
      }
    }
    if (skipAuthorRows.length === 0) {
      lines.push('No `skip:memory-gate` usage honored in this window.');
    } else {
      skipAuthorRows.sort((a, b) => {
        if (a.period !== b.period) return a.period < b.period ? -1 : 1;
        return a.author.localeCompare(b.author);
      });
      lines.push('| Period | Author | skip:memory-gate (honored) |');
      lines.push('| --- | --- | --- |');
      for (const { period: p, author, count } of skipAuthorRows) {
        lines.push(`| ${p} | ${author} | ${count} |`);
      }
    }
  }

  lines.push('');
  lines.push('## Repo-level signals (not a per-period series — design D3)');
  lines.push('');
  lines.push(`- memory-gate (memoryPresence) at HEAD: ${memGate.pass ? 'PASS' : 'FAIL'}`);
  if (!memCoverage.available) {
    lines.push('- memory records coverage: Unavailable (.memory/records/ missing or unreadable) — adoption pending');
  } else {
    lines.push(
      `- memory records coverage: ${memCoverage.tagged}/${memCoverage.total} tagged with \`issue\` `
      + `(${fmtPct(memCoverage.coveragePct)}) — adoption pending`,
    );
    // #634 — the denominator above is the DEDUPED record count, and it dropped
    // by 139 on this repo's corpus when #598 changed the reader from one-per-
    // line to one-per-`id`. The new number is the right one; what was missing
    // was any way for an operator watching this figure to find out why it moved.
    // One line, and only when there is something to say — the same discipline
    // memory/cli.mjs applies, not a warning banner.
    const dup = memCoverage.duplicates;
    if (dup?.lines > 0) {
      // Phrased as an ACCOUNTING of the lines the reader resolved, never as a
      // claim about the file. `readRecords` silently skips unparseable lines, so
      // "the store holds N physical line(s)" — the first wording here — asserts
      // a number it never measured: with one corrupt line it reports 2 where
      // `wc -l` says 3. Measured, and corrected. Stating the sum keeps the
      // reconciliation the reader wants without inventing a total.
      lines.push(
        `  - ${memCoverage.total} indexed + ${dup.lines} repeated = ${memCoverage.total + dup.lines} `
        + `record line(s) read; the ${dup.lines} repeats cover ${dup.ids} id(s) and are collapsed into `
        + 'the count above. Normal for `merge=union` (ADR-0017, REQ-MF-3) — run '
        + '`npm run brain:memory:reindex` for the per-id locations.',
      );
    }
  }
  lines.push('');
  lines.push('Caveats: lead time is an ISSUE-APPROVAL proxy (last `status:approved` label-add '
    + 'before merge), not PR-review-approval time. `skip:memory-gate` is honored at the '
    + '"standard" tier only (refused at "regulated", not consulted at "lite" — #1024, '
    + 'TIER_PARAMS.honorSkipMemoryGate) — the "raw/honored" column and the by-author table '
    + 'above report `decideMemoryGateOverride`\'s resolved verdict at merge time, not a raw '
    + 'label count subtracted from an enforced-failure total (`memory-gate` is not in '
    + 'PER_PERIOD_GATES, design D3 — there is no enforced count to subtract from).');

  return lines.join('\n');
}

/**
 * Render the JSON report: a FLAT array, one object per period bucket (spec
 * H2 — "a flat array of period-metric objects consumable... without
 * additional parsing"). The two repo-level signals are denormalized onto
 * EVERY row (they are true constants for the whole run) rather than breaking
 * the flat-array contract with a wrapping object.
 */
export function renderJson({ rows, memGate, memCoverage }) {
  // #634 — the duplicate accounting travels into JSON as COUNTS ONLY. The
  // `groups` array carries every repeated id with its file:line occurrences,
  // and `memoryRecordsCoverage` is denormalized onto every row, so passing it
  // through whole was measured at 6871 bytes per row against 111 without — 62×,
  // and ~79 KiB of byte-identical repetition on a 12-period run. The locations
  // have a home already: `npm run brain:memory:reindex` prints them once.
  //
  // Projected explicitly rather than by deleting a key, so a field added to
  // `duplicates` later cannot silently start bloating this output again.
  const { duplicates } = memCoverage;
  const coverage = {
    ...memCoverage,
    duplicates: {
      ids: duplicates?.ids ?? 0,
      lines: duplicates?.lines ?? 0,
      divergent: duplicates?.divergent ?? 0,
    },
  };
  return JSON.stringify(
    rows.map((row) => ({
      period: row.period,
      changesMerged: row.changesMerged,
      medianLeadTimeDays: row.medianLeadTimeDays,
      gates: row.gates,
      bypass: row.bypass,
      bypassByAuthor: row.bypassByAuthor ?? {},
      // #1024 (design item 7): skip:memory-gate's HONORED usage by author.
      skipMemoryGateByAuthor: row.skipMemoryGateByAuthor ?? {},
      detection: row.detection,
      uncomputable: row.uncomputable,
      memoryGatePassAtHead: memGate.pass,
      memoryRecordsCoverage: coverage,
    })),
    null,
    2,
  );
}

// ── Main orchestration ───────────────────────────────────────────────────────

/**
 * Evaluate one merge's full metrics descriptor (evidence + verdict + lead
 * time + detection-job current-state). Mirrors brain-audit.mjs's per-merge
 * loop body, but NEVER emits and NEVER exits — a per-merge git-plumbing
 * failure (parent resolution, diff read, reverter-exemption predicates) is
 * caught HERE and folded into the `uncomputable` column (design D2: metrics'
 * failure policy over the shared fail-closed core is "count visibly", never
 * "die on one bad merge" and never "silently hide it").
 *
 * @returns {Promise<object>} a foldMerge()-shaped merge descriptor.
 */
async function evaluateOneMerge(sha, subject, ctx) {
  const {
    cwd, resolutionGit, windowFrom, windowTo, allObservations, ignoreList, vcs, config, approvedLabel, period,
    leadTimeCache, bypassAuthorCache, baseline, gitIsAncestor, detectionJobs,
  } = ctx;

  // Same net-parity resolved-skip brain-audit applies — a merge brain-audit
  // itself never evaluates has no verdict for metrics to re-derive either
  // (Phase 7.4: never diverge from brain-audit's own resolution).
  let mergedAt;
  try {
    mergedAt = readMergedAt(sha, cwd);
  } catch {
    // Cannot even date the merge — nothing sensible to bucket. Propagates to
    // the CLI's own fail-closed handling (an infra-level failure, not a
    // per-merge governance signal).
    throw new Error(`brain-metrics: could not read merge date for ${sha.slice(0, 7)} ${subject}`);
  }

  // ── Baseline gate (issue #324 B2 fix round) ──────────────────────────────
  // Mirrors brain-audit.mjs's own baseline gate EXACTLY (same order: baseline
  // check first, before the resolved-skip check, before any of the 4 checks
  // run) — brain-audit.mjs's `resolveBaseline`/`isAfterBaseline` via the
  // SHARED lib/merge-walk.mjs (design D1). A pre-baseline merge is something
  // brain-audit itself never evaluated: reporting a raw/enforced gate failure
  // for it here would be a measurement that brain-audit's own verdict never
  // produced — the exact divergence the shared-lib extraction exists to
  // prevent (spec's Historical re-execution requirement, REQ-7).
  if (baseline && !isAfterBaseline(baseline, sha, gitIsAncestor)) {
    return {
      sha, mergedAt, prLabels: null, leadTimeDays: null, kind: 'baseline-skip', evalRec: null, detection: null, period,
    };
  }

  let resolvedLine;
  try {
    resolvedLine = resolvedSkipLine(sha, subject, { git: resolutionGit, tip: windowTo });
  } catch {
    return {
      sha, mergedAt, prLabels: null, leadTimeDays: null, kind: 'uncomputable', evalRec: null, detection: null, period,
    };
  }
  if (resolvedLine) {
    return {
      sha, mergedAt, prLabels: null, leadTimeDays: null, kind: 'resolved-skip', evalRec: null, detection: null, period,
    };
  }

  try {
    const parent1 = readMergeParent(sha, subject, cwd);
    const { numstat, changedFiles, addedFiles, body } = readMergeDiff(parent1, sha, cwd);
    const { prLabels, prBody, prAuthor, prMetaError } = await fetchPrMeta(subject, vcs, config, sha);

    // REQ-TS-1 (#474) — the PR fetch was attempted and FAILED. brain-audit
    // refuses to render a verdict for this merge and fails the window closed;
    // metrics must not re-derive one either, or it would REPORT a governance
    // verdict for a merge enforcement never evaluated — precisely the
    // measurement/enforcement divergence the shared-lib extraction exists to
    // prevent (design D1). Metrics' own failure policy applies over that shared
    // fail-closed core (design D2): count it visibly in the EXISTING
    // `uncomputable` column and keep exiting 0 — never die on one bad merge,
    // never silently hide it.
    if (prMetaError !== null) {
      return {
        sha, mergedAt, prLabels: null, leadTimeDays: null, kind: 'uncomputable', evalRec: null, detection: null, period,
      };
    }

    const issueLinkBody = selectIssueLinkBody(prBody, body);

    const tier = resolveTier(config);
    const { diffBudget, honorSizeException } = tierParams(tier);
    const evalRec = evaluateMerge(sha, {
      numstat, changedFiles, addedFiles, issueLinkBody, prLabels, ignoreList, allObservations,
      resolutionGit, windowFrom, windowTo,
      diffBudget, honorSizeException, tier, memoryHistory: readMemoryHistory(cwd),
    });

    // Lead time: the ISSUE this merge references (not the PR) — best-effort,
    // never throws (labelEvents() returns null on an uncomputable fetch,
    // mirroring the CONTRACT verb's own convention; leadTimeDays handles null).
    // `leadTimeCache` (design Data Flow: "1 call/issue") de-duplicates the
    // labelEvents() fetch across every merge that references the SAME issue
    // (e.g. a chained-PR flow's "Part of #N" slices) — many merges, one API call.
    let leadTime = null;
    const issueNum = extractIssueNumber(issueLinkBody);
    if (issueNum !== null && vcs) {
      if (!leadTimeCache.has(issueNum)) {
        leadTimeCache.set(issueNum, vcs.labelEvents({ project: config?.project?.slug, number: issueNum }).catch(() => null));
      }
      const events = await leadTimeCache.get(issueNum);
      leadTime = leadTimeDays(events, approvedLabel, mergedAt);
    }

    // Tier-scoped detection-job current-state (D6 — never historical; issue
    // #358 Q5 Phase 5 review finding 2): `detectionJobs` is `ctx.detectionJobs`,
    // resolved ONCE at the top of `runMetrics` from THIS repo's own declared
    // tier (`detectionJobNames(tier)`) — never the stale, tier-blind
    // DETECTION_JOB_NAMES literal. Best-effort.
    let detection = null;
    const prNumForRollup = parsePrNumber(subject);
    if (prNumForRollup !== null && vcs && typeof vcs.prStatusRollup === 'function') {
      try {
        const rollup = await vcs.prStatusRollup({ project: config?.project?.slug, number: prNumForRollup });
        detection = Object.fromEntries(detectionJobs.map((j) => [j, detectionConclusion(rollup, j)]));
      } catch {
        detection = null;
      }
    }

    // size:exception label-adding actor (spec's Bypass usage requirement —
    // "broken down by gate, by author, and by period"). The label lives on
    // the PR (prView, via fetchPrMeta above), not the linked issue, so this
    // reads labelEvents for the PR/MR NUMBER (GitHub PRs are issues under the
    // hood — same events endpoint; GitLab needs `kind: 'mr'`, #1024 —
    // `prNumForRollup` is always the PR/MR's own number, never an issue's,
    // so this call is unconditionally `kind: 'mr'`, unlike leadTimeCache's
    // issue-number fetch below which stays the 'issue' default), never the
    // issue number leadTimeCache keys on. `bypassAuthorCache` (keyed by PR
    // number) mirrors leadTimeCache's "1 fetch per entity" de-dup discipline
    // — and is now ALSO the source for skip:memory-gate's honored-applier
    // read (#1024, design item 7), one fetch serving both labels. Best-
    // effort: an unresolvable actor is `null` here and folds into the
    // "unknown" by-author bucket in lib/metrics-aggregate.mjs — never dropped.
    let exceptionAuthor = null;
    let skipMemoryGateHonoredAuthor = null;
    const prLabelsArr = Array.isArray(prLabels) ? prLabels : [];
    if (
      (prLabelsArr.includes('size:exception') || prLabelsArr.includes('skip:memory-gate'))
      && prNumForRollup !== null && vcs && typeof vcs.labelEvents === 'function'
    ) {
      if (!bypassAuthorCache.has(prNumForRollup)) {
        bypassAuthorCache.set(
          prNumForRollup,
          vcs.labelEvents({ project: config?.project?.slug, number: prNumForRollup, kind: 'mr' }).catch(() => null),
        );
      }
      const events = await bypassAuthorCache.get(prNumForRollup);
      if (prLabelsArr.includes('size:exception')) {
        const exceptionEvent = selectApprovalEvent(events, 'size:exception', mergedAt);
        exceptionAuthor = exceptionEvent?.actor?.login ?? null;
      }
      if (prLabelsArr.includes('skip:memory-gate')) {
        const decision = decideMemoryGateOverride({
          labels: prLabelsArr,
          labelEvents: events,
          prAuthor,
          tier,
          reviewActors: toActorList(config?.governance?.reviewActors),
          agentActors: toActorList(config?.governance?.agentActors),
        });
        skipMemoryGateHonoredAuthor = decision.honored ? decision.applier ?? null : null;
      }
    }

    return {
      sha, mergedAt, prLabels, leadTimeDays: leadTime, kind: 'evaluated', evalRec, detection,
      exceptionAuthor, skipMemoryGateHonoredAuthor, period,
    };
  } catch {
    // Any git-plumbing throw (missing parent, diff read failure, reverter-
    // exemption predicate failure) — never propagates. Counted, not hidden.
    return {
      sha, mergedAt, prLabels: null, leadTimeDays: null, kind: 'uncomputable', evalRec: null, detection: null, period,
    };
  }
}

/** Committer date, strict ISO 8601 — the merge date `bucketOf`/lead-time anchor on. */
function readMergedAt(sha, cwd) {
  return gitOrThrow(['log', '-1', '--format=%cI', sha], { cwd }).trim();
}

/**
 * Run the full report and return its rendered string plus exit code — kept
 * separate from `process.exit()` so it stays testable (mirrors
 * brain-governance-status.mjs's injectable-orchestration convention).
 *
 * `vcs` is an optional injection seam (issue #324 C1 review finding): when
 * provided (tests), it is used AS-IS instead of resolving a real adapter via
 * `resolveVcs()`/`getVcs()`. Production (CLI entrypoint below) never passes
 * it, so `resolveVcs(config)` still runs exactly as before. Before this seam,
 * `resolveVcs()` always called `getVcs()` directly with no way to substitute
 * a fake — the lead-time, detection-rollup, and by-author code paths (all of
 * which call `vcs.prView`/`vcs.prStatusRollup`/`vcs.labelEvents`) had ZERO
 * test coverage, which is how the uppercase-conclusion bug (fix round,
 * commit b9cc412) shipped undetected.
 *
 * @param {{ argv: string[], cwd?: string, vcs?: object|null }} opts
 * @returns {Promise<{ output: string, exitCode: number }>}
 */
export async function runMetrics({ argv, cwd = process.cwd(), vcs: injectedVcs }) {
  // `--help` is handled BEFORE parseArgs (issue #324 C3 review finding) —
  // parseArgs has no concept of it and would otherwise reject it as an
  // "unrecognized flag", exiting 1 instead of printing usage and exiting 0.
  if (argv.includes('--help')) {
    return { output: HELP_TEXT, exitCode: 0 };
  }

  let range;
  let json;
  let period;
  try {
    ({ range, json, period } = parseArgs(argv));
  } catch (err) {
    // `parseArgs` already prefixes its thrown message with "brain-metrics: "
    // — re-prefixing here doubled it (issue #324 C3 review finding). Return
    // the message AS-IS.
    return { output: err.message, exitCode: 1 };
  }
  if (!range) range = resolveDefaultRange(cwd);

  const config = loadConfig(cwd);
  const ignoreList = Array.isArray(config?.governance?.ignoreList) ? config.governance.ignoreList : [];
  const approvedLabel = resolveApprovedLabel(config, config?.vcs?.provider);
  // Tier-scoped detection-job names (issue #358 Q5 Phase 5 review finding 2):
  // resolved ONCE from THIS repo's own declared `governance.tier` — never the
  // stale, tier-blind DETECTION_JOB_NAMES literal (metrics-aggregate.mjs). At
  // brain's own declared "lite" tier this correctly excludes actor-check/
  // brain-writes-reviewed (required at every tier, REQ-TIER-2's never-tiered
  // core) from the "current-state, never blocking" detection column.
  const detectionJobs = detectionJobNames(resolveTier(config));
  const resolutionGit = makeGit(cwd);
  const vcs = injectedVcs !== undefined ? injectedVcs : await resolveVcs(config);
  const allObservations = readRecordObservations({ recordsDir: join(cwd, '.memory', 'records') });
  const memGate = memoryPresence(allObservations);
  const memCoverage = computeMemoryCoverage(cwd);

  // ── Audit baseline (optional, issue #324 B2 fix round) ───────────────────
  // SHARED with brain-audit.mjs via lib/merge-walk.mjs (design D1): metrics
  // must skip the same pre-baseline merges brain-audit skips, or it reports
  // gate failures on merges brain-audit itself never evaluated.
  const rawBaseline = config?.governance?.auditBaseline ?? null;
  const { ref: baseline, warning: baselineWarning } = resolveBaseline(rawBaseline, cwd);
  if (baselineWarning) process.stderr.write(`${baselineWarning}\n`);
  const gitIsAncestor = baseline ? makeGitIsAncestor(cwd) : null;

  let walk;
  try {
    walk = listAuditedCommits(range, cwd);
  } catch (err) {
    return {
      output: `brain-metrics: invalid git range "${range}" — ${err.message}\n`
        + 'Try a valid range such as "origin/main..HEAD" or "HEAD~10..HEAD" (see: npm run brain:audit).',
      exitCode: 1,
    };
  }

  if (walk.commits.length === 0) {
    if (json) return { output: '[]', exitCode: 0 };
    return {
      output: renderMarkdown({
        rows: [], memGate, memCoverage, range, period,
      }),
      exitCode: 0,
    };
  }

  const { commits: merges, windowFrom, windowTo } = walk;
  let rows = emptyRows();
  const leadTimeCache = new Map(); // issue number -> Promise<labelEvents() result> (design Data Flow: 1 call/issue)
  const bypassAuthorCache = new Map(); // PR number -> Promise<labelEvents() result> (size:exception by-author breakdown)
  for (const { sha, subject } of merges) {
    let m;
    try {
      m = await evaluateOneMerge(sha, subject, {
        cwd, resolutionGit, windowFrom, windowTo, allObservations, ignoreList, vcs, config, approvedLabel, period,
        leadTimeCache, bypassAuthorCache, baseline, gitIsAncestor, detectionJobs,
      });
    } catch (err) {
      // Could not even date the merge (a `git log -1 --format=%cI` failure on
      // an already-enumerated sha) — real repo corruption, not a normal
      // per-merge check failure. Fail closed at the CLI level rather than
      // silently dropping the merge from every bucket.
      return { output: `brain-metrics: ${err.message}`, exitCode: 1 };
    }
    rows = foldMerge(rows, m, detectionJobs);
  }
  const finalRows = finalizeRows(rows);

  const output = json
    ? renderJson({ rows: finalRows, memGate, memCoverage })
    : renderMarkdown({
      rows: finalRows, memGate, memCoverage, range, period,
    });
  return { output, exitCode: 0 };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { output, exitCode } = await runMetrics({ argv: process.argv.slice(2) });
  console.log(output);
  process.exit(exitCode);
}
