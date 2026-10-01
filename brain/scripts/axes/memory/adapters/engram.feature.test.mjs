// engram.feature.test.mjs — unit tests for featureCheckpoint() and featureResume().
//
// Acceptance criteria (task 2.3 / REQ-S2-1, REQ-S2-2, REQ-E-1):
//
// featureCheckpoint():
//   (a) Creates resume.md skeleton when absent (all three required fields present).
//   (b) Re-stamps checkpointed_at and checkpointed_from on second call (idempotent update).
//   (c) Core write succeeds even when engram enrichment throws (REQ-E-1).
//   (d) Passes injected timestamp and hostname into the written file.
//   (e) Exits 0 (returns) with no error when zero feature dirs exist.
//
// featureResume():
//   (f) Projects each .md file with --project brain-feature-<feature>.
//   (g) Does NOT call _engramSave when resume.md is absent ("no resume point").
//   (h) Degrades gracefully when engram is declared absent (no throws).
//   (i) Throws (non-zero exit via cli) when multiple features present and no arg given.
//
// Notes:
//   - All tests use temp dirs; no real openspec/ is touched.
//   - Injectable deps (getTimestamp, getHostname, getBranch, _doEngramEnrich,
//     _engramSave, _checkEngram) keep tests deterministic and the core write
//     verifiably independent of engram (REQ-E-1).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  rmSync,
  chmodSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// RED: imports fail until engram.mjs exports featureCheckpoint / featureResume.
import { featureCheckpoint, featureResume } from './engram.mjs';

// Also need the frontmatter parser for assertions.
import { parseFrontmatter } from '../../../memory/lib/resume-frontmatter.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'engram-feat-'));
}

function makeFeatureDir(root, feature) {
  const dir = join(root, 'openspec', 'changes', feature);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeMemoryDir(root) {
  const dir = join(root, '.memory');
  mkdirSync(dir, { recursive: true });
  return dir;
}

function resumePath(root, feature) {
  return join(root, 'openspec', 'changes', feature, 'resume.md');
}

// Injectable no-op deps (prevent real subprocess / engram calls in tests)
const FIXED_TS = '2026-01-01T00:00:00.000Z';
const FIXED_HOST = 'test-host';
const FIXED_BRANCH = 'test-branch';

function defaultDeps(overrides = {}) {
  return {
    getTimestamp: () => FIXED_TS,
    getHostname: () => FIXED_HOST,
    getBranch: () => FIXED_BRANCH,
    _doEngramEnrich: () => {},   // no-op: enrichment not exercised
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// (a) Creates resume.md skeleton when absent
// ---------------------------------------------------------------------------

test('featureCheckpoint: creates resume.md skeleton when file is absent', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFeatureDir(root, 'my-feature');

  await featureCheckpoint('my-feature', { root, ...defaultDeps() });

  const rp = resumePath(root, 'my-feature');
  assert.ok(existsSync(rp), 'resume.md should exist after checkpoint');

  const { frontmatter } = parseFrontmatter(readFileSync(rp, 'utf8'));
  assert.ok(frontmatter, 'frontmatter should be parseable');
  // Three required fields must be present
  assert.ok(frontmatter.current_slice != null, 'current_slice required');
  assert.ok(frontmatter.next_action != null, 'next_action required');
  assert.ok(Array.isArray(frontmatter.blockers), 'blockers must be an array');
});

// ---------------------------------------------------------------------------
// (b) Re-stamps on second call (idempotent update)
// ---------------------------------------------------------------------------

test('featureCheckpoint: re-stamps checkpointed_at and checkpointed_from on second call', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFeatureDir(root, 'my-feature');

  // First call
  await featureCheckpoint('my-feature', {
    root, ...defaultDeps({ getTimestamp: () => '2026-01-01T00:00:00.000Z' }),
  });

  // Second call with different time
  await featureCheckpoint('my-feature', {
    root, ...defaultDeps({ getTimestamp: () => '2026-06-26T12:00:00.000Z' }),
  });

  const rp = resumePath(root, 'my-feature');
  const { frontmatter } = parseFrontmatter(readFileSync(rp, 'utf8'));
  assert.equal(frontmatter.checkpointed_at, '2026-06-26T12:00:00.000Z', 'timestamp updated');
  assert.equal(frontmatter.checkpointed_from, `${FIXED_HOST}/${FIXED_BRANCH}`, 'from updated');
});

// ---------------------------------------------------------------------------
// (c) REQ-E-1: core write succeeds even when engram enrichment throws
// ---------------------------------------------------------------------------

test('featureCheckpoint: core write succeeds when enrichment throws (REQ-E-1)', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFeatureDir(root, 'my-feature');

  // Enrichment throws — must NOT prevent the core writeFileSync from running
  await featureCheckpoint('my-feature', {
    root,
    ...defaultDeps({
      _doEngramEnrich: () => { throw new Error('engram not available'); },
    }),
  });

  const rp = resumePath(root, 'my-feature');
  assert.ok(existsSync(rp), 'resume.md should still be written despite enrichment failure');
});

