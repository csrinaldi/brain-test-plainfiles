// upstream-records.test.mjs — unit tests for the issue #701 predicate module.
// Pure (`parseLsTree`) and seam-injected (`resolveUpstreamRef`,
// `upstreamRecordEntries`) — no test spawns a real git process (mirrors
// `backend-selection.test.mjs`'s `_spawn` seam discipline).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseLsTree, resolveUpstreamRef, upstreamRecordEntries } from './upstream-records.mjs';

const entry = (mode, oid, path) => `${mode} blob ${oid}\t${path}`;

// ---------------------------------------------------------------------------
// parseLsTree — pure, fixture strings (task 1.4)
// ---------------------------------------------------------------------------

test('parseLsTree: a per-record name lands its id in byId and its path in byPath', () => {
  const text = entry('100644', 'aaaa1111', '.memory/records/2026-08-rec-0123456789abcdef.jsonl');
  const { byId, byPath, unnamed } = parseLsTree(text);
  assert.equal(byId.get('rec-0123456789abcdef'), 'aaaa1111');
  assert.equal(byPath.get('.memory/records/2026-08-rec-0123456789abcdef.jsonl'), 'aaaa1111');
  assert.deepEqual(unnamed, []);
});

test('parseLsTree: a month file (pre-#677 shape) lands in unnamed, not byId', () => {
  const text = entry('100644', 'bbbb2222', '.memory/records/2026-08.jsonl');
  const { byId, unnamed } = parseLsTree(text);
  assert.equal(byId.size, 0);
  assert.deepEqual(unnamed, ['.memory/records/2026-08.jsonl']);
});

test('parseLsTree: a nested path still extracts the id from its basename', () => {
  const text = entry('100644', 'cccc3333', '.memory/records/legacy/2026-08-rec-fedcba9876543210.jsonl');
  const { byId } = parseLsTree(text);
  assert.equal(byId.get('rec-fedcba9876543210'), 'cccc3333');
});

test('parseLsTree: an empty tree yields empty maps and no unnamed entries', () => {
  const { byId, byPath, unnamed } = parseLsTree('');
  assert.equal(byId.size, 0);
  assert.equal(byPath.size, 0);
  assert.deepEqual(unnamed, []);
});

test('parseLsTree: garbage input never throws and yields nothing', () => {
  assert.doesNotThrow(() => parseLsTree('not\tls-tree\0output\0\0garbage'));
  const { byId, unnamed } = parseLsTree('garbage-with-no-tab\0also garbage');
  assert.equal(byId.size, 0);
  assert.deepEqual(unnamed, []);
});

test('parseLsTree: multiple NUL-separated entries all parse', () => {
  const text = [
    entry('100644', 'aaaa', '.memory/records/2026-08-rec-1111111111111111.jsonl'),
    entry('100644', 'bbbb', '.memory/records/2026-08-rec-2222222222222222.jsonl'),
  ].join('\0') + '\0';
  const { byId } = parseLsTree(text);
  assert.equal(byId.size, 2);
  assert.equal(byId.get('rec-1111111111111111'), 'aaaa');
  assert.equal(byId.get('rec-2222222222222222'), 'bbbb');
});

// ---------------------------------------------------------------------------
// resolveUpstreamRef — seam-injected (task 1.5)
// ---------------------------------------------------------------------------

function fakeSpawn(resolvesFor) {
  return (bin, args) => {
    const ref = args[3]?.replace(/\^\{tree\}$/, '');
    return { status: resolvesFor.includes(ref) ? 0 : 1 };
  };
}

test('resolveUpstreamRef: env (level 1, stated) resolves — wins outright', () => {
  const r = resolveUpstreamRef({
    root: '/fake',
    env: { BRAIN_MEMORY_UPSTREAM_REF: 'origin/feature/x' },
    config: { memory: { upstreamRef: 'origin/other' } },
    _spawn: fakeSpawn(['origin/feature/x', 'origin/main']),
  });
  assert.deepEqual(r, { ref: 'origin/feature/x', stated: true, resolved: true });
});

