#!/usr/bin/env node
// brain-audit.mjs — audit merged commits for governance invariants (REQ-S4-5, REQ-S4-6).
//
// Usage: node brain/scripts/brain-audit.mjs [<git-range>]
// Default range: origin/main..HEAD (falls back to HEAD if origin/main is absent).
//
// For each first-parent merge in the range, runs all 4 generic checks:
//   diffSize · issueLink · adrPresence · memoryPresence
//
// Two net-parity skips (design §15, anchored to the NET tree state at HEAD):
//   • resolved-skip  — a merge whose own first-parent contribution is NET-ABSENT
//     at HEAD (`isResolvedAt`, directional net-parity) is skipped BEFORE the four
//     checks run: `[SKIP] … resolved by revert`.
//   • reverter-skip  — a FAILING merge is exempt from its TREE-KEYED failures
//     only (adrPresence/diffSize; issueLink/memoryPresence always survive) iff
//     every path it ADDS OR MODIFIES is absent from the tree at the audited tip
//     (`addedPathsAbsentAt`, the liveness guard) AND its own contribution is
//     net-absent across the full window (`netAddFull ≤ 0`). A tip-most cleanup
//     revert that only DELETES touches no surviving path, so it settles without
//     itself being flagged; a merge
//     that puts a payload back on the tree — a revert-of-a-revert, or a re-add
//     of a payload first introduced BEHIND the window base — stays flagged.
//
// Output (one line per merge):
//   [PASS] <sha7> <subject>
//   [FAIL] <sha7> <subject> — <check>: <reason>; ...
//   [FAIL-SHA] <full-sha>            (auto-revert signal — tree-keyed classes ONLY)
//   [SKIP] <sha7> <subject> — resolved by revert | reverts offender (net-absent)
//   [UNCOMPUTABLE] <sha7> <subject> — PR metadata unreachable (REQ-TS-1, #474)
//
// Exit (fail-closed, REQ-D2-6): 0 all pass/legitimately skipped · 1 ≥1 [FAIL]
// (any class) · 2 uncomputable-infra (never a silent PASS).
//
// UNCOMPUTABLE DOMINATES (REQ-TS-2, issue #474). A merge whose PR-metadata
// fetch FAILED is not evaluated at all — evaluating it is what manufactures a
// false verdict — and ≥1 such merge drives the whole window to exit 2,
// regardless of the other merges' verdicts. This is exit-codes.mjs's own rule
// ("an uncomputable check must never read as clean or as a mere violation")
// applied at window scope: advancing the cursor past a merge that was never
// evaluated would make it permanently un-re-auditable (ADR-0015 rung 3). The
// halt self-heals — the postmerge workflow retries on every push and daily.
//
// NOT uncomputable, deliberately: a subject with no PR reference (nothing to
// fetch; the commit body IS the evidence) and an unconfigured VCS adapter (a
// configuration, uniform and therefore visible — surfaced as one [WARN]).

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

