// role-port.test.mjs — issue #312, Unit 2 (design D1-D5, D7). `resolveRoles`
// is PURE apart from the `inhabitant` module handed to it: every test below
// constructs a synthetic inhabitant rather than importing a real backend, so
// the port's own refusals are measured against cases a real backend cannot
// yet produce (a missing `declareRoles`, a per-stage omission, a concrete
// model id) — exactly the seam-absence discipline `agent-runtime.test.mjs`
// established for `AGENT_RUNTIME`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ROLE_TIERS, resolveRoles, resolveModelSelection, loadInhabitant } from './role-port.mjs';

const LIFECYCLE_STAGES = ['proposal', 'spec', 'design', 'tasks'];

/** A well-formed synthetic inhabitant: every resolved stage answered, checked values. */
function fakeInhabitant(overrides = {}) {
  return {
    declareRoles(stages) {
      const roles = Object.fromEntries(stages.map((stage) => [stage, {
        stage, agent: 'human', model_tier: null, chooses_model: false, instructions: null,
      }]));
      return { ...roles, ...overrides };
    },
  };
}

// ── Seam absence — enforced at the module level ─────────────────────────────

test('#312 D2: an inhabitant exporting no declareRoles is refused, not read as "nothing to run"', () => {
  assert.throws(
    () => resolveRoles({ config: {}, engine: 'synthetic', inhabitant: { someOtherExport() {} } }),
    (err) => {
      assert.match(err.message, /synthetic/);
      assert.match(err.message, /declareRoles/);
      return true;
    },
  );
});

test('#312 D2: an inhabitant module of undefined is refused the same way', () => {
  assert.throws(
    () => resolveRoles({ config: {}, engine: 'synthetic', inhabitant: undefined }),
    /declareRoles/,
  );
});

// ── Seam absence — enforced per stage ───────────────────────────────────────

test('#312 D2: a per-stage omission throws NAMING THE STAGE — it must never be read as disabled', () => {
  const inhabitant = {
    declareRoles(stages) {
      const roles = Object.fromEntries(stages.map((stage) => [stage, {
        stage, agent: 'human', model_tier: null, chooses_model: false, instructions: null,
      }]));
      delete roles.design; // omit one stage entirely
      return roles;
    },
  };

  assert.throws(
    () => resolveRoles({ config: {}, engine: 'synthetic', inhabitant }),
    (err) => {
      assert.match(err.message, /"design"/, 'the omitted stage must be named');
      // The message may use the word "disabled" only to NEGATE it explicitly
      // (agent-runtime.mjs's seam-missing wording does the same) — it must
      // never assert the stage IS disabled without that negation.
      assert.match(err.message, /not.*disabled/i, 'omission must be worded as a refusal, never a bare claim of "disabled"');
      return true;
    },
  );
});

// ── model_tier: abstract only, `plain`'s null is checked, not a fourth tier ─

test('#312 D2/spec: a concrete model_tier id is refused, naming the field', () => {
  const inhabitant = fakeInhabitant({ proposal: { stage: 'proposal', agent: 'x', model_tier: 'sonnet', chooses_model: false } });
  assert.throws(
    () => resolveRoles({ config: {}, engine: 'synthetic', inhabitant }),
    (err) => {
      assert.match(err.message, /model_tier/);
      assert.match(err.message, /sonnet/);
      return true;
    },
  );
});

test('#312 D2: every declared ROLE_TIERS member is accepted; null is accepted; nothing else is', () => {
  for (const tier of [...ROLE_TIERS, null]) {
    const inhabitant = fakeInhabitant({ proposal: { stage: 'proposal', agent: 'x', model_tier: tier, chooses_model: false, instructions: null } });
    assert.doesNotThrow(() => resolveRoles({ config: {}, engine: 'synthetic', inhabitant }));
  }
});

// ── chooses_model: strictly boolean, never absent ───────────────────────────

test('#312 D4: a missing chooses_model declaration is refused, the same reasoning as AGENT_RUNTIME `?? null`', () => {
  const inhabitant = fakeInhabitant({ proposal: { stage: 'proposal', agent: 'x', model_tier: null, chooses_model: undefined } });
  assert.throws(
    () => resolveRoles({ config: {}, engine: 'synthetic', inhabitant }),
    /chooses_model/,
  );
});

