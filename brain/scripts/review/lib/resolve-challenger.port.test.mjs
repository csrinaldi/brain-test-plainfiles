// resolve-challenger.port.test.mjs — issue #576 T4 (D4): the binding debt
// retires. The header's own instruction, executed: the role content calls the
// port; the AXIS resolution stays byte-for-byte.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { resolveJudgment, IMPLEMENTED_AXES, JUDGMENT_PROTOCOL } from './resolve-challenger.mjs';
import { firstPartyInstance } from '../../roles/first-party/index.mjs';

test('#576 D4: the debt header is gone because the debt is', () => {
  const src = readFileSync(new URL('./resolve-challenger.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('WHEN #312 LANDS'), 'the last debt of its class, retired — not prorogued a third time');
  assert.ok(!src.includes('PROVISIONAL'), 'nothing here is on loan any more');
});

test('#576 D4: the challenger role is SERVED from the shelf — an Adversary instance, not a config binding', () => {
  const role = firstPartyInstance('adversary-challenger');
  assert.ok(role, 'the shelf answers');
  assert.equal(role.archetype, 'adversary');
  const j = resolveJudgment({ config: {}, protocol: JUDGMENT_PROTOCOL });
  assert.equal(j.run, true);
  assert.equal(j.challengerRole, role, 'resolveJudgment hands the PORT\'s role to whatever runner slice 3 builds');
});

test('#576 D4: the AXIS half is untouched — human default, one implemented axis, the same refusals', () => {
  assert.deepEqual([...IMPLEMENTED_AXES], ['human'], 'reviewer policy stays here, exactly as the header always said');
  const j = resolveJudgment({ config: {}, protocol: JUDGMENT_PROTOCOL });
  assert.equal(j.axis, 'human');
  assert.throws(() => resolveJudgment({ config: { reviewer: { inferential: { challenger: { axis: 'psychic' } } } }, protocol: JUDGMENT_PROTOCOL }), /unrecognised/);
});

test('#576 D4: challenger.agent/model were RESERVED and never read — now said in code, still unread', () => {
  const j = resolveJudgment({ config: { reviewer: { inferential: { challenger: { axis: 'human', agent: 'x', model: 'y' } } } }, protocol: JUDGMENT_PROTOCOL });
  assert.equal(j.run, true, 'the keys change nothing — they never did, and now the file says so instead of promising a future');
});

test('#576 (review r1): the OFF arms null challengerRole EXPLICITLY — "never computed" must not read as absent', () => {
  // The pattern off() already keeps for axis and challenger, extended to the
  // field this change added: a future slice-3 consumer inherits one contract,
  // both branches, JSDoc included.
  const disabled = resolveJudgment({ config: { reviewer: { inferential: { enabled: false } } } });
  assert.equal(disabled.challengerRole, null);
  const wrongProtocol = resolveJudgment({ config: {}, protocol: 'brain-review/1' });
  assert.equal(wrongProtocol.challengerRole, null);
});
