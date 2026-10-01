// staged-records-check.test.mjs — issue #701, design.md Decision 6.
//
// `evaluateStagedRecords` is pure — no git, no filesystem — mirroring
// `actor-check.mjs#evaluateActor`'s split (pure evaluator + I/O wrapper).
// `parseStagedDiff`/`stagedRecordDiff` (the I/O half) are covered indirectly
// through `runStagedRecordsCheck` in a real-git integration test, following
// `upstream-records.integration.test.mjs`'s own division of labour.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { evaluateStagedRecords, mergeIntroducedRecords, parseStagedDiff, runStagedRecordsCheck } from './staged-records-check.mjs';

const ZERO = '0'.repeat(40);
const OID_A = 'a'.repeat(40);
const OID_B = 'b'.repeat(40);

const okUpstream = (byPath) => ({ ok: true, ref: 'origin/main', stated: false, byId: new Map(), byPath, unnamed: [] });

test('evaluateStagedRecords: a staged path byte-identical to the upstream copy is REFUSED', () => {
  const upstream = okUpstream(new Map([['.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', OID_A]]));
  const staged = [{ path: '.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', dstOid: OID_A, status: 'M' }];
  const r = evaluateStagedRecords({ staged, upstream });
  assert.equal(r.level, 'fail');
  assert.deepEqual(r.offending, ['.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl']);
});

test('evaluateStagedRecords: divergent bytes at the SAME path are ALLOWED (the source-widening case)', () => {
  const upstream = okUpstream(new Map([['.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', OID_A]]));
  const staged = [{ path: '.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', dstOid: OID_B, status: 'M' }];
  const r = evaluateStagedRecords({ staged, upstream });
  assert.equal(r.level, 'pass');
  assert.deepEqual(r.offending, []);
});

test('evaluateStagedRecords: a genuinely new path (absent upstream) is ALLOWED', () => {
  const upstream = okUpstream(new Map());
  const staged = [{ path: '.memory/records/2026-08-rec-cccccccccccccccc.jsonl', dstOid: OID_A, status: 'A' }];
  const r = evaluateStagedRecords({ staged, upstream });
  assert.equal(r.level, 'pass');
});

test('evaluateStagedRecords: a staged DELETION (dstOid all-zero) is ALLOWED — deleting is a different concern', () => {
  const upstream = okUpstream(new Map([['.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', OID_A]]));
  const staged = [{ path: '.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', dstOid: ZERO, status: 'D' }];
  const r = evaluateStagedRecords({ staged, upstream });
  assert.equal(r.level, 'pass');
});

test('evaluateStagedRecords: an EMPTY upstream (nothing durable yet) allows everything', () => {
  const upstream = okUpstream(new Map());
  const staged = [{ path: '.memory/records/2026-08-rec-dddddddddddddddd.jsonl', dstOid: OID_A, status: 'A' }];
  const r = evaluateStagedRecords({ staged, upstream });
  assert.equal(r.level, 'pass');
});

test('evaluateStagedRecords: upstream lookup unavailable → PASS with a note, never a block', () => {
  const r = evaluateStagedRecords({
    staged: [{ path: '.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', dstOid: OID_A, status: 'M' }],
    upstream: { ok: false, ref: 'origin/main', stated: false, reason: 'no remote' },
  });
  assert.equal(r.level, 'pass');
  assert.ok(r.note && r.note.length > 0, 'the gate never blocks on a question it could not ask');
});

test('evaluateStagedRecords: multiple staged paths — only the byte-identical one is offending', () => {
  const upstream = okUpstream(new Map([
    ['.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', OID_A],
    ['.memory/records/2026-08-rec-bbbbbbbbbbbbbbbb.jsonl', OID_B],
  ]));
  const staged = [
    { path: '.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', dstOid: OID_A, status: 'M' }, // identical — refuse
    { path: '.memory/records/2026-08-rec-bbbbbbbbbbbbbbbb.jsonl', dstOid: OID_A, status: 'M' }, // divergent — allow
    { path: '.memory/records/2026-08-rec-eeeeeeeeeeeeeeee.jsonl', dstOid: OID_A, status: 'A' }, // new — allow
  ];
  const r = evaluateStagedRecords({ staged, upstream });
  assert.equal(r.level, 'fail');
  assert.deepEqual(r.offending, ['.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl']);
});