// ── D7 trap oracle: `proposal` must be answered, not refused through assertRoutableStage ─

test('#312 D7: resolveRoles answers for "proposal" — the trap an assertRoutableStage-through-validation would fall into', () => {
  const inhabitant = fakeInhabitant();
  const roles = resolveRoles({ config: {}, engine: 'synthetic', inhabitant });
  assert.ok(Object.hasOwn(roles, 'proposal'), 'proposal is one of the four lifecycle stages the port must answer for');
  assert.equal(roles.proposal.stage, 'proposal');
});

test('#312: resolveRoles answers every resolved lifecycle stage with the full ResolvedRole shape', () => {
  const inhabitant = fakeInhabitant();
  const roles = resolveRoles({ config: {}, engine: 'synthetic', inhabitant });
  for (const stage of LIFECYCLE_STAGES) {
    const role = roles[stage];
    assert.equal(role.state, 'enabled');
    assert.equal(role.reason, null);
    assert.equal(role.selection.path, 'no-agent', 'plain-shaped fake declares model_tier: null everywhere');
  }
});

// ── sdd.configs integration: agent override, disable ────────────────────────

test('#312 D3 integration: sdd.configs.agent wins over the inhabitant\'s declared default', () => {
  const inhabitant = fakeInhabitant();
  const roles = resolveRoles({
    config: { sdd: { configs: { proposal: { agent: 'cold-reviewer' } } } },
    engine: 'synthetic',
    inhabitant,
  });
  assert.equal(roles.proposal.agent, 'cold-reviewer');
  assert.equal(roles.spec.agent, 'human', 'an unconfigured stage keeps the inhabitant\'s declared agent');
});

test('#312 D5 integration: sdd.configs.enabled=false resolves state:disabled with a named reason', () => {
  const inhabitant = fakeInhabitant();
  const roles = resolveRoles({
    config: { sdd: { configs: { spec: { enabled: false } } } },
    engine: 'synthetic',
    inhabitant,
  });
  assert.equal(roles.spec.state, 'disabled');
  assert.match(roles.spec.reason, /sdd\.configs\["spec"\]\.enabled = false/);
  assert.equal(roles.proposal.state, 'enabled');
  assert.equal(roles.proposal.reason, null);
});

// ── resolveModelSelection: the three-path dispatch, in isolation ───────────

test('#312 D4: dispatch order — model_tier===null wins even when chooses_model is true', () => {
  // The whole point: capability-first would send this down engine-chooses and
  // report a tier that will never run an agent. model_tier===null must win.
  const selection = resolveModelSelection({
    engine: 'synthetic', stage: 'proposal',
    role: { model_tier: null, chooses_model: true },
    routed: { model: 'should-never-appear' },
  });
  assert.equal(selection.path, 'no-agent');
  assert.equal(selection.tier, null);
  assert.equal(selection.model, null);
  assert.doesNotMatch(selection.note, /should-never-appear/);
});

test('#312 D4: chooses_model:true with a declared tier takes the engine-chooses path; brain fixes no id', () => {
  const selection = resolveModelSelection({
    engine: 'synthetic', stage: 'proposal',
    role: { model_tier: 'deep', chooses_model: true },
    routed: { model: 'ignored-id' },
  });
  assert.equal(selection.path, 'engine-chooses');
  assert.equal(selection.tier, 'deep');
  assert.equal(selection.model, null, 'brain must not fix an id when the engine chooses its own');
});

test('#312 D4: chooses_model:false with a declared tier takes brain-fixes, using the routed model', () => {
  const selection = resolveModelSelection({
    engine: 'synthetic', stage: 'proposal',
    role: { model_tier: 'balanced', chooses_model: false },
    routed: { model: 'vendor/model-x' },
  });
  assert.equal(selection.path, 'brain-fixes');
  assert.equal(selection.tier, 'balanced');
  assert.equal(selection.model, 'vendor/model-x');
});

test('#312 D4: brain-fixes with no routed entry still answers, with model:null', () => {
  const selection = resolveModelSelection({
    engine: 'synthetic', stage: 'proposal',
    role: { model_tier: 'balanced', chooses_model: false },
    routed: null,
  });
  assert.equal(selection.path, 'brain-fixes');
  assert.equal(selection.model, null);
});

