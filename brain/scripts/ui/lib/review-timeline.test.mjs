// review-timeline.test.mjs — #998 R998-5: the reviews timeline and the
// verdict queue.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewTimeline } from './review-timeline.mjs';

const prs = (value) => ({ ok: true, value });
const reviews = (value) => ({ ok: true, value });

const finding = (severity, over = {}) => ({ id: 'F-1', severity, evidenceExcerpt: 'because', cites: null, file: null, line: null, ...over });

const verdict = (rev, verdictWord, over = {}) => ({
  pr: over.pr ?? 1, head_sha: 'abcdef0123', rev, verdict: verdictWord, author: 'bot',
  findings: [], findingCount: 0, malformed: [], ...over,
});

test('#998 R998-5: two rounds (REVISE then APPROVE), findings grouped bySeverity, oldest round first', () => {
  const t = buildReviewTimeline(
    reviews([{ pr: 1, ok: true, verdicts: [
      verdict(1, 'REVISE', { findings: [finding('blocker'), finding('minor')] }),
      verdict(2, 'APPROVE'),
    ], latest: null }]),
    prs([{ number: 1, title: 'the PR', headBranch: 'feat/x', issue: 998 }]),
  );
  assert.equal(t.ok, true);
  assert.equal(t.value.threads.length, 1);
  const thread = t.value.threads[0];
  assert.equal(thread.pr, 1);
  assert.equal(thread.issue, 998);
  assert.equal(thread.rounds.length, 2);
  assert.equal(thread.rounds[0].verdict, 'REVISE');
  assert.deepEqual(thread.rounds[0].bySeverity, { blocker: 1, minor: 1 });
  assert.equal(thread.rounds[1].verdict, 'APPROVE');
  assert.equal(thread.latest.verdict, 'APPROVE');
  assert.equal(thread.noRound, false);
});

test('#998 R998-5: a thread with no round is distinct from an unreadable one', () => {
  const t = buildReviewTimeline(
    reviews([]),
    prs([{ number: 2, title: 'no round yet', headBranch: 'feat/y', issue: 999 }]),
  );
  assert.equal(t.value.threads[0].noRound, true);
  assert.deepEqual(t.value.threads[0].rounds, []);
  assert.equal(t.value.threads[0].unreadable, undefined);
});

test('#998 R998-5: a finding with file/line gets source:{path,line}; one without gets a null source, never dropped', () => {
  const t = buildReviewTimeline(
    reviews([{ pr: 6, ok: true, verdicts: [verdict(1, 'REVISE', { pr: 6, findings: [
      finding('blocker', { file: 'brain/scripts/governance/run-check.mjs', line: 556 }),
      finding('correction'),
    ] })], latest: null }]),
    prs([{ number: 6, title: 'anchored', headBranch: 'feat/anchor', issue: 6 }]),
  );
  const [anchored, unanchored] = t.value.threads[0].rounds[0].findings;
  assert.deepEqual(anchored.source, { path: 'brain/scripts/governance/run-check.mjs', line: 556 });
  assert.equal(unanchored.source, null, 'no file/line — the source is null, never dropped from the finding');
});

test('#998 R998-5: an unreadable thread is a row with its reason, never a skip', () => {
  const t = buildReviewTimeline(
    reviews([{ pr: 3, ok: false, reason: 'gh exploded' }]),
    prs([{ number: 3, title: 'broken', headBranch: 'feat/z', issue: 997 }]),
  );
  assert.equal(t.value.threads.length, 1);
  assert.deepEqual(t.value.threads[0].unreadable, { reason: 'gh exploded' });
  assert.deepEqual(t.value.threads[0].rounds, []);
  assert.equal(t.value.threads[0].noRound, false);
});

test('#998 R998-5: an unknown severity is kept verbatim in bySeverity, never dropped', () => {
  const t = buildReviewTimeline(
    reviews([{ pr: 4, ok: true, verdicts: [verdict(1, 'REVISE', { findings: [finding('galactic')] })], latest: null }]),
    prs([{ number: 4, title: 'weird severity', headBranch: 'feat/w', issue: 996 }]),
  );
  assert.deepEqual(t.value.threads[0].rounds[0].bySeverity, { galactic: 1 });
});

test('#998 R998-5: the queue holds exactly the no-round and REVISE-latest threads, oldest-PR first', () => {
  const t = buildReviewTimeline(
    reviews([
      { pr: 20, ok: true, verdicts: [verdict(1, 'REVISE', { pr: 20 })], latest: null },
      { pr: 10, ok: true, verdicts: [verdict(1, 'APPROVE', { pr: 10 })], latest: null },
      { pr: 30, ok: false, reason: 'unreadable' },
    ]),
    prs([
      { number: 20, title: 'revise', headBranch: 'feat/r', issue: 1 },
      { number: 10, title: 'approve', headBranch: 'feat/a', issue: 2 },
      { number: 5, title: 'no round', headBranch: 'feat/n', issue: 3 },
      { number: 30, title: 'unreadable', headBranch: 'feat/u', issue: 4 },
    ]),
  );
  assert.deepEqual(t.value.queue.map((q) => q.pr), [5, 20]);
  assert.equal(t.value.queue.find((q) => q.pr === 5).wait, 'no round posted');
  assert.equal(t.value.queue.find((q) => q.pr === 20).wait, 'abcdef0');
});