import { isAfterBaseline, selectIssueLinkBody, auditedBase, auditedTip } from './lib/audit-helpers.mjs';
import { loadBrainConfigOrThrow } from './lib/brain-config.mjs';
import { readRecordObservations } from './memory/lib/store.mjs';
import { makeGit } from './governance/postmerge/resolution.mjs';
// B1 (#889, design A8) — the lane predicate (A1) reused post-merge. brain-audit
// has no head branch at this point (fetchPrMeta exposes none), so it classifies
// on `lanePaths` alone plus the `/^Memory lane: /m` body marker — never on
// `sourceBranch`, which is always null here.
import { classifyLane } from './governance/checks/lane.mjs';
// The first-parent merge walk (EVIDENCE + VERDICT layers) is SHARED with
// brain-metrics — see lib/merge-walk.mjs's module header (design D1, issue
// #324). Emission ([PASS]/[FAIL]/[SKIP], [FAIL-SHA] dedup, crossCheckExit)
// stays local: it is a judgment about how to REPORT a verdict, not the
// verdict itself.
//
// NOTE (MINOR 2, external ruling rev 3 on #297): there is deliberately NO
// error-swallowing `git()` helper anywhere in the walk. The per-merge reads
// (numstat, changed files, commit body, parents) go through `gitOrThrow`
// (lib/merge-walk.mjs), so a transient git failure becomes exit 2 at the
// top-level catch below instead of an EMPTY diff that makes diffSize and
// adrPresence PASS. A source-scan test in brain-audit.test.mjs keeps the
// helper from returning (re-pointed at lib/merge-walk.mjs, issue #324 Phase 2).
import {
  resolvedSkipLine, listAuditedCommits, readMergeParent, readMergeDiff, fetchPrMeta, resolveVcs, evaluateMerge,
  resolveBaseline, makeGitIsAncestor, readMemoryHistory,
} from './lib/merge-walk.mjs';
// Tier resolution (issue #358 Q5, REQ-TIER-9): the audit path is the rung-2/
// rung-3 enforcement surface (release.yml's pre-tag gate, governance-postmerge.yml's
// auto-revert) — it MUST resolve the SAME tier-scoped diff budget and
// size:exception policy as the CI/hook path (run-check.mjs), never its own
// silent 400-line default.
import { resolveTier, tierParams } from './vcs/governance-tiers.mjs';

/**
 * REQ-D2-6(b) / design §15.5 — the fail-closed exit contract, with `failCount`
 * (human-readable `[FAIL]` lines of ANY class) DECOUPLED from the `[FAIL-SHA]`
 * (auto-revert) count now that emission is class-filtered:
 *
 *   • exit 1 ⟺ failCount ≥ 1 (any class). A `[FAIL-SHA]` count of 0 on exit 1 is
 *     LEGITIMATE (all violations are issueLink/memoryPresence — non-auto-revertible).
 *   • The old "any violation ⟹ ≥1 [FAIL-SHA]" coherence guard is REPLACED (not
 *     dropped) by the BIDIRECTIONAL NOMINABLE⟺[FAIL-SHA] invariant: ≥1 NOMINABLE
 *     tree-keyed failure ⟺ ≥1 [FAIL-SHA] line. A violation of EITHER direction is
 *     uncomputable → exit 2: (i) a nominable failure recorded but zero [FAIL-SHA]
 *     emitted (a crash mid-emission); (ii) a [FAIL-SHA] with no backing nominable
 *     failure. (A guard relaxed without a replacement is a guard deleted.)
 *
 *   • WHY "NOMINABLE", NOT "tree-keyed" (PR4 precondition, #302). Not every
 *     un-exempted tree-keyed failure is auto-revert-nominable: a removal-shaped
 *     cleanup (A11) or a replace-shaped cleanup (A12) fails a tree-keyed check,
 *     is (correctly) denied the exemption, yet is SUPPRESSED from [FAIL-SHA]
 *     because reverting it would RESURRECT a payload (§15.5). Those survivors
 *     legitimately emit `[FAIL]` (counted in failCount) with zero `[FAIL-SHA]`.
 *     So the coherence invariant re-anchors from "tree-keyed" to "nominable"
 *     (tree-keyed survivors whose revert does NOT resurrect); the old form would
 *     fire a spurious exit 2 the moment a cleanup is suppressed. `failCount`
 *     still governs exit 1 — a suppressed cleanup is a real [FAIL].
 *
 * @param {number} failCount               merges reported as [FAIL] (any class).
 * @param {number} nominableTreeKeyedCount tree-keyed survivors whose revert does NOT
 *                                         resurrect a payload (auto-revert-nominable).
 * @param {number} failShaCount            [FAIL-SHA] lines emitted (deduped carriers).
 * @returns {0|1|2}
 */
