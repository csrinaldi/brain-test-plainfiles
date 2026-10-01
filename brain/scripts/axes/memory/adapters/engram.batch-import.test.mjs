// engram.batch-import.test.mjs — issue #433.
//
// The import loop called `engram save` once per record: 1722 records × one
// execFileSync each = 1053 seconds, measured. That cost is paid by
// session-start.mjs (step 2) AND by the post-merge hook on every single
// `git pull`, both synchronously and both with the output suppressed.
//
// The fix is a BATCH path: read what engram already holds (one `engram export`,
// measured at 0.67s for 2248 observations), skip the records already there, and
// write the rest with ONE `engram import`. Two process spawns instead of N.
//
// ── The invariant this rests on, stated because it is load-bearing ──────────
//
// The old loop UPSERTED: `engram save --topic <record.id>` revised an existing
// observation when the record's content changed. The batch path SKIPS anything
// already present, which is only equivalent because **brain records are
// immutable** — a record id is content-derived (`rec-<hash>`), so changed
// content produces a NEW record rather than mutating an existing one.
//
// If that ever stops being true, this path starts silently ignoring updates.
// `records are immutable` below is the test that fails first if it does.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildImportPayload, importMemory, topicKeysFromExport } from './engram.mjs';
import { buildRecord } from '../../../memory/lib/format.mjs';

// #820: a faked backend has no store to protect — never take the real machine guard from a test.
const noGuard = () => ({ held: true, release() {} });


function rec(id, extra = {}) {
  return {
    id,
    ts: '2026-08-04T12:00:00Z',
    actor: '@t',
    actorKind: 'human',
    type: 'discovery',
    project: 'brain',
    content: `body of ${id}`,
    ...extra,
  };
}

// ── buildImportPayload — the delta ───────────────────────────────────────────

test('buildImportPayload: a record already in engram is SKIPPED, not re-sent', () => {
  const { payload, written, skipped } = buildImportPayload({
    records: [rec('rec-aaa'), rec('rec-bbb')],
    existingTopicKeys: new Set(['rec-aaa']),
    startedAt: '2026-08-04 12:00:00',
  });

  assert.equal(written, 1);
  assert.equal(skipped, 1);
  assert.deepEqual(payload.observations.map((o) => o.topic_key), ['rec-bbb']);
});

test('buildImportPayload: with nothing new there is no payload to send', () => {
  const { payload, written, skipped } = buildImportPayload({
    records: [rec('rec-aaa')],
    existingTopicKeys: new Set(['rec-aaa']),
    startedAt: '2026-08-04 12:00:00',
  });

  assert.equal(written, 0);
  assert.equal(skipped, 1);
  assert.equal(payload, null, 'nothing to import must produce no payload at all — not an empty one to spawn for');
});

// The record id IS the topic key. That is the whole idempotency anchor: it is
// what lets the next run recognise this record as already present.
test('buildImportPayload: every observation carries topic_key = record.id', () => {
  const { payload } = buildImportPayload({
    records: [rec('rec-aaa'), rec('rec-bbb')],
    existingTopicKeys: new Set(),
    startedAt: '2026-08-04 12:00:00',
  });

  assert.deepEqual(payload.observations.map((o) => o.topic_key).sort(), ['rec-aaa', 'rec-bbb']);
});

// Measured against the real binary: an observation whose session row is absent
// fails with `FOREIGN KEY constraint failed`. A `session_id: null` fails the
// same way. The session row is what establishes the project, so the payload has
// to carry one — this is not decoration.
test('buildImportPayload: a synthetic session row exists for each project present', () => {
  const { payload } = buildImportPayload({
    records: [rec('rec-aaa', { project: 'brain' }), rec('rec-bbb', { project: 'other' })],
    existingTopicKeys: new Set(),
    startedAt: '2026-08-04 12:00:00',
  });

  assert.deepEqual(payload.sessions.map((s) => s.project).sort(), ['brain', 'other']);
  for (const o of payload.observations) {
    const s = payload.sessions.find((x) => x.id === o.session_id);
    assert.ok(s, `observation for ${o.topic_key} references a session that is not in the payload`);
    assert.equal(s.project, o.project, 'an observation must hang off ITS OWN project session');
  }
});

