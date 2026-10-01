// no-gh-glab-spawn-regression.test.mjs — issue #239 A3 TASK3 (class-closure
// regression guard, fresh-context review finding). Runs every JS-invokable
// governance-job entrypoint (issue-link, diff-size, memory-gate,
// decision-gate, phase-order, actor-check, brain-writes-reviewed —
// `local-checks` is a shell combo — `npm run repo:check && brain:nav && npm
// test` — with no VCS spawn/fetch of its own, out of scope here) under
// `ctx.provider:'gitlab'` with every transport/network call mocked, and
// asserts NONE of them ever spawns a `gh`/`glab` CLI process.
//
// This is the CLASS guard closing a defect pattern found 3 times in this
// slice's review cycle (finding #14 issue-link's original fix, PR-1's
// labelEvents + fetchIssue in actor-check.mjs, prReviews in
// brain-writes-reviewed.mjs — the "4th violation"): a CI-path fetch that
// ignores the runtime ctx.provider and unconditionally shells out to `gh`,
// which throws ENOENT on a GitLab runner (no `gh` binary) and masks the
// REQUIRED/DETECTION gate behind a fail-closed or a permanent `warn`.
//
// setSpawn (lib/exec.mjs) intercepts every call made via run()/runJson() —
// the ONLY mechanism any provider verb uses to invoke `gh`. Local `git`
// usage (decision-gate/diff-size/phase-order's diff computation) goes
// through a SEPARATE raw execFileSync('git', ...) call, never through
// run()/runJson(), so this spy does not (and should not) fire for
// legitimate git usage — it purely proves zero gh/glab CLI invocations
// occurred across the whole reachable set.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setSpawn } from './lib/exec.mjs';

import { runCheck } from '../governance/run-check.mjs';
import { runPhaseOrderCheck } from './phase-order-check.mjs';
import { runActorCheck } from './actor-check.mjs';
import { runBrainWritesReviewedCheck } from './brain-writes-reviewed.mjs';

afterEach(() => setSpawn(spawnSync));

function spySpawn(calls) {
  return (cmd, args) => {
    calls.push({ cmd, args });
    return { status: 0, stdout: '{}', stderr: '' };
  };
}

const fakeVcsForIssueLink = {
  issueView: async () => ({ number: 1, title: 't', labels: ['status::approved'], body: 'b', author: 'bob' }),
};
const fakeVcsForActorCheck = {
  labelEvents: async () => ([{ actor: { login: 'bob' }, action: 'add', label: 'status::approved', at: 'T1' }]),
  issueView: async () => ({ number: 1, title: 't', labels: ['status::approved'], body: 'b', author: 'bob' }),
};
const fakeVcsForBrainWrites = {
  prReviews: async () => ([{ state: 'APPROVED', author: 'bob' }]),
};

