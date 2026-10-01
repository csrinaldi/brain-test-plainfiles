// records-merge.integration.test.mjs — REQ-MF-3 integration evidence.
//
// NOT a unit test: it builds real temp git repositories and runs real merges,
// because the claim under test is about git's behaviour and nothing short of
// running git can establish it.
//
// WHAT THIS FILE USED TO PROVE, AND WHY THAT WAS THE WRONG QUESTION (#677).
// The original test declared `merge=union` in the temp repo's `.gitattributes`,
// had two branches append distinct records to the same month file, merged, and
// asserted a clean union. It passed, and it was true — the union driver does
// exactly that. But the merge it modelled is not the merge that lands work:
// this repository merges through a forge's merge button, and a `.gitattributes`
// merge driver is a LOCAL git mechanism the forge does not apply. So the test
// established conflict-freedom under a condition the real merge site does not
// have, and the first memory-capturing PR merged clean while every subsequent
// one conflicted — on the durable log, resolved by hand, where a dropped record
// is indistinguishable from one never captured.
//
// A test that green-lights a guarantee its production setting cannot honour is
// #632's shape: green for the wrong reason. So the question here is now the one
// that decides the outcome — DOES IT MERGE WITHOUT A DRIVER? — and the union
// case is kept below it, demoted to what it actually is: a local convenience.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
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

/**
 * A temp repo with `.memory/records/`, optionally declaring the union
 * attribute. `attributes: false` is the forge's condition — no driver.
 */
function initRepo(t, { attributes }) {
  const repo = mkdtempSync(join(tmpdir(), 'brain-records-merge-'));
  t.after(() => removeTempTree(repo));
  const recordsDir = join(repo, '.memory', 'records');
  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'brain-test']);
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(repo, '.gitattributes'), attributes ? '.memory/records/*.jsonl merge=union\n' : '# no merge driver\n');
  git(repo, ['add', '.gitattributes']);
  git(repo, ['commit', '-q', '-m', 'init']);
  return { repo, recordsDir, indexPath: join(repo, '.memory', 'index.jsonl') };
}

/**
 * Two branches off main, each committing its own record via `writeOne`.
 *
 * The `mkdirSync` is not decoration: `git checkout main` deletes the record
 * files the other branch added and then prunes the directory that just became
 * empty, so the second branch starts without `.memory/records/` on disk.
 */
function twoBranches(repo, recs, writeOne) {
  for (const [branch, record] of [['branch-x', recs[0]], ['branch-y', recs[1]]]) {
    git(repo, ['checkout', '-q', 'main']);
    git(repo, ['checkout', '-q', '-b', branch]);
    mkdirSync(join(repo, '.memory', 'records'), { recursive: true });
    writeOne(record);
    git(repo, ['add', '.memory/records']);
    git(repo, ['commit', '-q', '-m', `${branch}: capture a session`]);
  }
}

// ── the question that decides the outcome ────────────────────────────────────

test('REQ-MF-3 (#677): one file per record merges with NO driver — the condition the forge actually merges under', (t) => {
  const { repo, recordsDir, indexPath } = initRepo(t, { attributes: false });
  const recA = buildRecord({ ...BASE, content: 'Decision A, from branch X.' });
  const recB = buildRecord({ ...BASE, content: 'Decision B, from branch Y.' });

  twoBranches(repo, [recA, recB], (r) => appendRecord(r, { recordsDir }));

  git(repo, ['checkout', '-q', 'branch-y']);
  const merge = git(repo, ['merge', '--no-edit', 'branch-x'], { allowFailure: true });
  assert.equal(merge.status, 0, `merge must be clean without any driver:\n${merge.stdout}\n${merge.stderr}`);

  const files = readdirSync(recordsDir).sort();
  assert.deepEqual(files, [recordFilename(recA), recordFilename(recB)].sort(), 'both records, one file each');
  for (const f of files) {
    const raw = readFileSync(join(recordsDir, f), 'utf8');
    assert.equal(raw.includes('<<<<<<<'), false, 'no conflict markers');
    assert.equal(raw.split('\n').filter(Boolean).length, 1, 'still exactly one physical line');
  }
  const { count, duplicates } = rebuildIndex({ recordsDir, indexPath });
  assert.equal(count, 2);
  assert.equal(duplicates.ids, 0, 'and nothing to deduplicate — the merge added no repeat');
});

