// audit.test.mjs — the pure half of `brain:memory:audit` (#870, memory 2.0 task 0.2).
// Every number the command prints is computed here from plain data; these tests
// pin each definition design.md D3 fixes, so the baseline on #864 and the exit
// report are comparable by construction rather than by memory.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  percentile,
  latencyStats,
  classifyActor,
  actorShape,
  coverage,
  lineAccounting,
  backendAccounting,
  buildReport,
  renderReport,
} from './audit.mjs';

const H = 3600000;

// ── percentile: nearest-rank ────────────────────────────────────────────────

test('percentile: nearest-rank on an ascending list', () => {
  const xs = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(percentile(xs, 0.5), 5);
  assert.equal(percentile(xs, 0.9), 9);
  assert.equal(percentile(xs, 1), 10);
  assert.equal(percentile([7], 0.5), 7);
});

test('percentile: empty list is null, never 0', () => {
  assert.equal(percentile([], 0.5), null);
});

// ── latencyStats ────────────────────────────────────────────────────────────

test('latencyStats: hours from ts to landing, buckets, and not-landed counted apart', () => {
  const t0 = Date.parse('2026-08-01T00:00:00Z');
  const pairs = [
    { id: 'a', tsMs: t0, landedMs: t0 + 0.5 * H },
    { id: 'b', tsMs: t0, landedMs: t0 + 10 * H },
    { id: 'c', tsMs: t0, landedMs: t0 + 30 * H },
    { id: 'd', tsMs: t0, landedMs: t0 + 100 * H },
    { id: 'e', tsMs: t0, landedMs: null },
  ];
  const s = latencyStats(pairs);
  assert.equal(s.n, 4);
  assert.equal(s.notLanded, 1);
  assert.equal(s.p50h, 10);
  assert.equal(s.p90h, 100);
  assert.equal(s.maxH, 100);
  assert.equal(s.within1h, 1);
  assert.equal(s.over24h, 2);
  assert.equal(s.over72h, 1);
});

test('latencyStats: nothing landed → n 0 and null percentiles, not zeros', () => {
  const s = latencyStats([{ id: 'a', tsMs: 1, landedMs: null }]);
  assert.equal(s.n, 0);
  assert.equal(s.notLanded, 1);
  assert.equal(s.p50h, null);
});

// ── actor shapes ────────────────────────────────────────────────────────────

test('classifyActor: the four shapes design.md D3 fixes', () => {
  assert.equal(classifyActor('@legacy'), 'legacy');
  assert.equal(classifyActor('feat/issue-266-h0a-reviewer'), 'branch');
  assert.equal(classifyActor('@csrinaldi'), 'handle');
  assert.equal(classifyActor('@a-b-1'), 'handle');
  assert.equal(classifyActor('claude/brain-architecture-review'), 'branch');
  assert.equal(classifyActor('main'), 'branch');
  assert.equal(classifyActor('master'), 'branch');
  assert.equal(classifyActor('someone'), 'other');
  assert.equal(classifyActor('@'), 'other');
  assert.equal(classifyActor(''), 'other');
  assert.equal(classifyActor(undefined), 'other');
});

test('actorShape: counts every shape, in order', () => {
  const recs = ['@legacy', '@legacy', 'fix/x', '@me', 'x'].map((actor) => ({ actor }));
  assert.deepEqual(actorShape(recs), { total: 5, legacy: 2, branch: 1, handle: 1, other: 1 });
});

// ── coverage & line accounting ──────────────────────────────────────────────

test('coverage: issue is a number, supersedes a non-empty string', () => {
  const recs = [
    { issue: 12, supersedes: 'rec-1' },
    { issue: '12' },
    { supersedes: '' },
    {},
  ];
  assert.deepEqual(coverage(recs), { total: 4, issue: 1, supersedes: 1 });
});

