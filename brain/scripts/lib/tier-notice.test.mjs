// tier-notice.test.mjs — issue #1124: env:init states the governance tier it
// set (a NEW consumer) or the one already declared (an EXISTING consumer),
// why, and how to change it.
//
// The notice is split in two on purpose: `tierNotice()` DECIDES (pure, no I/O,
// no locale), `renderTierNotice()` SAYS (through the i18n catalogs). The
// decision is what the ruling constrains — a new consumer is told `lite`, an
// existing one is told what it already has — so it is pinned without any
// string matching; the rendering is pinned separately against both catalogs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { tierNotice, renderTierNotice } from './tier-notice.mjs';

// ── the decision ──────────────────────────────────────────────────────────────

test('#1124 tierNotice: a config env:init just CREATED reports its tier as newly set', () => {
  const n = tierNotice({ created: true, config: { governance: { tier: 'lite' } } });
  assert.deepEqual(n, { tier: 'lite', source: 'new' });
});

test('#1124 tierNotice: an EXISTING config that declares standard or regulated reports it as declared', () => {
  for (const tier of ['lite', 'standard', 'regulated']) {
    const n = tierNotice({ created: false, config: { governance: { tier } } });
    assert.deepEqual(n, { tier, source: 'declared' }, `a declared ${tier} is reported as declared, never re-set`);
  }
});

test('#1124 tierNotice: an EXISTING config with NO tier key reports standard — what resolveTier() reads for an absent key', () => {
  for (const config of [{}, { governance: {} }, { governance: { tier: null } }]) {
    const n = tierNotice({ created: false, config });
    assert.deepEqual(n, { tier: 'standard', source: 'absent' });
  }
});

test('#1124 tierNotice: an unknown declared value is reported as invalid, never silently mapped to a tier', () => {
  const n = tierNotice({ created: false, config: { governance: { tier: 'strict' } } });
  assert.deepEqual(n, { tier: 'strict', source: 'invalid' });
});

// ── the rendering ─────────────────────────────────────────────────────────────

test('#1124 renderTierNotice (en): a new lite consumer is told the tier, why, and both alternatives with where to set them', async () => {
  const text = (await renderTierNotice({ tier: 'lite', source: 'new' }, { locale: 'en' })).join('\n');
  assert.match(text, /governance tier: lite/);
  assert.match(text, /one maintainer/i, 'the why: lite is for one maintainer');
  assert.match(text, /no second approv/i, 'the why: no required second approver');
  assert.match(text, /standard/);
  assert.match(text, /regulated/);
  assert.match(text, /governance\.tier/, 'names the key to change');
  assert.match(text, /brain\.config\.json/, 'names the file it lives in');
  assert.match(text, /brain:config -- set governance\.tier/, 'names the verb that sets it');
});

test('#1124 renderTierNotice (en): a declared tier is stated as unchanged, with no "set for this new repository" wording', async () => {
  const text = (await renderTierNotice({ tier: 'standard', source: 'declared' }, { locale: 'en' })).join('\n');
  assert.match(text, /governance tier: standard/);
  assert.match(text, /unchanged/i);
  assert.doesNotMatch(text, /new repository/i);
  assert.doesNotMatch(text, /one maintainer/i, 'the lite rationale is not attached to a standard declaration');
});

test('#1124 renderTierNotice (en): an absent key says so, and that it resolves to standard', async () => {
  const text = (await renderTierNotice({ tier: 'standard', source: 'absent' }, { locale: 'en' })).join('\n');
  assert.match(text, /governance tier: standard/);
  assert.match(text, /declares none/i);
  assert.match(text, /unchanged/i);
});

test('#1124 renderTierNotice (en): an invalid value is named as invalid, with the three valid tiers', async () => {
  const text = (await renderTierNotice({ tier: 'strict', source: 'invalid' }, { locale: 'en' })).join('\n');
  assert.match(text, /"strict"/);
  assert.match(text, /lite/);
  assert.match(text, /standard/);
  assert.match(text, /regulated/);
});

test('#1124 renderTierNotice (es): the notice goes through the catalog — Spanish differs from English', async () => {
  const en = (await renderTierNotice({ tier: 'lite', source: 'new' }, { locale: 'en' })).join('\n');
  const es = (await renderTierNotice({ tier: 'lite', source: 'new' }, { locale: 'es' })).join('\n');
  assert.notEqual(es, en);
  assert.match(es, /lite/);
  assert.match(es, /governance\.tier/);
});

// ── the memory lane (issue #1166) — same two halves, same catalogs ────────────

import { laneNotice, renderLaneNotice } from './tier-notice.mjs';

test('#1166 laneNotice: absent or false reads as OFF (the consumer default); true reads as ON', () => {
  for (const config of [{}, { memory: {} }, { memory: { lane: {} } }, { memory: { lane: { enabled: false } } }]) {
    assert.deepEqual(laneNotice({ config }), { enabled: false });
  }
  assert.deepEqual(laneNotice({ config: { memory: { lane: { enabled: true } } } }), { enabled: true });
});

test('#1166 renderLaneNotice (en): OFF says so, why it is off by default, and the exact command to turn it on', async () => {
  const text = (await renderLaneNotice({ enabled: false }, { locale: 'en' })).join('\n');
  assert.match(text, /memory lane: off/i);
  assert.match(text, /off by default/i, 'the why');
  assert.match(text, /npm run brain:config -- set memory\.lane\.enabled true/);
});

test('#1166 renderLaneNotice (en): ON says so and does not tell the operator to turn it on', async () => {
  const text = (await renderLaneNotice({ enabled: true }, { locale: 'en' })).join('\n');
  assert.match(text, /memory lane: on/i);
  assert.doesNotMatch(text, /set memory\.lane\.enabled true/);
});

test('#1166 renderLaneNotice (es): both states render from the Spanish catalog with no raw key leaking', async () => {
  for (const enabled of [false, true]) {
    const text = (await renderLaneNotice({ enabled }, { locale: 'es' })).join('\n');
    assert.doesNotMatch(text, /config\.lane\./, 'a missing catalog key would print the key itself');
  }
});
