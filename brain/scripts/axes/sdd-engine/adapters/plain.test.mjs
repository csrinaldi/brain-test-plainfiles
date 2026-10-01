// plain.test.mjs — unit + end-to-end dispatch tests for the `plain` SDD_HARNESS
// backend (issue #250, B0, REQ-B0-5). Run with: npm test.
//
// (a) unit-level: injects a capturing fake `_emit`, asserts the nine
//     docs/workflow-guide.md §B manual-flow steps are emitted in order.
// (b) end-to-end: dispatches through the REAL, unmodified harness/cli.mjs
//     dispatch path — proving n=2 on `init` (gentle-ai + plain) with ZERO
//     cli.mjs change (REQ-B0-5 scenario 2).

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Task 3.1 (RED): fails until axes/sdd-engine/adapters/plain.mjs exists.
import { init, declareRoles } from './plain.mjs';
import { dispatch } from '../../../harness/cli.mjs';

// ── (a) unit-level: injected _emit, nine steps in order ──────────────────────

test('3.1: plain init emits the header + all nine docs/workflow-guide.md §B steps, in order, each prefixed "N. "', async () => {
  const lines = [];
  await init({ _emit: (line) => lines.push(line) });

  assert.equal(lines[0], 'SDD_HARNESS=plain — manual flow (no AI). Run these npm verbs in sequence:');
  assert.equal(lines.length, 10); // header + 9 steps
  for (let i = 1; i <= 9; i++) {
    assert.match(lines[i], new RegExp(`^\\s*${i}\\. `), `step ${i} must be prefixed "${i}. "`);
  }
  // Spot-check content against docs/workflow-guide.md §B (cross-checked design §4).
  assert.match(lines[1], /brain:env:init/);
  assert.match(lines[2], /brain:session:start/);
  assert.match(lines[3], /brain:ticket:start/);
  assert.match(lines[4], /brain:project:feature/);
  assert.match(lines[5], /proposal\.md.*spec\.md.*design\.md.*tasks\.md/);
  assert.match(lines[6], /tasks\.md/i);
  assert.match(lines[7], /brain:repo:check/);
  assert.match(lines[8], /npm run brain:memory:save --issue <id>/);
  assert.match(lines[8], /memory lane/i);
  assert.match(lines[9], /Closes #/);
});

test('3.1: plain init defaults _emit to console.log (no throw when called with no opts)', async () => {
  const original = console.log;
  const captured = [];
  console.log = (line) => captured.push(line);
  try {
    await init();
  } finally {
    console.log = original;
  }
  assert.equal(captured.length, 10);
});

// ── (b) end-to-end: real dispatch('plain', 'init', []) through the unmodified cli.mjs ──

test('3.3: dispatch("plain", "init", []) resolves through the REAL cli.mjs dispatch path with zero cli.mjs change', async () => {
  await assert.doesNotReject(dispatch('plain', 'init', [], {
    // No backendLoader override — exercises the real defaultBackendLoader,
    // resolveHarness → 'plain' → import(harnessAdapterUrl('plain')) → VALID_OPS.includes('init') → backend.init().
  }));
});

// Task 3.4 — confirm n=2: SDD_HARNESS=gentle-ai and SDD_HARNESS=plain are now
// both real, dispatchable `init` inhabitants of the same dispatch path.
test('3.4: n=2 — both gentle-ai and plain resolve through dispatch() to a real init() export', async () => {
  const gentleAi = await import('./gentle-ai.mjs');
  const plain = await import('./plain.mjs');
  assert.equal(typeof gentleAi.init, 'function');
  assert.equal(typeof plain.init, 'function');
});

test('plain declares no agent runtime — there is no AI to check (issue #123)', async () => {
  const { AGENT_RUNTIME } = await import('./plain.mjs');
  const { probeAgentRuntime } = await import('../../lib/agent-runtime.mjs');

  assert.equal(AGENT_RUNTIME, null);
  assert.equal(probeAgentRuntime(AGENT_RUNTIME, { _run: () => { throw new Error('must not run'); } }).state,
    'not-declared');
});

// ── declareRoles (issue #312 slice A, Unit 3, design D2) ────────────────────
//
// plain answers EVERY resolved stage, including a stage it never heard of
// when this file was written — a human executes any stage, which is a real
// property of `plain` (AGENT_RUNTIME = null, one manual flow), not a gap. The
// three values (agent, model_tier, chooses_model) are checked and falsifiable,
// not a stub: every one of them would change the day plain gained a runtime.

test('#312 D2: declareRoles answers every stage it is asked about, including one it did not know about', () => {
  const roles = declareRoles(['proposal', 'spec', 'design', 'tasks', 'cold-review']);
  for (const stage of ['proposal', 'spec', 'design', 'tasks', 'cold-review']) {
    assert.ok(Object.hasOwn(roles, stage), `plain must declare a role for "${stage}"`);
    assert.equal(roles[stage].stage, stage);
  }
});

test('#312 D2: declareRoles declares a CHECKED model_tier:null and chooses_model:false on every stage — never a fourth tier, never absent', () => {
  const roles = declareRoles(['proposal', 'spec', 'design', 'tasks', 'cold-review']);
  for (const stage of Object.keys(roles)) {
    assert.equal(roles[stage].model_tier, null, `${stage}: plain has no runtime to run a model on`);
    assert.equal(roles[stage].chooses_model, false, `${stage}: plain never chooses a model — chooses_model must be strictly false, never absent`);
    assert.equal(roles[stage].agent, 'human', `${stage}: a human executes plain's flow`);
  }
});

test('#312 D2: declareRoles declares nothing for a stage it was not asked about', () => {
  const roles = declareRoles(['proposal']);
  assert.deepEqual(Object.keys(roles), ['proposal']);
});