/**
 * Formats the `[UNCOMPUTABLE]` line (issue #1086, D6). Pure — no I/O, no git,
 * takes exactly what `fetchPrMeta` returned.
 *
 * Two shapes, both byte-identical to their pre-#1086 wording where they
 * already existed: the LEGACY case (`prNum !== null` — the subject's own
 * `prView` read could not be completed, unchanged from today) keeps the
 * `— PR #N metadata unreachable: …` suffix exactly. Every dispatch-table
 * ambiguous/unresolvable outcome (`prNum === null`) prints `prMetaError`
 * directly — that message already names the subject's number and the cause
 * (`resolveByCommitSha`'s `uncomputable()` helper), so each cause stays
 * distinguishable from the others and from the legacy line.
 *
 * @param {string} sha
 * @param {string} subject
 * @param {{ prNum: number|null, prMetaError: string }} ctx
 * @returns {string}
 */
export function formatUncomputableLine(sha, subject, { prNum, prMetaError }) {
  const head = `[UNCOMPUTABLE] ${sha.slice(0, 7)} ${subject}`;
  return prNum !== null
    ? `${head} — PR #${prNum} metadata unreachable: ${prMetaError}`
    : `${head} — ${prMetaError}`;
}

/**
 * Formats the `[PASS]`/`[FAIL]` bracketed pull-request-resolution suffix
 * (issue #1086, D6) — in the style of the existing ` [size:exception]` note,
 * never a new line tag. Pure — no I/O, no git.
 *
 * Two cases render a suffix, everything else renders '':
 *   - `prSource === 'commit-sha'`: the merge was audited through a pull
 *     request resolved BY commit sha, because the subject's own number is not
 *     one.
 *   - `subjectRef !== null && prNum === null && prMetaError === null`: the
 *     subject's number is absent AND no pull request contains the merge —
 *     audited from the commit body, exactly the existing no-PR path.
 *
 * @param {{ subjectRef: number|null, prNum: number|null, prSource: 'subject'|'commit-sha'|null, prMetaError: string|null }} ctx
 * @returns {string}
 */
export function formatPrSourceSuffix({ subjectRef, prNum, prSource, prMetaError }) {
  if (prSource === 'commit-sha') {
    return ` [pr #${prNum} by commit-sha; (#${subjectRef}) is not a pull request]`;
  }
  if (subjectRef !== null && prNum === null && prMetaError === null) {
    return ` [(#${subjectRef}) is not a pull request; no pull request contains this merge — commit body audited]`;
  }
  return '';
}

export function crossCheckExit(failCount, nominableTreeKeyedCount, failShaCount) {
  // Bidirectional NOMINABLE ⟺ [FAIL-SHA] coherence. Newest-carrier dedup keeps
  // ≥1 emission per payload, so nominableTreeKeyedCount>0 ⟹ failShaCount>0 always
  // holds on the healthy path; a mismatch is a genuine mid-emission crash.
  const nominable = nominableTreeKeyedCount > 0;
  const emitted = failShaCount > 0;
  if (nominable !== emitted) return 2;
  return failCount > 0 ? 1 : 0;
}

/**
 * Payload-signature grouping key for the newest-carrier [FAIL-SHA] dedup ONLY —
 * NOT a security predicate. The security-critical resolution/exemption
 * comparisons all run inside `resolution.mjs`'s `normDiff` (which is
 * module-private and frozen for this PR — hence this thin mirror). It reproduces
 * that pinned command byte-for-byte so two DISTINCT payloads never collapse to
 * one key.
 *
 * RISK DIRECTION (corrected — the original note here was INVERTED, and the
 * inversion is the reason this comment is now this long). Drift COARSER does NOT
 * yield a harmless EXTRA [FAIL-SHA]: a coarser signature collides two distinct
 * payloads onto ONE dedup key, so the second payload's [FAIL-SHA] is SUPPRESSED
 * — a MISSED emission, fail-open for PR4's consumer. `crossCheckExit` compares
 * booleans (`> 0`), so it can never detect a partial suppression. Today the
 * mirror is byte-identical to `normDiff` (no live exploit) and it is FENCED by
 * the SIG drift-guard source-scan test in brain-audit.test.mjs, which reddens on
 * any divergence. See openspec/changes/issue-259-d2/brain-drafts/local-mirror-of-a-frozen-pin.md.
 *
 * This mirror is accepted for PR3 ONLY (external ruling rev 3, #297): exporting
 * a signature helper from resolution.mjs is the single-source-of-truth fix, but
 * it reopens the PR2b-frozen export surface, which is the owner's keystroke —
 * routed to the owner's backlog as the fast-follow. The mirror never decides
 * exempt/resolved: every security-critical comparison stays in resolution.mjs.
 */
