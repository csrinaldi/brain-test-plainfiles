// default-branch-records.integration.test.mjs — the empirical proof (design.md
// Testing Strategy): the injected-git-runner unit tests (default-branch-records
// .test.mjs) prove the argv/parsing CONTRACT; this file proves the real `git`
// binary actually satisfies it, entirely inside `t.tmpdir`-style temp
// directories built by ../lib/test-tmp.mjs. NO NETWORK: every "origin" here is
// a local bare repo reached via a `file://` URL, never github.com or any real
// remote.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { readDefaultBranchRecords } from './default-branch-records.mjs';
import { testTmp } from '../lib/test-tmp.mjs';
import { removeTempTree } from '../lib/tmp-tree.mjs';

function git(args, opts = {}) {
  return execFileSync('git', args, { encoding: 'utf8', ...opts });
}

/** Builds a bare "origin" repo whose `main` branch carries one
 *  `.memory/records/*.jsonl` file, then a shallow `--branch feature` clone of
 *  it (the `file://` form, required — otherwise `--depth` is ignored per
 *  design.md's Testing Strategy note). Returns the clone's working directory. */
function buildOriginAndClone(dir, { withRecordOnMain = true } = {}) {
  const originDir = join(dir, 'origin.git');
  const seedDir = join(dir, 'seed');
  const cloneDir = join(dir, 'clone');

  mkdirSync(originDir, { recursive: true });
  git(['init', '--bare', '-b', 'main', originDir]);

  mkdirSync(seedDir, { recursive: true });
  git(['init', '-b', 'main', seedDir]);
  git(['config', 'user.email', 'test@example.com'], { cwd: seedDir });
  git(['config', 'user.name', 'Test'], { cwd: seedDir });
  writeFileSync(join(seedDir, 'README.md'), '# seed\n', 'utf8');
  git(['add', '.'], { cwd: seedDir });
  git(['commit', '-m', 'seed'], { cwd: seedDir });

  if (withRecordOnMain) {
    const recordsDir = join(seedDir, '.memory', 'records');
    mkdirSync(recordsDir, { recursive: true });
    const record = JSON.stringify({ id: 'rec-1234567890abcdef', issue: 1024, type: 'session_summary', ts: '2026-09-18T00:00:00Z' });
    writeFileSync(join(recordsDir, '2026-09-rec-1234567890abcdef.jsonl'), record + '\n', 'utf8');
    git(['add', '.'], { cwd: seedDir });
    git(['commit', '-m', 'add memory record'], { cwd: seedDir });
  }

  git(['push', `file://${originDir}`, 'main'], { cwd: seedDir });

  // A feature branch on the origin so the clone below has something to
  // check out that is NOT main — mirroring a PR's feature-branch checkout,
  // whose tree never needs to carry the record (ADR-0034).
  git(['branch', 'feature'], { cwd: seedDir });
  git(['push', `file://${originDir}`, 'feature'], { cwd: seedDir });

  git(['clone', '--depth', '1', '--branch', 'feature', `file://${originDir}`, cloneDir]);
  git(['config', 'user.email', 'test@example.com'], { cwd: cloneDir });
  git(['config', 'user.name', 'Test'], { cwd: cloneDir });

  return { originDir, cloneDir, seedDir };
}

test('readDefaultBranchRecords: finds a record that exists only on origin/main via the targeted fetch', () => {
  const dir = testTmp('default-branch-records-integration-');
  try {
    const { cloneDir } = buildOriginAndClone(dir);

    const result = readDefaultBranchRecords({ defaultBranch: 'main', cwd: cloneDir });

    assert.equal(result.error, null);
    assert.deepEqual(result.records, [
      { id: 'rec-1234567890abcdef', issue: 1024, type: 'session_summary', ts: '2026-09-18T00:00:00Z' },
    ]);
    assert.equal(result.fetched, true, 'a shallow clone must report fetched: true');
  } finally {
    removeTempTree(dir);
  }
});

// ── Incident fix (batch 2): the fetch must be CONDITIONAL on the checkout
// already being shallow. Running `git fetch --no-tags --depth=1` against a
// FULL (non-shallow) clone writes `.git/shallow` and grafts the fetched
// commit as parentless — this exact defect shallowed a real, full checkout
// of this repository when an unguarded test reached this reader with the
// real cwd (see apply-progress.md Batch 2). These two cases prove the fix
// with REAL git, entirely in local fixtures — no network. ──────────────────

/** Builds a FULL (non-shallow) local clone of a bare origin whose `main`
 *  already carries one `.memory/records/*.jsonl` file — a plain `git clone`
 *  with no `--depth`, so EVERY remote branch (including `main`, never
 *  checked out) is already a populated remote-tracking ref. */
