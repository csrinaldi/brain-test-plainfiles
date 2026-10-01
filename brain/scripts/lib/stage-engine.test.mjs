// stage-engine.test.mjs — issue #682 slice B / #323's router, first inhabitant.
//
// The axis: WHICH OF THREE STATES a caller ends up in. Unrouted, routed, and
// routed-but-unreadable are different facts, and the middle one is the only one
// that produces an engine. Collapsing "unrouted" into "unreadable" would put
// every repo that never configured a stage into a refusal; collapsing
// "unreadable" into "unrouted" would silently ignore a key an operator wrote.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveStageEngine, COLD_REVIEW_STAGE, assertRoutableStage, SDD_LIFECYCLE_STAGES,
} from './stage-engine.mjs';
import { migrations } from '../../core/config-migrations.mjs';

const routed = (entry) => ({ sdd: { map: { [COLD_REVIEW_STAGE]: entry } } });

test('#323: an unrouted stage is null — not an error, and not a default engine', () => {
  for (const config of [undefined, null, {}, { sdd: {} }, { sdd: { map: {} } }, { sdd: { map: { other: { engine: 'x' } } } }]) {
    assert.equal(resolveStageEngine(config, COLD_REVIEW_STAGE), null,
      `${JSON.stringify(config)} must resolve to null — a repo that routed nothing misconfigured nothing`);
  }
});

test('#323: a routed stage yields its engine, and the model rides opaque', () => {
  assert.deepEqual(resolveStageEngine(routed({ engine: 'claude', model: 'some-model-id' }), COLD_REVIEW_STAGE),
    { engine: 'claude', model: 'some-model-id' });
  assert.deepEqual(resolveStageEngine(routed({ engine: 'gentle-ai' }), COLD_REVIEW_STAGE),
    { engine: 'gentle-ai', model: null }, 'an absent model is null, never a guess');
});

test('#323: the model is NEVER interpreted — any string passes through unchanged', () => {
  // The pin on the ruling. A resolver that validated ids against a catalogue
  // would have to be edited every time a vendor ships one, and would refuse a
  // model that exists simply because brain had not heard of it.
  for (const model of ['a', 'vendor/model:2026-08', 'x'.repeat(200), 'not-a-real-model']) {
    assert.equal(resolveStageEngine(routed({ engine: 'e', model }), COLD_REVIEW_STAGE).model, model);
  }
});

test('#323: a routed-but-unreadable entry REFUSES — an operator who wrote the key asked for something', () => {
  const bad = [
    ['no engine', {}],
    ['an empty engine', { engine: '' }],
    ['a whitespace engine', { engine: '   ' }],
    ['a non-string engine', { engine: 7 }],
    ['an array', ['claude']],
    ['a bare string', 'claude'],
    ['a non-string model', { engine: 'claude', model: 7 }],
  ];
  for (const [label, entry] of bad) {
    assert.throws(() => resolveStageEngine(routed(entry), COLD_REVIEW_STAGE), /stage-engine:/,
      `${label} must refuse rather than resolve to null — silence would ignore a key someone wrote`);
  }
  assert.throws(() => resolveStageEngine({ sdd: { map: [] } }, COLD_REVIEW_STAGE), /must be an object/);
});

test('#682 S3: "unrouted" and "unreadable" are DISTINGUISHABLE, on every shape', () => {
  // The complement of the two tests above, stated as the property rather than
  // left to be inferred from them: null is reachable only by absence, and a
  // present-but-broken entry can never produce it.
  assert.equal(resolveStageEngine({ sdd: { map: {} } }, COLD_REVIEW_STAGE), null);
  for (const entry of [{}, { engine: '' }, { engine: 7 }, 'claude', []]) {
    let outcome;
    try { outcome = resolveStageEngine(routed(entry), COLD_REVIEW_STAGE); } catch { outcome = 'threw'; }
    assert.equal(outcome, 'threw',
      `${JSON.stringify(entry)} resolved instead of refusing — a broken route read as "no route"`);
  }
});

test('#682 S3: the stage name is required — an empty one is not a lookup', () => {
  for (const stage of [undefined, null, '', 0]) {
    assert.throws(() => resolveStageEngine(routed({ engine: 'e' }), stage), /a stage name is required/);
  }
});

test('#323: sdd.map ships EMPTY — a default entry would spawn an engine nobody asked for', () => {
  const entry = migrations.find((m) => m.version === '0.10.0');
  assert.ok(entry, 'the migration must exist — sdd.map is new schema surface');
  assert.deepEqual(entry.defaults.sdd.map, {},
    'shipping a routed cold-review would turn a spawn on for every consumer on upgrade');

  // Monotonic-forever, per this file's own doctrine note: a reused version names
  // two indistinguishable states.
  const versions = migrations.map((m) => m.version);
  assert.equal(new Set(versions).size, versions.length, 'no version may be reused');
});

// ── A non-stage is not "a stage outside the lifecycle" (#682, cold-5's tail) ──
//
// Found while measuring judgment:cold-5, not reported by it. The comment above
// `VALID_OPS` calls this guard the executable form of ADR-0019's boundary —
// "refuses that case in code rather than promising it in a comment" — and it
// compared only against the lifecycle list, so `undefined` was simply "not a
// lifecycle stage" and passed. That is what let `runStage('cold-review', p)`
// get past the one check that should have stopped it: destructuring a string
// left `stage` undefined, this waved it through, and the refusal that finally
// came was the prompt check reporting `stage "undefined"` — a true message
// about the wrong problem.

test('#682 cold-5: assertRoutableStage REFUSES a non-stage, not just a lifecycle one', () => {
  for (const notAStage of [undefined, null, '', '   ', 42, {}, []]) {
    assert.throws(
      () => assertRoutableStage(notAStage),
      /is not a stage name/,
      `${JSON.stringify(notAStage)} passed — a caller that lost its argument reads as routable`
    );
  }
});

test('#682 cold-5: a real routable stage still passes, and a lifecycle stage still refuses', () => {
  assert.doesNotThrow(() => assertRoutableStage(COLD_REVIEW_STAGE));
  for (const stage of SDD_LIFECYCLE_STAGES) {
    assert.throws(() => assertRoutableStage(stage), /without routed evidence/,
      'the refusal SURVIVES as a demand for evidence (#323 S2, condition 4: replaced, not removed)');
  }
});
