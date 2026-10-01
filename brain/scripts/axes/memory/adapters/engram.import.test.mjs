// engram.import.test.mjs — unit tests for importMemory() gone records-only
// (design.md Decision 2 / D2, C4 #229): read `.memory/records/*.jsonl` via
// readRecordObservations, transform via importRecord(), write per-record via
// `engram save` with progress reporting. Replaces the former thin
// `engram sync --import` wrapper — no chunk path is read anymore.
//
// All seams are injected so no real engram/git subprocess is spawned and no
// real `.memory/` is touched.
//
// RED: importMemory's records-only signature (accepting _readRecords /
// _importRecord / _engramSave / _log seams) does not exist until engram.mjs
// is rewired.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importMemory } from './engram.mjs';
import { buildRecord } from '../../../memory/lib/format.mjs';
import { join as joinPath } from 'node:path';
import { testTmp } from '../../../lib/test-tmp.mjs';
import { acquireHydrationGuard } from '../../../memory/lib/hydration-guard.mjs';

// #820: a faked backend has no store to protect — never take the real machine guard from a test.
const noGuard = () => ({ held: true, release() {} });


function fixtureRecords(n) {
  const records = [];
  for (let i = 0; i < n; i++) {
    records.push(
      buildRecord({
        ts: `2026-07-0${(i % 9) + 1}T01:19:12Z`,
        actor: '@crinaldi',
        actorKind: 'human',
        type: 'decision',
        project: 'brain',
        content: `Fixture decision number ${i}.`,
        title: `Fixture ${i}`,
      }),
    );
  }
  return records;
}

// ---------------------------------------------------------------------------
// (a) records-only pull hydrates engram — REQ-C4-2 scenario 1
// ---------------------------------------------------------------------------

// REWRITTEN for #433. The requirement this test exists for — REQ-C4-2 scenario
// 1, "a records-only pull hydrates engram" — is unchanged and still asserted
// below, field for field. What changed is the MECHANISM it was written against:
// the old body asserted "exactly one _engramSave per record", and that per-record
// spawn IS the defect #433 removes (1722 records = 1053 seconds, paid on every
// `git pull`). Asserting it would now pin the bug in place.
test('importMemory: reads records via _readRecords and hydrates engram in ONE batch (REQ-C4-2 s1, #433)', async () => {
  const records = fixtureRecords(3);
  const imports = [];

  const result = await importMemory({
    _guard: noGuard,
    root: '/fake/root',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records }),
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: (payload) => imports.push(payload),
    _log: () => {},
  });

  assert.equal(imports.length, 1, 'three records must cost ONE import, not three saves');
  const sent = imports[0].observations;
  assert.equal(sent.length, 3, 'every record must reach engram');
  for (let i = 0; i < records.length; i++) {
    const o = sent.find((x) => x.topic_key === records[i].id);
    assert.ok(o, 'topic_key must be the record content-addressed id — the anchor the next run reads back');
    assert.equal(o.type, records[i].type);
    assert.equal(o.project, records[i].project);
  }
  assert.equal(result.written, 3, 'accounting must report 3 written');
});

test('importMemory: no chunk path is read — never spawns `engram sync --import`', async () => {
  const records = fixtureRecords(1);
  let chunkPathTouched = false;

  await importMemory({
    _guard: noGuard,
    root: '/fake/root',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records }),
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: () => {},
    _log: () => {},
    // If importMemory still tried the old chunk path it would need a real
    // execFileSync/spawn call — none is injected here, so any attempt to
    // reach outside the injected seams would throw (no real engram binary
    // resolution happens beyond the injected _requireEngram stub).
    //
    // #433 note: that comment is not decorative — it fired. The batch import
    // replaced the `_engramSave` stub above with `_engramImport`, and leaving
    // the old one here made this test shell out to a real `engram import`.
    // It stayed green locally (the binary is installed) and failed in CI with
    // `spawnSync engram ENOENT`. A hermetic test only stays hermetic if every
    // seam it relies on is named explicitly.
  });

  assert.equal(chunkPathTouched, false, 'no chunk-path seam was ever invoked');
});