test('REQ-MF-3 (#677): the SAME two records in a month file CONFLICT with no driver — the failure this layout removes', (t) => {
  const { repo, recordsDir } = initRepo(t, { attributes: false });
  const recA = buildRecord({ ...BASE, content: 'Decision A, from branch X.' });
  const recB = buildRecord({ ...BASE, content: 'Decision B, from branch Y.' });
  const monthFile = join(recordsDir, '2026-07.jsonl');

  // Same inputs as the test above. The ONLY variable is the layout.
  twoBranches(repo, [recA, recB], (r) => {
    const existing = existsSync(monthFile) ? readFileSync(monthFile, 'utf8') : '';
    writeFileSync(monthFile, existing + serializeRecord(r) + '\n', 'utf8');
  });

  git(repo, ['checkout', '-q', 'branch-y']);
  const merge = git(repo, ['merge', '--no-edit', 'branch-x'], { allowFailure: true });
  assert.notEqual(merge.status, 0, 'the month log conflicts — this is the bug #677 reports');
  assert.match(readFileSync(monthFile, 'utf8'), /<<<<<<</, 'and it lands as markers inside the durable log');
});

// ── the union driver, demoted to what it is ──────────────────────────────────

test('the union driver still works WHERE IT RUNS — a local convenience, not the mechanism the format depends on', (t) => {
  const { repo, recordsDir, indexPath } = initRepo(t, { attributes: true });
  const recA = buildRecord({ ...BASE, content: 'Decision A, from branch X.' });
  const recB = buildRecord({ ...BASE, content: 'Decision B, from branch Y.' });
  const monthFile = join(recordsDir, '2026-07.jsonl');

  twoBranches(repo, [recA, recB], (r) => {
    const existing = existsSync(monthFile) ? readFileSync(monthFile, 'utf8') : '';
    writeFileSync(monthFile, existing + serializeRecord(r) + '\n', 'utf8');
  });

  git(repo, ['checkout', '-q', 'branch-y']);
  const merge = git(repo, ['merge', '--no-edit', 'branch-x'], { allowFailure: true });
  assert.equal(merge.status, 0, 'locally, with the attribute in effect, union resolves it');
  const merged = readFileSync(monthFile, 'utf8');
  assert.equal(merged.includes('<<<<<<<'), false);
  const ids = merged.split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  assert.deepEqual(ids.sort(), [recA.id, recB.id].sort());
  assert.equal(rebuildIndex({ recordsDir, indexPath }).count, 2);
});

// ── the one residual conflict, and how small it is ───────────────────────────

test('a DIVERGENT same-id pair still conflicts — but on one file holding one record, both sides the same record', (t) => {
  const { repo, recordsDir } = initRepo(t, { attributes: false });
  const rec = buildRecord({ ...BASE, content: 'Captured once, exported twice.', source: 'PR #405' });
  const widened = { ...rec, source: 'issue #405 / PR #405' }; // ADR-0017 Amendment 1: `source` is not hashed
  assert.equal(widened.id, rec.id, 'precondition: same id, different bytes');
  const filename = recordFilename(rec);

  twoBranches(repo, [rec, widened], (r) => writeFileSync(join(recordsDir, filename), serializeRecord(r) + '\n', 'utf8'));

  git(repo, ['checkout', '-q', 'branch-y']);
  const merge = git(repo, ['merge', '--no-edit', 'branch-x'], { allowFailure: true });
  assert.notEqual(merge.status, 0, 'the residual case is real and must not be claimed away');

  const unmerged = git(repo, ['diff', '--name-only', '--diff-filter=U']).stdout.trim().split('\n').filter(Boolean);
  assert.deepEqual(unmerged, [`.memory/records/${filename}`], 'exactly one path, holding exactly one record');
  // The blast radius is the point: whichever side a human picks, the record is
  // the same record — `id` hashes the meaning. Under the month layout the same
  // event put every record in the file at the mercy of that resolution.
});