// ---------------------------------------------------------------------------
// (d) Injected timestamp and hostname appear in written file
// ---------------------------------------------------------------------------

test('featureCheckpoint: injected timestamp and hostname appear in written resume.md', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFeatureDir(root, 'my-feature');

  await featureCheckpoint('my-feature', {
    root,
    ...defaultDeps({
      getTimestamp: () => '2099-12-31T23:59:59.000Z',
      getHostname: () => 'sentinel-host',
      getBranch: () => 'sentinel-branch',
    }),
  });

  const rp = resumePath(root, 'my-feature');
  const { frontmatter } = parseFrontmatter(readFileSync(rp, 'utf8'));
  assert.equal(frontmatter.checkpointed_at, '2099-12-31T23:59:59.000Z');
  assert.equal(frontmatter.checkpointed_from, 'sentinel-host/sentinel-branch');
});

// ---------------------------------------------------------------------------
// (d2) REQ-E-1 behavioral: .memory/ is unchanged after checkpoint
// ---------------------------------------------------------------------------

test('featureCheckpoint: .memory/ has no new files after checkpoint (REQ-E-1 behavioral)', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFeatureDir(root, 'my-feature');
  const memDir = makeMemoryDir(root);

  await featureCheckpoint('my-feature', { root, ...defaultDeps() });

  // .memory/ must remain empty (no chunk from featureCheckpoint)
  const memFiles = readdirSync(memDir);
  assert.equal(memFiles.length, 0, '.memory/ must have no new chunks after checkpoint');
});

// ---------------------------------------------------------------------------
// (e) Zero feature dirs → exits 0 (returns without throwing)
// ---------------------------------------------------------------------------

test('featureCheckpoint: exits 0 with no feature dirs present', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  // Create empty openspec/changes dir
  mkdirSync(join(root, 'openspec', 'changes'), { recursive: true });

  // Must NOT throw (would cause cli.mjs to exit 1 and break pre-push)
  await assert.doesNotReject(
    () => featureCheckpoint(undefined, { root, ...defaultDeps() }),
  );
});

// ---------------------------------------------------------------------------
// (#102) Branch-scope guard — the auto (pre-push) path must not churn an
// unrelated feature's resume.md when the current branch belongs to other work.
// ---------------------------------------------------------------------------

function writeResume(root, feature, frontmatterLines, body = 'body text\n') {
  const dir = makeFeatureDir(root, feature);
  writeFileSync(
    join(dir, 'resume.md'),
    ['---', ...frontmatterLines, '---', '', body].join('\n'),
  );
}

const SEEDED = [
  'feature: my-feature',
  'current_slice: Slice-1',
  'next_action: do-x',
  'blockers:',
  'checkpointed_at: 2026-01-01T00:00:00.000Z',
  'checkpointed_from: test-host/branchA',
];