// #1116 (parent #864, found by #1081 F6): a FRESH engram 2.x store rejects
// brain's import session with "pulled session directory is invalid:
// directory is required" because the session row `buildImportPayload` builds
// carries no `directory`. `importMemory` already threads `root` through as
// the repo root (see the `root: '/fake/root'` seam above) — this pins that
// the same value reaches the session payload engram actually sees.
test('importMemory: the session payload carries directory = root — engram 2.x refuses an import session with none (#1116)', async () => {
  const records = fixtureRecords(1);
  const imports = [];

  await importMemory({
    _guard: noGuard,
    root: '/fake/root',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records }),
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: (payload) => imports.push(payload),
    _log: () => {},
  });

  assert.equal(imports.length, 1);
  assert.equal(
    imports[0].sessions[0].directory,
    '/fake/root',
    'engram 2.x: "pulled session directory is invalid: directory is required" — see #1116',
  );
});

test('importMemory: empty records/ → zero writes, no throw', async () => {
  const progressLines = [];
  const result = await importMemory({
    _guard: noGuard,
    root: '/fake/root',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records: [] }),
    _engramSave: () => {
      throw new Error('_engramSave must not be called when there are no records');
    },
    _log: (line) => progressLines.push(line),
  });
  assert.equal(result.written, 0);
});

// ---------------------------------------------------------------------------
// (b) idempotency — REQ-C4-2 scenario 2 (MANDATORY)
// ---------------------------------------------------------------------------
//
// Mechanism proven here: engram's REAL dedup for a repeated `engram save`
// call is topic_key-based UPSERT (verified against the engram Go source,
// internal/store/store.go AddObservation ~line 2003: a topic_key match on
// the same project+scope UPDATES the existing row — no time window). This is
// DISTINCT from the content-hash dedup path in the same function (~line
// 2050), which is windowed to 15 minutes (store.NewConfig DedupeWindow
// default) and therefore NOT safe for an idempotency guarantee that must
// hold across arbitrarily-spaced re-runs (day-start pulls, etc).
//
// importMemory() passes `topic: record.id` (the record's own content-
// addressed id) as the `engram save --topic` value, so a second run over the
// same records resolves to the SAME topic_key per record and revises the
// existing observation instead of inserting a new one. The fake store below
// mirrors that exact upsert semantics (keyed on project+scope+topic) to
// prove the behavior without spawning a real engram process.
// REWRITTEN for #433, and the rewrite is deliberately STRICTER than what it
// replaces. Read this before touching it.
//
// The GUARANTEE — "re-running over the same records creates no duplicate
// observations" — is unchanged and is still the load-bearing assertion below.
// Only the mechanism moved, and it had to:
//
//   old: N × `engram save --topic <id>`, where engram UPSERTS on topic_key.
//        Re-running re-sent all 5 and engram revised them in place, so the
//        proof was "row count unchanged, revisionCount incremented".
//   new: one `engram import`, which — measured against the real binary —
//        INSERTS. Importing the same file twice turned 2 observations into 4.
//        Engram will not deduplicate for us, so the second run must send
//        NOTHING, and that is now asserted directly.
//
// `revisionCount` is gone from this fake because nothing is revised any more.
// That is equivalent only because brain records are IMMUTABLE — an id is
// content-derived, so an edit produces a new record rather than mutating an
// imported one. `engram.batch-import.test.mjs` pins that premise on its own.
//
// This fake therefore mirrors the REAL insert semantics, not a forgiving
// upsert: a repeated topic_key creates a SECOND row, so a regression that
// re-sends known records fails here loudly instead of being absorbed.
function makeFakeEngramStore() {
  const rows = []; // insert-only, exactly like `engram import`
  const _engramImport = (payload) => {
    for (const o of payload.observations) rows.push({ ...o });
  };
  const _engramExistingTopicKeys = () => new Set(rows.map((r) => r.topic_key));
  return { rows, _engramImport, _engramExistingTopicKeys };
}

