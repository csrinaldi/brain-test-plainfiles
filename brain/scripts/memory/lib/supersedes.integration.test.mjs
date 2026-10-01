// supersedes.integration.test.mjs — issue #805, unit 5: the halves no pure
// unit test (supersedes.test.mjs) or seam-stubbed unit test
// (plainfiles.save.test.mjs) can state — a REAL bare `origin`, a real
// `git fetch`, and `plainfiles.save()`'s default seams (`_readRecordIds`,
// `_upstreamRecordEntries`) running unstubbed, against real git.
//
// Fixture mirrors upstream-records.integration.test.mjs:36-75 — a bare
// "remote" plus a trunk clone plus a worktree clone, the worktree branching
// BEFORE the trunk record it needs to see lands.
//
// MERGE NOTE (#738 × #805): `save()` now refuses when `brain.actor` is unset,
// and these roots are temp dirs that inherit nothing from this checkout. Where
// the fixture is a REAL repo (tests 1-3) the handle is configured the way an
// operator would — `git config --local brain.actor` — because that is the path
// under test here. Where the root is deliberately NOT a repo (tests 4-6, plain
// `mkdtempSync` dirs), the `getGitConfig` seam is injected instead: `git init`
// there would change the fixture's premise for the sake of a field none of
// those assertions are about.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { save } from '../../axes/memory/adapters/plainfiles.mjs';
import { readRecords } from './store.mjs';
import { withoutEnv } from '../__fixtures__/env.mjs';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli.mjs');

function git(cwd, args, { allowFailure = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

function runCli(args, { root, backend = 'plainfiles' } = {}) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, MEMORY_BACKEND: backend, BRAIN_MEMORY_TEST_ROOT: root },
  });
}

/** A bare "remote" plus a trunk clone that has pushed. */
function setupRemoteAndTrunk(prefix) {
  const remote = mkdtempSync(join(tmpdir(), `${prefix}-remote-`));
  const trunk = mkdtempSync(join(tmpdir(), `${prefix}-trunk-`));
  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  git(trunk, ['init', '-q', '-b', 'main']);
  git(trunk, ['config', 'user.email', 'test@example.invalid']);
  git(trunk, ['config', 'user.name', 'brain-test']);
  git(trunk, ['config', '--local', 'brain.actor', '@tester']);
  git(trunk, ['remote', 'add', 'origin', remote]);
  return { remote, trunk };
}

/** A worktree clone of `remote`, branched off main before any record commit. */
function cloneWorktree(remote, prefix) {
  const worktree = mkdtempSync(join(tmpdir(), `${prefix}-worktree-`));
  git(worktree, ['clone', '-q', remote, '.']);
  git(worktree, ['config', 'user.email', 'test@example.invalid']);
  git(worktree, ['config', 'user.name', 'brain-test']);
  git(worktree, ['config', '--local', 'brain.actor', '@tester']);
  git(worktree, ['checkout', '-q', '-b', 'feature/805']);
  return worktree;
}

/** Commits `.memory/records/` in `trunk` and pushes it to `origin/main`. */
function commitAndPushRecords(trunk) {
  git(trunk, ['add', '.memory/records']);
  git(trunk, ['commit', '-q', '-m', 'record']);
  git(trunk, ['push', '-q', 'origin', 'main']);
}

// ---------------------------------------------------------------------------
// 1. an id present ONLY at origin/main after `git fetch` ⇒ accepted, written
// ---------------------------------------------------------------------------

test('#805: an id present only at origin/main after a fetch is accepted', async (t) => {
  // #714: `save()`'s `--supersedes` path calls the real `_upstreamRecordEntries`
  // unstubbed (no `getEnv`/`env` threaded — same deliberate seam discipline as
  // `dualWriteRecords`), so an exported `BRAIN_MEMORY_UPSTREAM_REF` would win
  // over `origin/main` and this test's verdict would depend on the shell.
  withoutEnv(t, 'BRAIN_MEMORY_UPSTREAM_REF');
  const { remote, trunk } = setupRemoteAndTrunk('brain-805-upstream-only');
  const worktree = cloneWorktree(remote, 'brain-805-upstream-only');
  t.after(() => { removeTempTree(remote); removeTempTree(trunk); removeTempTree(worktree); });

  // The trunk writes record A AFTER the worktree already branched — A is
  // reachable only through origin/main, never through the worktree's own
  // working tree.
  const trunkResult = await save('A', 'the target record', { type: 'discovery', project: 'brain' }, {
    root: trunk, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'trunk-host',
  });
  commitAndPushRecords(trunk);
  git(worktree, ['fetch', '-q', 'origin']);

  assert.equal(existsSync(join(worktree, '.memory', 'records')), false, 'the id must be absent from the worktree local tree');

  const result = await save('B', 'a correction', { type: 'discovery', project: 'brain', supersedes: trunkResult.id }, {
    root: worktree, getBranch: () => 'feature/805', getTimestamp: () => '2026-09-10T09:05:00Z', getHostname: () => 'worktree-host',
  });
  assert.equal(result.written, true);
  const rec = JSON.parse(readFileSync(result.file, 'utf8').trim());
  assert.equal(rec.supersedes, trunkResult.id);
});

