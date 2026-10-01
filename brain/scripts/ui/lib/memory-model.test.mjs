// memory-model.test.mjs — buildMemoryModel reads `snapshot.records` (2421
// rows today) into the global Memory view: a recent-first capped list, the
// two summary counts a reader needs before the detail (by type, by
// actorKind), and the duplicate-id integrity signal named plainly rather
// than hidden behind a bare number. Strict TDD: every test below was run
// red (module absent) before memory-model.mjs existed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildMemoryModel, MEMORY_RECENT_CAP } from './memory-model.mjs';

const rec = (over = {}) => ({
  id: 'rec-0000000000000001',
  ts: '2026-07-01T00:00:00Z',
  actor: '@legacy',
  actorKind: 'human',
  type: 'architecture',
  file: '.memory/records/2026-07-rec-0000000000000001.jsonl',
  ...over,
});

const noDup = { ids: 0, lines: 0, divergent: 0, groups: [] };

const section = (records, duplicates = noDup) => ({ ok: true, value: { records, duplicates } });

// ── input guards ────────────────────────────────────────────────────────

test('no records section given -> ok:false, never throws', () => {
  assert.deepEqual(buildMemoryModel(undefined), { ok: false, reason: 'no records section was given to Memory' });
  assert.deepEqual(buildMemoryModel(null), { ok: false, reason: 'no records section was given to Memory' });
});

test('recordsSection.ok === false -> that reason is the whole model\'s reason (unreadable, not empty)', () => {
  const model = buildMemoryModel({ ok: false, reason: 'the records directory could not be read: EACCES' });
  assert.deepEqual(model, { ok: false, reason: 'the records directory could not be read: EACCES' });
});

test('a records section with no records array is malformed, not empty', () => {
  const model = buildMemoryModel({ ok: true, value: { duplicates: noDup } });
  assert.equal(model.ok, false);
  assert.match(model.reason, /records array/i);
});

// ── empty vs unreadable ─────────────────────────────────────────────────

test('zero records is a real, readable state — ok:true, empty:true, a stated note, never the unreadable shape', () => {
  const model = buildMemoryModel(section([]));
  assert.equal(model.ok, true);
  assert.equal(model.value.empty, true);
  assert.match(model.value.note, /no memory records/i);
  assert.deepEqual(model.value.recent, { shown: 0, total: 0, cap: MEMORY_RECENT_CAP, records: [] });
  assert.deepEqual(model.value.countsByType, []);
  assert.deepEqual(model.value.countsByActorKind, []);
});

test('a non-empty set carries empty:false and note:null — the two states never render the same', () => {
  const model = buildMemoryModel(section([rec()]));
  assert.equal(model.value.empty, false);
  assert.equal(model.value.note, null);
});

// ── recent-first capped list ────────────────────────────────────────────

test('recent sorts newest-first by ts', () => {
  const model = buildMemoryModel(section([
    rec({ id: 'rec-a', ts: '2026-07-01T00:00:00Z' }),
    rec({ id: 'rec-b', ts: '2026-09-01T00:00:00Z' }),
    rec({ id: 'rec-c', ts: '2026-08-01T00:00:00Z' }),
  ]));
  assert.deepEqual(model.value.recent.records.map((r) => r.id), ['rec-b', 'rec-c', 'rec-a']);
});

test('recent states both shown and total, capped at MEMORY_RECENT_CAP by default', () => {
  const records = Array.from({ length: MEMORY_RECENT_CAP + 7 }, (_, i) =>
    rec({ id: `rec-${i}`, ts: `2026-07-${String((i % 27) + 1).padStart(2, '0')}T00:00:00Z` }));
  const model = buildMemoryModel(section(records));
  assert.equal(model.value.recent.total, MEMORY_RECENT_CAP + 7);
  assert.equal(model.value.recent.shown, MEMORY_RECENT_CAP);
  assert.equal(model.value.recent.records.length, MEMORY_RECENT_CAP);
});

test('options.cap overrides the default cap', () => {
  const records = [rec({ id: 'a' }), rec({ id: 'b' }), rec({ id: 'c' })];
  const model = buildMemoryModel(section(records), { cap: 2 });
  assert.equal(model.value.recent.cap, 2);
  assert.equal(model.value.recent.shown, 2);
  assert.equal(model.value.recent.total, 3);
});

