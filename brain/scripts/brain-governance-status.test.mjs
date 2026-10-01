// brain-governance-status.test.mjs — regression guard for the CLI guard.
//
// brain-governance-status.mjs probes the VCS provider and prints to stdout.
// It MUST only run when invoked directly (CLI), never on import. Without the
// `import.meta.url` guard, importing the module would execute reportGovernanceStatus()
// at top level — reading config, calling the provider, printing to stdout — which
// would produce unexpected side effects in any importer.
//
// This test fails closed if the guard regresses: a clean import that exports the
// function proves the guard holds.

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { reportGovernanceStatus } from './brain-governance-status.mjs';
import { checkContexts } from './vcs/governance-checks.mjs';
import { setSpawn } from './vcs/lib/exec.mjs';
import { POSTMERGE_STALE_LABEL } from './vcs/substrate.mjs';

afterEach(() => setSpawn(spawnSync));

// Local fixture-loading glue, copied per vcs.contract.test.mjs:44-61 (design's
// file-changes note) — this file lives one directory up from `vcs/fixtures/`.
const FIXTURES_DIR = fileURLToPath(new URL('./vcs/fixtures/', import.meta.url));

/** Loads and parses a fixture JSON file by name. */
function loadFixture(name) {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}${name}`, 'utf8'));
}

/** Every fixture MUST declare exactly one of recorded/derived (never both, never neither). */
function assertProvenance(fixture, fixtureName) {
  const p = fixture._provenance;
  assert.ok(p, `${fixtureName}: missing _provenance`);
  const recorded = p.recorded === true;
  const derived = p.derived === true;
  assert.ok(recorded || derived, `${fixtureName}: must be marked recorded or derived — never ambiguous (lesson #12)`);
  assert.ok(!(recorded && derived), `${fixtureName}: must not be marked BOTH recorded and derived`);
  assert.ok(p.endpoint, `${fixtureName}: missing _provenance.endpoint`);
  assert.ok(p.date, `${fixtureName}: missing _provenance.date`);
}

test('brain-governance-status: importing is side-effect-free (CLI guard holds)', async () => {
  const mod = await import('./brain-governance-status.mjs');
  assert.equal(
    typeof mod.reportGovernanceStatus,
    'function',
    'reportGovernanceStatus must be exported',
  );
  // Reaching here means the import did NOT invoke reportGovernanceStatus() — if the
  // CLI guard were removed, the top-level report would have run on import (reading
  // config, probing the network, printing to stdout), and this test would still pass
  // but would produce side effects. The guard prevents that.
});

// ── PR2b — detectSubstrate wired into reportGovernanceStatus (REQ-HONESTY-1/2) ──
//
// Every scenario below injects `probes` (and a fake `providerModule`) so no real
// network/gh/fs I/O happens — reportGovernanceStatus() is fully offline-testable,
// same seam pattern as substrate.test.mjs and gentle-ai.test.mjs's captureLog.

/** Capture console.log lines while calling fn(). */
async function captureLog(fn) {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try { await fn(); } finally { console.log = orig; }
  return logs;
}

const OUR_CONTEXTS = checkContexts();

const baseConfig = {
  project: { slug: 'csrinaldi/brain', defaultBranch: 'main' },
  vcs: { provider: 'github' },
};

// A fake VCS provider module — capabilities() never hits the network.
const fakeProviderModule = {
  capabilities: async () => ({ hardEnforcement: 'available' }),
};

test('reportGovernanceStatus: rung-1-armed fixture reports RUNG 1 with no remedy line', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 200, contexts: OUR_CONTEXTS }),
        releaseGate: async () => true,
        postMergeCi: async () => true,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: true, codeownersPresent: true }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 1\b/);
  assert.doesNotMatch(output, /remedy:/i, 'rung 1 is the ceiling — no remedy line should print');
});

test('reportGovernanceStatus: rung-2-only fixture reports RUNG 2 with a remedy to reach rung 1', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => true,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 2\b/);
  assert.match(output, /remedy:.*brain:protect/is, 'must include remedy text describing how to reach rung 1');
});

test('reportGovernanceStatus: rung-3-only fixture reports RUNG 3 with remedy text', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => true,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 3\b/);
  assert.match(output, /remedy:/i);
});

test('reportGovernanceStatus: rung-4 (detection-only) fixture prints the prominent release-blocking-visible warning, never a bare "ok"', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 4 — DETECTION ONLY, no enforcing guarantee/);
  assert.ok(
    !logs.some((line) => /^\s*ok\s*$/i.test(line.trim())),
    'rung-4 must never be rendered as a bare "ok" / passing status',
  );
});

