// format.test.mjs — unit tests for the durable memory record format (REQ-MF-1, REQ-MF-2, REQ-MF-5).
//
// Pure-function contract: no FS, no engram, no child processes (brain/scripts/memory/lib/store.mjs
// owns the I/O side; see store.test.mjs for reindex/append behavior).
//
// RED: these imports fail until format.mjs is created (task C1a.1).
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  RECORD_TYPES,
  canonicalJson,
  computeRecordId,
  buildRecord,
  validateRecord,
  validateWritableRecord,
  serializeRecord,
  parseRecordLine,
  buildIndexEntry,
  serializeIndex,
  nowUtcSeconds,
  classifyActor,
} from './format.mjs';

// ── canonicalJson (RFC 8785 JCS) ──────────────────────────────────────────────

test('canonicalJson: sorts keys regardless of insertion order', () => {
  const a = canonicalJson({ b: 1, a: 2 });
  const b = canonicalJson({ a: 2, b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":2,"b":1}');
});

test('canonicalJson: whitespace-variant objects canonicalize identically', () => {
  const a = canonicalJson(JSON.parse('{"a":1,"b":2}'));
  const b = canonicalJson(JSON.parse('{ "b" : 2 , "a" : 1 }'));
  assert.equal(a, b);
});

// ── computeRecordId (content hash, REQ-MF-2) ─────────────────────────────────

const base = {
  type: 'decision',
  actor: '@crinaldi',
  actorKind: 'human',
  ts: '2026-07-04T12:00:00Z',
  project: 'brain',
  content: 'We chose union merge.',
};

test('computeRecordId: identical semantic fields hash identically across differing source', () => {
  const idA = computeRecordId({ ...base, source: 'issue #201' });
  const idB = computeRecordId({ ...base, source: 'PR #204 (differs)' });
  assert.equal(idA, idB);
  assert.match(idA, /^rec-[0-9a-f]{16}$/);
});

test('computeRecordId: a changed semantic field changes the id', () => {
  const idA = computeRecordId(base);
  const idB = computeRecordId({ ...base, content: 'Different content.' });
  assert.notEqual(idA, idB);
});

test('computeRecordId: absent optional (issue) vs another absent optional hash the same', () => {
  const idA = computeRecordId({ ...base });
  const idB = computeRecordId({ ...base });
  assert.equal(idA, idB);
});

// ── buildRecord (R2 title fold, R3 absent optionals omitted) ─────────────────

test('buildRecord: R2 folds a non-empty title into content BEFORE hashing', () => {
  const withTitle = buildRecord({ ...base, title: 'Union merge chosen' });
  const withoutTitle = buildRecord({ ...base, content: '**Union merge chosen**\n\nWe chose union merge.' });
  assert.equal(withTitle.content, '**Union merge chosen**\n\nWe chose union merge.');
  // Folding is deterministic — feeding the already-folded content directly yields the same id.
  assert.equal(withTitle.id, withoutTitle.id);
});

test('buildRecord: an empty title leaves content unchanged', () => {
  const rec = buildRecord({ ...base, title: '' });
  assert.equal(rec.content, base.content);
});

test('buildRecord: R3 absent issue/supersedes/source are OMITTED from the record, never null', () => {
  const rec = buildRecord({ ...base });
  assert.equal('issue' in rec, false);
  assert.equal('supersedes' in rec, false);
  assert.equal('source' in rec, false);
});

test('buildRecord: present optionals are carried through', () => {
  const rec = buildRecord({ ...base, issue: 205, source: 'issue #205' });
  assert.equal(rec.issue, 205);
  assert.equal(rec.source, 'issue #205');
});

// ── supersedes (#805) — pin only, no format.mjs edit; the field already
// round-trips through hashInput (R2/R3) and the writable-record gates. ────

test('buildRecord: a supersedes value changes the id versus the same content without it (#805)', () => {
  const withoutSupersedes = buildRecord({ ...base });
  const withSupersedes = buildRecord({ ...base, supersedes: 'rec-0123456789abcdef' });
  assert.notEqual(withSupersedes.id, withoutSupersedes.id);
  assert.equal(withSupersedes.supersedes, 'rec-0123456789abcdef');
});

test('buildRecord: an absent supersedes stays omitted, never null (R3, #805)', () => {
  const rec = buildRecord({ ...base });
  assert.equal('supersedes' in rec, false);
});

// ── validateRecord (REQ-MF-1, REQ-MF-5 partial) ───────────────────────────────

test('validateRecord: accepts a well-formed record', () => {
  const rec = buildRecord({ ...base });
  const { valid, errors } = validateRecord(rec);
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
});

test('validateRecord: rejects a missing required field', () => {
  const rec = buildRecord({ ...base });
  delete rec.project;
  const { valid, errors } = validateRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('project')));
});

