// brain-check.test.mjs — TDD tests for brain:check (REQ-S5-2)
//
// brain:check runs the 4 governance checks + npm test + repo:check against the
// current branch's diff vs base.  Returns a non-zero exit code if any fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Import safety regression ───────────────────────────────────────────────────

test('brain-check: importing is side-effect-free (CLI guard holds)', async () => {
  const mod = await import('./brain-check.mjs');
  assert.equal(typeof mod.runCheck, 'function', 'runCheck must be exported');
});

// ── runCheck unit tests (injected dependencies) ───────────────────────────────

/** Build a passing check context stub. */
function makeCtx(overrides = {}) {
  return {
    numstat: '1\t0\tsrc/feature.mjs\n',
    changedFiles: ['src/feature.mjs'],
    // The summary is SCOPED TO #42 (#340). Before this verb ran the CI evaluator, an
    // unscoped summary passed here and failed in CI — memory-gate matches the issue the
    // body closes. The old fixture encoded that divergence as the expected behaviour.
    observations: [{ type: 'session_summary', issue: 42, title: 'Session summary: brain' }],
    prBody: 'Closes #42',
    ignoreList: [],
    // The branch pair and the label lookup are what `issue-link` actually decides on
    // (#340). Omitting them is a real state — it makes the check UNVERIFIED, exercised
    // by its own test below — so a fixture that means "everything passes" must supply
    // them rather than leave the check unevaluated.
    targetBranch: 'feature/x',
    defaultBranch: 'main',
    fetchIssue: async () => ({ labels: ['status:approved'] }),
    // #1024: hermetic fake — memory-gate's D3 lazy union would otherwise
    // reach the REAL git remote (readDefaultBranchRecords' production
    // default) whenever the PR-tree observations alone are not a clean hit,
    // which is exactly the case `memoryPresence fails` below exercises.
    readDefaultBranchRecords: () => ({ records: [], error: null }),
    npmTestFn: async () => ({ ok: true }),
    repoCheckFn: async () => ({ ok: true }),
    ...overrides,
  };
}

test('brain-check: all checks pass → exitCode 0', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx());
  assert.equal(result.exitCode, 0,
    `expected exit 0 — all pass. Failures: ${JSON.stringify(result.failures)}`);
});

test('brain-check: diffSize fails → exitCode 1', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  // Generate a numstat with 401 added + 0 deleted lines
  const bigNumstat = '401\t0\tsrc/huge.mjs\n';
  const result = await runCheck(makeCtx({ numstat: bigNumstat }));
  assert.equal(result.exitCode, 1, 'expected exit 1 when diffSize fails');
  assert.ok(result.failures.some(f => f.check === 'diffSize'),
    `expected diffSize in failures: ${JSON.stringify(result.failures)}`);
});

test('brain-check: issueLink fails → exitCode 1', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({ prBody: 'no issue reference here' }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some(f => f.check === 'issueLink'),
    `expected issueLink in failures: ${JSON.stringify(result.failures)}`);
});

test('brain-check: memoryPresence fails → exitCode 1', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  // Pass an empty observations array — no session_summary → memoryPresence fails
  const result = await runCheck(makeCtx({ observations: [] }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some(f => f.check === 'memoryPresence'),
    `expected memoryPresence in failures: ${JSON.stringify(result.failures)}`);
});

test('brain-check: npm test fails → exitCode 1', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({
    npmTestFn: async () => ({ ok: false, output: '1 test failed' }),
  }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some(f => f.check === 'npmTest'),
    `expected npmTest in failures: ${JSON.stringify(result.failures)}`);
});

test('brain-check: repo:check fails → exitCode 1', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({
    repoCheckFn: async () => ({ ok: false, output: '1 prohibited reference' }),
  }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some(f => f.check === 'repoCheck'),
    `expected repoCheck in failures: ${JSON.stringify(result.failures)}`);
});

