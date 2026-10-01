// stage-engine.routing.test.mjs — issue #323 S2: ADR-0019 Amendment 1's
// condition 4 executed. RED-first; the #812 field config is pinned before a
// single behavior changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveStageEngine, assertRoutedStage, assertRoutableStage } from './stage-engine.mjs';

const FIELD_CONFIG = Object.freeze({ // the one live sdd.map in the wild (#812)
  // NO sdd.stages on purpose: the real field config declares nothing there —
  // cold-review is CODE-declared (COLD_REVIEW_STAGE, ADR-0033). The first cut
  // of this pin gave the fixture a declaration reality does not have, and the
  // full suite caught the lie with 47 failures.
  sdd: { map: { 'cold-review': { engine: 'claude', model: 'sonnet' } } },
});

const declaring = (stages) => ({
  declareRoles: (s) => Object.fromEntries(s.map((stage) => [stage, {
    stage, agent: 'a', model_tier: 'balanced', chooses_model: false, instructions: 'x',
  }])),
});

// ── 1.1 the field config, pinned FIRST ──────────────────────────────────────

test('#323 S2 1.1: the #812 field config keeps breathing — custom stage, transport name, byte-for-byte', async () => {
  const routing = resolveStageEngine(FIELD_CONFIG, 'cold-review');
  assert.deepEqual(routing, { engine: 'claude', model: 'sonnet' });
  const checked = await assertRoutedStage({ config: FIELD_CONFIG, stage: 'cold-review' });
  assert.equal(checked.routed, true);
  assert.deepEqual(checked.routing, routing, 'option A: a custom stage may name a transport — the split is #833\'s debt');
});

// ── D3: undeclared refuses everywhere ───────────────────────────────────────

test('#323 S2 D3: an sdd.map entry for an UNDECLARED stage refuses, naming both sets', () => {
  const cfg = { sdd: { map: { 'cold-reviw': { engine: 'plain' } } } };
  assert.throws(() => resolveStageEngine(cfg, 'cold-reviw'), (err) => {
    assert.match(err.message, /cold-reviw/);
    assert.match(err.message, /sdd\.stages/);
    return true;
  });
});

// ── C1 pin: nothing path-shaped in a value ──────────────────────────────────

test('#323 S2 C1: a value carrying extra keys or a slash refuses citing condition 1', () => {
  // model stays OPAQUE (the 05/08 ruling — 'vendor/model:2026-08' is a legal id);
  // the slash rule is the ENGINE's only.
  for (const entry of [{ engine: 'plain', layout: 'x' }, { engine: 'plain', root: 'y' }, { engine: 'a/b' }]) {
    const cfg = { sdd: { map: { tasks: entry } } };
    assert.throws(() => resolveStageEngine(cfg, 'tasks'), /condition 1|path-shaped|layout/i, JSON.stringify(entry));
  }
});

// ── D1/D2: the lifecycle check through the port ─────────────────────────────

test('#323 S2: a lifecycle stage routes to a DECLARING engine — and the role is C3\'s hook', async () => {
  const cfg = { sdd: { map: { tasks: { engine: 'gentle-ai' } } } };
  const r = await assertRoutedStage({ config: cfg, stage: 'tasks', _load: async () => declaring() });
  assert.equal(r.routed, true);
  assert.equal(r.role.stage, 'tasks', 'what was routed is exposed so S4\'s parity suite can compare');
});

test('#323 S2: a lifecycle stage routed to a PLATFORM refuses citing D6 and #833', async () => {
  const cfg = { sdd: { map: { tasks: { engine: 'claude' } } } };
  await assert.rejects(() => assertRoutedStage({ config: cfg, stage: 'tasks' }), (err) => {
    assert.match(err.message, /platform|declare/i);
    assert.match(err.message, /#833/);
    return true;
  });
});

test('#323 S2: a non-declaring or disabled engine refuses with the PORT\'s own words', async () => {
  const cfg = { sdd: { map: { tasks: { engine: 'plain' } } } };
  await assert.rejects(
    () => assertRoutedStage({ config: cfg, stage: 'tasks', _load: async () => ({ notDeclareRoles: true }) }),
    /declareRoles/,
  );
  const disabled = { sdd: { configs: { tasks: { enabled: false } }, map: { tasks: { engine: 'plain' } } } };
  await assert.rejects(() => assertRoutedStage({ config: disabled, stage: 'tasks' }), /disabled/);
});

test('#323 S2: unrouted passes through — not an error, exactly as one layer down', async () => {
  const r = await assertRoutedStage({ config: {}, stage: 'tasks' });
  assert.deepEqual(r, { routed: false, stage: 'tasks' }, 'even the unrouted answer names its stage — one shape, every arm');
});

// ── T3: the refusal is REPLACED — a demand for evidence ─────────────────────

test('#323 S2 T3: a lifecycle stage without routed evidence still throws — naming the skipped step', () => {
  assert.throws(() => assertRoutableStage('tasks'), /assertRoutedStage/);
});

test('#323 S2 T3: WITH the evidence, the lifecycle stage passes the transport guard', async () => {
  const cfg = { sdd: { map: { tasks: { engine: 'gentle-ai' } } } };
  const routed = await assertRoutedStage({ config: cfg, stage: 'tasks', _load: async () => declaring() });
  assert.doesNotThrow(() => assertRoutableStage('tasks', { routed }));
});

test('#323 S2 T3: custom stages are untouched — today\'s callers keep working', () => {
  assert.doesNotThrow(() => assertRoutableStage('cold-review'));
  assert.throws(() => assertRoutableStage(''), /not a stage name/);
});

// ── round 1 of the cold review — evidence is BOUND, not bearer ──────────────

test('#834 (review r1): evidence computed for one stage does not admit another — the check proves conditions FOR THIS stage', async () => {
  const cfg = { sdd: { map: { tasks: { engine: 'gentle-ai' } } } };
  const forTasks = await assertRoutedStage({ config: cfg, stage: 'tasks', _load: async () => declaring() });
  assert.equal(forTasks.stage, 'tasks', 'the evidence NAMES the stage it was computed for');
  assert.throws(() => assertRoutableStage('design', { routed: forTasks }), (err) => {
    assert.match(err.message, /design/); assert.match(err.message, /tasks/);
    return true;
  }, 'bearer evidence is the copy-paste bug condition 4 exists to make impossible');
  assert.doesNotThrow(() => assertRoutableStage('tasks', { routed: forTasks }));
});