test('a record whose ts cannot be parsed is kept, named, and sorted to the end — never dropped, never NaN-misplaced', () => {
  const model = buildMemoryModel(section([
    rec({ id: 'rec-good', ts: '2026-07-01T00:00:00Z' }),
    rec({ id: 'rec-bad', ts: 'not-a-date' }),
  ]));
  const ids = model.value.recent.records.map((r) => r.id);
  assert.deepEqual(ids, ['rec-good', 'rec-bad']);
  const bad = model.value.recent.records.find((r) => r.id === 'rec-bad');
  assert.match(bad.tsUnparseable, /could not be parsed/i);
  const good = model.value.recent.records.find((r) => r.id === 'rec-good');
  assert.equal(good.tsUnparseable, null);
});

// ── provenance ───────────────────────────────────────────────────────────

test('every recent row carries a sourceStamp derived from its own file, via governance-model.mjs\'s row()', () => {
  const model = buildMemoryModel(section([rec({ file: '.memory/records/2026-07-rec-x.jsonl' })]));
  const [row] = model.value.recent.records;
  assert.deepEqual(row.sourceStamp, { label: '[repo: .memory/records/2026-07-rec-x.jsonl]', href: null, kind: 'repo' });
  assert.equal(row.source, '.memory/records/2026-07-rec-x.jsonl');
});

test('a recent row states its type and actor/actorKind in detail, matching drawer-model.mjs\'s "actor (actorKind)" convention', () => {
  const model = buildMemoryModel(section([rec({ type: 'decision', actor: 'feat/issue-1', actorKind: 'agent' })]));
  const [row] = model.value.recent.records;
  assert.equal(row.title, 'decision');
  assert.equal(row.detail, 'feat/issue-1 (agent)');
});

test('an actorKind of null renders as "unknown" in detail, never a blank', () => {
  const model = buildMemoryModel(section([rec({ actorKind: null })]));
  assert.match(model.value.recent.records[0].detail, /\(unknown\)/);
});

// ── relative time: clock is always injected, never read ────────────────

test('with no now given, relativeTime is null on every row — never a fabricated age', () => {
  const model = buildMemoryModel(section([rec({ ts: '2026-07-01T00:00:00Z' })]));
  assert.equal(model.value.recent.records[0].relativeTime, null);
});

test('with now given, relativeTime is computed from the passed clock, never Date.now()', () => {
  const model = buildMemoryModel(section([rec({ ts: '2026-09-18T00:00:00Z' })]), { now: Date.parse('2026-09-19T00:00:00Z') });
  assert.equal(model.value.recent.records[0].relativeTime, '1 d ago');
});

// ── counts by type / by actorKind: the summary before the detail ───────

test('countsByType follows the canonical seven-type order, and omits a type with zero occurrences', () => {
  const model = buildMemoryModel(section([
    rec({ type: 'bugfix' }), rec({ type: 'architecture' }), rec({ type: 'architecture' }),
  ]));
  assert.deepEqual(model.value.countsByType, [
    { type: 'architecture', count: 2 },
    { type: 'bugfix', count: 1 },
  ]);
});

test('a type outside the documented seven is never hidden — appended after the canonical order, alphabetically', () => {
  const model = buildMemoryModel(section([
    rec({ type: 'zzz-unknown' }), rec({ type: 'decision' }), rec({ type: 'aaa-unknown' }),
  ]));
  assert.deepEqual(model.value.countsByType, [
    { type: 'decision', count: 1 },
    { type: 'aaa-unknown', count: 1 },
    { type: 'zzz-unknown', count: 1 },
  ]);
});

test('countsByType is computed over ALL records, not just the capped recent list', () => {
  const records = Array.from({ length: MEMORY_RECENT_CAP + 3 }, (_, i) => rec({ id: `rec-${i}`, type: 'discovery' }));
  const model = buildMemoryModel(section(records));
  assert.deepEqual(model.value.countsByType, [{ type: 'discovery', count: MEMORY_RECENT_CAP + 3 }]);
});

test('countsByActorKind orders human, agent, then unknown last — and a null actorKind counts as unknown, never dropped', () => {
  const model = buildMemoryModel(section([
    rec({ actorKind: null }), rec({ actorKind: 'agent' }), rec({ actorKind: 'human' }), rec({ actorKind: 'human' }),
  ]));
  assert.deepEqual(model.value.countsByActorKind, [
    { actorKind: 'human', count: 2 },
    { actorKind: 'agent', count: 1 },
    { actorKind: 'unknown', count: 1 },
  ]);
});