// ---------------------------------------------------------------------------
// 2. an id in neither local nor upstream ⇒ not-in-store, no file appended
// ---------------------------------------------------------------------------

test('#805: an id in neither local nor upstream is refused not-in-store, no file appended', async (t) => {
  // #714: see the sibling test above — the real upstream predicate must
  // resolve origin/main, not whatever the developer's shell happens to export.
  withoutEnv(t, 'BRAIN_MEMORY_UPSTREAM_REF');
  const { remote, trunk } = setupRemoteAndTrunk('brain-805-not-in-store');
  const worktree = cloneWorktree(remote, 'brain-805-not-in-store');
  t.after(() => { removeTempTree(remote); removeTempTree(trunk); removeTempTree(worktree); });

  // origin/main must resolve (so the classifier reaches ok:true and answers
  // not-in-store, never could-not-verify) — an empty commit on main suffices.
  git(trunk, ['commit', '-q', '--allow-empty', '-m', 'origin/main resolves']);
  git(trunk, ['push', '-q', 'origin', 'main']);
  git(worktree, ['fetch', '-q', 'origin']);

  const unknownId = 'rec-abcdef0123456789';
  await assert.rejects(
    () => save('t', 'c', { type: 'discovery', project: 'brain', supersedes: unknownId }, {
      root: worktree, getBranch: () => 'feature/805', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
    }),
    (err) => {
      assert.match(err.message, /not in the store|not-in-store|no está en el store/i, `expected a not-in-store refusal: ${err.message}`);
      return true;
    },
  );
  assert.equal(existsSync(join(worktree, '.memory', 'records')), false, 'no file must be appended on a not-in-store refusal');
});

// ---------------------------------------------------------------------------
// 3. the clone with origin removed ⇒ could-not-verify, naming the degradation
// ---------------------------------------------------------------------------

test('#805: a clone with origin removed is refused could-not-verify, naming the degradation', async (t) => {
  // #714: without this, a stated `BRAIN_MEMORY_UPSTREAM_REF` changes which
  // could-not-verify message the real predicate reports (a "stated ref does
  // not resolve" message instead of "no upstream ref resolved (tried
  // origin/HEAD, origin/main)"), and the assertion below is pinned to the
  // latter wording.
  withoutEnv(t, 'BRAIN_MEMORY_UPSTREAM_REF');
  const { remote, trunk } = setupRemoteAndTrunk('brain-805-degraded');
  const worktree = cloneWorktree(remote, 'brain-805-degraded');
  t.after(() => { removeTempTree(remote); removeTempTree(trunk); removeTempTree(worktree); });

  git(worktree, ['remote', 'remove', 'origin']);

  const unknownId = 'rec-abcdef0123456789';
  await assert.rejects(
    () => save('t', 'c', { type: 'discovery', project: 'brain', supersedes: unknownId }, {
      root: worktree, getBranch: () => 'feature/805', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
    }),
    (err) => {
      assert.match(err.message, /no upstream ref resolved \(tried origin\/HEAD, origin\/main\)/,
        `expected the degradation named verbatim: ${err.message}`);
      return true;
    },
  );
  assert.equal(existsSync(join(worktree, '.memory', 'records')), false);
});

// ---------------------------------------------------------------------------
// 4. chains — superseding an already-superseded record is accepted; all stay readable
// ---------------------------------------------------------------------------

test('#805: a chain (C supersedes B supersedes A) is accepted; A, B, C all stay readable and indexed', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-805-chain-'));
  t.after(() => removeTempTree(root));
  const seams = {
    root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
    getGitConfig: (key) => (key === 'brain.actor' ? '@tester' : null), getEnv: () => ({}),
  };

  const a = await save('A', 'first', { type: 'discovery', project: 'brain' }, seams);
  const b = await save('B', 'corrects A', { type: 'discovery', project: 'brain', supersedes: a.id }, seams);
  const c = await save('C', 'corrects B', { type: 'discovery', project: 'brain', supersedes: b.id }, seams);

  assert.equal(b.written, true);
  assert.equal(c.written, true);

  const { records } = readRecords({ recordsDir: join(root, '.memory', 'records') });
  const ids = records.map((r) => r.id);
  assert.ok(ids.includes(a.id), 'A must remain readable');
  assert.ok(ids.includes(b.id), 'B must remain readable');
  assert.ok(ids.includes(c.id), 'C must remain readable');
  const recB = records.find((r) => r.id === b.id);
  const recC = records.find((r) => r.id === c.id);
  assert.equal(recB.supersedes, a.id);
  assert.equal(recC.supersedes, b.id);
});

