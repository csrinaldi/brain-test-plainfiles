// default-branch-records.test.mjs — RED coverage for #1024's default-branch
// reader (design.md D1/D2/D4). Every git call is INJECTED — no real git
// process here (that is default-branch-records.integration.test.mjs's job).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  readDefaultBranchRecords,
  unionRecordsById,
  dedupeJsonlRecords,
} from './default-branch-records.mjs';
import { readRecordObservations } from '../memory/lib/store.mjs';
import { testTmp } from '../lib/test-tmp.mjs';

/** `git rev-parse --is-shallow-repository` output for a SHALLOW checkout —
 *  the CI scenario these unit tests model (D1, incident fix batch 2: the
 *  targeted fetch only ever runs when the checkout is already shallow). */
const SHALLOW_TRUE = Buffer.from('true\n', 'utf8');
/** ...and for a FULL (non-shallow) clone — the fetch must never run. */
const SHALLOW_FALSE = Buffer.from('false\n', 'utf8');

/** Builds a fake `git cat-file --batch` output buffer for the given ordered
 *  entries: `{ content: string }` for a found blob (sha is irrelevant to the
 *  parser, a fixed 40-hex placeholder is used), or `{ missing: true, ref }`
 *  for a missing object. */
function buildBatchBuffer(entries) {
  const parts = [];
  for (const e of entries) {
    if (e.missing) {
      parts.push(Buffer.from(`${e.ref} missing\n`, 'utf8'));
      continue;
    }
    const contentBuf = Buffer.from(e.content, 'utf8');
    parts.push(Buffer.from(`${'a'.repeat(40)} blob ${contentBuf.length}\n`, 'utf8'));
    parts.push(contentBuf);
    parts.push(Buffer.from('\n', 'utf8'));
  }
  return Buffer.concat(parts);
}

test('readDefaultBranchRecords: DEFAULT_BRANCH not mapped', () => {
  const result = readDefaultBranchRecords({ defaultBranch: null, git: () => { throw new Error('must not be called'); } });
  assert.deepEqual(result, { records: [], error: 'DEFAULT_BRANCH not mapped', fetched: false });
});