test('featureCheckpoint (#102): auto path leaves resume.md untouched when branch ≠ feature branch', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeResume(root, 'my-feature', SEEDED);
  const rp = resumePath(root, 'my-feature');
  const before = readFileSync(rp, 'utf8');

  // Auto path (no explicit feature), pushing an UNRELATED branch.
  await featureCheckpoint(undefined, {
    root,
    ...defaultDeps({ getBranch: () => 'branchB', getTimestamp: () => '2099-01-01T00:00:00.000Z' }),
  });

  assert.equal(readFileSync(rp, 'utf8'), before, 'resume.md must be byte-for-byte unchanged (no churn)');
});

test('featureCheckpoint (#102): auto path DOES checkpoint when branch matches the feature branch', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeResume(root, 'my-feature', SEEDED);

  await featureCheckpoint(undefined, {
    root,
    ...defaultDeps({ getBranch: () => 'branchA', getTimestamp: () => '2099-01-01T00:00:00.000Z' }),
  });

  const { frontmatter } = parseFrontmatter(readFileSync(resumePath(root, 'my-feature'), 'utf8'));
  assert.equal(frontmatter.checkpointed_at, '2099-01-01T00:00:00.000Z', 'matching branch must re-stamp');
});

test('featureCheckpoint (#102): explicit feature arg bypasses the branch guard', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeResume(root, 'my-feature', SEEDED);

  // Explicit feature, branch differs — the user asked for THIS feature → re-stamp.
  await featureCheckpoint('my-feature', {
    root,
    ...defaultDeps({ getBranch: () => 'branchB', getTimestamp: () => '2099-01-01T00:00:00.000Z' }),
  });

  const { frontmatter } = parseFrontmatter(readFileSync(resumePath(root, 'my-feature'), 'utf8'));
  assert.equal(frontmatter.checkpointed_at, '2099-01-01T00:00:00.000Z', 'explicit checkpoint must re-stamp');
  assert.equal(frontmatter.checkpointed_from, 'test-host/branchB', 'explicit checkpoint stamps the current branch');
});

// ---------------------------------------------------------------------------
// (f) featureResume: saves each .md file under brain-feature-<feature>
// ---------------------------------------------------------------------------

test('featureResume: saves each .md file with brain-feature-<feature> project', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const featureDir = makeFeatureDir(root, 'my-feature');

  // Create resume.md (valid skeleton)
  writeFileSync(join(featureDir, 'resume.md'), [
    '---',
    'feature: my-feature',
    'current_slice: Slice-2',
    'next_action: do-the-thing',
    'blockers:',
    '---',
    '',
  ].join('\n'));
  // Create a second .md file
  writeFileSync(join(featureDir, 'proposal.md'), '# Proposal\nContent here.\n');

  const savedCalls = [];

  await featureResume('my-feature', {
    root,
    _checkEngram: () => true,
    _engramSave: (title, content, opts) => {
      savedCalls.push({ title, content, opts });
    },
  });

  // Should have saved exactly 2 .md files
  assert.equal(savedCalls.length, 2, `expected 2 saves, got ${savedCalls.length}`);

  // All saves must use 'brain-feature-my-feature' as the project
  for (const call of savedCalls) {
    assert.equal(
      call.opts.project,
      'brain-feature-my-feature',
      `expected project 'brain-feature-my-feature', got '${call.opts.project}'`,
    );
  }
});

// ---------------------------------------------------------------------------
// (g) featureResume: "no resume point" message when resume.md absent
// ---------------------------------------------------------------------------

test('featureResume: returns without saving when resume.md is absent', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFeatureDir(root, 'my-feature');
  // NOTE: resume.md intentionally NOT created

  const savedCalls = [];

  await featureResume('my-feature', {
    root,
    _checkEngram: () => true,
    _engramSave: (title, content, opts) => { savedCalls.push(opts); },
  });

  assert.equal(savedCalls.length, 0, 'no engram saves when resume.md is absent');
});

