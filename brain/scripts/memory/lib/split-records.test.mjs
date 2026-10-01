// split-records.test.mjs — the month log → one-file-per-record migration
// (issue #677).
//
// The suite is organised around the two questions that decide whether this verb
// is safe to point at a durable log:
//
//   1. does it refuse everything it cannot read, BEFORE writing anything?
//   2. does it prove the new layout holds every record BEFORE deleting the old?
//
// and one that decides whether it is worth doing at all:
//
//   3. does the resulting layout merge without a driver, where the month log
//      does not? That test is `merge-without-a-driver` at the bottom, and it
//      runs real `git merge-tree` — the point of the ticket is that reading
//      `.gitattributes` proves nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { planSplit, runSplit } from './split-records.mjs';
import { buildRecord, serializeRecord } from './format.mjs';
import { testTmp } from '../../lib/test-tmp.mjs';

function tmpRecordsDir() {
  const root = testTmp('brain-split-records-');
  const recordsDir = join(root, 'records');
  mkdirSync(recordsDir, { recursive: true });
  return recordsDir;
}

/** A valid record whose `ts` decides its month, so month files are addressable. */
function rec({ content = 'a record', ts = '2026-08-01T10:00:00Z', ...rest } = {}) {
  return buildRecord({ type: 'discovery', content, project: 'brain', actor: 'tester', actorKind: 'agent', ts, ...rest });
}

function writeMonth(recordsDir, month, records) {
  writeFileSync(join(recordsDir, `${month}.jsonl`), records.map(serializeRecord).join('\n') + '\n', 'utf8');
}

