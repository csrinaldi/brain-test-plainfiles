// duplicates.test.mjs — issue #574. The accounting helpers and the operator
// report. Pure functions: no filesystem, no store.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  emptyDuplicates,
  summarizeDuplicates,
  normalizeDuplicates,
  formatDuplicateReport,
} from './duplicates.mjs';

test('emptyDuplicates: the zero accounting', () => {
  assert.deepEqual(emptyDuplicates(), { ids: 0, lines: 0, divergent: 0, groups: [] });
});

test('summarizeDuplicates: an id seen once is not a duplicate', () => {
  const summary = summarizeDuplicates(new Map([['rec-a', ['2026-07.jsonl:1']]]));
  assert.deepEqual(summary, { ids: 0, lines: 0, divergent: 0, groups: [] });
});

test('summarizeDuplicates: `lines` counts EXCESS lines, not occurrences', () => {
  const summary = summarizeDuplicates(new Map([
    ['rec-b', ['f:1', 'f:2', 'f:3']],   // 3 lines, 1 record → 2 excess
    ['rec-a', ['f:4', 'f:5']],          // 2 lines, 1 record → 1 excess
    ['rec-c', ['f:6']],
  ]));
  assert.equal(summary.ids, 2);
  assert.equal(summary.lines, 3);
  assert.deepEqual(summary.groups.map((g) => g.id), ['rec-a', 'rec-b'], 'groups are sorted by id');
});

test('summarizeDuplicates: reproduces the measurement that opened #574', () => {
  // The real shape of `main` at the time of writing: 2177 physical lines, 2038
  // unique ids. The 49 repeated ids carry these occurrence counts —
  // 15 ids appear twice, 16 three times, 2 four times, 8 five times, 1 six
  // times, 7 eight times — which is exactly the 139-line excess the ticket
  // measured. Pinned as a histogram so the arithmetic connecting "49 ids" to
  // "139 lines" is checkable rather than asserted.
  const histogram = { 2: 15, 3: 16, 4: 2, 5: 8, 6: 1, 8: 7 };
  const occurrences = new Map();
  let n = 0;
  for (const [times, ids] of Object.entries(histogram)) {
    for (let i = 0; i < ids; i++) {
      occurrences.set(`rec-${String(n++).padStart(16, '0')}`, Array.from({ length: Number(times) }, (_, k) => `f:${k}`));
    }
  }
  // …plus the 1989 ids that appear exactly once and are therefore not duplicates.
  for (let i = 0; i < 1989; i++) occurrences.set(`rec-solo-${i}`, ['f:1']);

  const summary = summarizeDuplicates(occurrences);

  assert.equal(occurrences.size, 2038, 'unique ids');
  assert.equal(summary.ids, 49, 'repeated ids');
  assert.equal(summary.lines, 139, 'excess physical lines — the amount the index is shorter than the store');
});

test('normalizeDuplicates: a seam that returns no accounting reports zero, never crashes', () => {
  assert.deepEqual(normalizeDuplicates(undefined), { ids: 0, lines: 0, divergent: 0, groups: [] });
  assert.deepEqual(normalizeDuplicates(null), { ids: 0, lines: 0, divergent: 0, groups: [] });
  assert.deepEqual(normalizeDuplicates({}), { ids: 0, lines: 0, divergent: 0, groups: [] });
});

test('normalizeDuplicates: derives the counts from groups when only groups are given', () => {
  const normalized = normalizeDuplicates({ groups: [{ id: 'rec-a', occurrences: ['f:1', 'f:2', 'f:3'] }] });
  assert.equal(normalized.ids, 1);
  assert.equal(normalized.lines, 2);
});

test('formatDuplicateReport: a clean store prints NOTHING', async () => {
  assert.deepEqual(await formatDuplicateReport(emptyDuplicates()), []);
  assert.deepEqual(await formatDuplicateReport(undefined), []);
});

test('formatDuplicateReport: leads with the counts, then the locations', async () => {
  const report = await formatDuplicateReport(
    summarizeDuplicates(new Map([['rec-a', ['2026-07.jsonl:1', '2026-07.jsonl:9']]])),
    { indexCount: 2038 },
  );
  assert.match(report[0], /1 duplicate record id/);
  assert.match(report[0], /1 excess physical line/);
  assert.match(report[0], /2039 physical line\(s\) → 2038 indexed/);
  assert.ok(report.some((l) => l.includes('rec-a ×2 — 2026-07.jsonl:1, 2026-07.jsonl:9')));
});

test('formatDuplicateReport: says WHY it deduplicated rather than refused', async () => {
  const report = await formatDuplicateReport(summarizeDuplicates(new Map([['rec-a', ['f:1', 'f:2']]])));
  const body = report.join('\n');
  assert.match(body, /merge=union/, 'names the mechanism that produced the duplicate');
  assert.match(body, /ADR-0017/, 'cites the decision it is consistent with');
  assert.match(body, /wc -l/, 'names the number that is now wrong, so the operator can check it');
});