test('readDefaultBranchRecords: checks is-shallow-repository FIRST, then the exact fetch, ls-tree and cat-file argv on a shallow checkout (D1/D2, incident fix batch 2)', () => {
  const calls = [];
  const git = (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'rev-parse') return SHALLOW_TRUE;
    if (args[0] === 'fetch') return Buffer.alloc(0);
    if (args[0] === 'ls-tree') return Buffer.from('.memory/records/2026-09-rec-aaaaaaaaaaaaaaaa.jsonl\0', 'utf8');
    if (args[0] === 'cat-file') {
      return buildBatchBuffer([{ content: JSON.stringify({ id: 'rec-aaaaaaaaaaaaaaaa', issue: 1024, type: 'session_summary' }) + '\n' }]);
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  const result = readDefaultBranchRecords({ defaultBranch: 'main', cwd: '/repo', git });

  assert.deepEqual(calls[0].args, ['rev-parse', '--is-shallow-repository']);
  assert.equal(calls[0].opts.cwd, '/repo');
  assert.deepEqual(calls[1].args, ['fetch', '--no-tags', '--depth=1', 'origin', '+refs/heads/main:refs/remotes/origin/main']);
  assert.equal(calls[1].opts.cwd, '/repo');
  assert.deepEqual(calls[2].args, ['ls-tree', '-r', '-z', '--name-only', 'refs/remotes/origin/main', '--', '.memory/records/']);
  assert.deepEqual(calls[3].args, ['cat-file', '--batch']);
  assert.equal(calls[3].opts.input, 'refs/remotes/origin/main:.memory/records/2026-09-rec-aaaaaaaaaaaaaaaa.jsonl\n');
  assert.equal(result.error, null);
  assert.deepEqual(result.records, [{ id: 'rec-aaaaaaaaaaaaaaaa', issue: 1024, type: 'session_summary' }]);
  // Batch 3 MINOR (visibility): the caller needs to know whether this read
  // came from a LIVE fetch (shallow checkout, fresh) or a local ref that was
  // never fetched (full clone, potentially stale) — see the `pathDetail`
  // wiring test in run-check.test.mjs.
  assert.equal(result.fetched, true, 'a shallow checkout must report fetched: true');
});

test('readDefaultBranchRecords: is-shallow-repository is FALSE (full clone) — the fetch never runs, ls-tree/cat-file run directly against the existing ref (incident fix batch 2)', () => {
  const calls = [];
  const git = (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'rev-parse') return SHALLOW_FALSE;
    if (args[0] === 'fetch') throw new Error('the fetch must NEVER run on a full (non-shallow) clone — #1024 incident');
    if (args[0] === 'ls-tree') return Buffer.from('.memory/records/2026-09-rec-eeeeeeeeeeeeeeee.jsonl\0', 'utf8');
    if (args[0] === 'cat-file') {
      return buildBatchBuffer([{ content: JSON.stringify({ id: 'rec-eeeeeeeeeeeeeeee', issue: 1024, type: 'session_summary' }) + '\n' }]);
    }
    throw new Error(`unexpected git call: ${args.join(' ')}`);
  };

  const result = readDefaultBranchRecords({ defaultBranch: 'main', cwd: '/repo', git });

  assert.deepEqual(calls.map((c) => c.args[0]), ['rev-parse', 'ls-tree', 'cat-file'], 'fetch must be entirely absent from the call sequence');
  assert.equal(result.error, null);
  assert.deepEqual(result.records, [{ id: 'rec-eeeeeeeeeeeeeeee', issue: 1024, type: 'session_summary' }]);
  // Batch 3 MINOR (visibility): a non-shallow read is from a LOCAL ref that
  // was never fetched — potentially stale evidence — and the caller must be
  // able to tell.
  assert.equal(result.fetched, false, 'a full clone (no fetch) must report fetched: false');
});

test('readDefaultBranchRecords: is-shallow-repository throws (unresolvable) — defaults to NOT fetching (the safe direction)', () => {
  const calls = [];
  const git = (args, opts) => {
    calls.push({ args, opts });
    if (args[0] === 'rev-parse') { const e = new Error('boom'); e.stderr = Buffer.from('fatal: not a git repository\n'); throw e; }
    if (args[0] === 'fetch') throw new Error('must not be called when shallow-ness is unresolvable');
    if (args[0] === 'ls-tree') return Buffer.alloc(0);
    throw new Error('unexpected');
  };
  const result = readDefaultBranchRecords({ defaultBranch: 'main', git });
  assert.deepEqual(calls.map((c) => c.args[0]), ['rev-parse', 'ls-tree']);
  assert.deepEqual(result, { records: [], error: null, fetched: false });
});

test('readDefaultBranchRecords: batch parsing handles embedded newlines and a missing entry', () => {
  const withNewline = JSON.stringify({ id: 'rec-bbbbbbbbbbbbbbbb', issue: 7, note: 'line one\nline two' });
  const git = (args) => {
    if (args[0] === 'rev-parse') return SHALLOW_TRUE;
    if (args[0] === 'fetch') return Buffer.alloc(0);
    if (args[0] === 'ls-tree') {
      return Buffer.from(
        '.memory/records/2026-09-rec-bbbbbbbbbbbbbbbb.jsonl\0.memory/records/2026-09-rec-cccccccccccccccc.jsonl\0',
        'utf8',
      );
    }
    if (args[0] === 'cat-file') {
      return buildBatchBuffer([
        { content: withNewline + '\n' },
        { missing: true, ref: 'refs/remotes/origin/main:.memory/records/2026-09-rec-cccccccccccccccc.jsonl' },
      ]);
    }
    throw new Error('unexpected');
  };

  const result = readDefaultBranchRecords({ defaultBranch: 'main', git });
  assert.equal(result.error, null);
  assert.deepEqual(result.records, [{ id: 'rec-bbbbbbbbbbbbbbbb', issue: 7, note: 'line one\nline two' }]);
});

