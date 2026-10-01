// actors-model.test.mjs — buildActorsModel merges the actors and reviews
// sections into one row per actor, humans and agents in the same table
// under the same schema (#882 R882-6). No ranking: rows sort by actor name,
// never by record count or review count.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildActorsModel, REVIEWS_CAVEAT, PRS_MERGED_ABSENT } from './actors-model.mjs';

const actorRow = (over = {}) => ({ actor: 'alice', actorKind: 'human', records: 3, byType: { proposal: 2, decision: 1 }, first: '2026-08-01T00:00:00Z', last: '2026-09-01T00:00:00Z', ...over });
const thread = (over = {}) => ({ pr: 1, ok: true, verdicts: [], latest: null, ...over });
const verdict = (over = {}) => ({ pr: 1, head_sha: 'abc', rev: 1, verdict: 'PASS', author: 'bob', findings: [], findingCount: 0, malformed: [], ...over });

test('#882 R882-6: actorsSection.ok === false is the whole model\'s own reason', () => {
  const model = buildActorsModel({ ok: false, reason: 'records could not be read: boom' }, { ok: true, value: [] });
  assert.deepEqual(model, { ok: false, reason: 'records could not be read: boom' });
});

test('#882 R882-6: a record-only actor and a forge-only actor both get a row, the second actorKind: null with the stated reason', () => {
  const model = buildActorsModel(
    { ok: true, value: [actorRow({ actor: 'alice' })] },
    { ok: true, value: [thread({ verdicts: [verdict({ author: 'carol' })] })] },
  );
  assert.equal(model.ok, true);
  const names = model.value.rows.map((r) => r.actor);
  assert.deepEqual(names, ['alice', 'carol'], 'both rows exist, sorted by name — never dropped, never ranked by volume');
  const carol = model.value.rows.find((r) => r.actor === 'carol');
  assert.equal(carol.actorKind, null);
  assert.equal(carol.actorKindReason, 'kind unknown — no record carries it yet');
  const alice = model.value.rows.find((r) => r.actor === 'alice');
  assert.equal(alice.actorKind, 'human');
  assert.equal(alice.actorKindReason, null, 'a record-backed actor carries no "kind unknown" reason');
});

test('#882 R882-6: reviewsPosted carries the open-PRs-only caveat verbatim, and counts verdicts filtered to that actor', () => {
  const model = buildActorsModel(
    { ok: true, value: [actorRow({ actor: 'alice' })] },
    { ok: true, value: [thread({ verdicts: [verdict({ author: 'alice' }), verdict({ author: 'alice' }), verdict({ author: 'bob' })] })] },
  );
  const alice = model.value.rows.find((r) => r.actor === 'alice');
  assert.deepEqual(alice.reviewsPosted, { ok: true, count: 2, caveat: REVIEWS_CAVEAT });
});

test('#882 R882-6: every row\'s prsMerged is the stated-absence shape, never a bare 0', () => {
  const model = buildActorsModel({ ok: true, value: [actorRow({ actor: 'alice' })] }, { ok: true, value: [] });
  const [alice] = model.value.rows;
  assert.deepEqual(alice.prsMerged, PRS_MERGED_ABSENT);
  assert.notEqual(alice.prsMerged, 0);
});

test('#882 R882-6: reviewsSection.ok === false degrades per-row, not the whole view — records-based rows still render', () => {
  const model = buildActorsModel(
    { ok: true, value: [actorRow({ actor: 'alice' })] },
    { ok: false, reason: 'the forge could not be reached' },
  );
  assert.equal(model.ok, true, 'one degraded section never blanks the whole view');
  const [alice] = model.value.rows;
  assert.deepEqual(alice.reviewsPosted, { ok: false, reason: 'the forge could not be reached' });
});

test('#882 R882-6: an unreadable thread inside an otherwise-ok reviews section contributes nothing, never throws', () => {
  const model = buildActorsModel(
    { ok: true, value: [actorRow({ actor: 'alice' })] },
    { ok: true, value: [thread({ ok: false, reason: 'thread unreadable', verdicts: undefined }), thread({ verdicts: [verdict({ author: 'alice' })] })] },
  );
  const [alice] = model.value.rows;
  assert.deepEqual(alice.reviewsPosted, { ok: true, count: 1, caveat: REVIEWS_CAVEAT });
});