// ── Tier-scoped diff-size budget (issue #358 Q5, REQ-TIER-9) ─────────────────
//
// CRITICAL fix: runCheck used to call diffSize(numstat, ignoreList) with no
// budget, silently using diff-size.mjs's own hardcoded 400 default — the CLI
// entry-point now resolves `tierParams(resolveTier(config)).diffBudget` and
// passes it as `ctx.budget`.

test('brain-check: budget=1000 (lite tier) passes a 900-line diff that would fail at the default 400', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({
    numstat: '900\t0\tsrc/huge.mjs\n',
    changedFiles: ['src/huge.mjs'],
    budget: 1000,
  }));
  assert.equal(result.exitCode, 0,
    `expected exit 0 at lite's 1000-line budget. Failures: ${JSON.stringify(result.failures)}`);
});

test('brain-check: no budget supplied falls back to the pre-tier 400-line default (backward compatibility)', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({ numstat: '401\t0\tsrc/huge.mjs\n' }));
  assert.equal(result.exitCode, 1, 'expected the legacy 400-line default to still apply when no budget is passed');
  assert.ok(result.failures.some(f => f.check === 'diffSize'));
});

// ── #1187: tier semantics, and "not applicable" ──────────────────────────────────────

test('#1187 (d): a fresh consumer at `lite` with no memory records — memoryPresence does not block, as in CI', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({ observations: [], config: { governance: { tier: 'lite' } } }));
  assert.equal(result.exitCode, 0, `lite detects, it does not block. Failures: ${JSON.stringify(result.failures)}`);
  assert.match(result.summary, /\[PASS\] memoryPresence — ::warning::memory-gate.*\(tier: lite\)/,
    'the tier that softened it must be named, never a silent pass');
});

test('#1187 (d): the same evidence at `standard` still blocks', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({ observations: [], config: { governance: { tier: 'standard' } } }));
  assert.equal(result.exitCode, 1);
});

test('#1187 (c): npm test that is not applicable is stated, never run, never a failure', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({
    npmTestApplicability: { applicable: false, reason: 'no "test" script in package.json — not applicable' },
    npmTestFn: async () => { throw new Error('npm test must not run when it is not applicable'); },
  }));
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  assert.match(result.summary, /\[N\/A\] npmTest — no "test" script in package\.json — not applicable/);
});

// ── #1186: the slug the local issue-link check hands the port ───────────────────────

test('#1186 (a): issue-link asks the port about the configured slug, never `undefined`', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const asked = [];
  const fakePort = { issueView: async ({ project, number }) => { asked.push({ project, number }); return { labels: ['status:approved'] }; } };
  const { fetchIssue: _omit, ...ctx } = makeCtx({
    config: { project: { slug: 'acme/widgets' }, vcs: { provider: 'github' } },
    getVcs: async () => fakePort,
  });
  const result = await runCheck(ctx);
  assert.deepEqual(asked, [{ project: 'acme/widgets', number: 42 }]);
  assert.ok(!result.failures.some(f => f.check === 'issueLink') && !result.unverified.some(f => f.check === 'issueLink'),
    `issueLink must resolve: ${result.summary}`);
});

// ── local-checks parity: every step of the CI job, not just two of four ─────────────

test('#1186 local-checks: a failing brain:nav blocks locally, as the CI step does', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({ navCheckFn: async () => ({ ok: false, output: 'broken link' }) }));
  assert.equal(result.exitCode, 1);
  assert.ok(result.failures.some(f => f.check === 'navCheck'), JSON.stringify(result.failures));
});

test('#1186 local-checks: index lag is a warning, never a failure — same as the CI step', async () => {
  const { runCheck } = await import('./brain-check.mjs');
  const result = await runCheck(makeCtx({
    // The script ALWAYS exits 0 (index-lag.mjs header); even a non-zero exit must not block.
    indexLagFn: async () => ({ ok: false, output: 'WARNING: index lags records (1 indexed, 2 rebuilt)' }),
  }));
  assert.equal(result.exitCode, 0, JSON.stringify(result.failures));
  assert.match(result.summary, /\[PASS\] indexLag — ::warning::.*index lags records/);
});
