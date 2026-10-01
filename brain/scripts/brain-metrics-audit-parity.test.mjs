// brain-metrics-audit-parity.test.mjs — cross-verb parity test (issue #324 B3).
//
// Spec's "Historical re-execution, zero new rules" requirement (REQ-7) states:
// "GIVEN a historical merge that brain-audit marked as failing a gate, WHEN
// brain-metrics re-executes checks for that merge, THEN it reports the same
// failure for that gate on that merge." Until this fix round, NOTHING actually
// exercised that claim end-to-end — the apply-progress notes for issue #324
// asserted parity was "guaranteed by construction" (both verbs call the same
// lib/merge-walk.mjs functions), which is true for CODE PATH sharing but does
// NOT cover CONFIGURATION divergence: brain-metrics did not even read
// `governance.auditBaseline`, so a pre-baseline merge brain-audit skips (never
// evaluates) was still evaluated — and its gate failures counted — by
// brain-metrics (bug B2). A shared function called with different inputs
// (baseline vs. no baseline) still diverges. This test runs BOTH CLIs over the
// EXACT same fixture history and range, and cross-checks their verdicts —
// this specific test would have failed before B2's fix.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync,
} from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const AUDIT_SCRIPT = new URL('./brain-audit.mjs', import.meta.url).pathname;
const METRICS_SCRIPT = new URL('./brain-metrics.mjs', import.meta.url).pathname;

// ── Fixture helpers (mirrors brain-audit.test.mjs / brain-metrics.test.mjs) ──

function makeRepo(dir) {
  const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'test@test.com');
  git('config', 'user.name', 'Test');
  return git;
}

function commit(git, dir, files, message) {
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(abs.replace(/\/[^/]+$/, ''), { recursive: true });
    writeFileSync(abs, content);
  }
  git('add', '-A');
  git('commit', '-m', message);
}

function mergeAddingPayload(git, dir, files, label, mergeMsg) {
  git('checkout', '-b', `feat-${label}`, 'main');
  commit(git, dir, files, `${label}: add payload`);
  git('checkout', 'main');
  const m = git('merge', '--no-ff', `feat-${label}`, '-m', mergeMsg);
  assert.equal(m.status, 0, `merge ${label} failed: ${m.stderr}`);
}

function makeSessionSummaryRecord() {
  // #1188: scoped to every issue the fixture's merges close — the audit runs the
  // memory-gate's issue-scoped predicate now, not the repo-wide existence check.
  return [1, 2, 9].map((issue) => JSON.stringify({
    id: `rec-${issue}`, ts: '2026-07-12T12:00:00Z', actor: '@test', actorKind: 'human',
    type: 'session_summary', project: 'brain', issue, content: 'Test session summary',
  })).join('\n') + '\n';
}

const bigFile = Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n') + '\n';

/**
 * Build a fixture history with FOUR merges spanning every relevant class:
 *   M1 (pre-baseline) — oversized diff AND no issue ref: brain-audit SKIPS it
 *                        wholesale (before audit baseline) — never evaluated.
 *   M2 (post-baseline) — PASS: Closes #1, small diff.
 *   M3 (post-baseline) — FAIL issue-link ONLY: no issue ref, small diff.
 *   M4 (post-baseline) — FAIL diff-size ONLY: Closes #2, oversized diff.
 *
 * `.memory/records/` carries a valid session_summary record from the FIRST
 * commit onward — memoryPresence is a repo-level check (@ HEAD), evaluated
 * identically for every merge, so it stays PASS throughout and never confounds
 * the issue-link / diff-size parity signal this test isolates.
 */
function buildFixture(dir) {
  const git = makeRepo(dir);

  commit(git, dir, {
    'README.md': 'init',
    '.memory/records/2026-07.jsonl': makeSessionSummaryRecord(),
  }, 'chore: initial (#0)');

  // M1 — pre-baseline: BOTH invariants violated (oversized + no issue ref).
  // If brain-metrics ever re-evaluated this merge (the B2 bug), it would
  // contribute a SECOND raw failure to both issue-link and diff-size —
  // exactly what this test's counts below would catch.
  mergeAddingPayload(git, dir, { 'src/pre-baseline.mjs': bigFile }, 'pre',
    'Merge feat-pre (no issue ref, oversized, PRE-baseline)');

  // Baseline config + tag, AFTER M1 — everything from here on is "post-baseline".
  commit(git, dir, {
    'brain.config.json': JSON.stringify({ governance: { auditBaseline: 'v0.1.0' } }),
  }, 'chore: add audit baseline config Closes #9');   // #518: on the audited line now
  git('tag', 'v0.1.0');

  // M2 — clean PASS.
  mergeAddingPayload(git, dir, { 'src/clean.mjs': 'export const ok = 1;\n' }, 'pass',
    'Merge feat-pass Closes #1');

  // M3 — FAIL issue-link only (small diff, no Closes/Part-of reference).
  mergeAddingPayload(git, dir, { 'src/noref.mjs': 'export const x = 1;\n' }, 'noissue',
    'Merge feat-noissue (no issue reference)');

  // M4 — FAIL diff-size only (Closes #2, oversized diff).
  mergeAddingPayload(git, dir, { 'src/oversized.mjs': bigFile }, 'big',
    'Merge feat-big Closes #2');

  return git;
}

/** Count occurrences of `[FAIL] ... — <checkName>:` lines in brain-audit's stdout. */
function countAuditFails(stdout, checkName) {
  return stdout.split('\n').filter((l) => l.startsWith('[FAIL]') && l.includes(`${checkName}:`)).length;
}