const perRecordFiles = (dir) => readdirSync(dir).filter((f) => !/^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
const monthFiles = (dir) => readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();

// ── 1. the plan, and what it refuses ─────────────────────────────────────────

test('planSplit names one file per record, <yyyy-mm>-<id>.jsonl', () => {
  const dir = tmpRecordsDir();
  const a = rec({ content: 'first' });
  const b = rec({ content: 'second', ts: '2026-09-02T11:00:00Z' });
  writeMonth(dir, '2026-08', [a]);
  writeMonth(dir, '2026-09', [b]);

  const plan = planSplit({ recordsDir: dir });
  assert.equal(plan.lines, 2);
  assert.deepEqual(
    plan.writes.map((w) => w.filename).sort(),
    [`2026-08-${a.id}.jsonl`, `2026-09-${b.id}.jsonl`].sort(),
  );
  assert.deepEqual(plan.monthFiles, ['2026-08.jsonl', '2026-09.jsonl']);
});

test('planSplit writes NOTHING — a dry run cannot mutate the store', () => {
  const dir = tmpRecordsDir();
  writeMonth(dir, '2026-08', [rec()]);
  planSplit({ recordsDir: dir });
  assert.deepEqual(readdirSync(dir), ['2026-08.jsonl']);
});

test('a corrupt line is REFUSED with <file>:<line>, and nothing is written', () => {
  const dir = tmpRecordsDir();
  writeFileSync(join(dir, '2026-08.jsonl'), serializeRecord(rec()) + '\n{ not json\n', 'utf8');

  assert.throws(() => runSplit({ recordsDir: dir, apply: true }), /corrupt record at 2026-08\.jsonl:2/);
  assert.deepEqual(readdirSync(dir), ['2026-08.jsonl'], 'the store must be untouched');
});

test('a tampered line — bytes that no longer hash to the id — is REFUSED', () => {
  const dir = tmpRecordsDir();
  const r = rec({ content: 'honest' });
  const tampered = { ...r, content: 'honest, edited by hand' };
  writeFileSync(join(dir, '2026-08.jsonl'), serializeRecord(tampered) + '\n', 'utf8');

  assert.throws(() => runSplit({ recordsDir: dir, apply: true }), /id mismatch at 2026-08\.jsonl:1/);
  assert.deepEqual(readdirSync(dir), ['2026-08.jsonl']);
});

// ── 2. duplicates are REPORTED, never refused (ADR-0017 Amendment 1) ─────────

test('a repeated id is collapsed FIRST-WINS and reported, not refused', () => {
  const dir = tmpRecordsDir();
  const r = rec({ content: 'said twice' });
  writeFileSync(join(dir, '2026-08.jsonl'), [serializeRecord(r), serializeRecord(r)].join('\n') + '\n', 'utf8');

  const out = runSplit({ recordsDir: dir, apply: true });
  assert.equal(out.lines, 2);
  assert.equal(out.written, 1);
  assert.equal(out.duplicates.length, 1);
  assert.equal(out.duplicates[0].at, '2026-08.jsonl:2');
  assert.equal(out.duplicates[0].firstAt, '2026-08.jsonl:1');
  assert.equal(out.duplicates[0].divergent, false);
  assert.deepEqual(perRecordFiles(dir), [`2026-08-${r.id}.jsonl`]);
});

test('a DIVERGENT repeat — same id, `source` widened — is reported as divergent and the FIRST line survives', () => {
  const dir = tmpRecordsDir();
  const r = rec({ content: 'round-tripped', source: 'PR #405' });
  const widened = { ...r, source: 'issue #405 / PR #405' }; // `source` is not hashed — same id
  assert.equal(widened.id, r.id, 'precondition: the round-trip does not change the id');
  writeFileSync(join(dir, '2026-08.jsonl'), [serializeRecord(r), serializeRecord(widened)].join('\n') + '\n', 'utf8');

  const out = runSplit({ recordsDir: dir, apply: true });
  assert.equal(out.duplicates.length, 1);
  assert.equal(out.duplicates[0].divergent, true);
  const survivor = JSON.parse(readFileSync(join(dir, `2026-08-${r.id}.jsonl`), 'utf8'));
  assert.equal(survivor.source, 'PR #405', 'first-wins: the earliest line, exactly as the readers resolve it');
});

// ── 3. apply: byte-preserving, verified, idempotent ──────────────────────────

test('every record survives the split with its bytes untouched, one line per file', () => {
  const dir = tmpRecordsDir();
  const records = [rec({ content: 'one' }), rec({ content: 'two' }), rec({ content: 'three', ts: '2026-09-01T10:00:00Z' })];
  writeMonth(dir, '2026-08', records.slice(0, 2));
  writeMonth(dir, '2026-09', records.slice(2));
  const before = records.map(serializeRecord).sort();

  const out = runSplit({ recordsDir: dir, apply: true });
  assert.equal(out.written, 3);
  assert.equal(out.verified, true);

  const after = perRecordFiles(dir).map((f) => {
    const lines = readFileSync(join(dir, f), 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.equal(lines.length, 1, `${f} must hold exactly one record`);
    return lines[0];
  }).sort();
  assert.deepEqual(after, before, 'byte-for-byte, not merely record-for-record');
});

test('the month files are removed only AFTER the records read back', () => {
  const dir = tmpRecordsDir();
  writeMonth(dir, '2026-08', [rec({ content: 'x' }), rec({ content: 'y' })]);
  runSplit({ recordsDir: dir, apply: true });
  assert.deepEqual(monthFiles(dir), [], 'month files gone');
  assert.equal(perRecordFiles(dir).length, 2);
});

test('a write that does not land REFUSES the delete — both layouts survive, never a short store', () => {
  // The branch that matters most, and the one a working writer never reaches.
  // A store that ends up duplicated is detectable (reindex reports it); a store
  // that ends up short a record is not — that is `evidence-reader-empty-on-failure`
  // written into the durable log. So the verb must prefer the detectable failure.
  const dir = tmpRecordsDir();
  const records = [rec({ content: 'x' }), rec({ content: 'y' })];
  writeMonth(dir, '2026-08', records);

  assert.throws(
    () => runSplit({ recordsDir: dir, apply: true, _writeFile: () => {} }),
    /refusing to delete the month files — 2 of 2 record\(s\) did not read back/,
  );
  assert.deepEqual(monthFiles(dir), ['2026-08.jsonl'], 'the month file is still there');
  assert.deepEqual(perRecordFiles(dir), [], 'and nothing landed beside it');
});

test('a PARTIAL write also refuses — one record short is still short', () => {
  const dir = tmpRecordsDir();
  const records = [rec({ content: 'x' }), rec({ content: 'y' })];
  writeMonth(dir, '2026-08', records);
  let calls = 0;
  assert.throws(
    () => runSplit({
      recordsDir: dir,
      apply: true,
      _writeFile: (...args) => { if (calls++ === 0) writeFileSync(...args); },
    }),
    /refusing to delete the month files — 1 of 2 record\(s\) did not read back/,
  );
  assert.deepEqual(monthFiles(dir), ['2026-08.jsonl']);
  assert.equal(perRecordFiles(dir).length, 1, 'the one that DID land stays — it is a duplicate, not a loss');
});

test('a second --apply is a no-op: nothing to split, nothing destroyed', () => {
  const dir = tmpRecordsDir();
  writeMonth(dir, '2026-08', [rec({ content: 'x' })]);
  runSplit({ recordsDir: dir, apply: true });
  const snapshot = perRecordFiles(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]);

  const again = runSplit({ recordsDir: dir, apply: true });
  assert.deepEqual(again.monthFiles, []);
  assert.equal(again.written, 0);
  assert.deepEqual(perRecordFiles(dir).map((f) => [f, readFileSync(join(dir, f), 'utf8')]), snapshot);
});

test('a per-record file already on disk is never overwritten — first-wins across a merge', () => {
  const dir = tmpRecordsDir();
  const r = rec({ content: 'merged in from another branch', source: 'PR #1' });
  const widened = { ...r, source: 'issue #1 / PR #1' };
  writeFileSync(join(dir, `2026-08-${r.id}.jsonl`), serializeRecord(widened) + '\n', 'utf8');
  writeMonth(dir, '2026-08', [r]);

  const out = runSplit({ recordsDir: dir, apply: true });
  assert.equal(out.alreadyPresent, 1);
  assert.equal(out.written, 0);
  assert.equal(
    JSON.parse(readFileSync(join(dir, `2026-08-${r.id}.jsonl`), 'utf8')).source,
    'issue #1 / PR #1',
    'what was already on disk stays — it may be what another branch merged in',
  );
  assert.deepEqual(monthFiles(dir), [], 'and the month file still goes, because the record is present');
});

// ── 4. the property the ticket exists for ────────────────────────────────────

const git = (cwd, ...args) => spawnSync('git', args, { cwd, encoding: 'utf8' });

function initRepo() {
  const root = testTmp('brain-split-merge-');
  git(root, 'init', '-q', '-b', 'main', '.');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'test');
  return root;
}