// #1024 Batch 4 (live-CI bug, PR #1048): execFileSync's default `maxBuffer`
// is 1 MiB. `git cat-file --batch` for a large `.memory/records/` volume
// (measured 8,967,273 bytes on this repo's real origin/main) exceeds it and
// throws ENOBUFS — with an EMPTY `stderr` (the child is killed before any
// stderr is captured), so the old `firstStderrLine` produced a bare, silent
// "git cat-file failed: " with nothing after the colon. Every test before
// this batch stayed under 1 MiB, so the defect never showed up here.
test('readDefaultBranchRecords: a cat-file failure with EMPTY stderr (e.g. ENOBUFS) still names the cause — never a bare "failed: " with nothing after the colon', () => {
  const result = readDefaultBranchRecords({
    defaultBranch: 'main',
    git: (args) => {
      if (args[0] === 'rev-parse') return SHALLOW_TRUE;
      if (args[0] === 'fetch') return Buffer.alloc(0);
      if (args[0] === 'ls-tree') return Buffer.from('.memory/records/2026-09-rec-ffffffffffffffff.jsonl\0', 'utf8');
      if (args[0] === 'cat-file') {
        const e = new Error('spawnSync git ENOBUFS');
        e.code = 'ENOBUFS';
        e.stderr = Buffer.alloc(0);
        throw e;
      }
      throw new Error('unexpected');
    },
  });
  assert.equal(result.records.length, 0);
  assert.notEqual(result.error, 'git cat-file failed: ', 'must never end in a bare, silent colon with no cause');
  assert.match(result.error, /ENOBUFS/, 'must name the actual cause (the thrown error\'s code/message) when stderr is empty');
});

test('readDefaultBranchRecords: a fetch failure with EMPTY stderr also falls back to the error\'s code/message (same fix, D1 path)', () => {
  const result = readDefaultBranchRecords({
    defaultBranch: 'main',
    git: (args) => {
      if (args[0] === 'rev-parse') return SHALLOW_TRUE;
      const e = new Error('spawnSync git ETIMEDOUT');
      e.code = 'ETIMEDOUT';
      e.stderr = Buffer.alloc(0);
      throw e;
    },
  });
  assert.notEqual(result.error, 'git fetch origin main failed: ');
  assert.match(result.error, /ETIMEDOUT/);
});

test('readDefaultBranchRecords: cause strings are verbatim', () => {
  const fetchFail = readDefaultBranchRecords({
    defaultBranch: 'main',
    git: (args) => {
      if (args[0] === 'rev-parse') return SHALLOW_TRUE;
      const e = new Error('boom'); e.stderr = Buffer.from('fatal: could not read from remote repository\nmore\n'); throw e;
    },
  });
  assert.equal(fetchFail.error, 'git fetch origin main failed: fatal: could not read from remote repository');

  const lsTreeFail = readDefaultBranchRecords({
    defaultBranch: 'main',
    git: (args) => {
      if (args[0] === 'rev-parse') return SHALLOW_TRUE;
      if (args[0] === 'fetch') return Buffer.alloc(0);
      const e = new Error('boom'); e.stderr = Buffer.from('fatal: not a tree object\n'); throw e;
    },
  });
  assert.equal(lsTreeFail.error, 'git ls-tree failed: fatal: not a tree object');

  const catFileFail = readDefaultBranchRecords({
    defaultBranch: 'main',
    git: (args) => {
      if (args[0] === 'rev-parse') return SHALLOW_TRUE;
      if (args[0] === 'fetch') return Buffer.alloc(0);
      if (args[0] === 'ls-tree') return Buffer.from('.memory/records/x.jsonl\0', 'utf8');
      const e = new Error('boom'); e.stderr = Buffer.from('fatal: unable to read batch\n'); throw e;
    },
  });
  assert.equal(catFileFail.error, 'git cat-file failed: fatal: unable to read batch');
});

