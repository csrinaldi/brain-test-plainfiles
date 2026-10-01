// archetypes.test.mjs — issue #576 T1: the archetype layer owns ONLY what the
// port does not, and every contract label is a CHECKED value (#499: an
// unlabelled protection is an apparent one).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ARCHETYPES, CONTRACT_LABELS, assertArchetypeShape } from './archetypes.mjs';
import { firstPartyRole } from './index.mjs';

test('#576 T1: the four archetypes exist, keyed in a Map — "constructor" is a name the prototype chain must never answer for', () => {
  assert.ok(ARCHETYPES instanceof Map, 'a Map has no inherited keys for a lookup to land on — the RUNNERS argument');
  assert.deepEqual([...ARCHETYPES.keys()].sort(), ['adversary', 'constructor', 'coordinator', 'verifier']);
});

test('#576 T1: every archetype carries the three fields the port does NOT own, each labelled', () => {
  for (const [name, def] of ARCHETYPES) {
    assert.equal(def.archetype, name);
    assert.ok(def.may_write_summary && def.must_not_see_summary, `${name}: the two axes that characterize it`);
    for (const field of ['escalation', 'output_contract']) {
      assert.ok(def[field]?.rule ?? def[field]?.shape, `${name}.${field} has content`);
      assert.ok(CONTRACT_LABELS.includes(def[field].label), `${name}.${field}.label is a checked value`);
    }
  }
});

test('#576 T1: a definition redeclaring a PORT field is refused — the rescope\'s named failure, as a throw', () => {
  for (const field of ['writes', 'reads', 'model_tier', 'chooses_model', 'instructions']) {
    assert.throws(
      () => assertArchetypeShape({ archetype: 'x', may_write_summary: 'w', must_not_see_summary: 's',
        escalation: { rule: 'r', label: 'doctrinal' }, output_contract: { shape: 'o', label: 'doctrinal' }, [field]: 'dup' }),
      new RegExp(field),
      `${field} belongs to the port's role contract`,
    );
  }
});

test('#576 T1: an unlabelled or mislabelled contract is refused', () => {
  assert.throws(() => assertArchetypeShape({ archetype: 'x', may_write_summary: 'w', must_not_see_summary: 's',
    escalation: { rule: 'r', label: 'hopeful' }, output_contract: { shape: 'o', label: 'doctrinal' } }), /label/);
});

test('#576 T1: the Adversary seed re-seats — archetype named, served surface unchanged', () => {
  const role = firstPartyRole('cold-review');
  assert.equal(role.archetype, 'adversary', 'it already said adversary — now the name resolves to a DEFINITION');
  assert.ok(ARCHETYPES.has(role.archetype));
  assert.ok(typeof role.text === 'string' && role.text.includes('COLD REVIEWER'), 'existing consumers see what they saw');
});