// #1116 (parent #864, found by #1081 F6): engram 2.x's `import` REJECTS a
// session row with no `directory` — "pulled session directory is invalid:
// directory is required" — so a deferred record can never reach a FRESH
// engram 2.x store. Measured directly against the real binary (issue #1081
// evidence 45, reproduced again in this change's own verification) and
// against engram 1.20.0, which accepts the same field as harmless extra
// metadata. `root` is the repo root already threaded through every other
// `root`-accepting export in this file (see `repoRoot` at the top of
// engram.mjs) — reusing it as the session's `directory` costs nothing new.
test('buildImportPayload: every session row carries directory = root — engram 2.x rejects an import session with none (#1116)', () => {
  const { payload } = buildImportPayload({
    records: [rec('rec-aaa', { project: 'brain' }), rec('rec-bbb', { project: 'other' })],
    existingTopicKeys: new Set(),
    startedAt: '2026-08-04 12:00:00',
    root: '/fake/repo/root',
  });

  assert.ok(payload.sessions.length > 0, 'fixture must produce at least one session to check');
  for (const s of payload.sessions) {
    assert.equal(
      s.directory,
      '/fake/repo/root',
      'a session with no directory is what makes engram 2.x refuse the whole import (#1116)',
    );
  }
});

test('buildImportPayload: the payload is in the shape engram import accepts', () => {
  const { payload } = buildImportPayload({
    records: [rec('rec-aaa')],
    existingTopicKeys: new Set(),
    startedAt: '2026-08-04 12:00:00',
  });

  assert.deepEqual(Object.keys(payload).sort(), ['exported_at', 'observations', 'prompts', 'sessions', 'version']);
  const o = payload.observations[0];
  for (const k of ['title', 'content', 'type', 'project', 'scope', 'topic_key', 'session_id']) {
    assert.ok(k in o, `observation is missing required field "${k}"`);
  }
});

// ── The invariant ────────────────────────────────────────────────────────────

// Not a behavioural test of the batch path — a guard on the PREMISE that makes
// skip-if-exists equivalent to the upsert it replaces. buildRecord derives the
// id from the content, so two different bodies can never share an id, and an
// edit therefore produces a new record instead of mutating one already imported.
test('records are immutable: a content change yields a DIFFERENT record id', () => {
  const common = { type: 'discovery', project: 'brain', actor: '@t', actorKind: 'human', ts: '2026-08-04T12:00:00Z' };
  const a = buildRecord({ ...common, content: 'one' });
  const b = buildRecord({ ...common, content: 'two' });

  assert.notEqual(a.id, b.id,
    'skip-if-exists is only equivalent to an upsert while record ids are content-derived — ' +
    'if this fails, the batch import is silently dropping updates');
});

// ── importMemory — the cost that made #433 ───────────────────────────────────

test('importMemory: ONE import call, not one save per record (#433)', async () => {
  const records = Array.from({ length: 50 }, (_, i) => rec(`rec-${i}`));
  const imports = [];

  const res = await importMemory({
    _guard: noGuard,
    root: '/tmp/nonexistent',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records }),
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: (payload) => { imports.push(payload); },
    _log: () => {},
  });

  assert.equal(res.written, 50);
  assert.equal(imports.length, 1, `50 records must cost ONE import; got ${imports.length}`);

  // This used to also pass `_engramSave` and assert `saves === 0`. importMemory
  // has no such parameter, so the counter could never move and the assertion
  // could never fail — a green tick over nothing, which is the same species as
  // the fake that could not see the duplication. The real guarantee is that the
  // signature carries no per-record write seam at all:
  assert.ok(
    !/_engramSave/.test(importMemory.toString()),
    'the per-record save path must be gone from importMemory entirely — it is the whole defect',
  );
});