test('validateRecord: rejects a non-enum type', () => {
  const rec = { ...buildRecord({ ...base }), type: 'manual' };
  const { valid, errors } = validateRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('type')));
});

test('validateRecord: rejects a naive (non-UTC) ts', () => {
  const rec = { ...buildRecord({ ...base }), ts: '2026-07-04 12:00:00' };
  const { valid, errors } = validateRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('ts')));
});

test('validateRecord: rejects an invalid actorKind', () => {
  const rec = { ...buildRecord({ ...base }), actorKind: 'robot' };
  const { valid, errors } = validateRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('actorKind')));
});

test('validateRecord: rejects a null optional field (R3)', () => {
  const rec = { ...buildRecord({ ...base }), issue: null };
  const { valid, errors } = validateRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('issue')));
});

test('validateRecord: accepts a record carrying supersedes (#805)', () => {
  const rec = buildRecord({ ...base, supersedes: 'rec-0123456789abcdef' });
  const { valid, errors } = validateRecord(rec);
  assert.equal(valid, true, errors.join('; '));
});

// ── W1/W2 (issue #404): the WRITE-path rules ────────────────────────────────
// `issue` and `source` share ONE `**Fuente:**` line, so a `source` carrying a
// newline pushes its tail into the body — the issue citation falls off the
// line AND the hashed `content` gains bytes. A string `issue` re-imports as a
// number, a different id.
//
// These live in validateWritableRecord(), NOT validateRecord(), and the split
// is the point: validateRecord() runs on the READ path (parseRecordLine
// throws), over `.memory/**`, which is consumer-owned and never touched by a
// brain upgrade. A new read rule would turn one pre-existing line into a
// store-wide failure brain has no way to migrate. The pair of tests below pins
// exactly that asymmetry — delete either half and the protection is gone.

test('validateRecord: the READ gate does NOT reject a multi-line source (a pre-existing store must stay readable)', () => {
  const rec = { ...buildRecord({ ...base }), source: 'see the tracker\n(context: issue #999)' };
  assert.equal(validateRecord(rec).valid, true, 'a read-path rejection would brick a consumer store');
});

test('validateRecord: the READ gate does NOT reject a string issue (same reason)', () => {
  const rec = { ...buildRecord({ ...base }), issue: '404' };
  assert.equal(validateRecord(rec).valid, true);
});

test('validateWritableRecord: W1 rejects a multi-line source', () => {
  const rec = { ...buildRecord({ ...base }), source: 'see the tracker\n(context: issue #999)' };
  const { valid, errors } = validateWritableRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('W1')), `errors were: ${errors.join('; ')}`);
});

test('validateWritableRecord: W1 rejects an untrimmed source', () => {
  const rec = { ...buildRecord({ ...base }), source: '  PR #405 ' };
  const { valid, errors } = validateWritableRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('W1')), `errors were: ${errors.join('; ')}`);
});

test('validateWritableRecord: W2 rejects a non-number issue', () => {
  const rec = { ...buildRecord({ ...base }), issue: '404' };
  const { valid, errors } = validateWritableRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('W2')), `errors were: ${errors.join('; ')}`);
});

test('validateWritableRecord: accepts the shapes brain actually writes', () => {
  // The whole real store's three source shapes, plus the issue-carrying shapes
  // #368 will produce, plus ADR-0017's canonical citation.
  for (const fields of [
    { source: 'provenance unknown — migrated from engram chunk obs-1034b42dcca30459' },
    { source: 'plainfiles save on gandalf-ROG-Zephyrus-G15-GA503QR-GA503QR' },
    { issue: 404, source: 'PR #405' },
    { issue: 404 },
    { issue: 0 },
    { issue: 201, source: 'issue #201 / PR #204' },
    {},
  ]) {
    const { valid, errors } = validateWritableRecord(buildRecord({ ...base, ...fields }));
    assert.equal(valid, true, `${JSON.stringify(fields)} must be writable — ${errors.join('; ')}`);
  }
});

// ── W3 (#738): the write gate refuses a branch-shaped actor ─────────────────
// `HANDLE_RE`/`DEFAULT_BRANCHES`/`classifyActor` move here from `audit.mjs`
// (design A4) so the schema owner holds the predicate; `audit.mjs` imports
// them instead of redefining them, and `audit.test.mjs` stays green
// UNMODIFIED — the proof the move is behaviour-preserving.

