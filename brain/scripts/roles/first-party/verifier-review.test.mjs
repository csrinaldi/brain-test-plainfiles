// verifier-review.test.mjs — issue #576 T2: the Verifier instance for the
// review role, and the second door on the shelf. The oracle for its citations
// is the DOCTRINE FILE, not this test's memory of it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { VERIFIER_REVIEW } from './verifier-review.mjs';
import { firstPartyInstance, firstPartyRole } from './index.mjs';
import { ARCHETYPES } from './archetypes.mjs';
import { ARTIFACT_TAG, CARRIED_FIELDS } from '../../review/lib/findings-artifact.mjs';

test('#576 T2: the reviewer instance sits on the verifier archetype and serves text', () => {
  assert.equal(VERIFIER_REVIEW.archetype, 'verifier');
  assert.ok(ARCHETYPES.has(VERIFIER_REVIEW.archetype));
  assert.ok(VERIFIER_REVIEW.text.length > 0);
  assert.ok(VERIFIER_REVIEW._provenance?.date, 'authored content states its provenance');
});

test('#576 T2: the three locks are cited BY SYMBOL, and the symbols exist in the doctrine', () => {
  const doctrine = readFileSync(new URL('../../../core/methodology/reviewer-protocol.md', import.meta.url), 'utf8');
  for (const symbol of ['evaluateBrainWritesReviewed', 'prReviewComment', 'governance.reviewActors']) {
    assert.ok(VERIFIER_REVIEW.text.includes(symbol), `lock symbol ${symbol} cited in the role text`);
    assert.ok(doctrine.includes(symbol), `${symbol} really is the doctrine's own symbol — the citation has a target`);
  }
  assert.ok(!/:\d+/.test(VERIFIER_REVIEW.text), 'no line-number citations — §2\'s own rule (#580)');
});

test('#576 T2: zero protocol literals — the assemble split\'s rule, applied again', () => {
  assert.ok(!VERIFIER_REVIEW.text.includes(ARTIFACT_TAG));
  for (const f of CARRIED_FIELDS) {
    assert.ok(!VERIFIER_REVIEW.text.includes(`\`${f}\``), `field \`${f}\` must not be restated as spec`);
  }
});

test('#576 T2: firstPartyInstance is the second door — by NAME, read-only, null for strangers', () => {
  assert.equal(firstPartyInstance('verifier-review'), VERIFIER_REVIEW);
  assert.equal(firstPartyInstance('no-such-instance'), null);
  assert.equal(firstPartyRole('cold-review')?.stage, 'cold-review', 'the stage door still answers');
});

test('#576 T2: neutrality holds on the new instance too — content, never routing', () => {
  for (const key of ['engine', 'map', 'model', 'model_tier', 'chooses_model', 'transport']) {
    assert.ok(!(key in VERIFIER_REVIEW), `"${key}" would make content into routing`);
  }
});

// ── T4 (tasks 1.4): the locks the projection CITES still hold mechanically ──

test('#576 1.4: the projected reviewer\'s claims are load-bearing — the port has prReviewComment and NO approve verb', async () => {
  const { VERBS } = await import('../../vcs/cli.mjs');
  const names = Array.isArray(VERBS) ? VERBS : [...(VERBS instanceof Map ? VERBS.keys() : Object.keys(VERBS))];
  assert.ok(names.includes('prReviewComment'), 'lock 2\'s verb exists — the citation has a target');
  assert.equal(names.filter((n) => /approve/i.test(n)).length, 0,
    'no verb on the whole port can approve — a fully compromised projected reviewer has no code path to one');
});