test('importMemory: re-running over the same records creates NO duplicate observations (idempotency, MANDATORY)', async () => {
  const records = fixtureRecords(5);
  const store = makeFakeEngramStore();
  const run = () => importMemory({
    _guard: noGuard,
    root: '/fake/root',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records }),
    _engramExistingTopicKeys: store._engramExistingTopicKeys,
    _engramImport: store._engramImport,
    _log: () => {},
  });

  const first = await run();
  assert.equal(first.written, 5);
  assert.equal(store.rows.length, 5, 'first run must create exactly 5 observations');

  const second = await run();

  // THE load-bearing assertion, unchanged in intent: the store holds the same
  // 5 observations. Under an inserting backend this can only hold if the second
  // run sent nothing at all.
  assert.equal(store.rows.length, 5, 'second run must not add any observation — zero duplicates');
  assert.equal(second.written, 0, 'nothing new to send: every record is already present');
  assert.equal(second.skipped, 5, 'and all 5 must be accounted for as skipped, not silently dropped');

  const keys = store.rows.map((r) => r.topic_key);
  assert.equal(new Set(keys).size, 5, 'every stored topic_key must still be distinct');
});

// ── #820 — the hydration guard around the read→write window ────────────────


function sharedGuard() {
  const lockPath = joinPath(testTmp('import-guard-'), 'brain-memory-hydration.lock');
  return () => acquireHydrationGuard({ lockPath, _pidAlive: () => true });
}

test('importMemory (#820 shape): importer B started inside A\'s read window is CONTENDED — one payload reaches engram, not two', async () => {
  const records = fixtureRecords(3);
  const imports = [];
  const warned = [];
  const _guard = sharedGuard();
  let bPromise = null;

  const a = await importMemory({
    _requireEngram: () => ({}),
    _readRecords: () => records,
    _engramExistingTopicKeys: () => {
      // While A holds the guard between its read and its write, B starts.
      bPromise = importMemory({
        _requireEngram: () => ({}),
        _readRecords: () => records,
        _engramExistingTopicKeys: () => new Set(),
        _engramImport: (payload) => imports.push(['B', payload]),
        _warn: (m) => warned.push(m),
        _guard,
      });
      return new Set();
    },
    _engramImport: (payload) => imports.push(['A', payload]),
    _warn: (m) => warned.push(m),
    _guard,
  });
  const b = await bPromise;

  assert.equal(imports.length, 1, 'exactly one import payload');
  assert.equal(imports[0][0], 'A');
  assert.equal(a.written, 3);
  assert.equal(b.deferred, true);
  assert.equal(b.contended, true);
  assert.equal(b.written, 0);
  assert.equal(warned.length, 1, 'B said so, once');
  assert.match(warned[0], /another hydration/i);
});

test('importMemory: contended path never waits and never throws — returns deferred, writes nothing', async () => {
  const lockPath = joinPath(testTmp('import-guard-'), 'brain-memory-hydration.lock');
  const holder = acquireHydrationGuard({ lockPath, _pidAlive: () => true, _pid: 7 });
  assert.equal(holder.held, true);
  let imported = 0;
  const started = Date.now();
  const r = await importMemory({
    _requireEngram: () => ({}),
    _readRecords: () => fixtureRecords(2),
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: () => { imported++; },
    _warn: () => {},
    _guard: () => acquireHydrationGuard({ lockPath, _pidAlive: () => true }),
  });
  holder.release();
  assert.equal(imported, 0);
  assert.deepEqual({ deferred: r.deferred, contended: r.contended, written: r.written }, { deferred: true, contended: true, written: 0 });
  assert.ok(Date.now() - started < 1000, 'no waiting');
});

test('importMemory: the guard is released after the write, so the NEXT run proceeds', async () => {
  const _guard = sharedGuard();
  let imported = 0;
  const opts = () => ({
    _requireEngram: () => ({}),
    _readRecords: () => fixtureRecords(1),
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: () => { imported++; },
    _warn: () => {},
    _guard,
  });
  await importMemory(opts());
  await importMemory(opts());
  assert.equal(imported, 2);
});

test('importMemory: the guard is released when the read throws (unreadable store path)', async () => {
  const _guard = sharedGuard();
  let imported = 0;
  const r1 = await importMemory({
    _requireEngram: () => ({}),
    _readRecords: () => fixtureRecords(1),
    _engramExistingTopicKeys: () => { throw new Error('engram: locked'); },
    _engramImport: () => { imported++; },
    _warn: () => {},
    _guard,
  });
  assert.equal(r1.deferred, true);
  const r2 = await importMemory({
    _requireEngram: () => ({}),
    _readRecords: () => fixtureRecords(1),
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: () => { imported++; },
    _warn: () => {},
    _guard,
  });
  assert.equal(r2.written, 1);
  assert.equal(imported, 1);
});