function commitAll(root, message) {
  git(root, 'add', '-A');
  git(root, 'commit', '-qm', message);
}

test('merge-without-a-driver: the month log CONFLICTS and one-file-per-record does not', { skip: spawnSync('git', ['--version']).status !== 0 ? 'git unavailable' : false }, () => {
  // Two branches, two DIFFERENT records, one shared base — the exact shape of
  // two open PRs that each capture a session (#677). No `.gitattributes`, which
  // is the condition on the forge that performs the merge.
  const a = rec({ content: 'branch A session' });
  const b = rec({ content: 'branch B session' });
  const base = rec({ content: 'already on main' });

  // (a) the month log
  const monthRepo = initRepo();
  mkdirSync(join(monthRepo, 'records'), { recursive: true });
  writeMonth(join(monthRepo, 'records'), '2026-08', [base]);
  commitAll(monthRepo, 'base');
  for (const [branch, r] of [['A', a], ['B', b]]) {
    git(monthRepo, 'checkout', '-q', '-b', branch, 'main');
    writeMonth(join(monthRepo, 'records'), '2026-08', [base, r]);
    commitAll(monthRepo, branch);
  }
  const monthMerge = git(monthRepo, 'merge-tree', '--write-tree', 'A', 'B');
  assert.notEqual(monthMerge.status, 0, 'the month log must conflict — this is the bug #677 reports');

  // (b) one file per record, built by the verb under test
  const splitRepo = initRepo();
  const splitRecords = join(splitRepo, 'records');
  mkdirSync(splitRecords, { recursive: true });
  writeMonth(splitRecords, '2026-08', [base]);
  runSplit({ recordsDir: splitRecords, apply: true });
  commitAll(splitRepo, 'base');
  for (const [branch, r] of [['A', a], ['B', b]]) {
    git(splitRepo, 'checkout', '-q', '-b', branch, 'main');
    writeFileSync(join(splitRecords, `2026-08-${r.id}.jsonl`), serializeRecord(r) + '\n', 'utf8');
    commitAll(splitRepo, branch);
  }
  const splitMerge = git(splitRepo, 'merge-tree', '--write-tree', 'A', 'B');
  assert.equal(splitMerge.status, 0, `one file per record must merge clean without any driver — got:\n${splitMerge.stdout}`);

  // and BOTH records are in the merged tree, which is the half a conflict UI loses
  const tree = splitMerge.stdout.trim().split('\n')[0];
  const listed = git(splitRepo, 'ls-tree', '-r', '--name-only', tree, 'records').stdout;
  assert.match(listed, new RegExp(`2026-08-${a.id}\\.jsonl`));
  assert.match(listed, new RegExp(`2026-08-${b.id}\\.jsonl`));
  assert.equal(existsSync(join(splitRecords, '2026-08.jsonl')), false);

  removeTempTree(monthRepo);
  removeTempTree(splitRepo);
});