test('classifyActor: exported from format.mjs, identical behaviour to the prior audit.mjs definition', () => {
  assert.equal(classifyActor('@csrinaldi'), 'handle');
  assert.equal(classifyActor('@legacy'), 'legacy');
  assert.equal(classifyActor('feat/issue-738-x'), 'branch');
  assert.equal(classifyActor('main'), 'branch');
  assert.equal(classifyActor('crinaldi'), 'other');
});

for (const actor of ['feat/x', 'main', 'master', 'develop', 'trunk']) {
  test(`validateWritableRecord: W3 refuses a branch-shaped actor ('${actor}')`, () => {
    const rec = { ...buildRecord({ ...base, actor }) };
    const { valid, errors } = validateWritableRecord(rec);
    assert.equal(valid, false);
    assert.ok(errors.some((e) => e.includes('W3')), `errors were: ${errors.join('; ')}`);
  });

  test(`validateRecord: the READ gate still ADMITS a branch-shaped actor ('${actor}'), unchanged`, () => {
    const rec = { ...buildRecord({ ...base, actor }) };
    assert.equal(validateRecord(rec).valid, true, 'a read-path rejection would brick a consumer store');
  });
}

for (const actor of ['@legacy', '@csrinaldi', 'crinaldi']) {
  test(`validateWritableRecord: W3 admits a non-branch-shaped actor ('${actor}')`, () => {
    const rec = { ...buildRecord({ ...base, actor }) };
    const { valid, errors } = validateWritableRecord(rec);
    assert.equal(valid, true, `${actor} must be writable — ${errors.join('; ')}`);
  });
}

test('validateWritableRecord: still reports every read-gate error (it is a superset, not a replacement)', () => {
  const { valid, errors } = validateWritableRecord({ ...buildRecord({ ...base }), issue: null, type: 'nope' });
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('R3')), `errors were: ${errors.join('; ')}`);
  assert.ok(errors.some((e) => e.includes('invalid type')), `errors were: ${errors.join('; ')}`);
});

// ── W4 (#461 "Case 4"): a source citing an issue the record does not declare
// fabricates that issue on round-trip. `issue` and `source` share ONE
// '**Fuente:**' line (provenance.mjs's renderFuente), so `{source: 'issue
// #201 / PR #204'}` (no `issue`) renders byte-identical to `{issue: 201,
// source: 'PR #204'}` — the two are indistinguishable on the wire. WRITE-time
// only, same asymmetry as W1-W3: #460's ruling against a READ-path rule for
// this exact shape stands, so a record already carrying it must still parse.

test('validateWritableRecord: W4 rejects a source citing an issue the record does not declare', () => {
  const rec = { ...buildRecord({ ...base }), source: 'issue #201 / PR #204' };
  const { valid, errors } = validateWritableRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('W4')), `errors were: ${errors.join('; ')}`);
});

test('validateWritableRecord: W4 rejects a source citing a DIFFERENT issue than the one declared', () => {
  const rec = { ...buildRecord({ ...base, issue: 405 }), source: 'issue #201 / PR #204' };
  const { valid, errors } = validateWritableRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('W4')), `errors were: ${errors.join('; ')}`);
});

test('validateWritableRecord: W4 admits a source citing the SAME issue the record declares', () => {
  const rec = buildRecord({ ...base, issue: 201, source: 'issue #201 / PR #204' });
  const { valid, errors } = validateWritableRecord(rec);
  assert.equal(valid, true, errors.join('; '));
});

test('validateWritableRecord: W4 does not fire on a source with no issue citation at all', () => {
  const rec = buildRecord({ ...base, source: 'PR #405' });
  const { valid, errors } = validateWritableRecord(rec);
  assert.equal(valid, true, errors.join('; '));
});

test(
  "validateRecord/parseRecordLine: the READ gate does NOT reject the W4 shape — a pre-existing record " +
    "carrying it must still parse (#461, #460's ruling against a read-path rule stands)",
  () => {
    const rec = { ...buildRecord({ ...base }), source: 'issue #201 / PR #204' };
    assert.equal(
      validateRecord(rec).valid,
      true,
      'a read-path rejection would brick a consumer store — #460 ruled this OUT',
    );
    assert.deepEqual(parseRecordLine(serializeRecord(rec)), rec);
  },
);

test('validateRecord: flags an email-shaped actor (REQ-MF-5 partial heuristic)', () => {
  const rec = { ...buildRecord({ ...base }), actor: 'someone@example.com' };
  const { valid, errors } = validateRecord(rec);
  assert.equal(valid, false);
  assert.ok(errors.some((e) => e.includes('actor')));
});