function buildOriginAndFullClone(dir) {
  const originDir = join(dir, 'origin.git');
  const seedDir = join(dir, 'seed');
  const cloneDir = join(dir, 'clone');

  mkdirSync(originDir, { recursive: true });
  git(['init', '--bare', '-b', 'main', originDir]);

  mkdirSync(seedDir, { recursive: true });
  git(['init', '-b', 'main', seedDir]);
  git(['config', 'user.email', 'test@example.com'], { cwd: seedDir });
  git(['config', 'user.name', 'Test'], { cwd: seedDir });
  writeFileSync(join(seedDir, 'README.md'), '# seed\n', 'utf8');
  git(['add', '.'], { cwd: seedDir });
  git(['commit', '-m', 'seed'], { cwd: seedDir });

  const recordsDir = join(seedDir, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  const record = JSON.stringify({ id: 'rec-fedcba9876543210', issue: 2024, type: 'session_summary', ts: '2026-09-18T00:00:00Z' });
  writeFileSync(join(recordsDir, '2026-09-rec-fedcba9876543210.jsonl'), record + '\n', 'utf8');
  git(['add', '.'], { cwd: seedDir });
  git(['commit', '-m', 'add memory record'], { cwd: seedDir });

  git(['push', `file://${originDir}`, 'main'], { cwd: seedDir });
  git(['branch', 'feature'], { cwd: seedDir });
  git(['push', `file://${originDir}`, 'feature'], { cwd: seedDir });

  // NO --depth here — a full clone. `git clone` (full) populates a
  // remote-tracking ref for EVERY branch on the origin, not only the one
  // checked out — `refs/remotes/origin/main` already exists with no fetch.
  git(['clone', '--branch', 'feature', `file://${originDir}`, cloneDir]);
  git(['config', 'user.email', 'test@example.com'], { cwd: cloneDir });
  git(['config', 'user.name', 'Test'], { cwd: cloneDir });

  return { originDir, cloneDir, seedDir };
}

test('readDefaultBranchRecords: a FULL (non-shallow) clone never fetches — reads the record already on refs/remotes/origin/<b>, and never shallows the repo (incident fix batch 2)', () => {
  const dir = testTmp('default-branch-records-integration-fullclone-');
  try {
    const { cloneDir } = buildOriginAndFullClone(dir);

    const isShallowBefore = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: cloneDir, encoding: 'utf8' }).trim();
    assert.equal(isShallowBefore, 'false', 'sanity: the clone must start as a full, non-shallow checkout');

    const result = readDefaultBranchRecords({ defaultBranch: 'main', cwd: cloneDir });

    assert.equal(result.error, null);
    assert.deepEqual(result.records, [
      { id: 'rec-fedcba9876543210', issue: 2024, type: 'session_summary', ts: '2026-09-18T00:00:00Z' },
    ]);
    assert.equal(result.fetched, false, 'a full clone must report fetched: false — the record came from a LOCAL ref, not a live fetch');

    // The regression proof: a fetch would have written `.git/shallow` and
    // flipped `is-shallow-repository` to `true`. Neither may happen.
    const isShallowAfter = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: cloneDir, encoding: 'utf8' }).trim();
    assert.equal(isShallowAfter, 'false', 'the reader must NEVER shallow a full clone — this is the #1024 incident');
    assert.equal(existsSync(join(cloneDir, '.git', 'shallow')), false, '.git/shallow must never be created in a full clone');
  } finally {
    removeTempTree(dir);
  }
});

test('readDefaultBranchRecords: a SHALLOW clone fetches live and picks up a record added to origin AFTER the initial clone (D1\'s "manual re-run heals the PR" rationale)', () => {
  const dir = testTmp('default-branch-records-integration-shallow-live-');
  try {
    const { originDir, cloneDir, seedDir } = buildOriginAndClone(dir, { withRecordOnMain: false });

    const isShallow = execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: cloneDir, encoding: 'utf8' }).trim();
    assert.equal(isShallow, 'true', 'sanity: the clone must start shallow (--depth 1)');

    // The record lands on origin/main AFTER the clone was made — mirroring a
    // memory-lane PR merging after the feature branch was checked out.
    const recordsDir = join(seedDir, '.memory', 'records');
    mkdirSync(recordsDir, { recursive: true });
    const record = JSON.stringify({ id: 'rec-0123456789abcdef', issue: 3033, type: 'session_summary', ts: '2026-09-18T01:00:00Z' });
    writeFileSync(join(recordsDir, '2026-09-rec-0123456789abcdef.jsonl'), record + '\n', 'utf8');
    execFileSync('git', ['add', '.'], { cwd: seedDir });
    execFileSync('git', ['commit', '-m', 'add memory record after the clone'], { cwd: seedDir });
    execFileSync('git', ['push', `file://${originDir}`, 'main'], { cwd: seedDir });

    const result = readDefaultBranchRecords({ defaultBranch: 'main', cwd: cloneDir });

    assert.equal(result.error, null);
    assert.deepEqual(result.records, [
      { id: 'rec-0123456789abcdef', issue: 3033, type: 'session_summary', ts: '2026-09-18T01:00:00Z' },
    ]);
  } finally {
    removeTempTree(dir);
  }
});