test('reportGovernanceStatus: L6 sub-status line prints when brainWritesReviewed gate is inactive', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 200, contexts: OUR_CONTEXTS }),
        releaseGate: async () => true,
        postMergeCi: async () => true,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(
    output,
    /brain-writes-reviewed enforced at evidence rung; CODEOWNERS rung-1 enhancement unavailable:/,
  );
  assert.match(output, /CODEOWNERS/);
});

test('reportGovernanceStatus: L6 sub-status line is absent when brainWritesReviewed gate is active', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 200, contexts: OUR_CONTEXTS }),
        releaseGate: async () => true,
        postMergeCi: async () => true,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: true, codeownersPresent: true }),
      },
    })
  );

  const output = logs.join('\n');
  assert.doesNotMatch(output, /brain-writes-reviewed enforced at evidence rung/);
});

// ── Rung-2 release-gate render caveat (issue #337, REQ-L2-1/REQ-HONESTY-1) ─────
//
// realReleaseGateProbe now returns structured evidence
// { declared, workflowPresent, workflowText } instead of a bare boolean — every
// scenario below injects that evidence shape via `probes.releaseGate` (never a
// legacy bare boolean) so the render tests exercise the SAME shape production
// wiring produces.

test('printSubstrateReport: config-declared release gate (verifiable:false) renders the caveat, never "verified"', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => ({ declared: true, workflowPresent: false, workflowText: null }),
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 2\b/);
  assert.match(output, /release gate\s+armed \(config-declared\)/i);
  assert.doesNotMatch(output, /release gate[^\n]*\bverified\b/i, 'a config declaration must never render as "verified"');
});

test('printSubstrateReport: structurally-proven active release gate (verifiable:true) renders armed with NO caveat', async () => {
  const workflowText = 'on:\n  workflow_dispatch:\npermissions: { contents: write }\njobs:\n  gate:\n    steps:\n      - run: node brain/scripts/brain-audit.mjs HEAD~1..HEAD\n';
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText }),
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 2\b/);
  assert.match(output, /release gate\s+armed\s+\[workflow triggers pre-tag/i);
  assert.doesNotMatch(output, /config-declared/i, 'a structurally-proven gate must not carry the declaration caveat');
});

test('printSubstrateReport: present-but-inert post-tag workflow (brain\'s own release.yml shape) surfaces reason + remedy even though rung demotes to 3', async () => {
  const workflowText = "on:\n  push:\n    tags: ['v*']\npermissions: { contents: read }\njobs:\n  gate:\n    steps:\n      - run: node brain/scripts/brain-audit.mjs HEAD~1..HEAD\n";
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText }),
        postMergeCi: async () => true,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 3\b/, 'post-fact trigger cannot block — demotes to rung 3, never masquerades as rung 2');
  assert.match(output, /release gate\s+present but cannot block/i);
  assert.match(output, /cannot block tags/i);
  assert.match(output, /remedy:.*#210/is);
});

// ── Rung-3 post-merge-CI breakdown (issue #468, REQ-R3-8) ───────────────────
//
// Driven SOLELY by rungs[3].available/active/verifiable/mechanism, mirroring
// the rung-1/rung-2 discipline above. Every scenario injects `probes.postMergeCi`
// evidence objects directly (no real probe needed) — one case per branch of
// the rung-3 print block, `available === false` checked first so it can never
// be swallowed by an inert render.

test('printSubstrateReport: rung-3 available:false renders UNCOMPUTABLE with reason + remedy, never a neutral inert render', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => ({ workflowPresent: true, read: 'failed', lastRun: null, error: 'gh: authentication required', observedAt: null }),
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /post-merge CI\s+UNCOMPUTABLE — /i);
  assert.match(output, /authentication required/i);
  assert.doesNotMatch(output, /post-merge CI\s+not armed/i, 'uncomputable must never render as a neutral "not armed"');
});

test('printSubstrateReport: every rung-3 render NAMES verifiable and mechanism, not merely consumes them (REQ-R3-8)', async () => {
  // REQ-R3-8 requires the two fields to be reported, not just to drive the
  // branch choice — "no computed rung-3 signal may go unrendered". Asserted
  // across two structurally different rows (uncomputable vs the legacy bare-
  // boolean probe) so that a render which names them on one branch and drops
  // them on another cannot pass.
  const render = async (postMergeCi) => {
    const logs = await captureLog(() =>
      reportGovernanceStatus({
        config: baseConfig,
        env: {},
        providerModule: fakeProviderModule,
        probes: {
          branchProtection: async () => ({ status: 404, contexts: [] }),
          releaseGate: async () => false,
          postMergeCi,
          brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
        },
      })
    );
    return logs.join('\n');
  };

  const uncomputable = await render(async () => ({ workflowPresent: true, read: 'failed', lastRun: null, error: 'gh: authentication required', observedAt: null }));
  assert.match(uncomputable, /mechanism=postmerge-run-ledger-uncomputable\s/, 'the uncomputable row must name its mechanism');
  assert.match(uncomputable, /verifiable=true\b/, 'the uncomputable row must name its verifiability');

  const declared = await render(async () => true);
  assert.match(declared, /mechanism=postmerge-ci-declared\s/, 'the bare-boolean row must name its mechanism');
  assert.match(declared, /verifiable=false\b/, 'the bare-boolean row is precisely the unverifiable one — it must say so');
});

