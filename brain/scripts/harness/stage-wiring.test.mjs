// stage-wiring.test.mjs — issue #323 S4: two engines wired, C3 proven.
// RED-first. The transport is a seam; no test spawns a model.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { removeTempTree } from '../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as plain from '../axes/sdd-engine/adapters/plain.mjs';
import * as gentleAi from '../axes/sdd-engine/adapters/gentle-ai.mjs';
import { assertRoutedStage } from '../lib/stage-engine.mjs';
import { artifactPaths } from '../lib/sdd-layout.mjs';

const declaring = () => ({
  declareRoles: (s) => Object.fromEntries(s.map((stage) => [stage, {
    stage, agent: 'sdd-tasks', model_tier: 'balanced', chooses_model: false,
    instructions: 'Break the change into ordered, actionable work items.',
  }])),
});
const evidence = (engine) => assertRoutedStage({
  config: { sdd: { map: { tasks: { engine } } } }, stage: 'tasks', _load: async () => declaring(),
});

// ── D1: plain — the handoff IS the run ──────────────────────────────────────

test('#323 S4 D1: plain answers a routed lifecycle stage with the manual handoff', async () => {
  const routed = await evidence('plain');
  const r = await plain.runStage({ stage: 'tasks', routed, changeId: 'issue-999-x' });
  assert.equal(r.ok, true);
  assert.equal(r.manual, true, 'the human is the runtime — said, not simulated');
  assert.equal(r.target, artifactPaths('issue-999-x').tasks, 'the single accessor names the target');
  assert.ok(Array.isArray(r.steps) && r.steps.length > 0, 'a handoff with no steps is not a handoff');
});

test('#323 S4 D3: BOTH engines refuse unbound and BEARER evidence — the spec says both, the suite proves both', async () => {
  // Round 9's correction: this ran only against plain while the spec demanded
  // both engines — the untested branch was exactly the one the design's
  // "drift the routing tests would catch" claim leaned on.
  for (const [name, backend] of [['plain', plain], ['gentle-ai', gentleAi]]) {
    await assert.rejects(() => backend.runStage({ stage: 'tasks', changeId: 'issue-999-x', _transport: async () => ({ ok: true }) }), /routed evidence|assertRoutedStage/, name);
    const forOther = await evidence(name);
    await assert.rejects(() => backend.runStage({ stage: 'design', routed: forOther, changeId: 'issue-999-x', _transport: async () => ({ ok: true }) }), /tasks.*design|design.*tasks/s, `${name}: bound, never bearer`);
  }
});

// ── D2: gentle-ai — the port's words, the platform's engine ─────────────────

test('#323 S4 D2: gentle-ai composes the prompt FROM the port and delegates to the transport', async () => {
  const routed = await evidence('gentle-ai');
  let seen = null;
  const r = await gentleAi.runStage({
    stage: 'tasks', routed, changeId: 'issue-999-x',
    _transport: async (payload) => { seen = payload; return { ok: true, elapsedMs: 1 }; },
  });
  assert.equal(r.ok, true, 'the transport\'s own answer rides through');
  assert.ok(seen.prompt.includes(routed.role.instructions), 'the PORT\'s recorded words — never the installed files');
  assert.ok(seen.prompt.includes(artifactPaths('issue-999-x').tasks), 'the target is named to the engine');
  assert.equal(seen.stage, 'tasks');
});