test('#882 R882-6: rows sort by actor name, never by record count or review count — no ranking', () => {
  const model = buildActorsModel(
    { ok: true, value: [actorRow({ actor: 'zack', records: 50 }), actorRow({ actor: 'amy', records: 1 })] },
    { ok: true, value: [] },
  );
  assert.deepEqual(model.value.rows.map((r) => r.actor), ['amy', 'zack']);
});

// Superseded by #1043 round 3: this test used to pin `count: 0` for an actor
// the forge never named, which the tracker's own review measured as a
// fabricated zero — the count is keyed by forge login, and a record-namespace
// name has no count in that data at all. The rule it pins now is the absence.
test('#882 R882-6 (as amended by #1043 round 3): an actor the forge never named has no review count — the absence is stated, never a zero', () => {
  const model = buildActorsModel({ ok: true, value: [actorRow({ actor: 'alice' })] }, { ok: true, value: [] });
  const [alice] = model.value.rows;
  assert.equal(alice.reviewsPosted.ok, false);
  assert.match(alice.reviewsPosted.reason, /not attributable/i);
  assert.ok(!('count' in alice.reviewsPosted), 'never a number this data cannot back');
});

test('#882 R882-6: every row goes through governance-model.mjs\'s own row() helper — carries a sourceStamp, never a second provenance shaper', () => {
  const model = buildActorsModel({ ok: true, value: [actorRow({ actor: 'alice' })] }, { ok: true, value: [] });
  const [alice] = model.value.rows;
  assert.deepEqual(alice.sourceStamp, { label: '[no source was recorded for this value]', href: null, kind: 'none' }, 'an actor row has no single per-row file/URL — row(null) states that honestly, rather than fabricating one');
});

// #1043 cold review, correction 3: record actors and forge logins are two
// namespaces. `@someone` in the records and `someone` as a review author are
// the same human, and this model cannot know it — so it must not let the
// second row read as a second person.
test('#1043 correction 3: a row whose only evidence is a forge login says so, unreconciled with the record namespace', () => {
  const actors = { ok: true, value: [{ actor: '@someone', actorKind: 'human', records: 4, byType: { decision: 4 }, first: '2026-01-01', last: '2026-02-01' }] };
  const reviews = { ok: true, value: [{ pr: 1, ok: true, verdicts: [{ author: 'someone' }] }] };

  const model = buildActorsModel(actors, reviews);
  const names = model.value.rows.map((r) => r.actor);
  assert.deepEqual(names, ['@someone', 'someone'], 'both rows stand: the model must not invent a mapping between the two namespaces');

  const forgeOnly = model.value.rows.find((r) => r.actor === 'someone');
  assert.match(forgeOnly.evidenceNote, /forge (review )?login/i, "the forge-only row must name what it is evidence of");
  assert.match(forgeOnly.evidenceNote, /not reconciled|unreconciled/i, 'and must say the two namespaces are not reconciled, so it never reads as a second person');

  const recorded = model.value.rows.find((r) => r.actor === '@someone');
  assert.equal(recorded.evidenceNote, null, 'a row backed by records has nothing unreconciled to warn about');
});

// ── #1043 round 3 ──────────────────────────────────────────────────────────
// A record actor lives in brain's namespace (`@alice`); a review author lives
// in the forge's (`alice`). Nothing maps one to the other, so "0 reviews" for
// a record row is a claim this model cannot back — the same fabricated zero
// its own header already refuses for `prsMerged`.
test('#1043 round 3: a record-only actor gets no review COUNT — an unattributable field says so, never 0', () => {
  const actors = { ok: true, value: [{ actor: '@alice', actorKind: 'human', records: 3, byType: {}, first: null, last: null }] };
  const reviews = { ok: true, value: [{ pr: 1, ok: true, verdicts: [{ author: 'alice' }] }] };

  const model = buildActorsModel(actors, reviews);
  const record = model.value.rows.find((r) => r.actor === '@alice');
  assert.equal(record.reviewsPosted.ok, false, 'a name the forge never used has no count to show');
  assert.match(record.reviewsPosted.reason, /not attributable|namespace/i, 'and the reason names why: the two namespaces are not reconciled');
  assert.ok(!('count' in record.reviewsPosted), 'never a number, and never a zero');

  const forge = model.value.rows.find((r) => r.actor === 'alice');
  assert.equal(forge.reviewsPosted.ok, true, 'the row the forge itself named does carry its count');
  assert.equal(forge.reviewsPosted.count, 1);
});