// ---------------------------------------------------------------------------
// parseStagedDiff — pure parser over `git diff --cached --raw -z --no-abbrev` output
// ---------------------------------------------------------------------------

test('parseStagedDiff: a modified file', () => {
  const text = `:100644 100644 ${OID_A} ${OID_B} M\0.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl\0`;
  const r = parseStagedDiff(text);
  assert.deepEqual(r, [{ path: '.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl', dstOid: OID_B, status: 'M' }]);
});

test('parseStagedDiff: an added file (src is the zero oid)', () => {
  const text = `:000000 100644 ${ZERO} ${OID_A} A\0.memory/records/2026-08-rec-cccccccccccccccc.jsonl\0`;
  const r = parseStagedDiff(text);
  assert.equal(r[0].status, 'A');
  assert.equal(r[0].dstOid, OID_A);
});

test('parseStagedDiff: a deleted file (dst is the zero oid)', () => {
  const text = `:100644 000000 ${OID_A} ${ZERO} D\0.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl\0`;
  const r = parseStagedDiff(text);
  assert.equal(r[0].status, 'D');
  assert.equal(r[0].dstOid, ZERO);
});

// ── R/C: git emits SOURCE first, DESTINATION second ─────────────────────────
//
// The branch that consumes a rename's second path token had ZERO coverage, and
// the code under it was backwards: it kept the SOURCE and discarded the
// destination, calling the destination "the old path". Found by cold review of
// #707, and it broke the gate in BOTH directions — a byte-identical restage was
// allowed whenever git paired it with a record deletion, and a legitimate
// `git mv` was refused while naming the file being deleted. (Not "an UNRELATED
// deletion": git pairs on byte similarity, and two real same-session records
// are measurably not similar enough to pair — see the module's own note.)
//
// The axis these tests add is STATUS: every fixture above is A/M/D, none is
// R or C, so nothing distinguished "took the right token" from "took a token".

test('parseStagedDiff: a rename yields the DESTINATION path, which is the one dstOid describes', () => {
  const text =
    `:100644 100644 ${OID_A} ${OID_B} R083\0` +
    '.memory/records/2026-08-rec-1111111111111111.jsonl\0' + // source
    '.memory/records/2026-08-rec-2222222222222222.jsonl\0';  // destination
  const r = parseStagedDiff(text);
  assert.equal(r.length, 1);
  assert.equal(r[0].path, '.memory/records/2026-08-rec-2222222222222222.jsonl',
    'the source path is not the one being written — pairing it with dstOid is what let a restage through');
  assert.equal(r[0].dstOid, OID_B);
});

test('parseStagedDiff: a copy behaves like a rename — the destination wins', () => {
  const text =
    `:100644 100644 ${OID_A} ${OID_B} C100\0` +
    '.memory/records/2026-08-rec-1111111111111111.jsonl\0' +
    '.memory/records/2026-08-rec-3333333333333333.jsonl\0';
  assert.equal(parseStagedDiff(text)[0].path, '.memory/records/2026-08-rec-3333333333333333.jsonl');
});

test('parseStagedDiff: the SAME write parses identically whether git pairs it as a rename or not', () => {
  // The verdict must not depend on whether an unrelated deletion happened to
  // sit in the same commit — that is the accident that made the gate silent.
  const target = '.memory/records/2026-08-rec-2222222222222222.jsonl';
  const asAdd = `:000000 100644 ${ZERO} ${OID_B} A\0${target}\0`;
  const asRename =
    `:100644 100644 ${OID_A} ${OID_B} R083\0.memory/records/2026-08-rec-1111111111111111.jsonl\0${target}\0`;

  const a = parseStagedDiff(asAdd)[0];
  const b = parseStagedDiff(asRename)[0];
  assert.equal(a.path, b.path, 'same file, same path, regardless of how git framed it');
  assert.equal(a.dstOid, b.dstOid, 'and the same blob is what the gate compares');
});

