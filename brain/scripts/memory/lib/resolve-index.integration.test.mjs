// resolve-index.integration.test.mjs — issue #330.
//
// `.memory/index.jsonl` is DERIVED and regenerable, and doctrine fixes exactly
// one resolution for a merge conflict on it: discard both sides and regenerate
// from `records/` (memory-format.md:145-153, adr-0017:121-129 — "NEVER
// hand-merged and NEVER union-merged"). `resolveIndex` is that resolution as
// one command, so the operator needs no judgement.
//
// NOT a unit test: builds real temp git repositories and runs a real
// `git merge` that really conflicts.
//
// Why the conflict fixture starts from an EMPTY committed index: this suite
// tests the RESOLVER, so it needs a conflict that is guaranteed, not likely.
// An empty base forces both branches to insert at the same position, so the
// conflict is deterministic. That is the worst case ON PURPOSE — it is NOT a
// claim about how often conflicts happen. Measured over the real 1575-entry
// index, a typical share conflicts 0-4.5% of the time (see design.md); the
// empty base is the pathological corner, chosen here because a resolver must
// be proven against a conflict that actually exists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { buildRecord, serializeIndex } from './format.mjs';
import { appendRecord, rebuildIndex } from './store.mjs';
import { resolveIndex } from './resolve-index.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const BASE_FIELDS = {
  ts: '2026-07-29T12:00:00Z',
  actor: '@crinaldi',
  actorKind: 'human',
  type: 'decision',
  project: 'brain',
};

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

function gitAllowFailure(cwd, args) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function unmergedPaths(repo) {
  return git(repo, ['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean);
}

/**
 * Two branches that each ran the equivalent of `brain:memory:share`, merged, leaving
 * `.memory/index.jsonl` genuinely conflicted. `records/*.jsonl` keeps its
 * built-in union attribute, so ONLY the index conflicts — which is the state
 * an operator actually meets.
 */
function buildConflictedRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'brain-resolve-index-'));
  const recordsDir = join(repo, '.memory', 'records');
  const indexPath = join(repo, '.memory', 'index.jsonl');

  git(repo, ['init', '-q', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.invalid']);
  git(repo, ['config', 'user.name', 'brain-test']);

  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(repo, '.gitattributes'), '/.memory/records/*.jsonl merge=union\n');
  writeFileSync(indexPath, serializeIndex(new Map()), 'utf8');
  git(repo, ['add', '.gitattributes', '.memory']);
  git(repo, ['commit', '-q', '-m', 'init: base state with an empty index']);

  const share = (branch, content, from) => {
    git(repo, ['checkout', '-q', from]);
    git(repo, ['checkout', '-q', '-b', branch]);
    const rec = buildRecord({ ...BASE_FIELDS, content });
    appendRecord(rec, { recordsDir });
    rebuildIndex({ recordsDir, indexPath });
    git(repo, ['add', '.memory']);
    git(repo, ['commit', '-q', `-m`, `${branch}: share`]);
    return rec;
  };

  const recA = share('branch-x', 'Decision A, from branch X.', 'main');
  const recB = share('branch-y', 'Decision B, from branch Y.', 'main');

  const merge = gitAllowFailure(repo, ['merge', '--no-edit', 'branch-x']);
  return { repo, recordsDir, indexPath, recA, recB, merge };
}

// ── Test 1 — the resolution works, and completes the merge ──────────────────