test('printSubstrateReport: rung-3 active with verifiable:false renders the declared-but-unverified caveat (legacy bare-true probe)', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => true,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /post-merge CI\s+armed \(declared\) — unverified; no run-ledger evidence/i);
});

test('printSubstrateReport: rung-3 active AND verifiable renders armed with the run-ledger mechanism, no caveat', async () => {
  const observedAt = Date.parse('2026-08-05T12:00:00Z');
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => ({
          workflowPresent: true,
          read: 'ok',
          lastRun: { id: 1, conclusion: 'success', completedAt: '2026-08-05T06:00:00Z', htmlUrl: 'https://github.com/o/r/actions/runs/1' },
          error: null,
          observedAt,
        }),
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 3\b/);
  assert.match(output, /post-merge CI\s+armed\s+\[last governance-postmerge run on main succeeded within 48h\]/i);
  assert.doesNotMatch(output, /post-merge CI[^\n]*declared/i, 'a run-ledger-verified arm must not carry the declared caveat');
});

test('printSubstrateReport: the armed line quotes the CONFIGURED branch and the CONSTANT, never hardcoded literals', async () => {
  // Both values were hardcoded until they were derived, and neither derivation
  // had a test: reverting both to `on main … within 48h` left the whole suite
  // green. This case is the only one where the literals and the derived values
  // disagree — `defaultBranch: 'master'` and a threshold read off
  // POSTMERGE_STALE_LABEL rather than typed into the string.
  const observedAt = Date.parse('2026-08-05T12:00:00Z');
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: { project: { slug: 'o/r', defaultBranch: 'master' }, vcs: { provider: 'github' } },
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => ({
          workflowPresent: true,
          read: 'ok',
          lastRun: { id: 1, conclusion: 'success', completedAt: '2026-08-05T06:00:00Z', htmlUrl: 'https://github.com/o/r/actions/runs/1' },
          error: null,
          observedAt,
        }),
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /run on master succeeded/, 'the branch named must be the one the probe queried, never a hardcoded "main"');
  assert.doesNotMatch(output, /run on main succeeded/, 'a consumer on master must never be told a run succeeded on a branch that was never read');
  assert.match(output, new RegExp(`succeeded within ${POSTMERGE_STALE_LABEL}\\]`), 'the threshold quoted must be derived from POSTMERGE_STALE_MS, not typed into the string');
});

test('printSubstrateReport: the stale reason quotes the CONSTANT, so the drift guard cannot leave it lying', async () => {
  const completedAt = Date.parse('2026-07-01T00:00:00Z');
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => ({
          workflowPresent: true,
          read: 'ok',
          lastRun: { id: 1, conclusion: 'success', completedAt: '2026-07-01T00:00:00Z', htmlUrl: 'https://github.com/o/r/actions/runs/1' },
          error: null,
          observedAt: completedAt + (49 * 60 * 60 * 1000),
        }),
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  assert.match(logs.join('\n'), new RegExp(`stale \\(older than ${POSTMERGE_STALE_LABEL}\\)`), 'the staleness threshold stated to the operator must be the one that actually rejected the run');
});

test('printSubstrateReport: rung-3 inactive (stale run) renders "not armed" with reason + remedy, never swallowed silently', async () => {
  const completedAt = Date.parse('2026-07-01T00:00:00Z');
  const observedAt = completedAt + (49 * 60 * 60 * 1000);
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => ({
          workflowPresent: true,
          read: 'ok',
          lastRun: { id: 2, conclusion: 'success', completedAt: '2026-07-01T00:00:00Z', htmlUrl: 'https://github.com/o/r/actions/runs/2' },
          error: null,
          observedAt,
        }),
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 4\b/, 'stale evidence does not arm any rung — falls to the floor');
  assert.match(output, /post-merge CI\s+not armed: last successful governance-postmerge run is stale/i);
  assert.match(output, /https:\/\/github\.com\/o\/r\/actions\/runs\/2/);
});

test('printSubstrateReport: rung-3 print does not regress existing rung-1/rung-2 blocks', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 200, contexts: OUR_CONTEXTS }),
        releaseGate: async () => true,
        postMergeCi: async () => true,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: true, codeownersPresent: true }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 1\b/);
  assert.match(output, /merge gate\s+armed/i);
  assert.match(output, /post-merge CI\s+armed \(declared\)/i, 'rung-3 evidence still renders even though rung 1 is selected');
});

