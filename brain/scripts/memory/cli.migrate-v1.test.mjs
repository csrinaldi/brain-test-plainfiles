// cli.migrate-v1.test.mjs — CLI-level tests for `brain:memory:migrate-v1` un-refusing
// (REQ-C2B2-1) and the `--rollback` refusal (#955 R1/R2/D1 — `--rollback`
// itself is retired; it deleted `records/` unconditionally after restoring
// `legacy/`, wiping every record captured since cutover).
//
// cli.mjs resolves `.memory/` from its own file location (`repoRoot`), not
// from `cwd` — so these tests redirect it via the BRAIN_MIGRATE_V1_TEST_ROOT
// env var (a test-only seam, see cli.mjs). This is the ONLY way this file
// touches the filesystem: every invocation here points at a fresh temp dir,
// NEVER the real `.memory/`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTmp } from '../lib/test-tmp.mjs';
import en from '../i18n/en.mjs';

const cliPath = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');

const baseObs = (overrides = {}) => ({
  id: 1,
  sync_id: 'obs-aaaa1111',
  session_id: 's1',
  type: 'discovery',
  title: 'A title',
  content: 'No provenance prose here.',
  project: 'brain',
  scope: 'project',
  topic_key: 'sdd/x/y',
  revision_count: 1,
  duplicate_count: 0,
  last_seen_at: '2026-07-02 11:45:38',
  created_at: '2026-07-01 01:19:12',
  updated_at: '2026-07-02 11:45:38',
  ...overrides,
});

function tmpFixtureRoot() {
  const root = testTmp('brain-cli-migrate-v1-');
  const chunksDir = join(root, '.memory', 'chunks');
  mkdirSync(chunksDir, { recursive: true });
  return { root, chunksDir };
}

function writeChunk(chunksDir, observations) {
  const payload = { sessions: [], observations, prompts: [] };
  writeFileSync(join(chunksDir, 'chunk1.jsonl.gz'), gzipSync(Buffer.from(JSON.stringify(payload))));
}

function runCli(args, testRoot) {
  return spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, BRAIN_MIGRATE_V1_TEST_ROOT: testRoot },
  });
}

// ── REQ-C2B2-1: the un-refused non-dry-run path runs the real migration ─────

test('migrate-v1 without --dry-run executes runMigration against the fixture root (records written, chunks → legacy/, report persisted, index rebuilt)', () => {
  const { root, chunksDir } = tmpFixtureRoot();
  writeChunk(chunksDir, [baseObs()]);

  const result = runCli(['migrate-v1'], root);

  assert.equal(result.status, 0, `expected exit 0, got ${result.status}. stderr: ${result.stderr}`);
  const memoryRoot = join(root, '.memory');
  // #677 — one record per file, so the assertion names the shape rather than a
  // month log: the migrated record landed under its own content-addressed name.
  assert.deepEqual(
    readdirSync(join(memoryRoot, 'records')).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/rec-[0-9a-f]{16}/, 'rec-<id>')),
    ['2026-07-rec-<id>.jsonl'],
    'records/ must be written',
  );
  assert.ok(existsSync(join(memoryRoot, 'legacy', 'chunk1.jsonl.gz')), 'chunk must be moved to legacy/');
  assert.ok(existsSync(join(memoryRoot, 'legacy', 'migration-rejected.json')), 'the rejection report must be persisted');
  assert.ok(existsSync(join(memoryRoot, 'index.jsonl')), 'the index must be rebuilt');
  assert.ok(!existsSync(join(chunksDir, 'chunk1.jsonl.gz')), 'the chunk must no longer be in chunks/');
});

test('migrate-v1 without --dry-run: the abort-if-populated throw surfaces as a non-zero exit with the message', () => {
  const { root, chunksDir } = tmpFixtureRoot();
  const recordsDir = join(root, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, '2026-01.jsonl'), '{"id":"already-migrated"}\n');
  writeChunk(chunksDir, [baseObs()]);

  const result = runCli(['migrate-v1'], root);

  assert.notEqual(result.status, 0, 'a populated records/ must abort with a non-zero exit');
  assert.match(result.stderr, /run the cutover runbook/);
});

// ── `--dry-run` stays unchanged (report only, no mutation) ──────────────────

test('migrate-v1 --dry-run is unchanged: prints the report and never mutates the fixture store', () => {
  const { root, chunksDir } = tmpFixtureRoot();
  writeChunk(chunksDir, [baseObs()]);

  const result = runCli(['migrate-v1', '--dry-run'], root);

  assert.equal(result.status, 0);
  assert.match(result.stdout, /Dry-run migration report/);
  const memoryRoot = join(root, '.memory');
  assert.ok(!existsSync(join(memoryRoot, 'records')), '--dry-run must never create records/');
  assert.ok(!existsSync(join(memoryRoot, 'legacy')), '--dry-run must never create legacy/');
  assert.ok(existsSync(join(chunksDir, 'chunk1.jsonl.gz')), '--dry-run must never move the chunk');
});

// ── `--rollback` is retired (#955 R1/R2/D1): it refuses, always ────────────

test('migrate-v1 --rollback refuses: exit 1, named reason, chunk untouched, no records/ or legacy/ created', () => {
  const { root, chunksDir } = tmpFixtureRoot();
  writeChunk(chunksDir, [baseObs()]);

  const result = runCli(['migrate-v1', '--rollback'], root);

  assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stdout: ${result.stdout}`);
  assert.ok(result.stderr.includes(en['memory.migrateV1.rollbackRetired']), `stderr must include the retirement reason. Got: ${result.stderr}`);
  const memoryRoot = join(root, '.memory');
  assert.ok(existsSync(join(chunksDir, 'chunk1.jsonl.gz')), 'the chunk must still be in chunks/ — nothing moved');
  assert.ok(!existsSync(join(memoryRoot, 'records')), '--rollback must never create records/');
  assert.ok(!existsSync(join(memoryRoot, 'legacy')), '--rollback must never create legacy/');
});

test('migrate-v1 --rollback --dry-run also refuses (the refusal branch runs BEFORE the --dry-run check)', () => {
  const { root, chunksDir } = tmpFixtureRoot();
  writeChunk(chunksDir, [baseObs()]);

  const result = runCli(['migrate-v1', '--rollback', '--dry-run'], root);

  assert.equal(result.status, 1, `expected exit 1, got ${result.status}. stdout: ${result.stdout}`);
  assert.ok(result.stderr.includes(en['memory.migrateV1.rollbackRetired']), `stderr must include the retirement reason. Got: ${result.stderr}`);
  const memoryRoot = join(root, '.memory');
  assert.ok(existsSync(join(chunksDir, 'chunk1.jsonl.gz')), 'the chunk must still be in chunks/ — nothing moved');
  assert.ok(!existsSync(join(memoryRoot, 'records')), '--rollback --dry-run must never create records/');
  assert.ok(!existsSync(join(memoryRoot, 'legacy')), '--rollback --dry-run must never create legacy/');
});