test('resolveIndex: a conflicted index is regenerated from records/ and the path leaves the unmerged state', (t) => {
  const { repo, recordsDir, indexPath, recA, recB, merge } = buildConflictedRepo();
  t.after(() => removeTempTree(repo));

  // Precondition — without this the rest of the test proves nothing.
  assert.notEqual(merge.status, 0, 'the fixture merge must actually conflict');
  assert.deepEqual(unmergedPaths(repo), ['.memory/index.jsonl'],
    'only the index conflicts — records/ is covered by its union attribute');

  const result = resolveIndex({ repoRoot: repo });

  const resolved = readFileSync(indexPath, 'utf8');
  for (const marker of ['<<<<<<<', '=======', '>>>>>>>']) {
    assert.equal(resolved.includes(marker), false, `no ${marker} left in the resolved index`);
  }

  // Byte-for-byte the canonical file: the resolution is a REGENERATION, not a
  // repair of the conflicted text.
  const canonicalPath = join(repo, 'canonical.jsonl');
  rebuildIndex({ recordsDir, indexPath: canonicalPath });
  assert.equal(resolved, readFileSync(canonicalPath, 'utf8'), 'resolved index is byte-identical to a fresh reindex');

  const ids = resolved.split('\n').filter(Boolean).map((l) => JSON.parse(l).id);
  assert.ok(ids.includes(recA.id), 'branch-x record present');
  assert.ok(ids.includes(recB.id), 'branch-y record present');
  assert.deepEqual([...ids].sort(), ids, 'entries are sorted by id');
  assert.equal(result.count, ids.length);

  // The resolution must be COMPLETE: git no longer considers the path
  // unmerged, so the merge is committable without further operator action.
  assert.deepEqual(unmergedPaths(repo), [], 'the index is no longer unmerged');
  assert.equal(result.staged, true, 'resolveIndex reports that it staged the resolution');
  git(repo, ['commit', '-q', '--no-edit']);
});

// ── Test 2 — fail closed when records/ is itself conflicted ─────────────────

test('resolveIndex: refuses when a records file carries conflict markers, and does not write the index', (t) => {
  const { repo, recordsDir, indexPath } = buildConflictedRepo();
  t.after(() => removeTempTree(repo));

  const before = readFileSync(indexPath, 'utf8');
  // #677 — one record per file, so the victim is whichever record file the
  // fixture wrote rather than a month log this test can name in advance.
  const victimName = readdirSync(recordsDir).filter((f) => f.endsWith('.jsonl')).sort()[0];
  assert.ok(victimName, 'the fixture must have written at least one record file');
  const victim = join(recordsDir, victimName);
  writeFileSync(victim, `<<<<<<< HEAD\n${readFileSync(victim, 'utf8')}=======\n>>>>>>> branch-x\n`, 'utf8');

  // The index is derived FROM records. Regenerating from a conflicted log
  // would bake the markers into the index and call it resolved.
  assert.throws(() => resolveIndex({ repoRoot: repo }), /records/i);
  assert.equal(readFileSync(indexPath, 'utf8'), before, 'the index must be left untouched on refusal');
});

// ── Test 3 — safe for the post-merge hook to call unconditionally ───────────

test('resolveIndex: on a clean tree it normalizes without staging anything', (t) => {
  const { repo, indexPath } = buildConflictedRepo();
  t.after(() => removeTempTree(repo));

  resolveIndex({ repoRoot: repo });
  git(repo, ['commit', '-q', '--no-edit']);

  const result = resolveIndex({ repoRoot: repo });

  assert.equal(result.staged, false, 'nothing was unmerged, so nothing is staged');
  assert.equal(git(repo, ['diff', '--cached', '--name-only']).trim(), '',
    'a hook-triggered call must never stage changes behind the operator');
  assert.equal(readFileSync(indexPath, 'utf8').includes('<<<<<<<'), false);
});

// ── Test 4 — doctrine tripwire on the SHIPPED .gitattributes ────────────────

test('the repo declares NO merge strategy for /.memory/index.jsonl (adr-0017: never union-merged)', () => {
  const attributes = readFileSync(join(repoRoot, '.gitattributes'), 'utf8');
  const indexRules = attributes
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .filter((l) => /(^|\s)\/?\.memory\/index\.jsonl(\s|$)/.test(l));

  // Asserting ABSENCE cannot be satisfied by a wrong value — unlike a check
  // that merely requires "some merge= attribute", which any value would pass.
  assert.deepEqual(indexRules, [],
    'index.jsonl must fall through to the default merge; conflicts are resolved by `npm run brain:memory:resolve-index`');
});