test('readDefaultBranchRecords: an empty listing returns [] with no error', () => {
  const git = (args) => {
    if (args[0] === 'rev-parse') return SHALLOW_TRUE;
    if (args[0] === 'fetch') return Buffer.alloc(0);
    if (args[0] === 'ls-tree') return Buffer.alloc(0);
    throw new Error('cat-file must not be called on an empty listing');
  };
  const result = readDefaultBranchRecords({ defaultBranch: 'main', git });
  assert.deepEqual(result, { records: [], error: null, fetched: true });
});

test('readDefaultBranchRecords: a corrupt line is skipped', () => {
  const git = (args) => {
    if (args[0] === 'rev-parse') return SHALLOW_TRUE;
    if (args[0] === 'fetch') return Buffer.alloc(0);
    if (args[0] === 'ls-tree') return Buffer.from('.memory/records/2026-09-rec-dddddddddddddddd.jsonl\0', 'utf8');
    if (args[0] === 'cat-file') {
      return buildBatchBuffer([{ content: 'not json\n' + JSON.stringify({ id: 'rec-dddddddddddddddd', issue: 3 }) + '\n' }]);
    }
    throw new Error('unexpected');
  };
  const result = readDefaultBranchRecords({ defaultBranch: 'main', git });
  assert.deepEqual(result.records, [{ id: 'rec-dddddddddddddddd', issue: 3 }]);
});

// ── unionRecordsById (D4) ────────────────────────────────────────────────

test('unionRecordsById: PR tree wins on a shared id, counted once', () => {
  const pr = [{ id: 'rec-1', issue: 1, source: 'pr' }];
  const branch = [{ id: 'rec-1', issue: 1, source: 'branch' }];
  const union = unionRecordsById(pr, branch);
  assert.deepEqual(union, [{ id: 'rec-1', issue: 1, source: 'pr' }]);
});

test('unionRecordsById: id-less records from both sources are kept', () => {
  const pr = [{ issue: 1 }];
  const branch = [{ issue: 2 }];
  const union = unionRecordsById(pr, branch);
  assert.deepEqual(union, [{ issue: 1 }, { issue: 2 }]);
});

test('unionRecordsById: a default-branch-only record is included', () => {
  const pr = [{ id: 'rec-1', issue: 1 }];
  const branch = [{ id: 'rec-2', issue: 2 }];
  const union = unionRecordsById(pr, branch);
  assert.deepEqual(union, [{ id: 'rec-1', issue: 1 }, { id: 'rec-2', issue: 2 }]);
});

// ── Parity (task 1.3, D4): the copied parse/dedupe rule must agree with
// store.mjs#readRecords on an identical fixture, without refactoring
// store.mjs itself. ─────────────────────────────────────────────────────

test('dedupeJsonlRecords: parity with store.mjs#readRecordObservations on an identical fixture', () => {
  const dir = testTmp('default-branch-records-parity-');
  const recordsDir = join(dir, 'records');
  mkdirSync(recordsDir, { recursive: true });

  const fileA = '2026-09-01-rec-1111111111111111.jsonl';
  const fileB = '2026-09-02-rec-2222222222222222.jsonl';
  const contentA = JSON.stringify({ id: 'rec-1111111111111111', issue: 10, type: 'session_summary' }) + '\n';
  // A duplicate id across files — first file (sorted) wins, per store.mjs.
  const contentB = JSON.stringify({ id: 'rec-1111111111111111', issue: 10, type: 'stale-duplicate' }) + '\n'
    + JSON.stringify({ id: 'rec-2222222222222222', issue: 11 }) + '\n'
    + 'not json at all\n'
    + JSON.stringify({ issue: 12 }) + '\n'; // id-less, passes through

  writeFileSync(join(recordsDir, fileA), contentA, 'utf8');
  writeFileSync(join(recordsDir, fileB), contentB, 'utf8');

  const expected = readRecordObservations({ recordsDir });
  const actual = dedupeJsonlRecords([
    { filename: fileA, content: contentA },
    { filename: fileB, content: contentB },
  ]);

  assert.deepEqual(actual, expected);
});
