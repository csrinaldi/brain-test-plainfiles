// cli.split-records-duplicates.test.mjs — the reindex `reportDuplicates` call
// `brain:memory:split-records --apply` runs AFTER the migration (cli.mjs:291-297),
// end to end through the real CLI.
//
// This is a SEPARATE surface from the duplicate-lines-WITHIN-a-month-file
// report `split-records.mjs`'s own suite covers (`planSplit`/`runSplit`'s
// `duplicates` array, printed by cli.mjs's own loop at :263-273): that report
// fires for a repeated id INSIDE the month logs being split. This file's
// fixture instead leaves a RESIDUAL already-split per-record file on disk
// (the shape a partial prior migration, or a git merge of two partially-split
// checkouts, would leave) that shares an id with a record newly split out of
// a month file — a duplicate `rebuildIndex()` only discovers once it walks the
// WHOLE `records/` directory after the split, which is exactly what the
// unguarded `await reportDuplicates(...)` at cli.mjs:297 exists to surface.
//
// Follows cli.reindex-duplicates.test.mjs's real-CLI-subprocess pattern
// (BRAIN_MEMORY_TEST_ROOT, MEMORY_BACKEND=plainfiles).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRecord, serializeRecord } from './lib/format.mjs';
import { testTmp } from '../lib/test-tmp.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

const base = {
  ts: '2026-08-01T10:00:00Z',
  actor: '@crinaldi',
  actorKind: 'human',
  type: 'decision',
  project: 'brain',
};

function fixtureRoot() {
  const root = testTmp('brain-cli-split-dup-');
  const recordsDir = join(root, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  return { root, recordsDir };
}

function runCli(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_MEMORY_TEST_ROOT: root, MEMORY_BACKEND: 'plainfiles' },
  });
}

test('brain:memory:split-records --apply REPORTS a duplicate the post-split reindex finds across the whole records/ dir', () => {
  const { root, recordsDir } = fixtureRoot();
  const a = buildRecord({ ...base, content: 'A' });

  // one month file with the record to be split out …
  writeFileSync(join(recordsDir, '2026-08.jsonl'), serializeRecord(a) + '\n', 'utf8');
  // … and a RESIDUAL already-split file, same id, same bytes — the shape a
  // partial prior migration or a union merge of two partial checkouts leaves.
  // Its name deliberately does NOT match the `<yyyy-mm>-<id>.jsonl` grammar
  // `runSplit()` itself writes, so it is left untouched by the split (counted
  // only in `alreadySplit`) and survives to be seen by the POST-split reindex.
  writeFileSync(join(recordsDir, 'already-split-residual.jsonl'), serializeRecord(a) + '\n', 'utf8');

  const run = runCli(root, 'split-records', '--apply');

  assert.equal(run.status, 0, `split --apply must still succeed on a duplicated store:\n${run.stderr}`);
  assert.match(run.stdout, /memory\/cli:.*record\(s\) indexed/, 'the post-split reindex ran');
  assert.match(run.stderr, /1 duplicate record id\(s\)/, 'the post-split reindex duplicate must be REPORTED, not silently dropped by a dangling promise racing process.exit(0)');
  assert.ok(run.stderr.includes(a.id), 'the duplicated id is named');
});