test('resolveUpstreamRef: env (level 1, stated) does NOT resolve — does not fall through to config', () => {
  const r = resolveUpstreamRef({
    root: '/fake',
    env: { BRAIN_MEMORY_UPSTREAM_REF: 'origin/does-not-exist' },
    config: { memory: { upstreamRef: 'origin/other' } },
    _spawn: fakeSpawn(['origin/other', 'origin/main']),
  });
  assert.deepEqual(r, { ref: 'origin/does-not-exist', stated: true, resolved: false });
});

test('resolveUpstreamRef: config (level 2, stated) resolves when env is unset', () => {
  const r = resolveUpstreamRef({
    root: '/fake',
    env: {},
    config: { memory: { upstreamRef: 'origin/other' } },
    _spawn: fakeSpawn(['origin/other']),
  });
  assert.deepEqual(r, { ref: 'origin/other', stated: true, resolved: true });
});

test('resolveUpstreamRef: config (level 2, stated) does NOT resolve — does not fall through to origin/HEAD', () => {
  const r = resolveUpstreamRef({
    root: '/fake',
    env: {},
    config: { memory: { upstreamRef: 'origin/other' } },
    _spawn: fakeSpawn(['origin/HEAD', 'origin/main']),
  });
  assert.deepEqual(r, { ref: 'origin/other', stated: true, resolved: false });
});

test('resolveUpstreamRef: no stated ref — origin/HEAD (level 3, derived) resolves', () => {
  const r = resolveUpstreamRef({
    root: '/fake',
    env: {},
    config: {},
    _spawn: fakeSpawn(['origin/HEAD', 'origin/main']),
  });
  assert.deepEqual(r, { ref: 'origin/HEAD', stated: false, resolved: true });
});

test('resolveUpstreamRef: no stated ref — origin/HEAD fails through to origin/main (level 4, derived)', () => {
  const r = resolveUpstreamRef({
    root: '/fake',
    env: {},
    config: {},
    _spawn: fakeSpawn(['origin/main']),
  });
  assert.deepEqual(r, { ref: 'origin/main', stated: false, resolved: true });
});

test('resolveUpstreamRef: nothing resolves — reports NO ref at all, not a name nothing used', () => {
  // The fabrication this pins. It returned the string `'origin/main'` here, and
  // every consumer that printed `ref` then named a ref that had answered
  // nothing: round 3 shipped "the upstream base was derived as origin/main
  // instead" on exactly this result, and round 4 added a second field to tell
  // the two apart. `null` is the discriminator; there is nothing to add.
  const r = resolveUpstreamRef({
    root: '/fake',
    env: {},
    config: {},
    _spawn: fakeSpawn([]),
  });
  assert.deepEqual(r, { ref: null, stated: false, resolved: false });
});

test('resolveUpstreamRef: a STATED ref that fails is still named — `null` is only for "nothing answered"', () => {
  // The other side: `ref == null` must not creep into the stated-and-failed
  // case. The operator asked for that ref by name and has to see which one.
  const r = resolveUpstreamRef({
    root: '/fake',
    env: { BRAIN_MEMORY_UPSTREAM_REF: 'origin/nope' },
    config: {},
    _spawn: fakeSpawn([]),
  });
  assert.deepEqual(r, { ref: 'origin/nope', stated: true, resolved: false });
});

// ---------------------------------------------------------------------------
// upstreamRecordEntries — seam-injected (task 1.6)
// ---------------------------------------------------------------------------