test('lineAccounting: physical lines vs distinct ids, repeats listed', () => {
  const ids = ['rec-a', 'rec-b', 'rec-a', 'rec-c', 'rec-a'];
  const a = lineAccounting(ids);
  assert.equal(a.lines, 5);
  assert.equal(a.distinct, 3);
  assert.equal(a.excess, 2);
  assert.deepEqual(a.repeated, [{ id: 'rec-a', times: 3 }]);
});

// ── backend accounting ──────────────────────────────────────────────────────

test('backendAccounting: rows vs distinct keys from a LIST, duplicates listed', () => {
  const b = backendAccounting({ measured: true, keys: ['rec-1', 'rec-2', 'rec-1'], mode: 'export' });
  assert.equal(b.measured, true);
  assert.equal(b.rows, 3);
  assert.equal(b.distinct, 2);
  assert.deepEqual(b.duplicated, [{ key: 'rec-1', times: 2 }]);
});

test('backendAccounting: a refused export is measured:false with the reason, no numbers', () => {
  const b = backendAccounting({ measured: false, reason: 'engram: not installed' });
  assert.equal(b.measured, false);
  assert.equal(b.reason, 'engram: not installed');
  assert.equal('rows' in b, false);
});

// ── buildReport + renderReport ──────────────────────────────────────────────

function sample() {
  const since = Date.parse('2026-08-01T00:00:00Z');
  const now = since + 40 * 24 * H;
  const rec = (id, ts, extra = {}) => ({ id, ts, actor: '@legacy', ...extra });
  const records = [
    rec('rec-old', '2026-07-01T00:00:00Z'),
    rec('rec-1', '2026-08-02T00:00:00Z', { issue: 5 }),
    rec('rec-2', '2026-08-03T00:00:00Z', { actor: 'feat/x' }),
    rec('rec-2', '2026-08-03T00:00:00Z', { actor: 'feat/x' }), // repeated physical line
    rec('rec-3', '2026-08-04T00:00:00Z', { actor: '@me', supersedes: 'rec-1' }),
  ];
  const landedMsById = new Map([
    ['rec-old', Date.parse('2026-07-01T01:00:00Z')],
    ['rec-1', Date.parse('2026-08-02T02:00:00Z')],
    ['rec-2', Date.parse('2026-08-05T00:00:00Z')],
  ]);
  return { records, landedMsById, sinceMs: since, nowMs: now, backend: { measured: false, reason: 'no backend' } };
}

test('buildReport: window applies to latency and in-window shapes; all-time rows are all-time', () => {
  const r = buildReport(sample());
  assert.equal(r.window.sinceIso, '2026-08-01T00:00:00Z');
  assert.equal(r.latency.n, 2); // rec-1, rec-2 (rec-3 not landed; rec-old outside window)
  assert.equal(r.latency.notLanded, 1);
  assert.equal(r.latency.p50h, 2);
  assert.equal(r.lines.lines, 5);
  assert.equal(r.lines.distinct, 4);
  assert.deepEqual(r.actors.window, { total: 3, legacy: 1, branch: 1, handle: 1, other: 0 });
  assert.equal(r.actors.allTime.total, 4);
  assert.deepEqual(r.coverage.window, { total: 3, issue: 1, supersedes: 1 });
  assert.equal(r.backend.measured, false);
});

test('buildReport: repeated physical lines count once for shapes and coverage', () => {
  const r = buildReport(sample());
  assert.equal(r.actors.allTime.branch, 1);
});

test('renderReport: one line per number, reason printed on the backend row, no zeros for unmeasured', () => {
  const text = renderReport(buildReport(sample())).join('\n');
  assert.match(text, /learn→main/);
  assert.match(text, /p50 2\.0 h/);
  assert.match(text, /not landed 1/);
  assert.match(text, /lines 5 · distinct 4 · excess 1/);
  assert.match(text, /@legacy 1 · branch 1 · handle 1 · other 0/);
  assert.match(text, /backend: not measured — no backend/);
  assert.doesNotMatch(text, /rows 0/);
});