test('parseStagedDiff: a rename with its destination token missing does not fabricate one', () => {
  const truncated = `:100644 100644 ${OID_A} ${OID_B} R083\0.memory/records/2026-08-rec-1111111111111111.jsonl\0`;
  assert.deepEqual(parseStagedDiff(truncated), [], 'a truncated entry is dropped, never guessed at');
});

test('parseStagedDiff: empty text yields no entries', () => {
  assert.deepEqual(parseStagedDiff(''), []);
});

test('parseStagedDiff: garbage never throws', () => {
  assert.doesNotThrow(() => parseStagedDiff('garbage\0more garbage\0'));
});

// ---------------------------------------------------------------------------
// runStagedRecordsCheck — the config LEVEL reaches the upstream lookup.
//
// This is the SECOND of the two entry points that defaulted `config = {}` and
// so killed `upstream-records.mjs`'s "omitted → read from root" contract (cold
// review of #708). It is exercised with the REAL `upstreamRecordEntries`
// (only git and the staged diff are faked), because a stubbed
// `_upstreamRecordEntries` would prove the argument was passed and nothing
// about whether it is honored.
// ---------------------------------------------------------------------------

/**
 * A tmpdir removed when the test ends — the convention
 * `staged-records-check.integration.test.mjs:35-43` already follows. Without it
 * this file leaks one directory per run (cold review round 2 of #701).
 */
function tmpRoot(t, configText) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-staged-records-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (configText !== undefined) writeFileSync(join(dir, 'brain.config.json'), configText);
  return dir;
}

test('runStagedRecordsCheck: memory.upstreamRef is read from root when config is omitted', (t) => {
  const root = tmpRoot(t, JSON.stringify({ memory: { upstreamRef: 'origin/stated-by-config' } }));

  const r = runStagedRecordsCheck({
    root,
    env: {},
    // origin/HEAD WOULD resolve — a stated ref must not fall through to it.
    _spawn: (bin, args) => {
      if (args[0] === 'rev-parse') {
        const ref = args[3]?.replace(/\^\{tree\}$/, '');
        return { status: ['origin/HEAD', 'origin/main'].includes(ref) ? 0 : 1 };
      }
      return { status: 0, stdout: '' };
    },
    _stagedRecordDiff: () => ({ ok: true, staged: [] }),
  });

  assert.equal(r.level, 'pass', 'an unresolvable upstream never blocks — the gate degrades open');
  assert.match(r.note, /origin\/stated-by-config/, 'the config-stated ref must reach the upstream lookup');
});

test('runStagedRecordsCheck: _loadConfig is injectable through the wrapper', () => {
  const r = runStagedRecordsCheck({
    root: '/fake',
    env: {},
    _loadConfig: () => ({ memory: { upstreamRef: 'origin/injected-by-seam' } }),
    _spawn: () => ({ status: 1 }),
    _stagedRecordDiff: () => ({ ok: true, staged: [] }),
  });
  assert.equal(r.level, 'pass');
  assert.match(r.note, /origin\/injected-by-seam/);
});

// ---------------------------------------------------------------------------
// A CORRUPT brain.config.json must not disarm the gate (cold review round 2 of
// #701). The window this lands in is the worst one: conflict markers in
// `brain.config.json` mean you are mid-merge, and committing merged
// `.memory/records/` mid-merge is exactly when this gate earns its keep. The
// scenario is the COMMON one — a config that never stated `memory.upstreamRef`
// at all, because the key is an optional escape hatch.
// ---------------------------------------------------------------------------

const IDENTICAL_OID = 'a'.repeat(40);
const RECORD_PATH = '.memory/records/2026-08-rec-0123456789abcdef.jsonl';

/** Resolves the named refs; answers ls-tree with one record already upstream. */
function gitWithUpstreamRecord(resolvesFor) {
  return (bin, args) => {
    if (args[0] === 'rev-parse') {
      const ref = args[3]?.replace(/\^\{tree\}$/, '');
      return { status: resolvesFor.includes(ref) ? 0 : 1 };
    }
    return { status: 0, stdout: `100644 blob ${IDENTICAL_OID}\t${RECORD_PATH}\0` };
  };
}