test('upstreamRecordEntries: no git binary at the rev-parse step → ok:false', () => {
  const r = upstreamRecordEntries({
    root: '/fake',
    env: {},
    config: {},
    _spawn: () => { throw new Error('spawn git ENOENT'); },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no upstream ref resolved/);
});

test('upstreamRecordEntries: not a git repo (every rev-parse fails) → ok:false', () => {
  const r = upstreamRecordEntries({
    root: '/fake',
    env: {},
    config: {},
    _spawn: () => ({ status: 128 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.stated, false);
});

test('upstreamRecordEntries: `reason` states the FACT and never the consumer\'s own degradation', () => {
  // The shared-string defect. `reason` is read by two consumers with OPPOSITE
  // degradations — the exporter writes every candidate, the pre-commit gate
  // writes nothing — so a clause naming one of them is doubled at that consumer
  // and FALSE at the other. Both were shipped simultaneously:
  //   memory/cli:            "… (pre-#701 behaviour). This run wrote every candidate (the pre-#701 behaviour); nothing was scoped."
  //   staged-records-check:  "… (pre-#701 behaviour). Nothing was refused; this run could not ask the question."
  for (const env of [{}, { BRAIN_MEMORY_UPSTREAM_REF: 'origin/nope' }]) {
    const r = upstreamRecordEntries({ root: '/fake', env, config: {}, _spawn: () => ({ status: 1 }) });
    assert.equal(r.ok, false);
    assert.doesNotMatch(r.reason, /writing every candidate/, `the write is the exporter's own fact, not this string's: ${r.reason}`);
    assert.doesNotMatch(r.reason, /pre-#701/, `and neither is the name of the behaviour it degrades to: ${r.reason}`);
  }
});

test('upstreamRecordEntries: no remote (origin/main also fails to resolve) → ok:false with NO ref, and the reason names what was tried', () => {
  const r = upstreamRecordEntries({
    root: '/fake',
    env: {},
    config: {},
    _spawn: () => ({ status: 1 }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.ref, null, 'no ref answered, so no ref is reported — the candidates tried belong in `reason`');
  assert.match(r.reason, /tried origin\/HEAD, origin\/main/, 'and they are still named, where naming them is true');
});

test('upstreamRecordEntries: ref resolves but ls-tree exits non-zero → ok:false', () => {
  const r = upstreamRecordEntries({
    root: '/fake',
    env: {},
    config: {},
    _spawn: (bin, args) => {
      if (args[0] === 'rev-parse') return { status: 0 };
      return { status: 128, stderr: 'fatal: bad object' };
    },
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ls-tree .* exited 128/);
  // The ref belongs in `reason` now, not in the consumers' catalog wrapper: the
  // wrapper fires on EVERY ok:false, including the one where no ref resolved, so
  // it cannot interpolate one. This arm is the case where a ref DID answer and
  // `ls-tree` then failed against it — drop the ref here and the operator loses
  // which base the failing command was pointed at.
  assert.match(r.reason, /origin\/HEAD/, 'the failing ref must be named where naming it is true');
});

test('upstreamRecordEntries: resolves and ls-tree succeeds → ok:true with parsed entries', () => {
  const lsTreeOut = entry('100644', 'dead', '.memory/records/2026-08-rec-abcdefabcdefabcd.jsonl') + '\0';
  const r = upstreamRecordEntries({
    root: '/fake',
    env: {},
    config: {},
    _spawn: (bin, args) => {
      if (args[0] === 'rev-parse') return { status: 0 };
      return { status: 0, stdout: lsTreeOut };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'origin/HEAD');
  assert.equal(r.byId.get('rec-abcdefabcdefabcd'), 'dead');
});

// ---------------------------------------------------------------------------
// The config LEVEL, driven through the PRODUCTION entry point (cold review of
// #708).
//
// Every test above passes `config` EXPLICITLY, so all of them exercise the
// non-default branch and none of them can see whether the config is ever read
// from disk. That is how `upstreamRecordEntries`'s own `config = {}` default
// survived: `{}` is not nullish, so `config ?? _loadConfig(root)` never fired
// from any production caller and `memory.upstreamRef` stayed dead while the
// module's refusal text kept naming it.
//
// These tests therefore OMIT `config` and drive `upstreamRecordEntries` — the
// function `engram.mjs#dualWriteRecords` and `staged-records-check.mjs` both
// call — against a real tmpdir holding a real `brain.config.json`.
// ---------------------------------------------------------------------------

/**
 * Takes the test's `t` and registers its own cleanup — the convention
 * `upstream-records.integration.test.mjs:37-43` already follows. Without it these
 * tests leaked one directory per run, forever (cold review round 2 of #701).
 */
function tmpRoot(t, configText) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-upstream-records-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (configText !== undefined) writeFileSync(join(dir, 'brain.config.json'), configText);
  return dir;
}

/** Resolves the named refs; answers `ls-tree` with one record entry. */
function fakeGit(resolvesFor, lsTreeSeen = []) {
  return (bin, args) => {
    if (args[0] === 'rev-parse') {
      const ref = args[3]?.replace(/\^\{tree\}$/, '');
      return { status: resolvesFor.includes(ref) ? 0 : 1 };
    }
    lsTreeSeen.push(args[4]); // `ls-tree -r -z --full-tree <ref> -- <path>`
    return { status: 0, stdout: entry('100644', 'dead', '.memory/records/2026-08-rec-abcdefabcdefabcd.jsonl') + '\0' };
  };
}

test('upstreamRecordEntries: memory.upstreamRef is read from root when config is OMITTED — and a stated ref that does not resolve never falls through', (t) => {
  const root = tmpRoot(t, JSON.stringify({ memory: { upstreamRef: 'origin/does-not-exist' } }));
  const r = upstreamRecordEntries({
    root,
    env: {},
    // no `config` — the production call shape (`_upstreamRecordIds({ root })`)
    _spawn: fakeGit(['origin/HEAD', 'origin/main']),
  });
  assert.equal(r.ok, false, 'a stated ref that does not resolve must stop resolution, not derive origin/HEAD');
  assert.equal(r.ref, 'origin/does-not-exist');
  assert.equal(r.stated, true);
  assert.match(r.reason, /the stated upstream ref 'origin\/does-not-exist' does not resolve/);
});

test('upstreamRecordEntries: a resolvable memory.upstreamRef read from root is the ref ls-tree is actually asked about', (t) => {
  const root = tmpRoot(t, JSON.stringify({ memory: { upstreamRef: 'origin/feature/x' } }));
  const lsTreeSeen = [];
  const r = upstreamRecordEntries({
    root,
    env: {},
    _spawn: fakeGit(['origin/feature/x', 'origin/HEAD', 'origin/main'], lsTreeSeen),
  });
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'origin/feature/x');
  assert.equal(r.stated, true);
  // The over-refusal axis: honoring the config must not stop at the REPORT —
  // the stated ref has to be the one the id set is read from.
  assert.deepEqual(lsTreeSeen, ['origin/feature/x']);
});

test('upstreamRecordEntries: no brain.config.json at root — the derived candidates still take over', (t) => {
  const root = tmpRoot(t, undefined);
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit(['origin/HEAD', 'origin/main']) });
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'origin/HEAD');
  assert.equal(r.stated, false);
});

test('upstreamRecordEntries: a brain.config.json with no memory.upstreamRef — the derived candidates still take over', (t) => {
  const root = tmpRoot(t, JSON.stringify({ project: { slug: 'brain' } }));
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit(['origin/HEAD', 'origin/main']) });
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'origin/HEAD');
  assert.equal(r.stated, false);
});

test('upstreamRecordEntries: env still wins over a config read from root', (t) => {
  const root = tmpRoot(t, JSON.stringify({ memory: { upstreamRef: 'origin/from-config' } }));
  const r = upstreamRecordEntries({
    root,
    env: { BRAIN_MEMORY_UPSTREAM_REF: 'origin/from-env' },
    _spawn: fakeGit(['origin/from-env', 'origin/from-config', 'origin/HEAD']),
  });
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'origin/from-env');
});

test('upstreamRecordEntries: _loadConfig is injectable at the layer production calls', () => {
  const r = upstreamRecordEntries({
    root: '/fake',
    env: {},
    _loadConfig: () => ({ memory: { upstreamRef: 'origin/injected' } }),
    _spawn: fakeGit(['origin/injected', 'origin/HEAD']),
  });
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'origin/injected');
  assert.equal(r.stated, true);
});