test('A3 TASK3 class guard: none of the 7 JS-invokable governance-job entrypoints spawns a gh/glab CLI process under provider:gitlab', async () => {
  const calls = [];
  setSpawn(spySpawn(calls));

  // issue-link (REQUIRED) — dispatches defaultFetchIssue → getVcs({provider}).issueView
  await runCheck('issue-link', {
    ctx: { body: 'Closes #1', provider: 'gitlab', repo: 'g/r', targetBranch: 'main', defaultBranch: 'main' },
    getVcs: async () => fakeVcsForIssueLink,
    readConfig: () => ({}),
  });

  // diff-size (REQUIRED) — local git numstat only, no VCS API
  await runCheck('diff-size', {
    ctx: { provider: 'gitlab', labels: [] },
    diffNumstat: () => '1\t1\tfoo.mjs\n',
    readConfig: () => ({}),
  });

  // memory-gate (REQUIRED) — local filesystem only, no VCS API
  await runCheck('memory-gate', {
    readRecords: () => [],
  });

  // decision-gate (REQUIRED) — local git diff only, no VCS API
  await runCheck('decision-gate', {
    diffNameOnly: () => ['foo.mjs'],
  });

  // phase-order (DETECTION) — local git only, no VCS API (sync, never a Promise)
  runPhaseOrderCheck({
    baseSha: 'base',
    headSha: 'head',
    diffNameOnly: () => [],
  });

  // actor-check (DETECTION) — dispatches labelEvents + issueView → getVcs({provider})
  await runActorCheck({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'g/r',
    provider: 'gitlab',
    getVcs: async () => fakeVcsForActorCheck,
    readBotAllowlist: () => [],
    readConfig: () => ({}),
  });

  // brain-writes-reviewed (DETECTION) — dispatches prReviews → getVcs({provider})
  await runBrainWritesReviewedCheck({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'g/r',
    author: 'alice',
    provider: 'gitlab',
    diffNameOnly: () => ['brain/core/foo.mjs'],
    getVcs: async () => fakeVcsForBrainWrites,
    readBotAllowlist: () => [],
  });

  const spawnedGhOrGlab = calls.filter(c => c.cmd === 'gh' || c.cmd === 'glab');
  assert.deepEqual(
    spawnedGhOrGlab,
    [],
    `no entrypoint may spawn gh/glab under provider:gitlab — saw: ${JSON.stringify(spawnedGhOrGlab)}`
  );
});

// ── Structural companion guard — closes a BLIND SPOT in the behavioral test
// above ────────────────────────────────────────────────────────────────────
//
// The behavioral test injects a fake `getVcs`, so it only proves the wrapper
// dispatches through `getVcs` WHEN that seam is reached. It CANNOT catch a
// regression where a wrapper reverts to a RAW `execFileSync('gh', ...)` call
// — exactly the original defect shape (finding #14, PR-1's labelEvents/
// fetchIssue, TASK2's prReviews) — because a raw execFileSync call bypasses
// `deps.getVcs`/`deps.fetchLabeledEvents`/etc. ENTIRELY and is never routed
// through lib/exec.mjs's `run()`/`runJson()` (the only mechanism `setSpawn`
// intercepts). Proven empirically: `setSpawn` does NOT see a direct
// `execFileSync('gh', ...)` call at all. A source-scan is the only reliable
// permanent guard against this specific regression shape.

const SOURCE_SCAN_TARGETS = [
  '../governance/run-check.mjs',
  './phase-order-check.mjs',
  './actor-check.mjs',
  './brain-writes-reviewed.mjs',
  // relabel-retrigger.mjs (issue #328): dispatches PR discovery (mrList/
  // prView) and the rerun capability (rerunWorkflowRun) exclusively through
  // getVcs({ provider }) — never a raw gh/glab spawn of its own.
  '../governance/relabel-retrigger.mjs',
];

test('A3 TASK3 structural guard: none of the governance-job wrapper source files contain a raw execFileSync/spawn(\'gh\'|\'glab\', ...) call', () => {
  // Quote class includes the backtick so a template-literal regression
  // (execFileSync(`gh`, ...)) is caught too, not just single/double quotes.
  // Residual gap (accepted, source-scan cannot close without an AST): an
  // indirect binding — `const bin = 'gh'; execFileSync(bin, ...)` — still
  // slips past. Tracked as a Phase-3 follow-up note in tasks.md.
  const GH_GLAB_LITERAL_RE = /(execFileSync|spawnSync|spawn)\(\s*['"`](gh|glab)['"`]/;
  for (const rel of SOURCE_SCAN_TARGETS) {
    const srcPath = fileURLToPath(new URL(rel, import.meta.url));
    const src = readFileSync(srcPath, 'utf8');
    assert.equal(
      GH_GLAB_LITERAL_RE.test(src),
      false,
      `${rel}: must never call execFileSync/spawn('gh'|'glab', ...) directly — dispatch through getVcs({ provider }) instead (the only provider-agnostic path)`
    );
  }
});