test('formatDuplicateReport: caps the evidence so the summary is never buried', async () => {
  const occurrences = new Map();
  for (let i = 0; i < 49; i++) occurrences.set(`rec-${String(i).padStart(4, '0')}`, ['f:1', 'f:2']);
  const report = await formatDuplicateReport(summarizeDuplicates(occurrences));

  assert.equal(report.filter((l) => /^ {2}rec-/.test(l)).length, 10, 'at most 10 ids are listed');
  assert.ok(report.at(-1).includes('+39 more duplicated id(s)'), 'and the remainder is counted, not dropped');
});

// ── the divergent channel ────────────────────────────────────────────────────

test('summarizeDuplicates: divergent ids are counted separately and marked on their group', () => {
  const summary = summarizeDuplicates(
    new Map([['rec-a', ['f:1', 'f:2']], ['rec-b', ['f:3', 'f:4']]]),
    new Set(['rec-b']),
  );
  assert.equal(summary.ids, 2);
  assert.equal(summary.divergent, 1, 'a subset of the repeats, not a separate population');
  assert.deepEqual(summary.groups.map((g) => g.divergent), [false, true]);
});

test('formatDuplicateReport: a divergent group gets its own line AND an inline mark', async () => {
  const report = await formatDuplicateReport(
    summarizeDuplicates(new Map([['rec-a', ['2026-06.jsonl:1', '2026-07.jsonl:4']]]), new Set(['rec-a'])),
  );
  const body = report.join('\n');
  assert.match(body, /1 of them DISAGREE outside the hashed fields/);
  assert.match(body, /`source` is not hashed/, 'says WHY two copies of one record can differ');
  assert.match(body, /first-wins/, 'and states the resolution rather than leaving it implicit');
  assert.match(body, /rec-a ×2 \[divergent\]/, 'marked inline, so it is findable in a capped list');
});

test('formatDuplicateReport: no divergence → no divergence line (the channels stay separate)', async () => {
  const report = await formatDuplicateReport(summarizeDuplicates(new Map([['rec-a', ['f:1', 'f:2']]])));
  assert.equal(/DISAGREE/.test(report.join('\n')), false);
  assert.equal(/\[divergent\]/.test(report.join('\n')), false);
});

test('formatDuplicateReport: a real accounting is never silenced by a malformed `ids`', async () => {
  // Gated on `ids === 0 && lines === 0`, not on `ids` alone: a seam returning a
  // non-integer `ids` would otherwise normalize to 0 and swallow a real
  // 139-line report.
  const report = await formatDuplicateReport({ ids: '49', lines: 139, groups: [] });
  assert.ok(report.length > 0, 'the excess-line count alone is enough to speak');
  assert.match(report[0], /139 excess physical line/);
});

test('formatDuplicateReport: a half-filled group NEVER throws — the reporter cannot fail the op it reports on', async () => {
  // Round-2 review finding. `normalizeDuplicates` documents that a partial
  // accounting reports as zero "never as a crash", but the formatter then
  // dereferenced `g.occurrences` unguarded. In cli.mjs these calls sit INSIDE
  // the try blocks, so the throw turned an already-completed `save` into
  // "plainfiles.save() failed …" and exit 1, with the record durably on disk.
  const report = await formatDuplicateReport({ groups: [{ id: 'rec-a' }] });
  assert.ok(report.length > 0);
  assert.ok(report.some((l) => l.includes('rec-a ×0')), 'reports what it has, rather than dying on what it lacks');
});

test('formatDuplicateReport: a divergence-only accounting is not silenced by the gate', async () => {
  const report = await formatDuplicateReport({ ids: 0, lines: 0, divergent: 7, groups: [] });
  assert.ok(report.length > 0, 'the channel this ticket added is the last one allowed to be silent');
  assert.match(report.join('\n'), /7 of them DISAGREE/);
});

test('formatDuplicateReport: `brief` keeps the counts and drops the evidence', async () => {
  const occurrences = new Map();
  for (let i = 0; i < 12; i++) occurrences.set(`rec-${i}`, ['2026-07.jsonl:1', '2026-07.jsonl:9']);
  const report = await formatDuplicateReport(summarizeDuplicates(occurrences), { brief: true });

  assert.match(report[0], /12 duplicate record id\(s\)/, 'brief is not silent');
  assert.equal(report.some((l) => /^ {2}rec-/.test(l)), false, 'no per-id lines');
  assert.match(report.at(-1), /brain:memory:reindex/, 'and it names where the locations live');
});

test('formatDuplicateReport: caps the per-id locations too, counting the rest', async () => {
  const occurrences = new Map([['rec-a', Array.from({ length: 8 }, (_, i) => `f:${i + 1}`)]]);
  const report = await formatDuplicateReport(summarizeDuplicates(occurrences));
  const line = report.find((l) => l.includes('rec-a'));
  assert.match(line, /rec-a ×8/);
  assert.match(line, /\+2 more/);
});
