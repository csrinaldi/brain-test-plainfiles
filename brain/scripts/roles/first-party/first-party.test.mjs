// first-party.test.mjs — issue #814 T4 (proposal D5): brain's own role
// content, served from the port's side of the house. The Adversary instance
// for cold-review is the FIRST first-party role; #576's archetype set grows
// around it. These tests are the neutrality and purity oracles.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { firstPartyRole } from './index.mjs';
import { ARTIFACT_TAG, CARRIED_FIELDS } from '../../review/lib/findings-artifact.mjs';

test('#814 T4: firstPartyRole("cold-review") serves the Adversary instance', () => {
  const role = firstPartyRole('cold-review');
  assert.ok(role, 'the role must exist — this is the discharge of ROLE_DEBT_TICKET');
  assert.equal(role.archetype, 'adversary');
  assert.ok(typeof role.text === 'string' && role.text.length > 0);
  assert.match(role.text, /COLD REVIEWER/, "the identity is the role's first sentence");
});

test('#814 T4: an unclaimed stage answers null — first-party content is not a registry of everything', () => {
  assert.equal(firstPartyRole('tasks'), null);
  assert.equal(firstPartyRole('no-such-stage'), null);
});

test('#814 T4: the role text carries ZERO protocol literals — the derived-from-the-reader property stays with the reader', () => {
  const { text } = firstPartyRole('cold-review');
  assert.ok(!text.includes(ARTIFACT_TAG), 'the fence tag belongs to the assembler, derived from the reader');
  for (const field of CARRIED_FIELDS) {
    // Backticked = restated as SPEC. The bare English word ("one file") is
    // role prose, not a field list — the old suite drew this same line.
    assert.ok(!text.includes(`\`${field}\``), `field \`${field}\` must not be restated as spec in role text`);
  }
  assert.ok(!/\.md\b|\.json\b|artifacts\//.test(text), 'no artifact path — the path is per-run, the role is not');
});

test('#814 T4: neutrality (ADR-0019 Am.1 c.2) — the served object routes nothing', () => {
  const role = firstPartyRole('cold-review');
  for (const key of ['engine', 'map', 'model', 'model_tier', 'chooses_model', 'transport']) {
    assert.ok(!(key in role), `"${key}" on a first-party role would make content into routing`);
  }
});

test('#814 T4/D2: provenance — brain-authored content says so', () => {
  const role = firstPartyRole('cold-review');
  assert.ok(role._provenance, 'missing _provenance');
  assert.ok(role._provenance.date);
});