// ── duplicates: an integrity signal, never a bare number ───────────────

test('no duplicates -> ok:true, zero counts, integrityNote:null — silence is only earned by zero, never assumed', () => {
  const model = buildMemoryModel(section([rec()], noDup));
  assert.deepEqual(model.value.duplicates, {
    ok: true, idsWithDuplicates: 0, totalDuplicateLines: 0, divergentCount: 0, groups: [], integrityNote: null,
  });
});

test('non-divergent duplicates state a plain count sentence, and never say DIVERGENT', () => {
  const dup = { ids: 1, lines: 2, divergent: 0, groups: [{ id: 'rec-dup', occurrences: ['2026-07-rec-dup.jsonl:1', '2026-07-rec-dup.jsonl:2'], divergent: false }] };
  const model = buildMemoryModel(section([rec()], dup));
  assert.match(model.value.duplicates.integrityNote, /1 record id/);
  assert.doesNotMatch(model.value.duplicates.integrityNote, /DIVERGENT/);
});

test('divergent duplicates name the ids and their occurrences in the integrity note, never just a count', () => {
  const dup = {
    ids: 2, lines: 2, divergent: 2,
    groups: [
      { id: 'rec-4a22e13fd3c3aebd', occurrences: ['2026-09-rec-4a22e13fd3c3aebd.jsonl:1', '2026-09-rec-4a22e13fd3c3aebd.jsonl:2'], divergent: true },
      { id: 'rec-95740755792f0f1c', occurrences: ['2026-08-rec-95740755792f0f1c.jsonl:1', '2026-08-rec-95740755792f0f1c.jsonl:2'], divergent: true },
    ],
  };
  const model = buildMemoryModel(section([rec()], dup));
  assert.match(model.value.duplicates.integrityNote, /DIVERGENT/);
  assert.match(model.value.duplicates.integrityNote, /rec-4a22e13fd3c3aebd/);
  assert.match(model.value.duplicates.integrityNote, /rec-95740755792f0f1c/);
  assert.match(model.value.duplicates.integrityNote, /2026-09-rec-4a22e13fd3c3aebd\.jsonl:1/);
  assert.deepEqual(model.value.duplicates.groups[0], {
    id: 'rec-4a22e13fd3c3aebd', divergent: true,
    occurrences: ['2026-09-rec-4a22e13fd3c3aebd.jsonl:1', '2026-09-rec-4a22e13fd3c3aebd.jsonl:2'],
  });
});

test('a malformed duplicates block degrades ONLY the duplicates field — the rest of the model still renders', () => {
  const model = buildMemoryModel({ ok: true, value: { records: [rec()], duplicates: { ids: 'not-a-number' } } });
  assert.equal(model.ok, true, 'one bad sub-section never blanks the whole view');
  assert.equal(model.value.duplicates.ok, false);
  assert.match(model.value.duplicates.reason, /malformed/i);
  assert.equal(model.value.recent.total, 1, 'records still render despite the duplicates block being unreadable');
});

test('a missing duplicates block degrades the duplicates field with its own stated reason', () => {
  const model = buildMemoryModel({ ok: true, value: { records: [rec()] } });
  assert.equal(model.value.duplicates.ok, false);
  assert.match(model.value.duplicates.reason, /no duplicates data/i);
});

// ── actor grouping: a deliberate non-feature, documented ───────────────

test('the model does not group or count by individual actor — actor is a branch name, not a person, and actors-model.mjs already owns the by-actor governance view', () => {
  const model = buildMemoryModel(section([rec({ actor: 'feat/issue-1' }), rec({ actor: 'feat/issue-2' })]));
  assert.equal(model.value.byActor, undefined, 'no by-actor breakdown is exported by this model, on purpose');
});

// ── determinism ──────────────────────────────────────────────────────────

test('totalRecords reflects the full set regardless of cap', () => {
  const records = Array.from({ length: MEMORY_RECENT_CAP + 5 }, (_, i) => rec({ id: `rec-${i}` }));
  const model = buildMemoryModel(section(records));
  assert.equal(model.value.totalRecords, MEMORY_RECENT_CAP + 5);
});

