// roles.contract.test.mjs — the shared, parameterized CONTRACT suite for the
// role port (issue #312 slice A, design D2, D7; spec "The parity suite names
// what it cannot yet measure"). ONE assertion set, run over an inhabitant map
// — parity means the SAME test body applies to every entry, not two divergent
// files that can silently drift apart. Mirrors
// `axes/vcs/contract.test.mjs`'s shape exactly, including its
// `assertProvenance` helper (reproduced here, not imported — that file does
// not export it, and it is small enough that importing across a directory
// boundary for one helper would be its own coupling to justify).
//
// n=2 IS MEASURED here since #814: `INHABITANTS` holds `plain` and `gentle-ai`
// — the two SDD_ENGINE frameworks (D6 vocabulary), the pairing Compuerta 3
// ruled. The parity-debt header and its TRIPWIRE test died on 2026-09-02 the
// way they demanded to: the tripwire FAILED on a real second entry and was
// deleted per its own instructions. The three recorded debts of that class are
// ALL retired now: cold-review-prompt.mjs's ROLE_DEBT_TICKET by #814 D5, and
// resolve-challenger.mjs's binding header by #576 D4 — the ledger closes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveStageSet } from '../../lib/sdd-layout.mjs';
import { ROLE_TIERS, resolveRoles } from './role-port.mjs';
import * as plain from './adapters/plain.mjs';
import * as gentleAi from './adapters/gentle-ai.mjs';

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

const INHABITANTS = { plain: { module: plain }, 'gentle-ai': { module: gentleAi } };

const FIXTURE = JSON.parse(readFileSync(new URL('./fixtures/stage-set-custom.json', import.meta.url)));
assertProvenance(FIXTURE, 'stage-set-custom.json');
const STAGES = resolveStageSet(FIXTURE).stages;   // ← RESOLVED, never enumerated

test('roles.contract: the fixture resolves five stages — the four lifecycle plus one custom', () => {
  assert.deepEqual([...STAGES].sort(), ['cold-review', 'design', 'proposal', 'spec', 'tasks']);
});

for (const name of Object.keys(INHABITANTS)) {
  const { module } = INHABITANTS[name];

  test(`${name}.declareRoles (contract): every resolved stage is answered, including the custom one`, () => {
    const roles = resolveRoles({ config: FIXTURE, engine: name, inhabitant: module });
    assert.deepEqual([...Object.keys(roles)].sort(), [...STAGES].sort());
  });

  test(`${name}.declareRoles (contract): model_tier is always a ROLE_TIERS member or null — never a concrete id`, () => {
    const roles = resolveRoles({ config: FIXTURE, engine: name, inhabitant: module });
    for (const stage of STAGES) {
      const tier = roles[stage].model_tier;
      assert.ok(tier === null || ROLE_TIERS.includes(tier), `${stage}: model_tier "${tier}" must be null or one of ${ROLE_TIERS.join(', ')}`);
    }
  });

  test(`${name}.declareRoles (contract): chooses_model is strictly boolean on every stage`, () => {
    const roles = resolveRoles({ config: FIXTURE, engine: name, inhabitant: module });
    for (const stage of STAGES) {
      assert.equal(typeof roles[stage].chooses_model, 'boolean', `${stage}: chooses_model must be a strict boolean`);
    }
  });

  test(`${name}.declareRoles (contract): a custom stage is covered by the SAME assertions as a lifecycle stage`, () => {
    const roles = resolveRoles({ config: FIXTURE, engine: name, inhabitant: module });
    assert.ok(Object.hasOwn(roles, 'cold-review'), 'the custom stage must be answered, not skipped');
    assert.deepEqual(Object.keys(roles['cold-review']).sort(), Object.keys(roles.proposal).sort(),
      'the custom stage\'s role must carry the exact same shape as a lifecycle stage\'s');
  });
}

// ── plain-specific: model_tier null on all five, selection path 'no-agent' ──

test('plain: model_tier is null on all five stages including the custom one — "checked null", not a fourth tier', () => {
  const roles = resolveRoles({ config: FIXTURE, engine: 'plain', inhabitant: plain });
  for (const stage of STAGES) {
    assert.equal(roles[stage].model_tier, null, `${stage}: plain declares checked null`);
  }
});

test('plain: selection path is "no-agent" with model:null on every stage — the third path, not brain-fixes', () => {
  const roles = resolveRoles({ config: FIXTURE, engine: 'plain', inhabitant: plain });
  for (const stage of STAGES) {
    assert.equal(roles[stage].selection.path, 'no-agent', `${stage}: plain never runs an agent`);
    assert.equal(roles[stage].selection.model, null, `${stage}: no model is ever fixed for plain`);
  }
});

// ── Abstraction is asserted by MEMBERSHIP, never a denylist of model aliases ─
// A denylist would be the catalogue #323 ruled brain must not hold
// (stage-engine.mjs:16-23), and model ids change monthly — a contract built on
// one would go stale on someone else's release schedule.

test('roles.contract: a synthetic entry declaring a concrete model_tier is refused, naming the field — not by a denylist', () => {
  const leaky = {
    declareRoles(stages) {
      return Object.fromEntries(stages.map((stage) => [stage, {
        stage, agent: 'synthetic', model_tier: 'gpt-5-nonexistent', chooses_model: false,
      }]));
    },
  };
  assert.throws(
    () => resolveRoles({ config: FIXTURE, engine: 'leaky', inhabitant: leaky }),
    (err) => {
      assert.match(err.message, /model_tier/);
      assert.match(err.message, /gpt-5-nonexistent/, 'the leaking value itself must be named');
      return true;
    },
  );
});

test('roles.contract: a synthetic module with no declareRoles is refused', () => {
  assert.throws(
    () => resolveRoles({ config: FIXTURE, engine: 'seamless', inhabitant: { notDeclareRoles() {} } }),
    /declareRoles/,
  );
});

