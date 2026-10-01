// engram.hydrate.test.mjs — unit tests for axes/memory/adapters/engram.mjs#hydrate (#874,
// split A, R3/R4/D1/D2/D9). Every seam (`_engramSave`, `_guard`, `_probe`,
// `_readRecords`, `_importRecord`) is injected — no real engram binary, no
// real filesystem read of a real store, and no real #820 guard file, so
// `npm test` never touches this repo's `.memory/` or a real engram store.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { hydrate } from './engram.mjs';
import { importRecord } from '../../../memory/lib/engram-import.mjs';

const CLEAN_RECORD = {
  id: 'rec-0123456789abcdef',
  ts: '2026-09-10T09:00:00Z',
  actor: '@test',
  actorKind: 'human',
  type: 'discovery',
  project: 'brain',
  content: 'a clean record body',
};

function heldGuard() {
  let released = false;
  return {
    guard: { held: true, release: () => { released = true; } },
    wasReleased: () => released,
  };
}

// ── one _engramSave call, topic === recordId, payload byte-equal to importRecord(record) ──

test('hydrate: calls _engramSave exactly once, topic === recordId, payload matches importRecord(record)', async () => {
  const calls = [];
  const { guard } = heldGuard();
  const result = await hydrate(
    { root: '/tmp/unused', recordId: CLEAN_RECORD.id, record: CLEAN_RECORD },
    {
      _probe: () => ({ available: true }),
      _guard: () => guard,
      _engramSave: (title, content, opts) => { calls.push({ title, content, opts }); },
    },
  );
  assert.equal(result.written, 1);
  assert.equal(result.skipped, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].opts.topic, CLEAN_RECORD.id);
  const expected = importRecord(CLEAN_RECORD);
  assert.equal(calls[0].title, expected.title);
  assert.equal(calls[0].content, expected.content);
  assert.equal(calls[0].opts.type, expected.type);
  assert.equal(calls[0].opts.project, expected.project);
  assert.equal(calls[0].opts.scope, expected.scope);
});

// ── idempotence (R6): two hydrations of one record against a topic-keyed fake
// store leave one row ──

test('hydrate: idempotent — two hydrations of the same record leave exactly one row in a topic-keyed fake store', async () => {
  const store = new Map(); // topic_key -> observation, mirrors engram's real upsert-by-topic
  const fakeEngramSave = (title, content, opts) => {
    store.set(opts.topic, { title, content, ...opts });
  };

  for (let i = 0; i < 2; i++) {
    const { guard } = heldGuard();
    // eslint-disable-next-line no-await-in-loop
    await hydrate(
      { root: '/tmp/unused', recordId: CLEAN_RECORD.id, record: CLEAN_RECORD },
      { _probe: () => ({ available: true }), _guard: () => guard, _engramSave: fakeEngramSave },
    );
  }
  assert.equal(store.size, 1, 'a topic-keyed store must hold exactly one row per record id, no matter how many times it is hydrated');
  // fresh-review F4 (#924): a fake store keyed on ANY constant topic would
  // also converge to size 1 — that alone does not prove `hydrate` used the
  // RECORD's id as the topic. Asserting the one key IS `CLEAN_RECORD.id`
  // closes that gap: a regression to a constant topic now fails HERE too,
  // not only in the byte-equality test above.
  assert.deepEqual([...store.keys()], [CLEAN_RECORD.id]);
});

// ── binary absent ⇒ deferred + stderr, no throw ─────────────────────────────

test('hydrate: binary absent ⇒ {deferred:true}, a stderr notice, and no throw', async () => {
  const { guard } = heldGuard();
  const warnings = [];
  let engramSaveCalled = false;
  const result = await hydrate(
    { root: '/tmp/unused', recordId: CLEAN_RECORD.id, record: CLEAN_RECORD },
    {
      _probe: () => ({ available: false }),
      _guard: () => guard,
      _engramSave: () => { engramSaveCalled = true; },
      _warn: (msg) => warnings.push(msg),
    },
  );
  assert.equal(result.written, 0);
  assert.equal(result.deferred, true);
  assert.equal(engramSaveCalled, false, 'the guard must never even be needed — _engramSave must never be called');
  assert.equal(warnings.length, 1);
});

// ── _engramSave throws ⇒ deferred with the reason, no throw ─────────────────

test('hydrate: _engramSave throws ⇒ {deferred:true, reason} and no throw propagates', async () => {
  const { guard, wasReleased } = heldGuard();
  const result = await hydrate(
    { root: '/tmp/unused', recordId: CLEAN_RECORD.id, record: CLEAN_RECORD },
    {
      _probe: () => ({ available: true }),
      _guard: () => guard,
      _engramSave: () => { throw new Error('engram: pragma "PRAGMA journal_mode = WAL": unable to open database file'); },
      _warn: () => {},
    },
  );
  assert.equal(result.written, 0);
  assert.equal(result.deferred, true);
  assert.ok(result.reason && result.reason.length > 0);
  assert.equal(wasReleased(), true, 'the guard must be released even when _engramSave throws');
});

// ── guard contended ⇒ {deferred:true, contended:true}, _engramSave never called ──

