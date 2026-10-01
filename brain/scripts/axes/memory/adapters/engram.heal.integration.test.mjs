// engram.heal.integration.test.mjs — the engram duplicate heal (#1061, #864
// task 1.2a) proved against a REAL `engram` binary and a THROWAWAY store.
// Never the real `~/.engram` store: every write below runs through
// `isolatedExec()`, which merges `{ ENGRAM_DATA_DIR, HOME }` pointed at a
// `testTmp()` sandbox and asserts that sandbox is neither the real
// `~/.engram` nor outside the managed test-run root, BEFORE every call —
// belt and suspenders, since setting `HOME` too means even an engram build
// that ignored `ENGRAM_DATA_DIR` would still resolve its default inside the
// sandbox.
//
// Skips (naming which) when the binary is absent or its version is outside
// the tested `1.20.x` range — the same guard `healDuplicates` itself applies,
// so this file never asserts behaviour of a version nobody measured.
//
// The project name `issue-1061-heal-it` is unique to this suite: nothing
// under `.memory/` and nothing on the real store's project list should ever
// carry it, before or after this file runs (checked by the orchestrator
// running this suite, not by the suite itself — a sandboxed `ENGRAM_DATA_DIR`
// makes the real store unreachable from inside these tests by construction).

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { testTmp } from '../../../lib/test-tmp.mjs';
import { probeBinary, ENGRAM_BIN } from '../../../memory/lib/backend-selection.mjs';
import { parseEngramVersion, isTestedVersion } from '../../../memory/lib/engram-heal.mjs';
import { healDuplicates } from './engram.mjs';

const PROJECT = 'issue-1061-heal-it';
const REAL_ENGRAM_DB = join(homedir(), '.engram', 'engram.db');

