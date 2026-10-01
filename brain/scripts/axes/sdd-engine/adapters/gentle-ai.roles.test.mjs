// gentle-ai.roles.test.mjs — issue #814 T2: the adapter is RECORDED DATA, and
// these tests run with NO tool installed. Nothing here reads ~/.claude — the
// declaration is brain's own, which is the whole point of the ticket: an
// engine legible on any machine, in brain's vocabulary, not the tool's.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { declareRoles } from './gentle-ai.mjs';
import { GENTLE_AI_ROLES } from './gentle-ai.roles.mjs';
import { ROLE_TIERS, resolveRoles } from '../role-port.mjs';
import * as gentleAi from './gentle-ai.mjs';

const LIFECYCLE = ['proposal', 'spec', 'design', 'tasks'];

test('#814 T2: every lifecycle stage is answered with recorded, checked values', () => {
  const roles = declareRoles(LIFECYCLE);
  for (const stage of LIFECYCLE) {
    const r = roles[stage];
    assert.ok(r, `${stage} must be answered`);
    assert.ok(ROLE_TIERS.includes(r.model_tier), `${stage}: tier "${r.model_tier}" must be abstract — never a vendor id`);
    assert.equal(r.chooses_model, false, `${stage}: D4 — brain fixes the model via sdd.map`);
    assert.ok(typeof r.instructions === 'string' && r.instructions.length > 0,
      `${stage}: gentle-ai HAS a prompt to declare — null is plain's answer, not this framework's`);
  }
});

test('#814 T2/D4: the recorded tier mapping is the maintainer\'s assignment table, translated', () => {
  const roles = declareRoles(LIFECYCLE);
  // sonnet → balanced, opus → deep — recorded 2026-09-02 from ~/.claude/agents/sdd-*.md
  assert.equal(roles.proposal.model_tier, 'deep', 'sdd-propose runs opus — architectural decisions');
  assert.equal(roles.design.model_tier, 'deep', 'sdd-design runs opus — architecture decisions');
  assert.equal(roles.spec.model_tier, 'balanced', 'sdd-spec runs sonnet — structured writing');
  assert.equal(roles.tasks.model_tier, 'balanced', 'sdd-tasks runs sonnet — mechanical breakdown');
});

test('#814 T2: a custom stage the recording never saw is answered as DERIVED — never silently "recorded"', () => {
  const roles = declareRoles([...LIFECYCLE, 'cold-review']);
  const r = roles['cold-review'];
  assert.ok(r, 'the custom stage must be answered, not skipped');
  assert.equal(r.chooses_model, false);
  assert.equal(r.derived, true, 'an answer the recording cannot vouch for says so on the role itself');
  assert.notEqual(roles.proposal.derived, true, 'a recorded stage must NOT carry the derived mark');
});

test('#814 T2/D2: the declaration carries _provenance — recorded, endpoint, date — the fixture discipline', () => {
  const p = GENTLE_AI_ROLES._provenance;
  assert.ok(p, 'missing _provenance');
  assert.equal(p.recorded, true);
  assert.ok(p.endpoint && p.date, 'endpoint and date are what make a re-recording auditable');
});

test('#814 T2: the port resolves gentle-ai end to end — the adapter satisfies the same contract plain does', () => {
  const resolved = resolveRoles({ config: {}, engine: 'gentle-ai', inhabitant: gentleAi });
  for (const stage of LIFECYCLE) {
    assert.equal(resolved[stage].selection.path, 'brain-fixes',
      `${stage}: chooses_model:false with a real tier takes brain-fixes — the 05/08 ruling`);
  }
});
