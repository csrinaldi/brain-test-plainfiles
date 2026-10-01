// no-artifact.parity.test.mjs — R12 acceptance (epic #864 task 2.4, issue
// #955): with no manifest, chunks, legacy, symlink or driver attribute, every
// verb hydrates from `.memory/records/` alone, on both backends where the
// operation exists at all. Modelled on reindex-parity.test.mjs.
//
// Design (openspec/changes/artifact-retirement/design.md, Testing Strategy).
// Each subtest builds its OWN `testTmp` fixture containing only
// `.memory/records/<one record>.jsonl`, injects every seam not under test,
// and ends with `assertOnlyRecordsAndIndex(root)`.
//
// The plainfiles `import` leg proves R12 by named-refusal vacuity (D5,
// ratified 2026-09-14, engram `sdd/artifact-retirement/design-decisions`):
// plainfiles has no `importMemory`, so `cli.mjs` refuses by name — this leg
// asserts that refusal and an untouched tree, never adding
// `plainfiles.importMemory`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { testTmp } from '../../lib/test-tmp.mjs';
import { buildRecord } from '../../memory/lib/format.mjs';
import { appendRecord } from '../../memory/lib/store.mjs';

import { share as plainfilesShare, pull as plainfilesPull } from './adapters/plainfiles.mjs';
import { share as engramShare, pullMemory as engramPullMemory, importMemory } from './adapters/engram.mjs';
import { runSessionStart, resolveSessionStrings } from '../../session-start.mjs';

const CLI_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'memory', 'cli.mjs');

/** Builds a fresh temp root with exactly one seeded record under `.memory/records/`. */
function fixtureWithOneRecord(prefix) {
  const root = testTmp(prefix);
  const recordsDir = join(root, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  const rec = buildRecord({
    ts: '2026-07-04T12:00:00Z',
    actor: '@test',
    actorKind: 'human',
    type: 'decision',
    project: 'brain',
    content: 'no-artifact parity seed record',
  });
  appendRecord(rec, { recordsDir });
  return { root, rec };
}

/** The root holds only `.memory/`, and `.memory/` holds only `records/` and `index.jsonl`. */
function assertOnlyRecordsAndIndex(root) {
  const rootEntries = readdirSync(root);
  assert.deepEqual(rootEntries, ['.memory'], `root must hold only .memory/, got: ${rootEntries.join(', ') || '(empty)'}`);
  const memoryEntries = readdirSync(join(root, '.memory'));
  for (const e of memoryEntries) {
    assert.ok(
      e === 'records' || e === 'index.jsonl',
      `.memory/ must hold only records/ and index.jsonl — found: ${e} (no manifest, no chunks/, no .engram symlink, no legacy/)`,
    );
  }
}

function walkTree(root) {
  const out = [];
  const walk = (dir, rel) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const r = rel ? `${rel}/${name}` : name;
      out.push(r);
      if (readdirSync(dir, { withFileTypes: true }).find((e) => e.name === name)?.isDirectory()) walk(p, r);
    }
  };
  try { walk(root, ''); } catch { /* root absent — untouched by definition */ }
  return out;
}

// ---------------------------------------------------------------------------
// session:start — backend-agnostic, runs once
// ---------------------------------------------------------------------------

test('no-artifact parity: session:start hydrates with no manifest operation — only memory/cli.mjs import reaches the spawn seam', async () => {
  const { root } = fixtureWithOneRecord('parity-session-');
  const calls = [];
  const _spawn = (cmd, args) => { calls.push(args); return { status: 0, stdout: '' }; };
  const _branch = () => 'main';
  const _changes = () => [];
  const _resume = () => null;
  const _recency = () => ({ ageDays: 0, newest: null });
  const strings = await resolveSessionStrings('en');

  const result = await runSessionStart(root, { _spawn, _branch, _changes, _resume, _recency }, strings);

  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1, `expected exactly one spawn call, got: ${JSON.stringify(calls)}`);
  assert.ok(typeof calls[0][0] === 'string' && calls[0][0].includes('memory/cli.mjs'));
  assert.equal(calls[0][1], 'import');

  assertOnlyRecordsAndIndex(root);
});