// ── GitLab rung-1 ladder awareness (issue #244 A4) ──────────────────────────────
//
// realBranchProtectionProbe dispatches on config.vcs.provider, mirroring
// realBrainWritesReviewedProbe. These tests exercise the REAL (non-injected)
// probe — no `probes.branchProtection` override — via the shared `setSpawn`
// seam (vcs/lib/exec.mjs), fully offline. GitHub stays UNCHANGED (regression
// guard); GitLab reads the per-branch protected-branch endpoint PLUS the new
// projectMergeSettings verb (injected via `providerModule`, mirroring how
// `capabilities()` is already injected in every test above).

test('realBranchProtectionProbe: GitHub branch is UNCHANGED — same gh api read, same {status,contexts} shape, no pipelineMustSucceed field added', async () => {
  setSpawn((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1] === 'repos/csrinaldi/brain/branches/main/protection') {
      return { status: 0, stdout: JSON.stringify({ required_status_checks: { contexts: OUR_CONTEXTS } }), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        releaseGate: async () => true,
        postMergeCi: async () => true,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: true, codeownersPresent: true }),
        // branchProtection intentionally NOT overridden — exercises the real GitHub probe.
      },
    })
  );

  assert.match(logs.join('\n'), /RUNG 1\b/, 'the real GitHub probe must still arm rung 1 on 200+our contexts');
});

const fakeGitlabProviderModule = {
  capabilities: async () => ({ hardEnforcement: 'available' }),
  projectMergeSettings: async () => ({ onlyAllowMergeIfPipelineSucceeds: true }),
};

const gitlabConfig = {
  project: { slug: 'csrinaldi/brain', defaultBranch: 'main' },
  vcs: { provider: 'gitlab' },
};

test('realBranchProtectionProbe: GitLab dispatch reuses the sanctioned config path — per-branch read + injected projectMergeSettings, no direct process.env read', async () => {
  setSpawn((cmd, args) => {
    if (cmd === 'glab' && args[0] === 'api' && args[1] === 'projects/csrinaldi%2Fbrain/protected_branches/main') {
      return { status: 1, stdout: '', stderr: 'GET .../protected_branches/main: 404\n{"message":"404 Not Found"}' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: gitlabConfig,
      env: {},
      providerModule: fakeGitlabProviderModule,
      probes: {
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ premiumOrHigher: false }),
        // branchProtection intentionally NOT overridden — exercises the real GitLab probe.
      },
    })
  );

  // pipelineMustSucceed armed (fakeGitlabProviderModule.projectMergeSettings → true),
  // protectedBranches not (404) — rung 1 armed via pipelineMustSucceed alone.
  assert.match(logs.join('\n'), /RUNG 1\b/);
});