// ---------------------------------------------------------------------------
// (h) featureResume: degrades gracefully when engram is absent
// ---------------------------------------------------------------------------

test('featureResume: degrades to print-only when engram is absent', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const featureDir = makeFeatureDir(root, 'my-feature');

  writeFileSync(join(featureDir, 'resume.md'), [
    '---',
    'feature: my-feature',
    'current_slice: Slice-2',
    'next_action: do-the-thing',
    'blockers:',
    '---',
    '',
  ].join('\n'));

  const savedCalls = [];

  // Does NOT throw even when engram is absent
  await assert.doesNotReject(
    () => featureResume('my-feature', {
      root,
      _checkEngram: () => false,    // engram declared absent
      _engramSave: () => { savedCalls.push({}); },
    }),
  );

  // No engram saves when degraded
  assert.equal(savedCalls.length, 0, 'no engram saves in degraded mode');
});

// ---------------------------------------------------------------------------
// (i) featureResume: throws when ambiguous (multiple features, no arg)
// ---------------------------------------------------------------------------

test('featureResume: throws ambiguous error when multiple dirs and no arg', async (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFeatureDir(root, 'feature-a');
  makeFeatureDir(root, 'feature-b');

  await assert.rejects(
    () => featureResume(undefined, {
      root,
      _checkEngram: () => true,
      _engramSave: () => {},
    }),
    (err) => {
      assert.ok(err.message.includes('ambiguous'), `expected 'ambiguous' in: ${err.message}`);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// #1127 (class C): a projection that lost files must not report success.
// Before: each failed save was a `⚠` line and featureResume returned normally,
// so `feature-resume` exited 0 over a partial hydration.
// ---------------------------------------------------------------------------

function resumeFixture(t) {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const featureDir = makeFeatureDir(root, 'my-feature');
  writeFileSync(join(featureDir, 'resume.md'), [
    '---', 'feature: my-feature', 'current_slice: S2', 'next_action: go', 'blockers:', '---', '',
  ].join('\n'));
  writeFileSync(join(featureDir, 'proposal.md'), '# Proposal\nbody\n');
  return root;
}

test('featureResume (#1127): rejects, naming the files, when an engram save fails', async (t) => {
  const root = resumeFixture(t);
  await assert.rejects(
    () => featureResume('my-feature', {
      root,
      _checkEngram: () => true,
      _engramSave: (title) => { if (title === 'Proposal') throw new Error('engram exploded'); },
    }),
    (err) => /proposal\.md/.test(err.message) && /engram exploded/.test(err.message),
  );
});

test('featureResume (#1127): still attempts every file before rejecting (one failure does not hide the others)', async (t) => {
  const root = resumeFixture(t);
  const attempted = [];
  await assert.rejects(() => featureResume('my-feature', {
    root,
    _checkEngram: () => true,
    _engramSave: (title) => { attempted.push(title); throw new Error('down'); },
  }));
  assert.equal(attempted.length, 2, 'both files were attempted');
});

test('featureCheckpoint (#1127): an existing resume.md that cannot be READ is never overwritten by a skeleton', async (t) => {
  if (process.getuid?.() === 0) return t.skip('root ignores file modes');
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeFeatureDir(root, 'my-feature');
  const rp = resumePath(root, 'my-feature');
  const original = '---\nfeature: my-feature\ncurrent_slice: S9\nnext_action: keep me\nblockers:\n---\n';
  writeFileSync(rp, original);
  chmodSync(rp, 0o200); // writable, not readable: read fails EACCES, a skeleton write would succeed

  await assert.rejects(() => featureCheckpoint('my-feature', { root, ...defaultDeps() }), /EACCES/);
  chmodSync(rp, 0o644);
  assert.equal(readFileSync(rp, 'utf8'), original, 'the hand-written state must survive');
});