test('#312 D4: the no-agent note states plainly that no id was read and none was delegated', () => {
  const selection = resolveModelSelection({
    engine: 'plain', stage: 'proposal',
    role: { model_tier: null, chooses_model: false },
    routed: null,
  });
  assert.match(selection.note, /no id was read/i);
  assert.match(selection.note, /plain/);
  assert.match(selection.note, /proposal/);
});

// ── loadInhabitant: one injectable seam ─────────────────────────────────────

test('#312 D1: loadInhabitant defaults to importing axes/<axis>/adapters/<engine>.mjs', async () => {
  const mod = await loadInhabitant('plain');
  assert.equal(typeof mod, 'object');
});

test('#312 D1: loadInhabitant routes engine name through the injected loader, unresolved', async () => {
  let seenEngine = null;
  const fakeModule = { declareRoles: () => ({}) };
  const mod = await loadInhabitant('some-engine', { _load: async (engine) => { seenEngine = engine; return fakeModule; } });
  assert.equal(seenEngine, 'some-engine');
  assert.equal(mod, fakeModule);
});

// ── #814 T3: `instructions` — a checked field, never an unread one ──────────

test('#814 T3: a role with NO instructions key is refused naming the stage and the field', () => {
  const role = { stage: 'proposal', agent: 'x', model_tier: null, chooses_model: false };
  delete role.instructions; // explicit: the ABSENCE is the case, not an undefined value
  const inhabitant = fakeInhabitant({ proposal: role });
  assert.throws(
    () => resolveRoles({ config: {}, engine: 'synthetic', inhabitant }),
    (err) => {
      assert.match(err.message, /instructions/);
      assert.match(err.message, /proposal/);
      return true;
    },
  );
});

test('#814 T3: instructions: null is a CHECKED value — the no-prompt state, resolved and reported as null', () => {
  const inhabitant = fakeInhabitant({ proposal: { stage: 'proposal', agent: 'x', model_tier: null, chooses_model: false, instructions: null } });
  const roles = resolveRoles({ config: {}, engine: 'synthetic', inhabitant });
  assert.equal(roles.proposal.instructions, null);
});

test('#814 T3: a non-empty string travels to the resolved role VERBATIM', () => {
  const text = 'You are the proposer. Read the exploration; write intent, scope, non-goals.';
  const inhabitant = fakeInhabitant({ proposal: { stage: 'proposal', agent: 'x', model_tier: 'balanced', chooses_model: false, instructions: text } });
  const roles = resolveRoles({ config: {}, engine: 'synthetic', inhabitant });
  assert.equal(roles.proposal.instructions, text);
});

test('#814 T3: an EMPTY string is refused — "no prompt" is null, never a prompt with nothing in it', () => {
  const inhabitant = fakeInhabitant({ proposal: { stage: 'proposal', agent: 'x', model_tier: null, chooses_model: false, instructions: '' } });
  assert.throws(() => resolveRoles({ config: {}, engine: 'synthetic', inhabitant }), /instructions/);
});

test('#814 T3: a non-string, non-null value is refused', () => {
  const inhabitant = fakeInhabitant({ proposal: { stage: 'proposal', agent: 'x', model_tier: null, chooses_model: false, instructions: 42 } });
  assert.throws(() => resolveRoles({ config: {}, engine: 'synthetic', inhabitant }), /instructions/);
});

test('#814 (round 2): `derived` SURVIVES the port as a strict boolean — the laundering was the defect', () => {
  // Cold review round 2 on PR2, correction — verified: declareRoles carried
  // derived:true and resolveRoles dropped it, so the first real caller would
  // read a guessed role exactly as if it were the recorded one. Every
  // resolved role now states it, false included: an always-present boolean
  // keeps the shape identical across stages while the VALUE tells the truth.
  const inhabitant = {
    declareRoles: (stages) => Object.fromEntries(stages.map((stage) => [stage, {
      stage, agent: 'x', model_tier: 'balanced', chooses_model: false, instructions: 'do it',
      ...(stage === 'proposal' ? {} : { derived: true }),
    }])),
  };
  const roles = resolveRoles({ config: {}, engine: 'synthetic', inhabitant });
  assert.equal(roles.proposal.derived, false, 'recorded → strict false, never absent');
  assert.equal(roles.spec.derived, true, 'guessed → strict true, carried through');
});