function countLinesStartingWith(stdout, prefix) {
  return stdout.split('\n').filter((l) => l.startsWith(prefix)).length;
}

test('brain-metrics re-execution matches brain-audit\'s own verdict, per gate, over the SAME fixture history and range (spec REQ-7)', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'metrics-audit-parity-'));
  t.after(() => removeTempTree(dir));
  buildFixture(dir);

  const auditRun = spawnSync('node', [AUDIT_SCRIPT], { cwd: dir, encoding: 'utf8' });
  const metricsRun = spawnSync('node', [METRICS_SCRIPT, '--json'], { cwd: dir, encoding: 'utf8' });

  assert.equal(auditRun.status, 1,
    `expected brain-audit exit 1 (2 real [FAIL] merges)\n${auditRun.stdout}\n${auditRun.stderr}`);
  assert.equal(metricsRun.status, 0,
    `expected brain-metrics exit 0 (reporting tool, never fails)\n${metricsRun.stdout}\n${metricsRun.stderr}`);

  // ── brain-audit's own verdict, parsed from its stdout ──────────────────────
  const auditSkipCount = countLinesStartingWith(auditRun.stdout, '[SKIP]');
  const auditPassCount = countLinesStartingWith(auditRun.stdout, '[PASS]');
  const auditFailCount = countLinesStartingWith(auditRun.stdout, '[FAIL]');
  const auditIssueLinkFails = countAuditFails(auditRun.stdout, 'issueLink');
  const auditDiffSizeFails = countAuditFails(auditRun.stdout, 'diffSize');

  // #518 widened the walk to the whole first-parent line, so the two ORDINARY
  // commits in this fixture are audited too: `chore: initial (#0)` joins M1 as
  // pre-baseline [SKIP], and the baseline-config commit (now carrying `Closes #9`)
  // joins M2 as [PASS]. The per-gate failure counts below are unchanged, which is
  // the point — widening added coverage, it did not add failures.
  //
  // And both CLIs had to shift TOGETHER. That is exactly what this test is for: a
  // shared function called with different inputs still diverges (bug B2), so if
  // only one of them had widened, these counts would disagree instead of both
  // moving from 1 to 2.
  assert.equal(auditSkipCount, 2, `expected 2 [SKIP] (root + M1, both pre-baseline):\n${auditRun.stdout}`);
  assert.equal(auditPassCount, 2, `expected 2 [PASS] (baseline-config commit + M2):\n${auditRun.stdout}`);
  assert.equal(auditFailCount, 2, `expected 2 [FAIL] (M3 issue-link, M4 diff-size):\n${auditRun.stdout}`);
  assert.equal(auditIssueLinkFails, 1, `expected exactly 1 issueLink failure (M3 only, M1 is baseline-skipped):\n${auditRun.stdout}`);
  assert.equal(auditDiffSizeFails, 1, `expected exactly 1 diffSize failure (M4 only, M1 is baseline-skipped):\n${auditRun.stdout}`);

  // ── brain-metrics' re-derived verdict, parsed from its --json output ──────
  const metricsRows = JSON.parse(metricsRun.stdout);
  assert.equal(metricsRows.length, 1, 'every commit in this fixture lands in the same month bucket');
  const row = metricsRows[0];

  // Every change that LANDED counts toward changesMerged — including the
  // baseline-skipped one (it is still a real change, brain-audit just never
  // evaluated its governance verdict).
  //
  // Six, not four, since #518: the denominator is the audited first-parent line,
  // so the two ordinary commits count as well. That is the correct reading of the
  // metric and not a side effect to tolerate — a squashed PR is a change that
  // merged, and a throughput number that silently omitted a third of them was
  // measuring the walk's blind spot rather than the repo.
  assert.equal(row.changesMerged, 6, `expected 6 changes on the audited line:\n${JSON.stringify(row)}`);
  assert.equal(row.uncomputable, 0, 'no infra-level failures in this fixture');

  // THE PARITY ASSERTION (spec REQ-7): brain-metrics' raw AND enforced counts
  // for issue-link/diff-size must match brain-audit's own [FAIL] count for
  // that gate EXACTLY — not "off by the baseline-skipped merge's failures".
  // No VCS is configured in this fixture, so size:exception is unreachable —
  // raw === enforced for both gates here (no exemption in play).
  assert.equal(row.gates['issue-link'].raw, auditIssueLinkFails,
    `metrics issue-link RAW (${row.gates['issue-link'].raw}) must equal brain-audit's issueLink [FAIL] count (${auditIssueLinkFails}) — a mismatch means metrics evaluated a merge brain-audit skipped (or vice versa)`);
  assert.equal(row.gates['issue-link'].enforced, auditIssueLinkFails,
    `metrics issue-link ENFORCED (${row.gates['issue-link'].enforced}) must equal brain-audit's issueLink [FAIL] count (${auditIssueLinkFails})`);
  assert.equal(row.gates['diff-size'].raw, auditDiffSizeFails,
    `metrics diff-size RAW (${row.gates['diff-size'].raw}) must equal brain-audit's diffSize [FAIL] count (${auditDiffSizeFails}) — a mismatch means metrics evaluated a merge brain-audit skipped (or vice versa)`);
  assert.equal(row.gates['diff-size'].enforced, auditDiffSizeFails,
    `metrics diff-size ENFORCED (${row.gates['diff-size'].enforced}) must equal brain-audit's diffSize [FAIL] count (${auditDiffSizeFails})`);
});