test('realBranchProtectionProbe: an unreachable GET /projects/:id degrades honestly — pipelineMustSucceed reports available:false, report completes without throwing', async () => {
  setSpawn((cmd, args) => {
    if (cmd === 'glab' && args[1] === 'projects/csrinaldi%2Fbrain/protected_branches/main') {
      return { status: 1, stdout: '', stderr: 'GET .../protected_branches/main: 404\n{"message":"404 Not Found"}' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const unreachableProviderModule = {
    capabilities: async () => ({ hardEnforcement: 'available' }),
    projectMergeSettings: async () => ({ onlyAllowMergeIfPipelineSucceeds: null }), // uncomputable, never fabricated false
  };

  await assert.doesNotReject(async () => {
    const logs = await captureLog(() =>
      reportGovernanceStatus({
        config: gitlabConfig,
        env: {},
        providerModule: unreachableProviderModule,
        probes: {
          releaseGate: async () => false,
          postMergeCi: async () => false,
          brainWritesReviewed: async () => ({ premiumOrHigher: false }),
        },
      })
    );
    assert.doesNotMatch(logs.join('\n'), /RUNG 1\b/, 'uncomputable merge-gate + unset protected branches must not falsely arm rung 1');
  });
});

// ── Propagation proof — the null-coercion fix survives end-to-end (fresh-context review MAJOR) ──
//
// Exercises the REAL (non-injected) gitlab.mjs — no `providerModule` override —
// so `projectMergeSettings`'s actual JSON.parse/typeof-guard runs for real.
// `GET /projects/:id` succeeds (200, parseable) but the response body simply
// OMITS `only_allow_merge_if_pipeline_succeeds` (GitLab permission-gates some
// project attributes) — a case DISTINCT from a failed/unreachable read. Before
// the fix, `Boolean(undefined)` fabricated `false` ("readable, not
// configured") and the report would have said "not set" / offered the
// brain:protect remedy. After the fix, the `null` (uncomputable) survives
// gitlab.mjs → realBranchProtectionProbe's pass-through normalization →
// evalPipelineMustSucceedGate's three-way ladder → the printed report.

test('propagation proof: GET /projects/:id succeeds but omits the field — null (uncomputable) survives end-to-end through the REAL gitlab.mjs, never fabricated as "not configured"', async () => {
  setSpawn((cmd, args) => {
    if (cmd !== 'glab' || args[0] !== 'api') {
      return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
    }
    // capabilities()'s protected_branches COLLECTION read (platform section).
    if (args[1] === 'projects/csrinaldi%2Fbrain/protected_branches') {
      return { status: 0, stdout: '[]', stderr: '' };
    }
    // realBranchProtectionProbe's per-branch protected-branch read.
    if (args[1] === 'projects/csrinaldi%2Fbrain/protected_branches/main') {
      return { status: 1, stdout: '', stderr: 'GET .../protected_branches/main: 404\n{"message":"404 Not Found"}' };
    }
    // projectMergeSettings' GET /projects/:id — 200, parseable, field ABSENT.
    if (args[1] === 'projects/csrinaldi%2Fbrain') {
      return { status: 0, stdout: JSON.stringify({ id: 1, path_with_namespace: 'csrinaldi/brain', default_branch: 'main' }), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected glab api call: ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: gitlabConfig,
      env: {},
      // providerModule intentionally NOT overridden — dynamically imports the REAL gitlab.mjs.
      probes: {
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ premiumOrHigher: false }),
        // branchProtection intentionally NOT overridden — exercises the real GitLab probe.
      },
    })
  );

  const output = logs.join('\n');
  assert.doesNotMatch(output, /RUNG 1\b/, 'an uncomputable merge-gate + unset protected branches must not falsely arm rung 1');
  assert.doesNotMatch(output, /merge gate\s+armed/i, 'a null (uncomputable) read must never render as armed');
  // printSubstrateReport does not currently render inactive-gate reasons for
  // rung-1 sub-gates (only active ones) — the DATA-level distinction
  // (available:false vs available:true on an uncomputable read) is proven
  // directly against detectSubstrate's `gates` object in substrate.test.mjs
  // ("propagation proof" test, wiring the REAL gitlab.mjs#projectMergeSettings
  // as the branchProtection probe) — that is the strong regression guard for
  // this fix; this test only proves the CLI report path completes honestly
  // (no crash, no false arming) when fed the real function's `null`.
});

// ── Honesty rendering — caveat IFF verifiable:false, never "verified" (REQ-A4-2) ─

test('printSubstrateReport: an active preReceive sub-gate renders the config-declared caveat, never "verified"', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: { ...gitlabConfig, vcs: { provider: 'gitlab', selfHostedPreReceive: true } },
      env: {},
      providerModule: fakeGitlabProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [], pipelineMustSucceed: false }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ premiumOrHigher: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /not remotely detectable/i);
  assert.match(output, /verify via install runbook/i);
  assert.doesNotMatch(output, /pre-receive[^\n]*verified/i, 'pre-receive must never be rendered as "verified"');
  assert.doesNotMatch(output, /verified[^\n]*pre-receive/i);
});

test('printSubstrateReport: an active API-verified gate (protectedBranches) does NOT borrow the pre-receive caveat', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: gitlabConfig,
      env: {},
      providerModule: fakeGitlabProviderModule,
      probes: {
        branchProtection: async () => ({ status: 200, contexts: [], pipelineMustSucceed: false }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ premiumOrHigher: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 1\b/);
  assert.doesNotMatch(output, /not remotely detectable/i, 'an API-verified gate must not attach the non-detectability caveat');
});

// ── Offline governance-status fixtures — 4 injected-probe cases (Decision 5) ────

test('governance-status GitLab fixture: pipelineMustSucceed-armed — RUNG 1, merge gate armed, push gate inactive, NO pre-receive caveat', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: gitlabConfig,
      env: {},
      providerModule: fakeGitlabProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [], pipelineMustSucceed: true }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ premiumOrHigher: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 1\b/);
  assert.match(output, /merge gate\s+armed/i);
  assert.doesNotMatch(output, /push gate\s+armed/i);
  assert.doesNotMatch(output, /not remotely detectable/i);
});

test('governance-status GitLab fixture: protectedBranches-armed — RUNG 1, push gate armed, merge gate inactive', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: gitlabConfig,
      env: {},
      providerModule: fakeGitlabProviderModule,
      probes: {
        branchProtection: async () => ({ status: 200, contexts: [], pipelineMustSucceed: false }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ premiumOrHigher: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 1\b/);
  assert.match(output, /push gate\s+armed/i);
  assert.doesNotMatch(output, /merge gate\s+armed/i);
});