// ---------------------------------------------------------------------------
// An UNPARSEABLE brain.config.json is REPORTED and RESOLUTION CONTINUES
// (`evidence-reader-empty-on-failure` kept by the report, cold review round 2
// of #701). The first attempt stopped at level 2 against a pseudo-ref, which
// cost every repo with a corrupt config its upstream scoping — including the
// common case where the config never stated `memory.upstreamRef` at all.
// ---------------------------------------------------------------------------

test('upstreamRecordEntries: a malformed brain.config.json still falls through to the derived candidates — the scope is not lost', (t) => {
  const root = tmpRoot(t, '{ "memory": { "upstreamRef": "origin/x" ');
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit(['origin/HEAD', 'origin/main']) });
  assert.equal(r.ok, true, 'levels 3-4 stay answerable when the config is broken — stopping here loses the gate entirely');
  assert.equal(r.ref, 'origin/HEAD');
  assert.equal(r.stated, false, 'the ref actually used IS derived — claiming stated:true would misreport which level answered');
  assert.equal(r.byId.size, 1, 'the id set must really be read, not an empty scope wearing ok:true');
});

test('upstreamRecordEntries: a malformed brain.config.json is REPORTED — configError rides on the ok:true result', (t) => {
  const root = tmpRoot(t, '{ "memory": { "upstreamRef": "origin/x" ');
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit(['origin/HEAD', 'origin/main']) });
  assert.ok(r.configError, 'a fall-through that is not reported is the silent override the STATED split exists to prevent');
  assert.match(r.configError, /could not be parsed/);
  assert.match(r.configError, /brain\.config\.json/);
});

