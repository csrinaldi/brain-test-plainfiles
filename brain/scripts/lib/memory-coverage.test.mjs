// memory-coverage.test.mjs — repo-level memory-records coverage snapshot for
// brain-metrics (issue #324/M9, spec "Memory-record coverage" requirement).
// Deliberately NOT a per-merge time series (design/spec: a single repo-level
// snapshot) — this is why it lives in its own lib module, separate from
// lib/metrics-aggregate.mjs's per-period rows.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { computeMemoryCoverage } from './memory-coverage.mjs';

function recordLine(fields) {
  return JSON.stringify({ id: `rec-${Math.random()}`, type: 'session_summary', ...fields }) + '\n';
}

test('computeMemoryCoverage: counts total records and those with a populated issue field', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-cov-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recordsDir = join(dir, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, '2026-07.jsonl'),
    recordLine({ issue: 324 }) + recordLine({}) + recordLine({ issue: '' }));

  const cov = computeMemoryCoverage(dir);
  assert.equal(cov.available, true);
  assert.equal(cov.total, 3);
  assert.equal(cov.tagged, 1, 'only the record with a non-empty issue field counts as tagged');
  assert.equal(cov.coveragePct, Math.round((1 / 3) * 1000) / 10);
});

test('E2 — missing .memory/records/ reports unavailable, 0% coverage, never throws', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-cov-missing-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  // No .memory/records/ created at all.

  const cov = computeMemoryCoverage(dir);
  assert.equal(cov.available, false);
  assert.equal(cov.total, 0);
  assert.equal(cov.tagged, 0);
  assert.equal(cov.coveragePct, 0);
});

test('computeMemoryCoverage: an empty (but present) records/ dir is available with 0 records, not "unavailable"', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-cov-empty-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, '.memory', 'records'), { recursive: true });

  const cov = computeMemoryCoverage(dir);
  assert.equal(cov.available, true, 'a present-but-empty dir is available — distinct from missing/unreadable');
  assert.equal(cov.total, 0);
  assert.equal(cov.coveragePct, 0);
});

test('computeMemoryCoverage: a corrupt record line is skipped, never crashes', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'mem-cov-corrupt-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recordsDir = join(dir, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, '2026-07.jsonl'), 'not-json\n' + recordLine({ issue: 1 }));

  const cov = computeMemoryCoverage(dir);
  assert.equal(cov.total, 1);
  assert.equal(cov.tagged, 1);
});