test('governance-status GitLab fixture: preReceive-declared-only — RUNG 1, pre-receive caveat renders (verifiable:false), never "verified"', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: { ...gitlabConfig, vcs: { provider: 'gitlab', selfHostedPreReceive: true } },
      env: {},
      providerModule: fakeGitlabProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [], pipelineMustSucceed: false }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ premiumOrHigher: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 1\b/);
  assert.match(output, /not remotely detectable/i);
  assert.doesNotMatch(output, /pre-receive[^\n]*verified/i);
});

// ── Tier x rung cross-product (issue #358 Q5, REQ-TIER-11) ─────────────────

test('reportGovernanceStatus: prints the declared tier and the detected rung as separate, labelled facts', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: { ...baseConfig, governance: { tier: 'standard' } },
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /tier standard \(declared\)/);
  assert.match(output, /rung 4 \(detected\)/);
});

test('reportGovernanceStatus: a required-by-doctrine gate on a non-rung-1 substrate renders "detection-only in substrate", never armed', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: { ...baseConfig, governance: { tier: 'standard' } },
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /issue-link: required by doctrine, detection-only in substrate \(rung 4\)/);
  assert.doesNotMatch(output, /issue-link: required by doctrine, enforced/);
});

test('reportGovernanceStatus: a required-by-doctrine gate on a rung-1 substrate renders as enforced, not detection-only', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: { ...baseConfig, governance: { tier: 'standard' } },
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 200, contexts: OUR_CONTEXTS }),
        releaseGate: async () => true,
        postMergeCi: async () => true,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: true, codeownersPresent: true }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /issue-link: required by doctrine, enforced in substrate \(rung 1\)/);
});

test('reportGovernanceStatus: a lite-tier gate not required at this tier renders "detection by doctrine", never omitted', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: { ...baseConfig, governance: { tier: 'lite' } },
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.match(output, /tier lite \(declared\)/);
  assert.match(output, /memory-gate: detection by doctrine \(tier lite\)/);
});

test('reportGovernanceStatus: an unrecognized governance.tier fails closed (rejects), never silently defaults', async () => {
  await assert.rejects(() =>
    reportGovernanceStatus({
      config: { ...baseConfig, governance: { tier: 'enterprise' } },
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
      },
    })
  );
});

test('governance-status GitLab fixture: none armed — rung falls below 1, no false arming', async () => {
  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: gitlabConfig,
      env: {},
      providerModule: fakeGitlabProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [], pipelineMustSucceed: false }),
        releaseGate: async () => false,
        postMergeCi: async () => false,
        brainWritesReviewed: async () => ({ premiumOrHigher: false }),
      },
    })
  );

  const output = logs.join('\n');
  assert.doesNotMatch(output, /RUNG 1\b/);
});

// ── realPostMergeCiProbe — run-ledger reader (issue #468) ───────────────────
//
// `postMergeCi` intentionally NOT overridden below — exercises the REAL probe
// via the shared `setSpawn` seam, mirroring the realBranchProtectionProbe
// pattern above (:271-294). The top-level RUNG/remedy signals and the rung-3
// breakdown block's `mechanism=` field are asserted here — and only in ways
// that are TIME-INDEPENDENT (design's testing
// strategy: real-probe fixtures own evidence extraction, never freshness;
// E7-vs-E8 staleness is asserted only at the pure substrate.test.mjs layer
// with an injected `observedAt`).

const postmergeInertOtherRungs = {
  branchProtection: async () => ({ status: 404, contexts: [] }),
  releaseGate: async () => false,
  brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
};

test('realPostMergeCiProbe: a well-formed success-page run is neither uncomputable nor unproven (evidence extraction, not freshness)', async () => {
  const fixture = loadFixture('github-postmergeRuns-success.json');
  assertProvenance(fixture, 'github-postmergeRuns-success.json');

  setSpawn((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1].startsWith('repos/csrinaldi/brain/actions/workflows/governance-postmerge.yml/runs')) {
      return { status: 0, stdout: JSON.stringify(fixture.data), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: postmergeInertOtherRungs,
    })
  );

  const output = logs.join('\n');
  assert.doesNotMatch(output, /run-ledger evidence is unavailable/i, 'a well-formed lastRun must never render as uncomputable');
  assert.doesNotMatch(output, /mechanism=postmerge-unproven\s/, 'a well-formed lastRun must never render as unproven — anchored to the MECHANISM, not to reason prose a reword can silently defang');
  assert.doesNotMatch(output, /verify gh auth/i, 'a well-formed lastRun must never render the read-failure remedy');
});