test('upstreamRecordEntries: the config parse failure is not doubled — "is not valid JSON" appears once, from JSON.parse itself', (t) => {
  const root = tmpRoot(t, '<<<<<<< HEAD\n{}');
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit(['origin/HEAD']) });
  const hits = r.configError.match(/is not valid JSON/g) ?? [];
  assert.equal(hits.length, 1, `the wrapper must not restate what JSON.parse already said: ${r.configError}`);
});

test('upstreamRecordEntries: a brain.config.json that cannot be READ (a directory) falls through and is reported too', (t) => {
  const root = tmpRoot(t);
  mkdirSync(join(root, 'brain.config.json'));
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit(['origin/HEAD', 'origin/main']) });
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'origin/HEAD');
  assert.match(r.configError, /could not be read/);
});

test('upstreamRecordEntries: an unreadable config AND no derived ref → ok:false, and BOTH failures travel — on their OWN channels', (t) => {
  const root = tmpRoot(t, '}}} not json');
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit([]) });
  assert.equal(r.ok, false);
  assert.equal(r.ref, null);
  assert.equal(r.stated, false);
  assert.match(r.configError, /could not be parsed/, 'the config failure must not be dropped when the derived refs also fail');
  assert.match(r.reason, /no upstream ref resolved/);
  // The reason used to PREFIX `configError`. Both consumers print `configError`
  // on its own line and then print `reason`, so the operator read the identical
  // sentence twice (cold review round 2 of #701) — measured through the real
  // CLI, not argued.
  assert.doesNotMatch(
    r.reason, /could not be parsed/,
    'reason must not restate configError — every consumer prints both, so a prefix doubles the sentence',
  );
});