test('readDefaultBranchRecords: main absent on origin returns the fetch-failure cause', () => {
  const dir = testTmp('default-branch-records-integration-missing-');
  try {
    const { originDir, cloneDir } = buildOriginAndClone(dir, { withRecordOnMain: false });

    // Remove `main` from the origin AFTER the clone exists, so the clone's
    // own local refs are untouched — only the remote-side ref disappears,
    // which is exactly what a targeted `git fetch origin main` must fail on.
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/feature'], { cwd: originDir });
    execFileSync('git', ['branch', '-D', 'main'], { cwd: originDir });

    const result = readDefaultBranchRecords({ defaultBranch: 'main', cwd: cloneDir });

    assert.equal(result.records.length, 0);
    assert.ok(result.error?.startsWith('git fetch origin main failed:'), `unexpected error: ${result.error}`);
  } finally {
    removeTempTree(dir);
  }
});

// ── Batch 4 (#1024 live-CI bug, PR #1048): real production volume ─────────
//
// Live CI on PR #1048 printed `memory-gate: path=retrieval #1024 (records:
// pr-tree only — default branch unreadable: git cat-file failed: )` and
// exited 2. Reproduced locally: this repo's real `origin/main` holds
// 8,967,273 bytes of `.memory/records/`, and `execFileSync`'s DEFAULT
// `maxBuffer` is 1 MiB — `git cat-file --batch`'s single-call design (D2)
// needs to hold the WHOLE listing's blob stream in memory at once, so it
// died with ENOBUFS well before this repo's own real volume. No test before
// this batch ever built a fixture anywhere near 1 MiB, so the defect never
// showed up here despite the parsing CONTRACT itself being correct.

/** Builds a bare "origin" whose `main` branch carries `count` records of
 *  ~1 KB each (comfortably over the 1 MiB `execFileSync` default), then
 *  clones it either FULL or SHALLOW per `depth`. Returns the clone dir. */
function buildLargeRecordsOriginAndClone(dir, { count = 1500, depth = null } = {}) {
  const originDir = join(dir, 'origin.git');
  const seedDir = join(dir, 'seed');
  const cloneDir = join(dir, 'clone');

  mkdirSync(originDir, { recursive: true });
  git(['init', '--bare', '-b', 'main', originDir]);

  mkdirSync(seedDir, { recursive: true });
  git(['init', '-b', 'main', seedDir]);
  git(['config', 'user.email', 'test@example.com'], { cwd: seedDir });
  git(['config', 'user.name', 'Test'], { cwd: seedDir });
  writeFileSync(join(seedDir, 'README.md'), '# seed\n', 'utf8');

  const recordsDir = join(seedDir, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  for (let i = 0; i < count; i++) {
    const id = `rec-${i.toString(16).padStart(16, '0')}`;
    const record = JSON.stringify({
      id, ts: '2026-09-18T00:00:00Z', issue: 1000 + (i % 50), type: 'decision',
      content: 'x'.repeat(900), // pads each record to roughly 1 KB
    });
    writeFileSync(join(recordsDir, `2026-09-${id}.jsonl`), record + '\n', 'utf8');
  }
  git(['add', '.'], { cwd: seedDir });
  git(['commit', '-m', `seed ${count} large records`], { cwd: seedDir });
  git(['push', `file://${originDir}`, 'main'], { cwd: seedDir });
  git(['branch', 'feature'], { cwd: seedDir });
  git(['push', `file://${originDir}`, 'feature'], { cwd: seedDir });

  const cloneArgs = depth
    ? ['clone', '--depth', String(depth), '--branch', 'feature', `file://${originDir}`, cloneDir]
    : ['clone', '--branch', 'feature', `file://${originDir}`, cloneDir];
  git(cloneArgs);
  git(['config', 'user.email', 'test@example.com'], { cwd: cloneDir });
  git(['config', 'user.name', 'Test'], { cwd: cloneDir });

  return { originDir, cloneDir };
}

test('readDefaultBranchRecords: a FULL (non-shallow) clone reads MORE THAN 1 MiB of records without ENOBUFS (#1024 live-CI bug, Batch 4)', () => {
  const dir = testTmp('default-branch-records-integration-largevol-full-');
  try {
    const { cloneDir } = buildLargeRecordsOriginAndClone(dir, { count: 1500 });

    const result = readDefaultBranchRecords({ defaultBranch: 'main', cwd: cloneDir });

    assert.equal(result.error, null, `must not fail with ENOBUFS on a large volume: ${result.error}`);
    assert.equal(result.records.length, 1500);
    assert.equal(result.fetched, false, 'a full clone reads the local ref, never fetches');
  } finally {
    removeTempTree(dir);
  }
});

test('readDefaultBranchRecords: a SHALLOW clone reads MORE THAN 1 MiB of records without ENOBUFS (#1024 live-CI bug, Batch 4)', () => {
  const dir = testTmp('default-branch-records-integration-largevol-shallow-');
  try {
    const { cloneDir } = buildLargeRecordsOriginAndClone(dir, { count: 1500, depth: 1 });

    const result = readDefaultBranchRecords({ defaultBranch: 'main', cwd: cloneDir });

    assert.equal(result.error, null, `must not fail with ENOBUFS on a large volume: ${result.error}`);
    assert.equal(result.records.length, 1500);
    assert.equal(result.fetched, true, 'a shallow clone runs the live fetch');
  } finally {
    removeTempTree(dir);
  }
});