const SIG_CONFIG = ['-c', 'diff.algorithm=myers', '-c', 'diff.renames=false', '-c', 'core.attributesFile=/dev/null'];
const SIG_ARGS = ['diff', '--no-textconv', '--no-ext-diff', '--no-renames', '--binary', '-U3'];
function payloadSignature(resolutionGit, sha) {
  const raw = resolutionGit.orThrow([...SIG_CONFIG, ...SIG_ARGS, `${sha}^1`, sha]);
  return raw
    .split('\n')
    .filter((line) => !/^@@ /.test(line) && !/^index /.test(line))
    .join('\n');
}

/**
 * Loads brain.config.json for the release gate — DENY-DIRECTION (issue #962,
 * the sixth reader named in `evidence-reader-empty-on-failure.md`'s "Applied
 * at" paragraph, extending #942 R1). `governance.reviewActors` (read at
 * `:354` below) is a DENY/exclusion list — the set of reviewer identities
 * EXCLUDED from the human-approver count — so a config-read failure here must
 * PROPAGATE rather than degrade to `{}`: an empty `{}` excludes nobody, which
 * is the PERMISSIVE (fail-open) answer in a DENY direction. `brain-audit.mjs`
 * IS the release gate (`.github/workflows/release.yml` tags only after it
 * exits 0), so the old `catch { return {}; }` let a release through on a
 * policy the audit never actually read.
 *
 * `loadBrainConfigOrThrow(cwd)` (`./lib/brain-config.mjs`, shipped by #942)
 * distinguishes ABSENCE (`ENOENT` → `{}`, R11 — an un-migrated repo with no
 * brain.config.json keeps auditing exactly as before) from UNREADABILITY (any
 * other read failure, or a `JSON.parse` failure → throws, naming the file and
 * the failure). The throw is NOT caught here: it propagates to the top-level
 * `.catch` below (REQ-D2-12, "no error path produces a PASS/violation
 * verdict"), which prints `[FAIL] governance:audit-uncomputable — …` and
 * exits 2 — before any merge is evaluated, never a silent PASS.
 */
function loadConfig(cwd) {
  return loadBrainConfigOrThrow(cwd);
}