test('importMemory: a second run over the same records sends NOTHING (#433 + idempotency)', async () => {
  const records = [rec('rec-aaa'), rec('rec-bbb')];
  let store = new Set();
  const imports = [];

  const run = () => importMemory({
    _guard: noGuard,
    root: '/tmp/nonexistent',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records }),
    _engramExistingTopicKeys: () => new Set(store),
    _engramImport: (payload) => {
      imports.push(payload);
      for (const o of payload.observations) store.add(o.topic_key);
    },
    _log: () => {},
  });

  const first = await run();
  const second = await run();

  assert.equal(first.written, 2);
  assert.equal(second.written, 0, 're-running must send nothing — engram import DUPLICATES, it does not upsert');
  assert.equal(imports.length, 1, 'the second run must not spawn an import at all');
});

test('importMemory: empty records/ → zero writes, no import spawned, no throw', async () => {
  const imports = [];
  const res = await importMemory({
    _guard: noGuard,
    root: '/tmp/nonexistent',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records: [] }),
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: (p) => imports.push(p),
    _log: () => {},
  });

  assert.equal(res.written, 0);
  assert.equal(imports.length, 0);
});

// ── The unreadable-state path — fail closed, never "import everything" ───────
//
// Reading what engram already holds is the delta's only input, and it runs over
// a store that may be empty, locked, or from another engram version. The obvious
// degradation — "import everything, correct merely slower" — is WRONG, measured
// against the real binary: `engram import` INSERTS, so re-sending known records
// doubles them, and it never self-heals because the next run reads the duplicate
// keys back and skips them.
//
// So these tests use a store with INSERT semantics (an array, not a Set). A fake
// that dedupes cannot see this defect — that is exactly how it was pinned as
// intended behaviour in the first place.

function insertStore() {
  const rows = [];
  return {
    rows,
    keys: () => new Set(rows),
    insert: (payload) => { for (const o of payload.observations) rows.push(o.topic_key); },
  };
}

test('importMemory: an unreadable state SKIPS the import — a full re-import would DUPLICATE the store', async () => {
  const store = insertStore();
  const records = [rec('rec-aaa'), rec('rec-bbb')];
  const imports = [];
  const logs = [];

  // First run populates the store normally.
  await importMemory({
    _guard: noGuard,
    root: '/tmp/nonexistent',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records }),
    _engramExistingTopicKeys: () => store.keys(),
    _engramImport: (p) => { imports.push(p); store.insert(p); },
    _log: () => {},
  });
  assert.deepEqual(store.rows, ['rec-aaa', 'rec-bbb']);

  // Second run: the read fails, exactly as a locked DB on the `git pull` path would.
  const res = await importMemory({
    _guard: noGuard,
    root: '/tmp/nonexistent',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records }),
    _engramExistingTopicKeys: () => { throw new Error('database is locked'); },
    _engramImport: (p) => { imports.push(p); store.insert(p); },
    _warn: (line) => logs.push(line),
    _log: () => {},
  });

  // The damage assertion first, so a regression reports what actually broke.
  assert.deepEqual(store.rows, ['rec-aaa', 'rec-bbb'],
    'the store must be untouched — degrading to a full import is what DOUBLES it, permanently');
  assert.equal(imports.length, 1, 'the failed run must not spawn an import at all');
  assert.equal(res.written, 0);
  assert.equal(res.deferred, true, 'the caller must be able to tell "nothing new" from "did not run"');
  assert.match(logs.join('\n'), /database is locked/, 'the reason must be surfaced on stderr — the hook discards stdout');
});

// The deferred warning has to reach a stream the deployment does not discard.
// post-merge redirects stdout to /dev/null, so stdout would be as silent as the
// duplication this replaced.
test('importMemory: the deferred warning goes to STDERR, not stdout (#448)', async () => {
  const out = [];
  const errs = [];
  await importMemory({
    _guard: noGuard,
    root: '/tmp/nonexistent',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records: [rec('rec-aaa')] }),
    _engramExistingTopicKeys: () => { throw new Error('database is locked'); },
    _engramImport: () => {},
    _log: (l) => out.push(l),
    _warn: (l) => errs.push(l),
  });

  assert.match(errs.join('\n'), /database is locked/, 'the skip must report on stderr');
  assert.equal(
    out.join('\n').includes('database is locked'),
    false,
    'stdout is discarded by the post-merge hook — reporting there is reporting nowhere',
  );
});