test('upstreamRecordEntries: an unreadable config with NOTHING resolved reports no ref — the consumers discriminate on that', (t) => {
  // `ref == null` is the whole discriminator, and it replaced a `refResolved`
  // boolean that existed only because `ref` was fabricated. Both consumers pick
  // their catalog key off this value; put a string back here and each of them
  // tells the operator a ref answered while the very next line says none did.
  const root = tmpRoot(t, '}}} not json');
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit([]) });
  assert.equal(r.ref, null, 'no candidate resolved, so no ref was used for anything');
  assert.match(r.configError, /could not be parsed/, 'and the config failure still travels beside it');
});

test('upstreamRecordEntries: an unreadable config with a derived ref that DID answer reports that ref by name', (t) => {
  const root = tmpRoot(t, '}}} not json');
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit(['origin/HEAD']) });
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'origin/HEAD', 'this IS the derived ref resolution fell through to — the one case the wording may name');
});

test('upstreamRecordEntries: a READABLE config stating an unresolvable ref STILL stops at that ref — unchanged, and not the same case', (t) => {
  const root = tmpRoot(t, JSON.stringify({ memory: { upstreamRef: 'origin/nope' } }));
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit(['origin/HEAD', 'origin/main']) });
  assert.equal(r.ok, false, 'an operator ref that was honored and failed is a different fact from a config that could not be read');
  assert.equal(r.ref, 'origin/nope');
  assert.equal(r.stated, true);
  assert.equal(r.configError, undefined, 'nothing failed to be read here');
});

test('upstreamRecordEntries: a HEALTHY config carries no configError — the field is evidence, not decoration', (t) => {
  const root = tmpRoot(t, JSON.stringify({ project: { slug: 'brain' } }));
  const r = upstreamRecordEntries({ root, env: {}, _spawn: fakeGit(['origin/HEAD']) });
  assert.equal(r.ok, true);
  assert.equal(r.configError, undefined);
});

test('upstreamRecordEntries: a malformed brain.config.json does NOT disable the env escape hatch', (t) => {
  const root = tmpRoot(t, '}}} not json');
  const r = upstreamRecordEntries({
    root,
    env: { BRAIN_MEMORY_UPSTREAM_REF: 'origin/from-env' },
    _spawn: fakeGit(['origin/from-env']),
  });
  assert.equal(r.ok, true, 'the env level is read before the config, so a broken config cannot block the workaround');
  assert.equal(r.ref, 'origin/from-env');
});

test('resolveUpstreamRef: an explicit `{}` config still means "no stated ref" — it does not trigger a read', (t) => {
  const root = tmpRoot(t, JSON.stringify({ memory: { upstreamRef: 'origin/from-config' } }));
  const r = resolveUpstreamRef({
    root,
    env: {},
    config: {},
    _spawn: fakeSpawn(['origin/HEAD', 'origin/main']),
  });
  assert.deepEqual(r, { ref: 'origin/HEAD', stated: false, resolved: true });
});

// #1118: an explicit `ref` bypasses env/config/origin resolution entirely.
test('upstreamRecordEntries: an explicit ref is read as given and never resolved via env/config', () => {
  const calls = [];
  const r = upstreamRecordEntries({
    root: '/x',
    ref: 'origin/topic',
    env: { BRAIN_MEMORY_UPSTREAM_REF: 'ignored/ref' },
    _spawn: (cmd, args) => {
      calls.push(args.join(' '));
      if (args[0] === 'rev-parse') return { status: 0, stdout: '' };
      return { status: 0, stdout: '100644 blob abc\t.memory/records/2026-09-rec-0123456789abcdef.jsonl\0' };
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.ref, 'origin/topic');
  assert.ok(r.byPath.has('.memory/records/2026-09-rec-0123456789abcdef.jsonl'));
  assert.ok(calls.every((c) => !c.includes('ignored/ref')));
});

test('upstreamRecordEntries: an explicit ref that does not resolve names it plainly', () => {
  const r = upstreamRecordEntries({ root: '/x', ref: 'origin/gone', _spawn: () => ({ status: 1, stdout: '' }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /given ref 'origin\/gone' does not resolve/);
});