test('RECORD_TYPES exports the seven-member enum', () => {
  assert.deepEqual(RECORD_TYPES, [
    'decision', 'architecture', 'pattern', 'bugfix', 'config', 'discovery', 'session_summary',
  ]);
});

// ── serializeRecord / parseRecordLine (one physical JSONL line) ──────────────

test('serializeRecord: multi-line content is escaped into one physical line', () => {
  const rec = buildRecord({ ...base, content: 'line one\nline two\nline three' });
  const line = serializeRecord(rec);
  assert.equal(/[\n\r]/.test(line), false);
  assert.equal(JSON.parse(line).content, 'line one\nline two\nline three');
});

test('parseRecordLine: round-trips a serialized record', () => {
  const rec = buildRecord({ ...base });
  const line = serializeRecord(rec);
  const parsed = parseRecordLine(line);
  assert.deepEqual(parsed, rec);
});

test('parseRecordLine: fails closed (throws) on invalid JSON', () => {
  assert.throws(() => parseRecordLine('{not valid json'));
});

test('parseRecordLine: fails closed (throws) on a schema violation', () => {
  assert.throws(() => parseRecordLine(JSON.stringify({ ...buildRecord({ ...base }), type: 'manual' })));
});

// ── buildIndexEntry / serializeIndex (REQ-MF-4, R1) ──────────────────────────

test('buildIndexEntry: carries id/ts/actor/type/project/file, omits absent optionals', () => {
  const rec = buildRecord({ ...base });
  const entry = buildIndexEntry(rec, '2026-07.jsonl');
  assert.equal(entry.id, rec.id);
  assert.equal(entry.file, '2026-07.jsonl');
  assert.equal('issue' in entry, false);
});

test('buildIndexEntry: carries issue/supersedes when present', () => {
  const rec = buildRecord({ ...base, issue: 205 });
  const entry = buildIndexEntry(rec, '2026-07.jsonl');
  assert.equal(entry.issue, 205);
});

test('serializeIndex: one entry per physical line, sorted by id', () => {
  const recA = buildRecord({ ...base, content: 'A' });
  const recB = buildRecord({ ...base, content: 'B' });
  const entries = new Map([
    [recB.id, buildIndexEntry(recB, 'f.jsonl')],
    [recA.id, buildIndexEntry(recA, 'f.jsonl')],
  ]);
  const serialized = serializeIndex(entries);
  const lines = serialized.split('\n').filter(Boolean);
  assert.equal(lines.length, 2);
  const ids = lines.map((l) => JSON.parse(l).id);
  assert.deepEqual(ids, [...ids].sort());
});

test('serializeIndex: empty map serializes to empty string', () => {
  assert.equal(serializeIndex(new Map()), '');
});

// ── nowUtcSeconds (C3, task 1.1) — the C2a canonical UTC-seconds clock ───────

test('nowUtcSeconds: strips millisecond precision (.mmmZ → Z) for an injected fixed clock', () => {
  const getNow = () => new Date('2026-07-12T09:41:07.123Z');
  const ts = nowUtcSeconds(getNow);
  assert.equal(ts, '2026-07-12T09:41:07Z');
});

test('nowUtcSeconds: the result matches the UTC_TS_RE format validateRecord enforces', () => {
  const getNow = () => new Date('2026-01-01T00:00:00.000Z');
  const ts = nowUtcSeconds(getNow);
  const { valid, errors } = validateRecord({
    id: 'rec-0000000000000000',
    ts,
    actor: 'agent',
    actorKind: 'agent',
    type: 'decision',
    project: 'brain',
    content: 'x',
  });
  assert.equal(valid, true, `expected ts '${ts}' to satisfy UTC_TS_RE: ${errors.join('; ')}`);
});

test('nowUtcSeconds: defaults to the real clock when getNow is omitted', () => {
  const before = Date.now();
  const ts = nowUtcSeconds();
  const after = Date.now();
  assert.match(ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  const parsed = new Date(ts).getTime();
  assert.ok(parsed >= before - 1000 && parsed <= after + 1000, 'nowUtcSeconds() default clock should be near real time');
});

test('#1164 HANDLE_RE: a handle may carry . and _ after its first character (GitLab usernames), never shell or path metacharacters', () => {
  for (const ok of ['@jane.doe', '@jane_doe', '@a-b.c_d']) assert.equal(classifyActor(ok), 'handle', ok);
  for (const no of ['@.x', '@_x', '@a b', '@a;b', '@a$b', '@a/b']) assert.notEqual(classifyActor(no), 'handle', no);
});
