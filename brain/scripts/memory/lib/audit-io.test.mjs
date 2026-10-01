// audit-io.test.mjs — the reading half of `brain:memory:audit` (#870), exercised
// through its seams: no real git, no real engram, no real fs beyond a tmp dir.
// Written after the rev-1 cold review of PR #871: the engram branch trusted
// `observations.length` without the `Observations: N` cross-check that
// `topicKeysFromExport` already performs (#445), and none of these readers had
// a test at all.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { testTmp } from '../../lib/test-tmp.mjs';
import { readRecordLines, readLandingTimes, readBackendKeys, runAudit } from './audit-io.mjs';

// ── readRecordLines ─────────────────────────────────────────────────────────

test('readRecordLines: every physical line with its file; blanks and junk skipped', () => {
  const root = testTmp('audit-io-');
  const dir = join(root, '.memory', 'records');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-09-rec-a.jsonl'), '{"id":"rec-a","ts":"2026-09-01T00:00:00Z"}\n\n{"id":"rec-a","ts":"2026-09-01T00:00:00Z"}\n', 'utf8');
  writeFileSync(join(dir, '2026-09-rec-b.jsonl'), 'not json\n{"id":"rec-b","ts":"2026-09-02T00:00:00Z"}\n', 'utf8');
  writeFileSync(join(dir, 'README.txt'), 'ignored', 'utf8');
  const lines = readRecordLines(dir);
  assert.deepEqual(lines.map((l) => [l.id, l.file]), [
    ['rec-a', '2026-09-rec-a.jsonl'],
    ['rec-a', '2026-09-rec-a.jsonl'],
    ['rec-b', '2026-09-rec-b.jsonl'],
  ]);
});

test('readRecordLines: a missing dir THROWS naming the path — never an empty list', () => {
  assert.throws(() => readRecordLines('/nowhere/.memory/records'), /records dir not found — \/nowhere/);
});

// ── readLandingTimes ────────────────────────────────────────────────────────

test('readLandingTimes: asks git for the first-parent line with merge diffs, parses COMMIT blocks', () => {
  let argv = null;
  const out = [
    'COMMIT 1700000300', '.memory/records/2026-09-rec-0000000000000001.jsonl', '',
    'COMMIT 1700000200', '', // a merge commit that added nothing under records
    'COMMIT 1700000100', '.memory/records/2026-08-rec-0000000000000002.jsonl', '.memory/records/2026-08-rec-0000000000000003.jsonl', '',
  ].join('\n');
  const landed = readLandingTimes('/repo', { _exec: (cmd, args) => { argv = [cmd, ...args]; return out; } });
  assert.deepEqual(argv.slice(0, 5), ['git', 'log', '-m', '--first-parent', '--diff-filter=A']);
  assert.equal(landed.get('rec-0000000000000001'), 1700000300000);
  assert.equal(landed.get('rec-0000000000000002'), 1700000100000);
  assert.equal(landed.get('rec-0000000000000003'), 1700000100000);
  assert.equal(landed.has('rec-0000000000000004'), false);
});

test('readLandingTimes: git failure propagates — "could not read" is not "nothing landed"', () => {
  assert.throws(() => readLandingTimes('/repo', { _exec: () => { throw new Error('fatal: not a git repository'); } }), /not a git repository/);
});

// ── readBackendKeys ─────────────────────────────────────────────────────────

test('readBackendKeys: plainfiles reads index ids, labelled as the vacuity row', () => {
  const root = testTmp('audit-io-');
  mkdirSync(join(root, '.memory'), { recursive: true });
  writeFileSync(join(root, '.memory', 'index.jsonl'), '{"id":"rec-1"}\n{"id":"rec-2"}\nbroken\n', 'utf8');
  const r = readBackendKeys('plainfiles', root);
  assert.equal(r.measured, true);
  assert.match(r.mode, /vacuity/);
  assert.deepEqual(r.keys, ['rec-1', 'rec-2']);
});

test('readBackendKeys: plainfiles with no index is measured:false with the reason', () => {
  const root = testTmp('audit-io-');
  const r = readBackendKeys('plainfiles', root);
  assert.equal(r.measured, false);
  assert.match(r.reason, /index\.jsonl not found/);
});

test('readBackendKeys: engram absent → measured:false naming the probe reason, no exec', () => {
  let execs = 0;
  const r = readBackendKeys('engram', '/repo', { _probe: () => ({ available: false, reason: 'not on PATH' }), _exec: () => { execs++; } });
  assert.equal(r.measured, false);
  assert.match(r.reason, /engram: not on PATH/);
  assert.equal(execs, 0);
});

function engramExport(files, { reportedCount, observations }) {
  return {
    _probe: () => ({ available: true }),
    _exec: (bin, args) => { files.set(args[1], JSON.stringify({ version: '0.1.0', observations })); return `Exported to ${args[1]}\n  Observations: ${reportedCount}\n`; },
    _read: (p) => files.get(p),
  };
}

test('readBackendKeys: engram export → rec- keys as a LIST (rows), non-rec keys dropped', () => {
  const files = new Map();
  const obs = [{ topic_key: 'rec-1' }, { topic_key: 'skill-registry' }, { topic_key: 'rec-1' }, {}];
  const r = readBackendKeys('engram', '/repo', engramExport(files, { reportedCount: 4, observations: obs }));
  assert.equal(r.measured, true);
  assert.deepEqual(r.keys, ['rec-1', 'rec-1']);
});

test('readBackendKeys: engram export whose stdout count disagrees with the file is measured:false — the #445 cross-check, reused', () => {
  const files = new Map();
  const obs = [{ topic_key: 'rec-1' }, { topic_key: 'rec-2' }];
  const r = readBackendKeys('engram', '/repo', engramExport(files, { reportedCount: 5, observations: obs }));
  assert.equal(r.measured, false);
  assert.match(r.reason, /reported 5 observations but the file carries 2/);
  assert.equal('keys' in r, false);
});

test('readBackendKeys: engram export with no count on stdout is measured:false', () => {
  const files = new Map();
  const seams = engramExport(files, { reportedCount: 1, observations: [{ topic_key: 'rec-1' }] });
  seams._exec = (bin, args) => { files.set(args[1], JSON.stringify({ observations: [{ topic_key: 'rec-1' }] })); return 'Exported\n'; };
  const r = readBackendKeys('engram', '/repo', seams);
  assert.equal(r.measured, false);
  assert.match(r.reason, /no observation count on stdout/);
});

// ── runAudit ────────────────────────────────────────────────────────────────

test('runAudit: a git failure makes latency measured:false with the reason; the other numbers still print', () => {
  const root = testTmp('audit-io-');
  const dir = join(root, '.memory', 'records');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, '2026-09-rec-a.jsonl'), '{"id":"rec-a","ts":"2026-09-01T00:00:00Z","actor":"@me"}\n', 'utf8');
  const r = runAudit({
    root, backend: 'plainfiles', sinceMs: Date.parse('2026-08-01T00:00:00Z'), nowMs: Date.parse('2026-09-06T00:00:00Z'),
    _readLandingTimes: () => { throw new Error('fatal: not a git repository'); },
    _readBackendKeys: () => ({ measured: false, reason: 'test' }),
  });
  assert.equal(r.latency.measured, false);
  assert.match(r.latency.reason, /not a git repository/);
  assert.equal(r.lines.lines, 1);
  assert.equal(r.actors.window.handle, 1);
});