test('#1009 cold review finding 2: a REVISE-latest thread with an unparseable head_sha still enters the queue, saying "head not readable" — never silently excluded', () => {
  const t = buildReviewTimeline(
    reviews([{ pr: 40, ok: true, verdicts: [verdict(1, 'REVISE', { pr: 40, head_sha: null })], latest: null }]),
    prs([{ number: 40, title: 'unparseable head', headBranch: 'feat/badhead', issue: 40 }]),
  );
  assert.deepEqual(t.value.queue.map((q) => q.pr), [40], 'a REVISE-latest thread must be in the queue even when its head cannot be parsed');
  assert.equal(t.value.queue.find((q) => q.pr === 40).wait, 'head not readable');
});

test('#998 R998-5: threads are sorted by PR number, deterministic under input shuffle', () => {
  const a = buildReviewTimeline(
    reviews([{ pr: 9, ok: true, verdicts: [verdict(1, 'APPROVE', { pr: 9 })], latest: null }, { pr: 1, ok: true, verdicts: [], latest: null }]),
    prs([{ number: 9, title: 'b', headBranch: 'x', issue: 1 }, { number: 1, title: 'a', headBranch: 'y', issue: 2 }]),
  );
  const b = buildReviewTimeline(
    reviews([{ pr: 1, ok: true, verdicts: [], latest: null }, { pr: 9, ok: true, verdicts: [verdict(1, 'APPROVE', { pr: 9 })], latest: null }]),
    prs([{ number: 1, title: 'a', headBranch: 'y', issue: 2 }, { number: 9, title: 'b', headBranch: 'x', issue: 1 }]),
  );
  assert.deepEqual(a, b);
  assert.deepEqual(a.value.threads.map((t) => t.pr), [1, 9]);
});

test('#998 R998-5: a failed prs or reviews section is the timeline\'s own reason, never an empty timeline', () => {
  const failedPrs = buildReviewTimeline(reviews([]), { ok: false, reason: 'the PR list could not be read' });
  assert.deepEqual(failedPrs, { ok: false, reason: 'the PR list could not be read' });
  const failedReviews = buildReviewTimeline({ ok: false, reason: 'gh exploded' }, prs([]));
  assert.deepEqual(failedReviews, { ok: false, reason: 'gh exploded' });
});

test('#1009 cold review finding 1: a malformed findings block keeps its malformed keys and null findingCount on the shaped round, never dropped to {findings: [], bySeverity: {}}', () => {
  const t = buildReviewTimeline(
    reviews([{ pr: 7, ok: true, verdicts: [verdict(1, 'REVISE', { pr: 7, findings: [], findingCount: null, malformed: ['findings'] })], latest: null }]),
    prs([{ number: 7, title: 'malformed', headBranch: 'feat/malformed', issue: 7 }]),
  );
  const round = t.value.threads[0].rounds[0];
  assert.deepEqual(round.malformed, ['findings'], 'shapeRound must carry the verdict\'s malformed keys forward');
  assert.equal(round.findingCount, null, 'uncomputable, distinct from a verdict that declared zero findings');
  assert.deepEqual(round.findings, []);
  assert.deepEqual(round.bySeverity, {});
});

test('#998 R998-5: totals count threads, the queue, and unreadable threads', () => {
  const t = buildReviewTimeline(
    reviews([{ pr: 1, ok: true, verdicts: [verdict(1, 'REVISE', { pr: 1 })], latest: null }, { pr: 2, ok: false, reason: 'x' }]),
    prs([{ number: 1, title: 'a', headBranch: 'x', issue: 1 }, { number: 2, title: 'b', headBranch: 'y', issue: 2 }]),
  );
  assert.deepEqual(t.value.totals, { threads: 2, queue: 1, unreadable: 1, stops: 0 });
});