function resolveRange(cwd) {
  const arg = process.argv[2];
  if (arg) return arg;
  try {
    execSync('git rev-parse origin/main', { encoding: 'utf8', cwd, stdio: 'pipe' });
    return 'origin/main..HEAD';
  } catch { /* swallow-ok: an unresolvable origin/main widens the audited range to HEAD — a superset, never a narrower one */
    return 'HEAD';
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  // Wrap in an async IIFE so we can await VCS calls (best-effort PR label fetch).
  (async () => {
    const cwd = process.cwd();
    const range = resolveRange(cwd);
    const config = loadConfig(cwd);
    const ignoreList = Array.isArray(config?.governance?.ignoreList)
      ? config.governance.ignoreList
      : [];
    // REQ-TIER-9: one source for the diff-size budget and the size:exception
    // waiver policy. `resolveTier` defaults to `standard` (REQ-TIER-10) when
    // `governance.tier` is absent, so an un-migrated config keeps auditing at
    // the exact pre-tier 400-line/honored-waiver behaviour.
    const tier = resolveTier(config);
    const { diffBudget, honorSizeException } = tierParams(tier);

    // ── Audit baseline (optional) ────────────────────────────────────────────
    // When governance.auditBaseline is set, only merges that are "after" that
    // ref are audited.  Merges before it are skipped as pre-baseline without
    // failing the audit.  This lets teams adopt governance incrementally.
    // `resolveBaseline`/`makeGitIsAncestor` are SHARED with brain-metrics (design
    // D1, lib/merge-walk.mjs) — before issue #324's fix round, brain-metrics had
    // no baseline awareness at all and silently diverged from this decision.
    const rawBaseline = config?.governance?.auditBaseline ?? null;
    const { ref: baseline, warning: baselineWarning } = resolveBaseline(rawBaseline, cwd);
    if (baselineWarning) process.stderr.write(`${baselineWarning}\n`);
    const gitIsAncestor = baseline ? makeGitIsAncestor(cwd) : null;
    const resolutionGit = makeGit(cwd);

    // ── VCS adapter for size:exception label check (best-effort) ────────────
    // If the adapter is unavailable or misconfigured, audit runs without the
    // size:exception bypass — never crash on a missing VCS config.
    const vcs = await resolveVcs(config);
    // REQ-TS-3 (#474): an unconfigured adapter is a deliberate CONFIGURATION,
    // not an outage — it degrades issueLink to commit-body evidence uniformly
    // across every merge, so it is visible rather than selective, and it must
    // not fail the window closed (that would break every consumer repo running
    // brain:audit without a VCS adapter). But it must not be SILENT either:
    // one [WARN] for the run, never one per merge.
    if (!vcs) {
      console.log('[WARN] no VCS adapter configured — issueLink falls back to commit-body evidence '
        + 'for every merge; PR descriptions are not read. This is a configuration state, not a fetch failure.');
    }

    // Read the on-disk .memory/records/ ONCE (repo-level, not per-merge): the same
    // observations are passed to memoryPresence for every merge. Best-effort — a
    // missing/corrupt/schema-drifted record yields fewer observations, never a crash.
    const allObservations = readRecordObservations({ recordsDir: join(cwd, '.memory', 'records') });
    // #1188: does ANY record file exist? An unreadable-only tree is history the
    // audit cannot read (fails), not "no history yet" (abstains).
    const memoryHistory = readMemoryHistory(cwd);

    // --first-parent: audit only the INTEGRATION merges that landed on the audited
    // branch (e.g. main), NOT the nested slice merges inside a feature branch.
    // Nested slice merges legitimately carry "Part of #N" bodies and no per-slice
    // memory — auditing them produces false failures.  The integration merge (the
    // one that actually landed on main) is the canonical governance checkpoint.
    //
    // Range-load via the throwing seam (salvaged R-2 exit-2 site, re-derived
    // against git-seam.mjs — never cherry-picked; design §8): a throwing call
    // distinguishes "git could not compute the range" (infra → exit 2) from
    // "the range genuinely has zero merges" (→ exit 0, below).
    let walk;
    try {
      walk = listAuditedCommits(range, cwd);
    } catch (err) {
      console.log(`[FAIL] governance:audit-uncomputable — could not compute merge range ${range}: ${err.message}`);
      process.exit(2);
    }
    // #518 stood here: an advisory `[WARN] N first-parent commit(s) … were NOT
    // audited`, counting what the merges-only walk skipped. It is gone because
    // the walk no longer skips anything — `listAuditedCommits` enumerates the
    // whole first-parent line, so the count it reported is structurally zero and
    // a warning that can never fire is a protection that only looks like one.
    //
    // What replaces it is not another runtime line but a SOURCE guard
    // (`brain-audit.test.mjs`): no enumerator on the audited path may carry
    // `--merges` again. The completeness is a property of the command, so that is
    // where it is pinned — a runtime re-count would re-run the same git query and
    // agree with itself.
    if (walk.commits.length === 0) {
      console.log(`[INFO] No commits found on the audited first-parent line in range: ${range}`);
      process.exit(0);
    }
    const { commits: merges, windowFrom, windowTo } = walk;

    let failCount = 0;          // [FAIL] lines of ANY class — governs exit 1.
    let nominableTreeKeyedCount = 0; // tree-keyed survivors whose revert does NOT resurrect a payload (auto-revert-nominable, §15.5).
    let failShaCount = 0;       // [FAIL-SHA] lines actually emitted (deduped).
    let uncomputableCount = 0;  // merges whose PR-metadata fetch FAILED (REQ-TS-1/-2) — dominates the exit code.
    const emittedSignatures = new Set(); // payload signatures already carried by a [FAIL-SHA].

    for (const { sha, subject } of merges) {
      // ── Baseline gate ────────────────────────────────────────────────────
      // Skip merges that pre-date the baseline ref (not an audit failure).
      if (baseline) {
        const after = isAfterBaseline(baseline, sha, gitIsAncestor);
        if (!after) {
          console.log(`[SKIP] ${sha.slice(0, 7)} ${subject} — before audit baseline`);
          continue;
        }
      }

      // ── Resolved-by-revert pre-evaluation skip (REQ-D2-10, design §15.3) ──
      // Runs BEFORE the four checks, symmetric to the baseline skip above. A
      // genuinely settled offender (payload net-absent at HEAD) is skipped
      // wholesale — including memoryPresence.
      const resolvedLine = resolvedSkipLine(sha, subject, { git: resolutionGit, tip: windowTo });
      if (resolvedLine) {
        console.log(resolvedLine);
        continue;
      }

      // MINOR 2 — the THROWING seam (lib/merge-walk.mjs): a transient git
      // failure is exit 2 at the top-level catch, never an empty diff that
      // silently PASSes diffSize and adrPresence. A missing parent1 (design
      // §5) also throws — never a silent [SKIP].
      const parent1 = readMergeParent(sha, subject, cwd);
      const { numstat, changedFiles, addedFiles, body } = readMergeDiff(parent1, sha, cwd);

      // ── Best-effort PR metadata fetch (single call for labels + body) ─────
      // Any failure (VCS unconfigured, adapter error, no PR number found)
      // leaves both null (uncomputable — REQ-CIC-2) and falls back to
      // commit-body behavior. NEVER crash, and NEVER collapse a
      // fetched-but-null value back into a fabricated [] / '' default —
      // shouldSkipSize()/selectIssueLinkBody() already treat null as "no
      // evidence" correctly; re-fabricating an empty default here would
      // re-introduce the exact fail-open the seam removes, just on a
      // parallel path (prView fix-at-source disposition).
      const {
        prNum, subjectRef, prLabels, prBody, prAuthor, prReviews, prMetaError, prSource,
      } = await fetchPrMeta(subject, vcs, config, sha);

      // ── Uncomputable merge (REQ-TS-1/-2, issue #474) ─────────────────────
      // The PR fetch was ATTEMPTED and FAILED. Do NOT evaluate this merge:
      // running the four checks over evidence the evaluator could not read is
      // exactly what manufactures a false verdict — selectIssueLinkBody would
      // fall back to the auto-generated merge commit body and issueLink would
      // report a confident FAIL for a PR whose body it never saw (#467).
      //
      // This merge is counted, not skipped: `uncomputableCount` DOMINATES the
      // exit code below, per governance/postmerge/exit-codes.mjs — "an
      // uncomputable check must never read as clean or as a mere violation".
      // Advancing the cursor past a merge that was never evaluated would make
      // it permanently un-re-auditable (ADR-0015 rung 3), so the whole window
      // fails closed rather than the merge being silently dropped.
      if (prMetaError !== null) {
        uncomputableCount += 1;
        console.log(formatUncomputableLine(sha, subject, { prNum, prMetaError }));
        continue;
      }

      // Use the PR description for issueLink when available (it contains the
      // actual Closes/Part of #N reference).  Fall back to the raw commit body
      // when the PR description is absent or empty.
      const issueLinkBody = selectIssueLinkBody(prBody, body);

      // ── Lane merge (D4, design A8, spec "brain:audit reports [LANE] on both
      // signals") ───────────────────────────────────────────────────────────
      // A shipped memory lane is not a governance-relevant merge — it is
      // recognized structurally (every changed path an addition under
      // `.memory/records/`) AND declared (the `/^Memory lane: /m` marker in
      // `issueLinkBody` — the PR body when the PR is reachable, the commit body
      // as `selectIssueLinkBody`'s fallback otherwise (design A8); this is the
      // SAME evidence `issueLink` would have read, never something extra).
      // The `[UNCOMPUTABLE]` guard above (`prMetaError !== null`) is what stops
      // a failed PR fetch from ever reaching this line — without it, a fetch
      // failure would still fall back to the commit body here and could
      // fabricate a [LANE] verdict from evidence the audit never actually read.
      // Paths alone or the marker alone are NOT a lane — the conjunction is the
      // whole point.
      const laneMerge = classifyLane({ sourceBranch: null, changedFiles, addedFiles });
      if (laneMerge.lanePaths && /^Memory lane: /m.test(issueLinkBody ?? '')) {
        console.log(`[LANE] ${sha.slice(0, 7)} ${subject}`);
        continue;
      }

      const rec = evaluateMerge(sha, {
        numstat, changedFiles, addedFiles, issueLinkBody, prLabels, ignoreList, allObservations,
        prReviews, prAuthor, prResolved: prNum !== null && !prMetaError,
        botAllowlist: config?.governance?.reviewActors ?? [],
        resolutionGit, windowFrom, windowTo,
        diffBudget, honorSizeException, tier, memoryHistory,
      });

      const prNote = formatPrSourceSuffix({ subjectRef, prNum, prSource, prMetaError });

      if (rec.kind === 'pass') {
        const sizeNote = rec.sizeSkipped ? ' [size:exception]' : '';
        const memNote = rec.results.memoryPresence?.note ? ' [memory: no history yet — abstained]' : '';
        console.log(`[PASS] ${sha.slice(0, 7)} ${subject}${sizeNote}${memNote}${prNote}`);
        continue;
      }

      if (rec.kind === 'reverter-skip') {
        // Every failure was a tree-keyed failure the net-parity exemption covers.
        console.log(`[SKIP] ${sha.slice(0, 7)} ${subject} — reverts offender (net-absent at HEAD)`);
        continue;
      }

      // ── [FAIL] (any surviving class) — governs exit 1 ────────────────────
      failCount += 1;
      const survivingNames = rec.surviving.map(([name]) => name);
      let reasons = rec.surviving.map(([name, r]) => `${name}: ${r.reason}`).join('; ');
      // adrPresence is the one class with NO automatic forward-fix path
      // (REQ-D2-10a): append the human-gate remediation so the [FAIL] line is
      // self-documenting (design §15.6a).
      if (survivingNames.includes('adrPresence')) {
        // #518 — this used to print `accept ${sha} --reason "…"`, which is not a
        // runnable command and misdescribes the verb. `accept` takes `<from> <to>`
        // and advances the CURSOR across a WINDOW; there is no per-merge accept, and
        // `from` is the cursor value the human asserts they reviewed (that is what
        // gives the CAS its function), never the offending sha. The old form did not
        // even fail on arity — `--reason` bound to `<to>` and the run printed
        // `accept: <reason>` to stdout before dying on the non-hex target.
        //
        // The window is what the audit already knows, so the command is emitted from
        // it. When the range names no base (a bare revision — a local `brain:audit`
        // with no argument and no origin/main), the placeholder is left VISIBLY a
        // placeholder rather than filled with a guess: a fabricated sha in a
        // force-with-lease is worse than an obvious blank.
        const windowBase = auditedBase(range);
        const windowTip = auditedTip(range);
        const acceptCmd = windowBase
          ? `node brain/scripts/governance/postmerge/cursor.mjs accept ${windowBase} ${windowTip} `
            + `--reason "<why the ungoverned ADR is accepted>"`
          : 'node brain/scripts/governance/postmerge/cursor.mjs accept <cursor-sha> <target-sha> '
            + '--reason "<why the ungoverned ADR is accepted>"  (run `cursor.mjs window` for the shas)';
        reasons += ` — resolve by reverting ${sha.slice(0, 7)}, or ACCEPT THE WHOLE AUDITED WINDOW: ${acceptCmd}`;
      }
      console.log(`[FAIL] ${sha.slice(0, 7)} ${subject} — ${reasons}${prNote}`);

      // ── [FAIL-SHA] (auto-revert signal) — class-filtered + newest-carrier
      // dedup (design §15.5, REQ-D2-3). Emitted ONLY for a surviving un-exempted
      // TREE-KEYED failure that is auto-revert-nominable (rec.nominable, from
      // lib/merge-walk.mjs's evaluateMerge — `!revertResurrectsAt(...)`), and
      // ONLY for the newest carrier of each payload signature (git log is
      // newest-first, so the first-seen carrier is the newest). Older carriers
      // stay [FAIL] but emit no auto-revert signal, so PR4 reverts the live
      // carrier once — never O AND R2, never the intermediate legit reverter.
      // issueLink/memoryPresence-only merges emit nothing here.
      if (rec.nominable) {
        nominableTreeKeyedCount += 1;
        const sig = payloadSignature(resolutionGit, sha);
        if (!emittedSignatures.has(sig)) {
          emittedSignatures.add(sig);
          console.log(`[FAIL-SHA] ${sha}`);
          failShaCount += 1;
        }
      }
    }

    // ── Uncomputable DOMINATES (REQ-TS-2, issue #474) ───────────────────────
    // Decided HERE, deliberately OUTSIDE `crossCheckExit`: that function's
    // contract is the NOMINABLE⟺[FAIL-SHA] emission-coherence invariant over a
    // window that was fully evaluated, and folding a "could not evaluate" term
    // into it would conflate an emission bug with an evidence outage — the two
    // states this change exists to separate. `crossCheckExit`'s signature and
    // semantics are unchanged (REQ-TS-6).
    if (uncomputableCount > 0) {
      console.log(`[FAIL] governance:audit-uncomputable — ${uncomputableCount} merge(s) could not be evaluated: `
        + 'their PR metadata was unreachable, so no governance verdict was rendered for them. '
        + 'NOT a violation — the evaluator could not read its evidence. '
        + 'The cursor stays pinned; re-running once the API is reachable clears this '
        + '(the postmerge workflow retries on every push and daily via cron). '
        + 'If this is a local run, `gh auth login` is the usual fix.');
      process.exit(2);
    }

    const exitCode = crossCheckExit(failCount, nominableTreeKeyedCount, failShaCount);
    if (exitCode === 2) {
      console.log('[FAIL] governance:audit-uncomputable — tree-keyed⟺[FAIL-SHA] coherence violated '
        + `(failCount=${failCount}, nominableTreeKeyedCount=${nominableTreeKeyedCount}, failShaCount=${failShaCount})`);
    }
    process.exit(exitCode);
  })().catch(err => {
    // REQ-D2-12 / design §5: no error path produces a PASS/violation verdict.
    // The message is written to STDOUT (captured by the wrapper), never stderr,
    // and exit is 2 — never 1 or 0.
    console.log(`[FAIL] governance:audit-uncomputable — ${err.message}`);
    process.exit(2);
  });
}