// fresh-context review SUGGESTION-5 — spec.md's "a mismatched `--issue` is
// allowed" scenario had no test: no rule ties `supersedes` to `issue`
// equality, so a record saved under a DIFFERENT `--issue` than its target
// still succeeds.
test('#805: superseding a record written under a different --issue succeeds — no issue/supersedes equality rule', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-805-mismatched-issue-'));
  t.after(() => removeTempTree(root));
  const seams = {
    root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
    getGitConfig: (key) => (key === 'brain.actor' ? '@tester' : null), getEnv: () => ({}),
  };

  const a = await save('A', 'first, filed under issue 100', { type: 'discovery', project: 'brain', issue: 100 }, seams);
  const b = await save('B', 'corrects A, filed under a different issue', {
    type: 'discovery', project: 'brain', issue: 805, supersedes: a.id,
  }, seams);

  assert.equal(b.written, true, 'a mismatched --issue must not block the supersedes write');
  const { records } = readRecords({ recordsDir: join(root, '.memory', 'records') });
  const recB = records.find((r) => r.id === b.id);
  assert.equal(recB.supersedes, a.id);
  assert.equal(recB.issue, 805, "B's own --issue must be recorded as given, unrelated to A's");
});

// ---------------------------------------------------------------------------
// 5. the epic's 6.1 exit scenario: brain:memory:audit coverage.supersedes 0 → 1,
//    and B's supersedes field survives a brain:memory:reindex round trip.
//
// Measured correction: the ticket phrase "B's `**Supersede:**` line" names
// provenance.mjs's SUPERSEDE_MARKER, which renderProvenance() emits only on
// the engram-import materialization path (engram-import.mjs:70) — a path
// design.md explicitly keeps UNCHANGED and out of scope for this writer. The
// durable fact this writer actually owns is the raw `supersedes` field on
// the record and its index entry, so that is what this test asserts across
// the round trip.
// ---------------------------------------------------------------------------

test("#805: the epic's 6.1 exit — brain:memory:audit's coverage.supersedes goes 0 → 1, and B's supersedes field survives brain:memory:reindex", async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-805-6-1-'));
  t.after(() => removeTempTree(root));
  const seams = {
    root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
    getGitConfig: (key) => (key === 'brain.actor' ? '@tester' : null), getEnv: () => ({}),
  };

  // `brain:memory:audit` refuses when `.memory/records/` does not exist yet
  // (measured: audit-io.mjs's "records dir not found") — a fresh store with
  // zero writes is created explicitly so the baseline reads a real 0, not a
  // refusal.
  mkdirSync(join(root, '.memory', 'records'), { recursive: true });

  const before = runCli(['audit', '--json'], { root });
  assert.equal(before.status, 0, `baseline audit failed: ${before.stderr}`);
  const beforeReport = JSON.parse(before.stdout);
  assert.equal(beforeReport.coverage.allTime.supersedes, 0, 'baseline coverage.supersedes must be 0 — nothing saved yet');

  const a = await save('A', 'first, no supersedes', { type: 'discovery', project: 'brain' }, seams);
  const b = await save('B', 'corrects A', { type: 'discovery', project: 'brain', supersedes: a.id }, seams);
  assert.equal(b.written, true);

  const after = runCli(['audit', '--json'], { root });
  assert.equal(after.status, 0, `second audit failed: ${after.stderr}`);
  const afterReport = JSON.parse(after.stdout);
  assert.equal(afterReport.coverage.allTime.supersedes, 1, 'coverage.supersedes must report 1, up from 0');

  const reindexResult = runCli(['reindex'], { root });
  assert.equal(reindexResult.status, 0, `reindex failed: ${reindexResult.stderr}`);

  const recordsDir = join(root, '.memory', 'records');
  const { records } = readRecords({ recordsDir });
  const recB = records.find((r) => r.id === b.id);
  assert.equal(recB.supersedes, a.id, "B's supersedes field must survive the records/ store untouched");

  const indexPath = join(root, '.memory', 'index.jsonl');
  const indexLines = readFileSync(indexPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const indexB = indexLines.find((e) => e.id === b.id);
  assert.equal(indexB.supersedes, a.id, "B's supersedes field must survive the brain:memory:reindex round trip in index.jsonl");
});