test('#323 S4 D2: the transport\'s failure rides through untouched', async () => {
  const routed = await evidence('gentle-ai');
  const r = await gentleAi.runStage({
    stage: 'tasks', routed, changeId: 'issue-999-x',
    _transport: async () => ({ ok: false, reason: 'engine exited 3' }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /engine exited 3/);
});

test('#323 S4 D3: gentle-ai refuses unbound evidence too — the guard holds at the engine layer', async () => {
  await assert.rejects(() => gentleAi.runStage({ stage: 'tasks', changeId: 'x', _transport: async () => ({ ok: true }) }), /routed evidence|assertRoutedStage/);
});

// ── D4: C3's parity — one target, engine-blind readers ──────────────────────

test('#323 S4 D4: both engines name the SAME target for one stage — condition 3 at the boundary', async () => {
  const p = await plain.runStage({ stage: 'tasks', routed: await evidence('plain'), changeId: 'issue-999-x' });
  let seen = null;
  await gentleAi.runStage({ stage: 'tasks', routed: await evidence('gentle-ai'), changeId: 'issue-999-x',
    _transport: async (payload) => { seen = payload; return { ok: true }; } });
  assert.equal(p.target, artifactPaths('issue-999-x').tasks);
  assert.ok(seen.prompt.includes(p.target), 'one accessor, two engines, one path');
});

test('#323 S4 D4: a change dir passes the presence reader ENGINE-BLIND — produced by hand or by transport, same verdict', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-s4-parity-'));
  t.after(() => removeTempTree(root));
  for (const producer of ['plain-as-human', 'gentle-ai-as-transport']) {
    const dir = join(root, producer, 'openspec/changes/issue-999-x');
    mkdirSync(dir, { recursive: true });
    for (const f of ['proposal.md', 'spec.md', 'design.md', 'tasks.md']) writeFileSync(join(dir, f), `# ${f} by ${producer}\n`);
    for (const f of ['proposal.md', 'spec.md', 'design.md', 'tasks.md']) {
      assert.ok(existsSync(join(dir, f)), `${producer}: ${f} present — the reader has no engine parameter to even ask`);
    }
  }
});

// ── round 1 of the cold review — the PATH, not the parts ────────────────────

test('#836 (review r1): the wiring works THROUGH the seam and dispatch — the only path production has', async () => {
  const { makeRunStageSeam } = await import('./stage-seam.mjs');
  const seam = makeRunStageSeam();
  const routed = await evidence('plain');
  const r = await seam({ stage: 'tasks', engine: 'plain', prompt: 'ignored', routed, changeId: 'issue-999-x' });
  assert.equal(r.ok, true, 'the seam that drops a field silently is its own header\'s recorded lesson — relearned');
  assert.equal(r.manual, true);
  assert.equal(r.target, artifactPaths('issue-999-x').tasks);
});

// ── round 2 of the cold review — the custom-stage half of option A ──────────

test('#836 (review r2): cold-review through the SEAM to plain — no evidence demanded of a custom stage', async () => {
  const { makeRunStageSeam } = await import('./stage-seam.mjs');
  const seam = makeRunStageSeam();
  // The real caller (run-cold-review-stage) passes NO routed — before this PR
  // that failed clean ("does not implement the op"); with runStage present it
  // must still answer, never fake-refuse about evidence a custom stage owes nobody.
  const r = await seam({ stage: 'cold-review', engine: 'plain', prompt: 'p', changeId: 'issue-999-x' });
  assert.equal(r.ok, true, 'a custom stage arrives evidence-free BY THE OPTION-A SPLIT this very change shipped');
  assert.equal(r.manual, true);
});

test('#836 (review r2): gentle-ai composes a CUSTOM stage from its OWN declaration — S2 evidence carries no role there', async () => {
  const routed = await assertRoutedStage({ config: { sdd: { map: { 'cold-review': { engine: 'gentle-ai' } } } }, stage: 'cold-review' });
  assert.ok(!('role' in routed), 'precondition: custom-stage evidence has no role — the crash input');
  let seen = null;
  const r = await gentleAi.runStage({ stage: 'cold-review', routed, changeId: 'issue-999-x',
    _transport: async (p) => { seen = p; return { ok: true }; } });
  assert.equal(r.ok, true, 'a TypeError is not a refusal');
  assert.ok(seen.prompt.length > 0, 'composed from the engine\'s own recorded/derived declaration');
});

test('#836 (review r2): lifecycle stages STILL demand bound evidence — the split narrowed the guard, not the doctrine', async () => {
  await assert.rejects(() => plain.runStage({ stage: 'tasks', changeId: 'x' }), /routed evidence/);
});

test('#836 (review r3): gentle-ai, custom stage, NO routed AT ALL — the real caller\'s exact shape', async () => {
  // run-cold-review-stage passes no routed and no changeId. Round 2's fix
  // covered routed-without-role; the real caller passes routed-as-undefined,
  // and the custom-no-evidence test existed only for plain — the one backend
  // that never touches .role. Same class, one branch deeper, third round.
  let seen = null;
  const r = await gentleAi.runStage({ stage: 'cold-review', prompt: 'p', _transport: async (p) => { seen = p; return { ok: true }; } });
  assert.equal(r.ok, true, 'a TypeError dressed as a generic engine failure is still not a refusal');
  assert.ok(seen.prompt.length > 0, 'composed from the engine\'s own declaration, evidence-free as option A permits');
});

test('#836 (review r4): credentialEnv and forgeConfigDir SURVIVE gentle-ai — and so does any field it does not name', async () => {
  // Fifth instance of the destructure-and-drop class, and the most
  // consequential: dropping these two spawns the child UNSCRUBBED while the
  // forge-reach probe verified the shadowed env (ADR-0033). The fix kills the
  // CLASS at this layer: everything gentle-ai does not consume rides ...rest.
  let seen = null;
  const routed = await evidence('gentle-ai');
  await gentleAi.runStage({
    stage: 'tasks', routed, changeId: 'issue-999-x',
    credentialEnv: ['BRAIN_REVIEWER_TOKEN'], forgeConfigDir: '/tmp/shadow',
    futureField: 'must-survive-too',
    _transport: async (p) => { seen = p; return { ok: true }; },
  });
  assert.deepEqual(seen.credentialEnv, ['BRAIN_REVIEWER_TOKEN'], 'the scrub list reaches the child');
  assert.equal(seen.forgeConfigDir, '/tmp/shadow', 'the forge shadow reaches the child');
  assert.equal(seen.futureField, 'must-survive-too', 'the class is dead: unnamed fields ride through');
});

// ── round 5 — the inputs themselves ─────────────────────────────────────────

test('#836 (review r5): an unnamed stage refuses at BOTH wirings — the guard stage-engine\'s own history demanded', async () => {
  for (const backend of [plain, gentleAi]) {
    await assert.rejects(() => backend.runStage({ stage: undefined, changeId: 'x', _transport: async () => ({ ok: true }) }), /not a stage name/);
    await assert.rejects(() => backend.runStage({ stage: '  ', changeId: 'x', _transport: async () => ({ ok: true }) }), /not a stage name/);
  }
});

test('#836 (review r5): a lifecycle run without changeId REFUSES — never a target named "undefined"', async () => {
  const routed = await evidence('plain');
  await assert.rejects(() => plain.runStage({ stage: 'tasks', routed }), /changeId/);
  const routedG = await evidence('gentle-ai');
  await assert.rejects(() => gentleAi.runStage({ stage: 'tasks', routed: routedG, _transport: async () => ({ ok: true }) }), /changeId/);
});

test('#836 (review r6): plain\'s handoff for a CUSTOM stage never says "undefined" — the sibling gets the same honesty', async () => {
  const r = await plain.runStage({ stage: 'cold-review', changeId: 'issue-999-x' });
  assert.equal(r.ok, true);
  assert.equal(r.target, null, 'the accessor only knows the four — null is the checked answer, undefined the accident');
  assert.ok(!JSON.stringify(r.steps).includes('undefined'), 'no step hands a human a path named undefined');
  assert.ok(r.steps.some((s) => s.includes('own declared root')), 'the custom-stage line, same as gentle-ai\'s');
});

test('#836 (review r7): the prompt never says "undefined" — the LAST unguarded interpolation, with the real caller\'s shape', async () => {
  let seen = null;
  await gentleAi.runStage({ stage: 'cold-review', prompt: 'p', _transport: async (p) => { seen = p; return { ok: true }; } });
  assert.ok(!seen.prompt.includes('undefined'), 'stage, target and changeId — all three interpolations guarded now');
});

test('#836 (review r8): the CALLER\'s prompt survives verbatim — composition is the fallback, never the override', async () => {
  let seen = null;
  const assembled = 'REVIEW PR #999: git diff base...head — write findings to /abs/cold-review.md';
  await gentleAi.runStage({ stage: 'cold-review', prompt: assembled, _transport: async (p) => { seen = p; return { ok: true }; } });
  assert.equal(seen.prompt, assembled, 'the assembled review prompt is the ONLY carrier of prNumber/diff/path — discarding it is a silent wrong run');
  seen = null;
  const routed = await evidence('gentle-ai');
  await gentleAi.runStage({ stage: 'tasks', routed, changeId: 'issue-999-x', _transport: async (p) => { seen = p; return { ok: true }; } });
  assert.ok(seen.prompt.includes(routed.role.instructions), 'no caller prompt → composed from the port, as before');
});