test('runStagedRecordsCheck: a CORRUPT brain.config.json that never stated a ref still REFUSES a byte-identical restage', (t) => {
  const root = tmpRoot(t, '<<<<<<< HEAD\n{"project":{"slug":"brain"}}\n=======');

  const r = runStagedRecordsCheck({
    root,
    env: {},
    _spawn: gitWithUpstreamRecord(['origin/HEAD', 'origin/main']),
    _stagedRecordDiff: () => ({ ok: true, staged: [{ path: RECORD_PATH, dstOid: IDENTICAL_OID, status: 'A' }] }),
  });

  assert.equal(r.level, 'fail', 'origin/HEAD is still perfectly answerable — a broken config must not cost the gate its scope');
  assert.deepEqual(r.offending, [RECORD_PATH]);
});

test('runStagedRecordsCheck: the corrupt config is still REPORTED alongside that refusal — configError is a separate channel from note', (t) => {
  const root = tmpRoot(t, '<<<<<<< HEAD\n{"project":{"slug":"brain"}}\n=======');

  const r = runStagedRecordsCheck({
    root,
    env: {},
    _spawn: gitWithUpstreamRecord(['origin/HEAD', 'origin/main']),
    _stagedRecordDiff: () => ({ ok: true, staged: [{ path: RECORD_PATH, dstOid: IDENTICAL_OID, status: 'A' }] }),
  });

  assert.match(r.configError, /could not be parsed/, 'the operator must learn the config was skipped');
  assert.equal(r.ref, 'origin/HEAD', 'and which ref answered instead');
  assert.equal(r.note, undefined, '`note` says "nothing was judged" — printing it over a real refusal would be a lie');
});

test('evaluateStagedRecords: configError travels on the ok:false arm too — it is not tied to a successful lookup', () => {
  const r = evaluateStagedRecords({
    staged: [{ path: RECORD_PATH, dstOid: IDENTICAL_OID, status: 'A' }],
    // `ref: null` is the real shape of "nothing resolved" (`upstream-records.mjs`
    // returns no name for a run in which no name was used). It is forwarded as
    // `null` rather than dropped, because `main()` reads it to choose which of
    // the two config-unreadable messages is true.
    upstream: { ok: false, ref: null, stated: false, reason: 'nothing resolved', configError: 'config broke' },
  });
  assert.equal(r.level, 'pass');
  assert.equal(r.configError, 'config broke');
  assert.equal(r.ref, null);
});

test('evaluateStagedRecords: a resolved ref on the ok:false arm IS forwarded — ls-tree can fail against a real base', () => {
  const r = evaluateStagedRecords({
    staged: [],
    upstream: { ok: false, ref: 'origin/HEAD', stated: false, reason: 'git ls-tree against \'origin/HEAD\' exited 128', configError: 'config broke' },
  });
  assert.equal(r.ref, 'origin/HEAD', 'ok:false does not mean "no ref" — a `null` here would lose the base that was used');
});

test('evaluateStagedRecords: a healthy upstream carries no configError — the field is evidence, not decoration', () => {
  const r = evaluateStagedRecords({
    staged: [],
    upstream: { ok: true, ref: 'origin/HEAD', stated: false, byPath: new Map() },
  });
  assert.equal(r.configError, undefined);
  assert.equal(r.ref, undefined);
});

// ---------------------------------------------------------------------------
// Issue #821 — the merge commit that CARRIES records in from the trunk.
//
// The gate's predicate is byte-identity against upstream, and a record arriving
// through a merge from the trunk is byte-identical to upstream BY DEFINITION —
// it IS upstream's blob. So the rule that makes the gate right for a
// `brain:memory:share` restage fired on every merge, and the remedy it printed
// (`git restore --staged` + `rm`) made the merge result OMIT the record, which
// propagates as a deletion when the branch merges back. Measured in a throwaway
// repo before this fix: the record was gone from the trunk afterwards.
//
// The distinction is NOT "mid-merge or not" — `test.mjs:227` deliberately wants
// this gate live mid-merge, and it stays live. It is "did THIS MERGE introduce
// this exact blob at this exact path". `MERGE_HEAD` answers that, and it
// resolves inside a linked worktree, which is the normal shape here since #782.
// ---------------------------------------------------------------------------