function statOrNull(path) {
  try {
    const s = statSync(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  } catch {
    return null;
  }
}

function versionGuard() {
  const probe = probeBinary(ENGRAM_BIN);
  if (probe.available !== true) {
    return { skip: `engram binary not available (${probe.reason ?? 'not found via which'})` };
  }
  let stdout;
  try {
    stdout = execFileSync(ENGRAM_BIN, ['version'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  } catch (err) {
    return { skip: `\`engram version\` failed to run: ${err.message}` };
  }
  const version = parseEngramVersion(stdout);
  if (!isTestedVersion(version)) {
    return { skip: `installed engram reports '${stdout.trim()}', outside the tested 1.20.x range` };
  }
  return { skip: false };
}

const GUARD = versionGuard();
const testOpts = GUARD.skip ? { skip: GUARD.skip } : {};

let dbStatBefore = null;
before(() => {
  dbStatBefore = statOrNull(REAL_ENGRAM_DB);
});
after(() => {
  assert.deepEqual(
    statOrNull(REAL_ENGRAM_DB),
    dbStatBefore,
    'the real ~/.engram/engram.db must be byte-unchanged (size+mtime) after this file — every write in this suite must go through isolatedExec()',
  );
});

/** Refuses any dir that is not a managed `testTmp()` sandbox, and is never
 *  the real `~/.engram`. Called before EVERY isolated exec, not just once at
 *  setup — a seam that only checks its argument at construction time could
 *  still be reused against a different (unchecked) path later. */
function assertSandboxed(dir) {
  assert.ok(dir.startsWith(tmpdir()), `sandbox dir must be under the OS tmp root, got: ${dir}`);
  assert.match(dir, /brain-test-\d+-/, `sandbox dir must be under the managed testTmp() run root, got: ${dir}`);
  assert.notEqual(dir, join(homedir(), '.engram'), 'sandbox dir must never be the real ~/.engram');
}

/** `_exec` seam for `healDuplicates()` (and this file's own import/export
 *  helpers below): every call is forced through a throwaway `ENGRAM_DATA_DIR`
 *  — `HOME` is set too, so even an engram build that ignored the data-dir
 *  override would still resolve its default inside the sandbox, never
 *  `~/.engram`. */
function isolatedExec(dir) {
  assertSandboxed(dir);
  return (bin, args, opts = {}) => {
    assertSandboxed(dir);
    return execFileSync(bin, args, {
      ...opts,
      env: { ...process.env, ...(opts.env ?? {}), ENGRAM_DATA_DIR: dir, HOME: dir },
    });
  };
}

function healOpts(dir) {
  const exec = isolatedExec(dir);
  return {
    _exec: exec,
    _read: readFileSync,
    _probe: () => {
      try {
        return exec(ENGRAM_BIN, ['version'], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
      } catch {
        return null;
      }
    },
  };
}

let seq = 0;
function tmpFile(dir, label) {
  seq += 1;
  return join(dir, `${label}-${seq}.json`);
}

/** Imports fresh observations (no `id`/`sync_id` — engram assigns both). */
function importFresh(dir, exec, observations) {
  const startedAt = '2026-09-19 00:00:00';
  const payload = {
    version: '0.1.0',
    exported_at: startedAt,
    sessions: [{ id: 's1', project: PROJECT, started_at: startedAt, ended_at: null, summary: null }],
    prompts: [],
    observations: observations.map((o) => ({
      session_id: 's1', project: PROJECT, scope: 'project',
      created_at: startedAt, updated_at: startedAt, last_seen_at: startedAt,
      duplicate_count: 0, revision_count: 0,
      ...o,
    })),
  };
  const file = tmpFile(dir, 'import');
  writeFileSync(file, JSON.stringify(payload));
  exec(ENGRAM_BIN, ['import', file]);
}

/** Re-imports ONE already-exported row as a NEW row, sharing its `topic_key`
 *  but carrying a rewritten `sync_id` and no `id` — the exact mechanism
 *  design.md measured: re-importing an export UNCHANGED does not duplicate
 *  (deduped by `sync_id`); a rewritten `sync_id` does. `content` may be
 *  overridden to build the divergent-copy scenario (T-INT-2). */
function importDuplicateOf(dir, exec, row, { content } = {}) {
  const copy = { ...row, sync_id: `obs-dup-${row.id}-${Date.now()}-${Math.random().toString(36).slice(2)}` };
  delete copy.id;
  if (content !== undefined) copy.content = content;
  const file = tmpFile(dir, 'dup-import');
  writeFileSync(file, JSON.stringify({
    version: '0.1.0', exported_at: row.created_at,
    sessions: [{ id: 's1', project: PROJECT, started_at: row.created_at, ended_at: null, summary: null }],
    prompts: [], observations: [copy],
  }));
  exec(ENGRAM_BIN, ['import', file]);
}

function exportNow(dir, exec) {
  const file = tmpFile(dir, 'export');
  exec(ENGRAM_BIN, ['export', file], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
  return JSON.parse(readFileSync(file, 'utf8'));
}

function rowFor(doc, topicKey) {
  const rows = doc.observations.filter((o) => o.topic_key === topicKey);
  assert.equal(rows.length, 1, `expected exactly one row for ${topicKey} before duplicating it`);
  return rows[0];
}

// ── T-INT-1: the real duplicate shape, dry-run, apply, verify, no-op re-run ──

test('T-INT-1: two records imported once; a sync_id-rewritten copy duplicates ONE of them; dry-run is inert; apply hard-deletes; a second apply is a no-op', testOpts, () => {
  const dir = testTmp('engram-heal-it-');
  const exec = isolatedExec(dir);

  importFresh(dir, exec, [
    { topic_key: 'rec-a', title: 'A', content: 'content-a', type: 'decision' },
    { topic_key: 'rec-b', title: 'B', content: 'content-b', type: 'decision' },
  ]);
  const afterFirstImport = exportNow(dir, exec);
  assert.equal(afterFirstImport.observations.length, 2, 'two fresh records, two rows');

  importDuplicateOf(dir, exec, rowFor(afterFirstImport, 'rec-a'));
  const beforeHeal = exportNow(dir, exec);
  assert.equal(beforeHeal.observations.length, 3, 'rec-a now has two live rows, rec-b still has one');

  // Dry-run: inert.
  const dry = healDuplicates({ apply: false, ...healOpts(dir) });
  assert.equal(dry.outcome, 'planned');
  assert.equal(dry.groups.length, 1);
  assert.equal(dry.groups[0].key, 'rec-a');
  const afterDryRun = exportNow(dir, exec);
  assert.equal(afterDryRun.observations.length, 3, 'dry-run must not delete anything');

  // Apply: hard-deletes the non-keeper.
  const applied = healDuplicates({ apply: true, ...healOpts(dir) });
  assert.equal(applied.outcome, 'healed');
  assert.equal(applied.deleted.length, 1);
  const deletedId = applied.deleted[0];

  const afterApply = exportNow(dir, exec);
  assert.equal(afterApply.observations.length, 2, 'exactly the non-keeper row is gone — hard delete, not soft');
  assert.equal(
    afterApply.observations.some((o) => o.id === deletedId),
    false,
    'the hard-deleted row must be ABSENT from the export, not present with deleted_at set',
  );
  const recAKeys = afterApply.observations.filter((o) => o.topic_key === 'rec-a');
  const recBKeys = afterApply.observations.filter((o) => o.topic_key === 'rec-b');
  assert.equal(recAKeys.length, 1, 'rec-a: exactly the keeper remains');
  assert.equal(recBKeys.length, 1, 'rec-b was never touched');
  assert.equal(afterApply.observations.length, applied.rows, 'REQ-MB-5: distinct = rows on the healed store');
  const distinctKeys = new Set(afterApply.observations.map((o) => o.topic_key));
  assert.equal(distinctKeys.size, applied.distinct);

  // A second apply is a no-op.
  const secondApply = healDuplicates({ apply: true, ...healOpts(dir) });
  assert.equal(secondApply.outcome, 'none');
  const afterSecondApply = exportNow(dir, exec);
  assert.equal(afterSecondApply.observations.length, 2, 'no-op means literally nothing changed');
});

// ── T-INT-2: divergent copies refuse, row count unchanged ───────────────────

test('T-INT-2: two rows sharing a key with different content refuse; nothing is deleted', testOpts, () => {
  const dir = testTmp('engram-heal-it-');
  const exec = isolatedExec(dir);

  importFresh(dir, exec, [{ topic_key: 'rec-c', title: 'C', content: 'original', type: 'decision' }]);
  const afterImport = exportNow(dir, exec);
  importDuplicateOf(dir, exec, rowFor(afterImport, 'rec-c'), { content: 'different' });

  const beforeHeal = exportNow(dir, exec);
  assert.equal(beforeHeal.observations.length, 2);

  const result = healDuplicates({ apply: true, ...healOpts(dir) });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal, 'divergent');
  assert.equal(result.key, 'rec-c');
  assert.deepEqual(result.fields, ['content']);

  const afterHeal = exportNow(dir, exec);
  assert.equal(afterHeal.observations.length, 2, 'a refusal must delete nothing');
});

// ── T-INT-3: 3+ live rows sharing a key refuse tooMany ───────────────────────

test('T-INT-3: three live rows sharing one key refuse tooMany; nothing is deleted', testOpts, () => {
  const dir = testTmp('engram-heal-it-');
  const exec = isolatedExec(dir);

  importFresh(dir, exec, [{ topic_key: 'rec-d', title: 'D', content: 'content-d', type: 'decision' }]);
  const afterImport = exportNow(dir, exec);
  const original = rowFor(afterImport, 'rec-d');
  importDuplicateOf(dir, exec, original);
  const afterFirstDup = exportNow(dir, exec);
  // Duplicate again off the ORIGINAL row (not the copy) so both duplicates
  // carry distinct sync_ids independently of each other.
  importDuplicateOf(dir, exec, rowFor({ observations: afterFirstDup.observations.filter((o) => o.id === original.id) }, 'rec-d'));

  const beforeHeal = exportNow(dir, exec);
  assert.equal(beforeHeal.observations.filter((o) => o.topic_key === 'rec-d').length, 3);

  const result = healDuplicates({ apply: false, ...healOpts(dir) });
  assert.equal(result.outcome, 'refused');
  assert.equal(result.refusal, 'tooMany');
  assert.equal(result.key, 'rec-d');
  assert.equal(result.count, 3);

  const afterHeal = exportNow(dir, exec);
  assert.equal(afterHeal.observations.filter((o) => o.topic_key === 'rec-d').length, 3, 'a refusal must delete nothing');
});