test('#1009 cold review round 2 finding: a STOP-latest thread is waiting, head of the queue (before REVISE and no-round entries), saying the human escalation', () => {
  const t = buildReviewTimeline(
    reviews([
      { pr: 20, ok: true, verdicts: [verdict(1, 'REVISE', { pr: 20 })], latest: null },
      { pr: 5, ok: true, verdicts: [verdict(3, 'STOP', { pr: 5, head_sha: 'stopsha0123' })], latest: null },
    ]),
    prs([
      { number: 20, title: 'revise', headBranch: 'feat/r', issue: 1 },
      { number: 5, title: 'stopped', headBranch: 'feat/s', issue: 2 },
      { number: 1, title: 'no round', headBranch: 'feat/n', issue: 3 },
    ]),
  );
  // STOP (pr 5) heads the queue ahead of everything else; REVISE (pr 20) and
  // no-round (pr 1) keep their own pre-existing relative order beneath it —
  // plain PR-ascending, un-split between the two.
  assert.deepEqual(t.value.queue.map((q) => q.pr), [5, 1, 20], 'STOP first, then the REVISE/no-round entries in their existing oldest-PR-first order');
  const stopEntry = t.value.queue.find((q) => q.pr === 5);
  assert.equal(stopEntry.wait, 'human escalation');
  assert.equal(stopEntry.escalate, true);
  assert.notEqual(stopEntry.wait, 'no round posted');
  const reviseEntry = t.value.queue.find((q) => q.pr === 20);
  assert.equal(reviseEntry.escalate, false);
  assert.notEqual(reviseEntry.wait, stopEntry.wait);
});

test('#1009 cold review round 2 finding: totals count STOP threads separately from the rest of the queue', () => {
  const t = buildReviewTimeline(
    reviews([
      { pr: 1, ok: true, verdicts: [verdict(1, 'REVISE', { pr: 1 })], latest: null },
      { pr: 2, ok: true, verdicts: [verdict(3, 'STOP', { pr: 2 })], latest: null },
    ]),
    prs([{ number: 1, title: 'a', headBranch: 'x', issue: 1 }, { number: 2, title: 'b', headBranch: 'y', issue: 2 }]),
  );
  assert.equal(t.value.totals.stops, 1);
  assert.equal(t.value.totals.queue, 2, 'the STOP thread is still counted in the overall waiting queue too');
});

test('#1009 cold review round 2 finding: a verdict outside APPROVE|REVISE|STOP is kept on the round and said as unknownVerdict, never dropped or treated as approved', () => {
  const t = buildReviewTimeline(
    reviews([{ pr: 8, ok: true, verdicts: [verdict(1, 'WOBBLE', { pr: 8 })], latest: null }]),
    prs([{ number: 8, title: 'odd verdict', headBranch: 'feat/odd', issue: 8 }]),
  );
  const round = t.value.threads[0].rounds[0];
  assert.equal(round.verdict, 'WOBBLE', 'the verdict word itself is never dropped');
  assert.equal(round.unknownVerdict, true);
  assert.equal(t.value.queue.length, 0, 'an unknown verdict is not treated as a waiting state (neither REVISE nor STOP)');
});

test('#1009 cold review round 2 finding: APPROVE and STOP rounds are not marked unknownVerdict', () => {
  const t = buildReviewTimeline(
    reviews([{ pr: 9, ok: true, verdicts: [verdict(1, 'APPROVE', { pr: 9 }), verdict(2, 'STOP', { pr: 9 })], latest: null }]),
    prs([{ number: 9, title: 'known verdicts', headBranch: 'feat/known', issue: 9 }]),
  );
  const [approveRound, stopRound] = t.value.threads[0].rounds;
  assert.equal(approveRound.unknownVerdict, false);
  assert.equal(stopRound.unknownVerdict, false);
});

// ── #1059 region 05: the design's queue is a table ────────────────────────
// Its columns are PR, issue, rounds, latest verdict, head judged and waiting.
// The entry carried only the first two and the wait, so the page would have
// had to reach back into the threads to fill a row — the join belongs here.
test('#1059 region 05: a queue entry carries every column the design\'s table shows', () => {
  const reviews = { ok: true, value: [
    { pr: 889, ok: true, verdicts: [
      { rev: 1, verdict: 'REVISE', head_sha: 'aaaaaaa1', author: 'bot', findings: [] },
      { rev: 2, verdict: 'REVISE', head_sha: 'e6412ab0', author: 'bot', findings: [] },
    ] },
  ] };
  const prs = { ok: true, value: [{ number: 889, title: 'the door', issue: 881, headBranch: 'feat/x' }] };

  const model = buildReviewTimeline(reviews, prs);
  const [entry] = model.value.queue;

  assert.equal(entry.pr, 889);
  assert.equal(entry.issue, 881);
  assert.equal(entry.rounds, 2, 'the table counts the rounds posted so far');
  assert.equal(entry.verdict, 'REVISE', 'and names the latest verdict word');
  assert.equal(entry.headSha7, 'e6412ab', 'and the head that verdict judged');
});

test('#1059 region 05: a thread with no round fills the same columns without inventing any', () => {
  const reviews = { ok: true, value: [{ pr: 1050, ok: true, verdicts: [] }] };
  const prs = { ok: true, value: [{ number: 1050, title: 'a memory lane', issue: null, headBranch: 'memory/x' }] };

  const [entry] = buildReviewTimeline(reviews, prs).value.queue;
  assert.equal(entry.rounds, 0);
  assert.equal(entry.verdict, null, 'no round means no verdict word — never an empty string passed off as one');
  assert.equal(entry.headSha7, null);
  assert.equal(entry.wait, 'no round posted');
});