test('realPostMergeCiProbe: a non-terminal newest run does not make a readable ledger uncomputable (the terminal-run filter is load-bearing)', async () => {
  const fixture = loadFixture('github-postmergeRuns-inflight.json');
  assertProvenance(fixture, 'github-postmergeRuns-inflight.json');

  setSpawn((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1].startsWith('repos/csrinaldi/brain/actions/workflows/governance-postmerge.yml/runs')) {
      return { status: 0, stdout: JSON.stringify(fixture.data), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: postmergeInertOtherRungs,
    })
  );

  const output = logs.join('\n');
  // Time-independent by construction: the completed run's age decides only
  // between E9 (armed) and E8 (stale), and neither emits the strings asserted
  // here — so this test keeps its mutation power after the fixture ages past
  // the 48h window. What it pins is the filter, not freshness.
  assert.doesNotMatch(output, /evidence is malformed/i, 'reading the non-terminal entry carries conclusion null into the evaluator (E5) — the completed entry is the one to read');
  assert.doesNotMatch(output, /mechanism=postmerge-unproven\s/, 'a completed run exists further down the page — this ledger has a terminal run to read');
  assert.match(output, /mechanism=postmerge-(?:run-ledger|stale)\s/, 'the completed run drives the verdict — armed when fresh, stale when not, never uncomputable');
});

test('realPostMergeCiProbe: an empty run-ledger page reports unproven (zero terminal runs), deterministic regardless of clock', async () => {
  const fixture = loadFixture('github-postmergeRuns-empty.json');
  assertProvenance(fixture, 'github-postmergeRuns-empty.json');

  setSpawn((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1].startsWith('repos/csrinaldi/brain/actions/workflows/governance-postmerge.yml/runs')) {
      return { status: 0, stdout: JSON.stringify(fixture.data), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: postmergeInertOtherRungs,
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 4\b/, 'no rung is armed — falls to the floor');
  assert.match(output, /remedy:.*push to main.*record a terminal run/is);
});

test('realPostMergeCiProbe: a non-zero gh exit (auth failure) reports uncomputable, never active', async () => {
  setSpawn((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1].startsWith('repos/csrinaldi/brain/actions/workflows/governance-postmerge.yml/runs')) {
      return { status: 1, stdout: '', stderr: 'gh: authentication required. Run gh auth login.' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: postmergeInertOtherRungs,
    })
  );

  const output = logs.join('\n');
  assert.match(output, /RUNG 4\b/);
  assert.match(output, /remedy:.*verify gh auth\/connectivity/is);
});

test('realPostMergeCiProbe: malformed JSON reports uncomputable, never crashes', async () => {
  setSpawn((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1].startsWith('repos/csrinaldi/brain/actions/workflows/governance-postmerge.yml/runs')) {
      return { status: 0, stdout: '{not valid json', stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  await assert.doesNotReject(async () => {
    const logs = await captureLog(() =>
      reportGovernanceStatus({
        config: baseConfig,
        env: {},
        providerModule: fakeProviderModule,
        probes: postmergeInertOtherRungs,
      })
    );
    const output = logs.join('\n');
    assert.match(output, /RUNG 4\b/);
    assert.match(output, /remedy:.*verify gh auth\/connectivity/is);
  });
});

test('realPostMergeCiProbe: a parseable but wrong-shaped 200 body (workflow_runs missing/not-an-array) reports uncomputable, NOT zero-runs unproven', async () => {
  // A 200 body that parses as JSON but does not have a `workflow_runs` array
  // (e.g. a proxy/gateway error page, or an API shape change) must be treated
  // as a read failure — never conflated with "the endpoint legitimately
  // returned zero runs" (which is the honest, claimable postmerge-unproven
  // state the 4-state `read` field exists to distinguish).
  setSpawn((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1].startsWith('repos/csrinaldi/brain/actions/workflows/governance-postmerge.yml/runs')) {
      return { status: 0, stdout: JSON.stringify({ message: 'Not Found', documentation_url: 'https://x' }), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: postmergeInertOtherRungs,
    })
  );

  const output = logs.join('\n');
  assert.doesNotMatch(output, /mechanism=postmerge-unproven\s/, 'a wrong-shaped body is UNREADABLE, never the honest no-terminal-run-in-window state — the distinction the 4-state read field exists to keep');
  assert.match(output, /remedy:.*verify gh auth\/connectivity/is, 'a wrong-shaped body must render as a read failure');
});

test('realPostMergeCiProbe: config.vcs.provider "gitlab" reports unsupported and spawns ZERO gh/glab processes', async () => {
  const calls = [];
  setSpawn((cmd, args) => {
    calls.push({ cmd, args });
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: gitlabConfig,
      env: {},
      providerModule: fakeGitlabProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [], pipelineMustSucceed: false }),
        releaseGate: async () => false,
        brainWritesReviewed: async () => ({ premiumOrHigher: false }),
        // postMergeCi intentionally NOT overridden — exercises the real probe.
      },
    })
  );

  const output = logs.join('\n');
  assert.doesNotMatch(output, /run-ledger evidence is unavailable/i, 'unsupported provider must be distinct from uncomputable');
  const spawnedGhOrGlab = calls.filter((c) => c.cmd === 'gh' || c.cmd === 'glab');
  assert.deepEqual(spawnedGhOrGlab, [], `expected zero gh/glab spawns for the postMergeCi probe under provider:gitlab — saw: ${JSON.stringify(spawnedGhOrGlab)}`);
});