test('importMemory: a reader that returns a non-Set is uncomputable too, not an empty store', async () => {
  const imports = [];
  const res = await importMemory({
    _guard: noGuard,
    root: '/tmp/nonexistent',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records: [rec('rec-aaa')] }),
    _engramExistingTopicKeys: () => null,
    _engramImport: (p) => imports.push(p),
    _log: () => {},
  });

  assert.equal(imports.length, 0);
  assert.equal(res.deferred, true);
});

// The other half of the distinction: a store that is genuinely empty is NOT a
// failure, and must still import everything. Failing closed on both would make
// first-ever hydration impossible.
test('importMemory: a genuinely EMPTY store still imports everything', async () => {
  const imports = [];
  const res = await importMemory({
    _guard: noGuard,
    root: '/tmp/nonexistent',
    _requireEngram: () => 'engram',
    _readRecords: () => ({ records: [rec('rec-aaa')] }),
    _engramExistingTopicKeys: () => new Set(),
    _engramImport: (p) => imports.push(p),
    _log: () => {},
  });

  assert.equal(res.written, 1);
  assert.equal(imports.length, 1);
  assert.notEqual(res.deferred, true);
});

// ── topicKeysFromExport — the guard, now reachable from the suite (#448) ─────
//
// These exist because the guard was NOT reachable before: every test above
// injects `_engramExistingTopicKeys`, so the default reader was never executed.
// Measured — neutralising the cross-check to `if (false && …)` left the whole
// suite at 2416/2416 green. The schema-drift proof was real but MANUAL, and a
// manual proof does not survive the next edit.

const OK_STDOUT = 'Exported to /tmp/x.json\n  Sessions:     3\n  Observations: 2\n  Prompts:      0\n';

test('topicKeysFromExport: the reported count matching the file yields the keys', () => {
  const file = JSON.stringify({
    version: '0.1.0',
    observations: [{ topic_key: 'rec-aaa' }, { topic_key: 'rec-bbb' }],
  });
  const keys = topicKeysFromExport(OK_STDOUT, file);
  assert.deepEqual([...keys].sort(), ['rec-aaa', 'rec-bbb']);
});

// The legitimately-EMPTY store. Measured against engram v1.17.0: it exports
// `"observations": null`, not `[]`. This case must yield an empty Set so a
// first-ever hydration still imports everything — failing closed here would
// make brain unable to populate an empty engram at all.
//
// It is also the case a version allowlist would have refused for no reason,
// which is why the count was chosen over a version check. Pinned as the record
// of that decision.
test('topicKeysFromExport: a genuinely EMPTY store (observations: null, reported 0) is an empty Set, not a failure', () => {
  const stdout = 'Exported to /tmp/x.json\n  Sessions:     0\n  Observations: 0\n  Prompts:      0\n';
  const file = JSON.stringify({ version: '0.1.0', sessions: null, observations: null, prompts: null });
  const keys = topicKeysFromExport(stdout, file);
  assert.ok(keys instanceof Set);
  assert.equal(keys.size, 0);
});

test('topicKeysFromExport: a count mismatch THROWS — it never degrades to an empty Set', () => {
  // What a moved schema looks like from here: engram wrote 2, we parsed 0.
  const file = JSON.stringify({ version: '0.2.0', observationsRenamed: [{ topic_key: 'rec-aaa' }] });
  assert.throws(
    () => topicKeysFromExport(OK_STDOUT, file),
    /reported 2 observations but the file carries 0/,
    'a disagreement between engram and the parse must fail closed — an empty Set here becomes a full re-import, which DUPLICATES the store',
  );
});

test('topicKeysFromExport: no count on stdout THROWS — an unconfirmable export is not an empty store', () => {
  const file = JSON.stringify({ version: '0.1.0', observations: [] });
  assert.throws(
    () => topicKeysFromExport('Exported to /tmp/x.json\n', file),
    /no observation count on stdout/,
  );
});

test('topicKeysFromExport: an observations field that is not an array THROWS, naming the schema', () => {
  const file = JSON.stringify({ version: '9.9.9', observations: { rows: [] } });
  assert.throws(
    () => topicKeysFromExport(OK_STDOUT, file),
    /not an array — this reader was not written against export schema 9\.9\.9/,
  );
});