// ── #1067 cold review, finding cold-2 ──────────────────────────────────────
// `countsBy` sorted the keys `order` does not name with `a.localeCompare(b)`.
// `actorKind` is normalised to 'unknown' before it gets there, but `type` is
// not: a record whose `type` is null, or a number, puts a non-string key in
// that list, and with two or more of them the comparator throws — taking the
// WHOLE Memory view down over one malformed record. The module's own stated
// rule is that an unexpected value is never absorbed and never dropped, so the
// fix names it rather than deleting it.
test('#1067: a record with no declared type is named, never dropped and never fatal', () => {
  const section = {
    ok: true,
    value: {
      records: [
        { id: 'a', ts: '2026-09-01T00:00:00Z', actor: 'x', actorKind: 'agent', type: 'bugfix', file: '.memory/records/a.jsonl' },
        { id: 'b', ts: '2026-09-02T00:00:00Z', actor: 'x', actorKind: 'agent', type: null, file: '.memory/records/b.jsonl' },
        { id: 'c', ts: '2026-09-03T00:00:00Z', actor: 'x', actorKind: 'agent', file: '.memory/records/c.jsonl' },
      ],
      duplicates: { ids: 0, lines: 0, divergent: 0, groups: [] },
    },
  };

  const model = buildMemoryModel(section);
  assert.equal(model.ok, true, 'one malformed record must not take the whole ledger down');

  const types = model.value.countsByType;
  const total = types.reduce((sum, row) => sum + row.count, 0);
  assert.equal(total, 3, 'every record is counted exactly once — nothing absorbed, nothing dropped');
  assert.deepEqual(types.find((row) => row.type === 'bugfix'), { type: 'bugfix', count: 1 });

  const undeclared = types.find((row) => row.type !== 'bugfix');
  assert.ok(undeclared, 'the records with no type are their own row');
  assert.equal(undeclared.count, 2, 'a null type and an absent one are the same fact: nobody declared it');
  assert.match(String(undeclared.type), /declared/, 'and the row says so in words, rather than rendering "null"');
});

test('#1067: two or more records with non-string types do not throw the comparator', () => {
  const records = [
    { id: 'a', ts: '2026-09-01T00:00:00Z', actor: 'x', actorKind: 'agent', type: 42, file: 'a.jsonl' },
    { id: 'b', ts: '2026-09-02T00:00:00Z', actor: 'x', actorKind: 'agent', type: { weird: true }, file: 'b.jsonl' },
    { id: 'c', ts: '2026-09-03T00:00:00Z', actor: 'x', actorKind: 'agent', type: null, file: 'c.jsonl' },
  ];
  const section = { ok: true, value: { records, duplicates: { ids: 0, lines: 0, divergent: 0, groups: [] } } };

  // Before the fix this threw `a.localeCompare is not a function`, which the
  // page has no way to recover from: the mode renders nothing at all.
  const model = buildMemoryModel(section);
  assert.equal(model.ok, true);
  assert.equal(model.value.countsByType.reduce((sum, row) => sum + row.count, 0), 3);
});

// The `type` fix above coerces its own key, so on its own it makes the
// stringified comparator unreachable — and a guard no test can reach is a
// guard nobody can trust. `actorKind` is the second key extractor, and it
// normalises only null and undefined (`?? 'unknown'`): a NUMBER or an object
// passes straight through. Two of those and the comparator throws, with the
// same consequence — the whole Memory view renders nothing.
test('#1067: a non-string actorKind cannot throw the comparator either', () => {
  const records = [
    { id: 'a', ts: '2026-09-01T00:00:00Z', actor: 'x', actorKind: 7, type: 'bugfix', file: 'a.jsonl' },
    { id: 'b', ts: '2026-09-02T00:00:00Z', actor: 'x', actorKind: { rogue: true }, type: 'bugfix', file: 'b.jsonl' },
    { id: 'c', ts: '2026-09-03T00:00:00Z', actor: 'x', actorKind: 'human', type: 'bugfix', file: 'c.jsonl' },
  ];
  const section = { ok: true, value: { records, duplicates: { ids: 0, lines: 0, divergent: 0, groups: [] } } };

  const model = buildMemoryModel(section);
  assert.equal(model.ok, true, 'a rogue actorKind must not take the ledger down');
  assert.equal(model.value.countsByActorKind.reduce((sum, row) => sum + row.count, 0), 3,
    'and every record is still counted — the value is unexpected, not absent');
});