test('hydrate: guard contended ⇒ {deferred:true, contended:true}, _engramSave never called, never waits', async () => {
  let engramSaveCalled = false;
  const result = await hydrate(
    { root: '/tmp/unused', recordId: CLEAN_RECORD.id, record: CLEAN_RECORD },
    {
      _probe: () => ({ available: true }),
      _guard: () => ({ held: false, owner: { pid: 4242, ageMs: 5000 } }),
      _engramSave: () => { engramSaveCalled = true; },
      _warn: () => {},
    },
  );
  assert.equal(result.written, 0);
  assert.equal(result.deferred, true);
  assert.equal(result.contended, true);
  assert.equal(engramSaveCalled, false);
});

// ── unknown recordId with no record passed ⇒ throws (D4, a caller mistake, never deferred) ──

test('hydrate: an unknown recordId with no record passed THROWS (D4) — never deferred', async () => {
  await assert.rejects(() =>
    hydrate(
      { root: '/tmp/unused', recordId: 'rec-ffffffffffffffff' },
      {
        _probe: () => ({ available: true }),
        _guard: () => heldGuard().guard,
        _readRecords: () => ({ records: [CLEAN_RECORD], duplicates: {} }),
      },
    ),
  );
});

// ── fresh-review F2 (#924): a title/content starting with `-` cannot be
// spawned safely as an `engram save` argv token — `engram save --help` shows
// no `--` escape (measured), so a leading `-` would be parsed as an option
// instead of a positional. `hydrate` must refuse to spawn rather than hand
// engram an argv it will misparse. The proper fix (an escape in the engram
// CLI itself) is upstream — nothing to file in this repo. ─────────────────

test('hydrate: a record whose title starts with "-" is deferred with reason "engram-argv-unsafe" — _engramSave is never called', async () => {
  const dashRecord = { ...CLEAN_RECORD, content: '**-x**\n\na title that starts with a dash' };
  const { guard } = heldGuard();
  let engramSaveCalled = false;
  const result = await hydrate(
    { root: '/tmp/unused', recordId: dashRecord.id, record: dashRecord },
    {
      _probe: () => ({ available: true }),
      _guard: () => guard,
      _engramSave: () => { engramSaveCalled = true; },
      _warn: () => {},
    },
  );
  assert.equal(engramSaveCalled, false, 'a leading "-" in the title must never reach the engram CLI spawn');
  assert.equal(result.written, 0);
  assert.equal(result.deferred, true);
  assert.equal(result.reason, 'engram-argv-unsafe');
});

// ── cold review E1 (#924): the argv guard skipped `project` — `_defaultEngramSave`
// also spawns `--project <project>`, and `save()`'s `deriveProject()` falls back to
// the checkout directory's basename (`String(root).split('/').pop()`) when no
// `project` is configured or passed, which may itself start with `-` (e.g. a
// worktree checked out as `/path/to/-repo`). `type` (one of format.mjs's
// RECORD_TYPES enum), `scope` (always the constant `'project'` from
// importRecord()), and `topic` (always the record's own id, always
// `rec-`-prefixed per format.mjs#computeRecordId) cannot start with `-`, so
// only `project` needs the same guard as title/content. ─────────────────────

test(
  'hydrate: a record whose project starts with "-" (deriveProject\'s checkout-basename fallback, e.g. a ' +
    '"-repo" worktree) is deferred with reason "engram-argv-unsafe" — _engramSave is never called',
  async () => {
    const dashProjectRecord = { ...CLEAN_RECORD, project: '-repo' };
    const { guard } = heldGuard();
    let engramSaveCalled = false;
    const result = await hydrate(
      { root: '/tmp/unused', recordId: dashProjectRecord.id, record: dashProjectRecord },
      {
        _probe: () => ({ available: true }),
        _guard: () => guard,
        _engramSave: () => { engramSaveCalled = true; },
        _warn: () => {},
      },
    );
    assert.equal(engramSaveCalled, false, 'a leading "-" in project must never reach the engram CLI spawn');
    assert.equal(result.written, 0);
    assert.equal(result.deferred, true);
    assert.equal(result.reason, 'engram-argv-unsafe');
  },
);

// ── cold review B1 (#924): a throwing _guard() must fold into the SAME
// deferred envelope as every other backend failure. `acquireHydrationGuard`'s
// `mkdirSync(staging)` is unguarded and can throw (ENOSPC, EACCES, …), and a
// rename error other than ENOTEMPTY/EEXIST/EPERM is rethrown too — either way
// R5's promise ("the record is durable before this runs; a backend failure
// here can never make the capture appear lost") must still hold. `_engramSave`
// must never be called, and since the guard was never actually taken, no
// release must happen either (there is nothing to release). ────────────────

test('hydrate: a throwing _guard() ⇒ {deferred:true, reason: "guard-failed: <code>"}, no throw propagates, _engramSave never called', async () => {
  let engramSaveCalled = false;
  const result = await hydrate(
    { root: '/tmp/unused', recordId: CLEAN_RECORD.id, record: CLEAN_RECORD },
    {
      _probe: () => ({ available: true }),
      _guard: () => { throw Object.assign(new Error('no space'), { code: 'ENOSPC' }); },
      _engramSave: () => { engramSaveCalled = true; },
      _warn: () => {},
    },
  );
  assert.equal(engramSaveCalled, false, 'a guard that never acquired must never reach _engramSave');
  assert.equal(result.written, 0);
  assert.equal(result.deferred, true);
  assert.match(result.reason, /guard-failed/);
  assert.match(result.reason, /ENOSPC/);
});