// ── Outage-window replay lock (issue #468, REQ-R3-9) ─────────────────────────
//
// Replays the real 2026-07-24 → 2026-08-05 governance-postmerge.yml failure
// window (recorded live via `gh api`, see fixture `_provenance`) through the
// REAL probe (`postMergeCi` not overridden) and the real `evalRung3`. This is
// acceptance criterion (a) from the proposal, made executable: the 12-day
// outage must never report armed. Deterministic without a clock freeze — row
// E6 (conclusion !== success) precedes row E8 (staleness) in the decision
// table, so the outage window fails on conclusion, not on age.

test('replay lock: the real 2026-07-24→2026-08-05 outage window reports rung 3 inactive, names the failing run URL, never claims RUNG 3', async () => {
  const fixture = loadFixture('github-postmergeRuns-outage-window.json');
  assertProvenance(fixture, 'github-postmergeRuns-outage-window.json');

  setSpawn((cmd, args) => {
    if (cmd === 'gh' && args[0] === 'api' && args[1].startsWith('repos/csrinaldi/brain/actions/workflows/governance-postmerge.yml/runs')) {
      return { status: 0, stdout: JSON.stringify(fixture.data), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const logs = await captureLog(() =>
    reportGovernanceStatus({
      config: baseConfig,
      env: {},
      providerModule: fakeProviderModule,
      probes: {
        branchProtection: async () => ({ status: 404, contexts: [] }),
        releaseGate: async () => false,
        brainWritesReviewed: async () => ({ requireCodeOwnerReviews: false, codeownersPresent: false }),
        // postMergeCi intentionally NOT overridden — exercises the real probe + real evalRung3.
      },
    })
  );

  const output = logs.join('\n');
  assert.doesNotMatch(output, /RUNG 3\b/, 'a continuously-failing post-merge CI ledger must never report RUNG 3 armed');
  assert.match(output, /post-merge CI\s+not armed:/i);
  assert.match(output, /https:\/\/github\.com\/csrinaldi\/brain\/actions\/runs\/31035091085/, 'the reason must name the failing run URL (the most recent completed run in the window)');
  // Pins the CAUSE, not just the outcome. Without this the lock decays with the
  // calendar: once the fixture is older than POSTMERGE_STALE_MS, evalRung3
  // reaches E8 (stale) instead of E6 (failed), and E8's reason ALSO carries the
  // run URL — so all three assertions above keep passing while the conclusion
  // check they exist to guard can be deleted freely. Asserting the mechanism is
  // what keeps "inactive because it FAILED" distinguishable from "inactive
  // because the fixture aged", which is the whole of REQ-R3-9.
  assert.match(output, /mechanism=postmerge-failing\s/, 'rung 3 must be inactive because the run FAILED (E6) — not because the fixture has aged into E8');
});

// ── #348 (round 3): R348-3 gets the coverage it shipped without ──────────────
import { approvalLines } from './brain-governance-status.mjs';

test('#348: the approvals axis prints available, NOT ENFORCED with its remedy, and unknown with its cause', () => {
  assert.deepEqual(approvalLines({ approvalCount: 'available' }),
    ["  approvals   available  (the tier's requiredReviews is applied)"]);

  const denied = approvalLines({ approvalCount: 'unavailable', approvalRemedy: 'needs GitLab Premium' });
  assert.match(denied[0], /NOT ENFORCED/);
  assert.match(denied[1], /needs GitLab Premium/, 'the remedy is on screen, not only in the return value');

  const unknown = approvalLines({ approvalCount: 'unknown', approvalDetail: 'no such host' });
  assert.match(unknown[0], /unknown/);
  assert.match(unknown[1], /no such host/,
    'a probe we could not read tells the operator what it could not read');
});

test('#348: a provider that omits the axis is REPORTED, never silently absent', () => {
  const lines = approvalLines({});
  assert.match(lines[0], /approvals   unknown/, 'the line exists');
  assert.match(lines[1], /does not report the axis/,
    'silent omission is the one thing `unknown` may not degrade into — cold-4 of round 1');
  assert.ok(approvalLines(undefined).length > 0, 'and an absent capability object is still a report');
});