const RECORD = '.memory/records/2026-08-rec-aaaaaaaaaaaaaaaa.jsonl';
// `byPath` maps a path to the SET of oids the merge parents hold there — an
// octopus merge can carry the same path from more than one parent (#821, cold
// review round 1). Written as a plain {path: oid} here and lifted, so the cases
// below stay about the VERDICT rather than about Set construction.
const okMerge = (byPath) =>
  ({ ok: true, byPath: new Map([...byPath].map(([k, v]) => [k, new Set([v])])) });

test('#821 evaluateStagedRecords: a record the MERGE is carrying in from the trunk is ALLOWED', () => {
  const upstream = okUpstream(new Map([[RECORD, OID_A]]));
  const merge = okMerge(new Map([[RECORD, OID_A]]));
  const staged = [{ path: RECORD, dstOid: OID_A, status: 'A' }];

  const r = evaluateStagedRecords({ staged, upstream, merge });

  assert.equal(r.level, 'pass', 'refusing here makes the operator drop a record the merge is carrying');
  assert.deepEqual(r.offending, []);
});

test('#821 evaluateStagedRecords: mid-merge, a restage the merge is NOT carrying is still REFUSED', () => {
  // The gate keeps its keep exactly where test.mjs:227 says it should: a record
  // re-exported locally during a merge is not in MERGE_HEAD at that path, so
  // nothing about this fix reaches it.
  const upstream = okUpstream(new Map([[RECORD, OID_A]]));
  const merge = okMerge(new Map());   // a merge IS in progress; it just did not bring this
  const staged = [{ path: RECORD, dstOid: OID_A, status: 'A' }];

  const r = evaluateStagedRecords({ staged, upstream, merge });

  assert.equal(r.level, 'fail');
  assert.deepEqual(r.offending, [RECORD]);
});

test('#821 evaluateStagedRecords: mid-merge, DIFFERENT bytes at a path the merge also touched is REFUSED', () => {
  // Byte-identity is the whole predicate. A path present in MERGE_HEAD does not
  // launder a blob the merge never carried.
  const upstream = okUpstream(new Map([[RECORD, OID_A]]));
  const merge = okMerge(new Map([[RECORD, OID_B]]));
  const staged = [{ path: RECORD, dstOid: OID_A, status: 'A' }];

  const r = evaluateStagedRecords({ staged, upstream, merge });

  assert.equal(r.level, 'fail', 'the merge carried OID_B here — OID_A is a restage, not the merge');
  assert.deepEqual(r.offending, [RECORD]);
});

test('#821 evaluateStagedRecords: NO merge in progress leaves the verdict exactly as before', () => {
  const upstream = okUpstream(new Map([[RECORD, OID_A]]));
  const staged = [{ path: RECORD, dstOid: OID_A, status: 'A' }];

  const withoutArg = evaluateStagedRecords({ staged, upstream });
  const notMerging = evaluateStagedRecords({ staged, upstream, merge: { ok: false, reason: 'no MERGE_HEAD' } });

  assert.equal(withoutArg.level, 'fail', 'omitting the argument must not change the existing contract');
  assert.equal(notMerging.level, 'fail');
  assert.deepEqual(notMerging.offending, [RECORD]);
});

test('#821 runStagedRecordsCheck: the merge lookup is wired through a seam, like every other input', () => {
  const r = runStagedRecordsCheck({
    root: '/fake',
    env: {},
    config: {},
    _upstreamRecordEntries: () => okUpstream(new Map([[RECORD, OID_A]])),
    _stagedRecordDiff: () => ({ ok: true, staged: [{ path: RECORD, dstOid: OID_A, status: 'A' }] }),
    _mergeIntroducedRecords: () => okMerge(new Map([[RECORD, OID_A]])),
  });

  assert.equal(r.level, 'pass');
  assert.deepEqual(r.offending, []);
});