// ---------------------------------------------------------------------------
// share — plainfiles and engram
// ---------------------------------------------------------------------------

test('no-artifact parity: share() hydrates via reindex alone on both backends — no manifest, no .engram symlink required', async () => {
  {
    const { root } = fixtureWithOneRecord('parity-share-plainfiles-');
    const result = await plainfilesShare({ root });
    assert.equal(result.indexCount, 1, 'plainfiles.share() must index the one seeded record');
    assertOnlyRecordsAndIndex(root);
  }
  {
    const { root } = fixtureWithOneRecord('parity-share-engram-');
    const result = await engramShare({ root });
    assert.equal(result.indexCount, 1, 'engram.share() must index the one seeded record');
    assertOnlyRecordsAndIndex(root);
  }
});

// ---------------------------------------------------------------------------
// pull — plainfiles and engram
// ---------------------------------------------------------------------------

test('no-artifact parity: pull hydrates via git-pull-then-reindex alone on both backends — engram never touches a manifest seam', async () => {
  {
    const { root } = fixtureWithOneRecord('parity-pull-plainfiles-');
    const result = await plainfilesPull({ root }, { _gitPull: () => {} });
    assert.equal(result.indexCount, 1);
    assertOnlyRecordsAndIndex(root);
  }
  {
    const { root } = fixtureWithOneRecord('parity-pull-engram-');
    let imported = false;
    // Legacy manifest seams, injected deliberately: if pullMemory still reads
    // them, `_restoreManifest` throws and this subtest goes red for the right
    // reason. Once the manifest step is retired (#955 R6), these are inert —
    // extra, unused properties on the opts object.
    const result = await engramPullMemory({
      root,
      _gitPull: () => {},
      _import: () => { imported = true; },
      _isManifestDirty: () => true,
      _restoreManifest: () => { throw new Error('restoreManifest must never be called — the manifest step is retired (#955)'); },
    });
    assert.equal(result.indexCount, 1);
    assert.equal(imported, true, 'the import step must still run');
    assertOnlyRecordsAndIndex(root);
  }
});

// ---------------------------------------------------------------------------
// import — engram (real hydration) and plainfiles (named refusal, D5)
// ---------------------------------------------------------------------------

test('no-artifact parity: import — engram hydrates the one record from records/ alone; plainfiles refuses by name, tree untouched (D5)', async () => {
  {
    const { root, rec } = fixtureWithOneRecord('parity-import-engram-');
    let writtenTopicKey = null;
    const result = await importMemory({
      root,
      _guard: () => ({ held: true, release() {} }),
      _requireEngram: () => 'engram',
      _engramExistingTopicKeys: () => new Set(),
      _engramImport: (payload) => { writtenTopicKey = payload.observations?.[0]?.topic_key; },
      _log: () => {},
      _now: () => '2026-07-04 12:00:00',
    });
    assert.equal(result.written, 1);
    assert.equal(writtenTopicKey, rec.id, 'the record\'s own content-addressed id becomes the engram topic_key');
    assertOnlyRecordsAndIndex(root);
  }
  {
    const { root } = fixtureWithOneRecord('parity-import-plainfiles-');
    const before = walkTree(root);
    const r = spawnSync(process.execPath, [CLI_PATH, 'import'], {
      encoding: 'utf8',
      env: { ...process.env, MEMORY_BACKEND: 'plainfiles', BRAIN_MEMORY_TEST_ROOT: root },
    });
    assert.equal(r.status, 1, `plainfiles import must refuse (D5); stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
    assert.match(r.stderr, /backend 'plainfiles' does not implement op 'import'/);
    assert.deepEqual(walkTree(root), before, 'the refusal must leave the tree untouched');
  }
});
