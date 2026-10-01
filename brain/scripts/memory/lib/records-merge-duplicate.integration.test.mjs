// records-merge-duplicate.integration.test.mjs — issue #574 evidence.
//
// records-merge.integration.test.mjs proves the DISTINCT-record merge: two
// branches capture different records and, since #677, land in different files
// that merge with no driver at all. This is its sibling for the case where a
// merge still mints a DUPLICATE physical line — the whole argument for
// deduplicate-and-report over refuse, executed against real git rather than
// asserted in a comment.
//
// WHAT CHANGED WITH #677, STATED RATHER THAN QUIETLY DROPPED. The scenario this
// file used to run — two branches holding the same record, union concatenating
// both copies into one month file — no longer produces a duplicate: the same
// record is the same `<yyyy-mm>-<id>.jsonl` with the same bytes, and git merges
// that as an identical add/add. That is the layout working, not the rule
// becoming unnecessary, so the rule keeps its evidence here against the two
// shapes that CAN still produce a repeat:
//
//   1. a half-migrated store — a month file merged back beside the per-record
//      files split out of it. This is not hypothetical: a branch that captured
//      memory before the split still carries `<yyyy-mm>.jsonl`, and a human
//      resolving that delete/modify conflict by keeping it lands exactly here.
//   2. the union driver where it DOES run, applied to the one residual conflict
//      — a same-`id` pair whose bytes diverge (ADR-0017 Amendment 1) — which it
//      resolves into a two-line file rather than a conflict.
//
// If `rebuildIndex` refused a duplicate, case 1 would leave the store
// unindexable mid-migration, and `brain:memory:reindex` — the command doctrine
// prescribes for finishing a merge — would be the thing that could no longer
// run.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildRecord, serializeRecord } from './format.mjs';
import { appendRecord, rebuildIndex, recordFilename } from './store.mjs';

function git(cwd, args, { allowFailure = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

const BASE = {
  ts: '2026-07-04T12:00:00Z', actor: '@crinaldi', actorKind: 'human', type: 'decision', project: 'brain',
};

function initRepo(t) {
  const repo = mkdtempSync(join(tmpdir(), 'brain-records-dup-merge-'));
  t.after(() => removeTempTree(repo));
  const recordsDir = join(repo, '.memory', 'records');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'brain-test']);
  writeFileSync(join(repo, '.gitattributes'), '.memory/records/*.jsonl merge=union\n');
  mkdirSync(recordsDir, { recursive: true });
  git(repo, ['add', '.gitattributes']);
  git(repo, ['commit', '-q', '-m', 'init: declare union-merge attribute']);
  return { repo, recordsDir, indexPath: join(repo, '.memory', 'index.jsonl') };
}

test('#677: the same record captured on both branches no longer duplicates — one id, one filename, identical bytes', (t) => {
  const { repo, recordsDir, indexPath } = initRepo(t);
  const seed = buildRecord({ ...BASE, content: 'Already on main before either branch.' });
  const recP = buildRecord({ ...BASE, content: 'Decision P, captured on both branches.' });

  appendRecord(seed, { recordsDir });
  git(repo, ['add', '.memory/records']);
  git(repo, ['commit', '-q', '-m', 'main: seed record']);

  for (const branch of ['branch-x', 'branch-y']) {
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['checkout', '-q', '-b', branch]);
    mkdirSync(recordsDir, { recursive: true });
    appendRecord(recP, { recordsDir });
    git(repo, ['add', '.memory/records']);
    git(repo, ['commit', '-q', '-m', `${branch}: capture P`]);
  }

  const merge = git(repo, ['merge', '--no-edit', 'branch-x'], { allowFailure: true });
  assert.equal(merge.status, 0, 'identical add/add is a clean merge');
  assert.deepEqual(readdirSync(recordsDir).sort(), [recordFilename(seed), recordFilename(recP)].sort());
  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });
  assert.equal(count, 2);
  assert.equal(duplicates.lines, 0, 'nothing to collapse — the layout prevented the duplicate rather than surviving it');
});

test('#574: a half-migrated store — a month file merged back beside the records split out of it — is collapsed AND reported, never refused', (t) => {
  const { recordsDir, indexPath } = initRepo(t);
  const recP = buildRecord({ ...BASE, content: 'Decision P, captured before the split.' });
  const recQ = buildRecord({ ...BASE, content: 'Decision Q, captured before the split.' });

  // The post-split layout…
  appendRecord(recP, { recordsDir });
  appendRecord(recQ, { recordsDir });
  // …and the pre-split month file, brought back by a branch that predates it.
  writeFileSync(
    join(recordsDir, '2026-07.jsonl'),
    [serializeRecord(recP), serializeRecord(recQ)].join('\n') + '\n',
    'utf8',
  );

  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });
  assert.equal(count, 2, 'two records — the collapse is lossless because the repeated lines agree');
  assert.equal(duplicates.ids, 2);
  assert.equal(duplicates.lines, 2, 'the store is exactly two physical lines longer than the index');
  assert.deepEqual(
    duplicates.groups.map((g) => g.occurrences.length),
    [2, 2],
    'every physical location is accounted for, not just the count',
  );
  // FIRST WINS is the earliest line of the earliest FILE, and `2026-07-rec-…`
  // sorts before `2026-07.jsonl` — so the winner is the per-record file, which
  // is also the one the migration verified. Named rather than left to luck.
  for (const g of duplicates.groups) {
    assert.match(g.occurrences[0], /^2026-07-rec-[0-9a-f]{16}\.jsonl:1$/);
  }

  const again = rebuildIndex({ recordsDir, indexPath });
  assert.equal(again.count, 2);
  assert.equal(again.duplicates.lines, 2, 'idempotent — reporting a duplicate does not consume it');
});

test('#574: union on the residual DIVERGENT pair yields a two-line record file — indexed once, reported, still runnable', (t) => {
  const { repo, recordsDir, indexPath } = initRepo(t);
  const rec = buildRecord({ ...BASE, content: 'Captured once, exported twice.', source: 'PR #405' });
  const widened = { ...rec, source: 'issue #405 / PR #405' };
  assert.equal(widened.id, rec.id, 'precondition: `source` is not hashed, so the id is unchanged');
  const filename = recordFilename(rec);

  for (const [branch, r] of [['branch-x', rec], ['branch-y', widened]]) {
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['checkout', '-q', '-b', branch]);
    mkdirSync(recordsDir, { recursive: true });
    writeFileSync(join(recordsDir, filename), serializeRecord(r) + '\n', 'utf8');
    git(repo, ['add', '.memory/records']);
    git(repo, ['commit', '-q', '-m', `${branch}: capture`]);
  }

  // Locally, where the driver runs, union turns the conflict into two lines.
  const merge = git(repo, ['merge', '--no-edit', 'branch-x'], { allowFailure: true });
  assert.equal(merge.status, 0, 'the union attribute still earns its keep on exactly this case');
  const lines = readFileSync(join(recordsDir, filename), 'utf8').split('\n').filter(Boolean);
  assert.equal(lines.length, 2);

  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });
  assert.equal(count, 1, 'one record');
  assert.equal(duplicates.lines, 1);
  assert.equal(duplicates.divergent, 1, 'and it is reported as divergent, not silently agreed with');
});