test('#821 mergeIntroducedRecords: ENOENT is "no merge in progress"; any OTHER read failure says so', () => {
  // Cold review round 2, editorial. The catch said "no merge in progress" for
  // every read failure while its own comment claimed ENOENT was the case it
  // meant. The verdict is unaffected either way — both arms return `ok:false`
  // and leave the pre-#821 behaviour standing — but an operator debugging a
  // broken checkout mid-merge was told the opposite of what happened.
  const spawnNamingPath = () => ({ status: 0, stdout: '.git/MERGE_HEAD\n' });
  const throwing = (code) => () => { const e = new Error(code); e.code = code; throw e; };

  const absent = mergeIntroducedRecords({ root: '/fake', _spawn: spawnNamingPath, _readFile: throwing('ENOENT') });
  assert.equal(absent.ok, false);
  assert.match(absent.reason, /no merge in progress/);

  const broken = mergeIntroducedRecords({ root: '/fake', _spawn: spawnNamingPath, _readFile: throwing('EACCES') });
  assert.equal(broken.ok, false, 'still fails safe — the verdict must not change');
  assert.doesNotMatch(broken.reason, /no merge in progress/, 'a permission error is not an absent merge');
  assert.match(broken.reason, /EACCES/, 'and the operator has to be told which failure it was');
});

// ---------------------------------------------------------------------------
// Cold review round 3, `correction`. `mergeIntroducedRecords` can fail for real
// reasons — an unreadable MERGE_HEAD, an `ls-tree` that refuses against one
// parent — and on that arm the gate silently falls back to the pre-#821
// verdict: a REFUSE carrying the same remedy this module's own header calls
// destructive when the blob really is merge-carried. The operator was never
// told the tool had TRIED to ask the merge question and failed.
//
// This module already states the opposite doctrine for `configError`, and
// `main()` applies it to both `configError` and `note`. The merge channel got
// none of it — an omission of MINE, not of #701's.
//
// "No merge in progress" is NOT such a failure. It is the answer on almost
// every commit ever made here, and reporting it would be noise on all of them,
// which is why the absence is discriminated explicitly rather than by matching
// the reason string.
// ---------------------------------------------------------------------------

test('#821 evaluateStagedRecords: a REAL merge-lookup failure is surfaced, never swallowed', () => {
  const upstream = okUpstream(new Map([[RECORD, OID_A]]));
  const staged = [{ path: RECORD, dstOid: OID_A, status: 'A' }];

  const r = evaluateStagedRecords({
    staged,
    upstream,
    merge: { ok: false, inMerge: true, reason: 'MERGE_HEAD could not be read — EACCES permission denied' },
  });

  assert.equal(r.level, 'fail', 'the verdict still falls back — this is about telling, not about deciding');
  assert.match(r.mergeError, /EACCES/, 'the operator has to learn the merge question was attempted and failed');
});

test('#821 evaluateStagedRecords: "no merge in progress" is SILENT — it is the answer on nearly every commit', () => {
  const upstream = okUpstream(new Map([[RECORD, OID_A]]));
  const staged = [{ path: RECORD, dstOid: OID_A, status: 'A' }];

  const r = evaluateStagedRecords({
    staged,
    upstream,
    merge: { ok: false, absent: true, reason: 'no merge in progress' },
  });

  assert.equal(r.level, 'fail');
  assert.equal(r.mergeError, undefined, 'printing this on every ordinary commit is noise, not diagnosis');
});

test('#821 mergeIntroducedRecords: ENOENT is flagged `absent`, a real failure is not', () => {
  const spawnNamingPath = () => ({ status: 0, stdout: '.git/MERGE_HEAD\n' });
  const throwing = (code) => () => { const e = new Error(code); e.code = code; throw e; };

  const absent = mergeIntroducedRecords({ root: '/fake', _spawn: spawnNamingPath, _readFile: throwing('ENOENT') });
  assert.equal(absent.absent, true, 'the ordinary case must be distinguishable without matching prose');

  const broken = mergeIntroducedRecords({ root: '/fake', _spawn: spawnNamingPath, _readFile: throwing('EACCES') });
  assert.notEqual(broken.absent, true);
  assert.equal(broken.inMerge, true, 'EACCES means the file IS there — a merge really is underway');
});
