import { test } from 'node:test';
import assert from 'node:assert/strict';

import { watcherBanner, pollBanner, controlBanner, degradationBands, failedSections, pollIndicator } from './banners.mjs';

const NOW = Date.parse('2026-09-16T12:00:00Z');
const at = (secondsAgo) => new Date(NOW - secondsAgo * 1000).toISOString();

const meta = (over = {}) => ({
  project: 'o/r',
  watcher: { ok: true, watched: 110, failed: [] },
  poller: { paused: false, lastPolledAt: at(5), lastOkAt: at(5), lastError: null, forgeAsOf: {}, intervalMs: 60000, nextAttemptAt: at(-55) },
  ...over,
});

test('#881 R881-9 S1 / D2: the watcher-failure banner is the design\'s string, verbatim', () => {
  assert.equal(
    watcherBanner('ENOSPC: no space for a watch'),
    'the watcher failed: ENOSPC: no space for a watch — the canvas updates on the forge poll only; press Refresh for repo changes.',
  );
});

test('#881 R881-9 S2 / D2: the poll-failure banner states the data\'s age AND the failed attempt\'s time', () => {
  const text = pollBanner({ lastOkAt: '2026-09-16T11:00:00Z', lastPolledAt: '2026-09-16T12:00:00Z', lastError: 'gh: rate limited' });
  assert.ok(text.startsWith('forge as of 2026-09-16T11:00:00Z — last poll failed: gh: rate limited'), `unexpected: ${text}`);
  assert.match(text, /attempted 2026-09-16T12:00:00Z/, 'R881-9 S2 asks for the time of the failed poll, not only the age of the data');
});

test('#881: a poll that has never succeeded says so instead of printing "as of null"', () => {
  const text = pollBanner({ lastOkAt: null, lastPolledAt: '2026-09-16T12:00:00Z', lastError: 'no VCS token' });
  assert.ok(text.startsWith('forge as of never — no poll has completed'), `unexpected: ${text}`);
  assert.match(text, /no VCS token/);
});

test('#881: a healthy page shows no band at all', () => {
  assert.deepEqual(degradationBands({ stream: { ok: true }, meta: meta(), snapshot: { graph: { ok: true, value: {} } } }), []);
});

test('#881 R881-9: a failed watcher keeps polling and shows the band with the paths that failed', () => {
  const bands = degradationBands({
    stream: { ok: true },
    meta: meta({ watcher: { ok: false, reason: '2 watch(es) failed', watched: 108, failed: [{ path: '/r/a', reason: 'ENOENT' }, { path: '/r/b', reason: 'EPERM' }] } }),
    snapshot: {},
  });
  assert.equal(bands.length, 1);
  assert.equal(bands[0].id, 'watcher');
  assert.equal(bands[0].text, watcherBanner('2 watch(es) failed'));
  assert.deepEqual(bands[0].detail, ['/r/a: ENOENT', '/r/b: EPERM'], 'which watches failed is the fact an operator needs');
});

test('#881 R881-4: a poll control that failed names the control, and never claims the stream dropped', () => {
  const text = controlBanner({ action: 'once', reason: 'POST /api/poll/once answered 503' });
  assert.equal(text, 'the "once" poll control failed: POST /api/poll/once answered 503 — polling is unchanged and the page is still live.');
});

test('#881 R881-4: a failed control is its own band, beside a live stream — not a stream-failure band', () => {
  const bands = degradationBands({
    stream: { ok: true },
    controls: { ok: false, action: 'pause', reason: 'POST /api/poll/pause answered 500' },
    meta: meta(),
    snapshot: {},
  });
  assert.deepEqual(bands.map((b) => b.id), ['controls'], 'a button that did not take is not a transport that dropped');
  assert.equal(bands[0].text, controlBanner({ action: 'pause', reason: 'POST /api/poll/pause answered 500' }));
  assert.ok(!/stream/.test(bands[0].text), `the control band must not mention the stream: ${bands[0].text}`);
});

test('#881 R881-9 S2: a failed poll shows its band while the watcher band stays absent', () => {
  const bands = degradationBands({
    stream: { ok: true },
    meta: meta({ poller: { paused: false, lastPolledAt: at(1), lastOkAt: at(600), lastError: 'boom', forgeAsOf: {} } }),
    snapshot: {},
  });
  assert.deepEqual(bands.map((b) => b.id), ['poller']);
  assert.match(bands[0].text, /last poll failed: boom/);
});

test('#881: a dropped stream is a band of its own, above the rest', () => {
  const bands = degradationBands({
    stream: { ok: false, reason: 'the live stream dropped' },
    meta: meta({ watcher: { ok: false, reason: 'ENOSPC', watched: 0, failed: [] } }),
    snapshot: {},
  });
  assert.deepEqual(bands.map((b) => b.id), ['stream', 'watcher']);
  assert.equal(bands[0].text, 'the live stream dropped');
});

test('#881: before the first status frame there is no meta, and the page still says something rather than nothing', () => {
  const bands = degradationBands({ stream: { ok: false, reason: 'the live stream has not connected yet' }, meta: null, snapshot: null });
  assert.deepEqual(bands.map((b) => b.id), ['stream']);
});

test('#881 R881-9 S1: every {ok:false} section of the snapshot is named with its reason, even one no view renders', () => {
  const snapshot = {
    generatedAt: 't',
    graph: { ok: false, reason: 'the issue list could not be read' },
    changes: { ok: true, value: [] },
    records: { ok: false, reason: '.memory/index.jsonl is unreadable' },
  };
  assert.deepEqual(failedSections(snapshot), [
    { name: 'graph', reason: 'the issue list could not be read' },
    { name: 'records', reason: '.memory/index.jsonl is unreadable' },
  ]);
  assert.deepEqual(failedSections(null), []);

  const bands = degradationBands({ stream: { ok: true }, meta: meta(), snapshot });
  assert.deepEqual(bands.map((b) => b.id), ['sections']);
  assert.deepEqual(bands[0].detail, ['graph: the issue list could not be read', 'records: .memory/index.jsonl is unreadable']);
});

test('#881 R881-4: the poll indicator says how long ago the forge was polled', () => {
  assert.deepEqual(pollIndicator({ poller: meta().poller, nowMs: NOW }), { text: 'forge polled 5 s ago', paused: false, countdown: 'next poll in 55 s' });
  assert.equal(pollIndicator({ poller: { ...meta().poller, lastOkAt: at(180) }, nowMs: NOW }).text, 'forge polled 3 min ago');
  assert.equal(pollIndicator({ poller: { ...meta().poller, lastOkAt: at(7200) }, nowMs: NOW }).text, 'forge polled 2 h ago');
});

test('#881 R881-4 S2: paused is visible in the indicator itself, not only in the control', () => {
  const paused = pollIndicator({ poller: { ...meta().poller, paused: true }, nowMs: NOW });
  assert.equal(paused.paused, true);
  assert.equal(paused.text, 'polling is paused — forge polled 5 s ago');
  assert.equal(paused.countdown, 'paused', 'the countdown says paused even though a nextAttemptAt is still in the fixture — paused always wins');

  const never = pollIndicator({ poller: { paused: true, lastPolledAt: null, lastOkAt: null, lastError: null, forgeAsOf: {}, intervalMs: 60000, nextAttemptAt: null }, nowMs: NOW });
  assert.equal(never.text, 'polling is paused — the forge has not been polled yet');
  assert.equal(never.countdown, 'paused');
});

test('#881: with no meta yet the indicator states that, rather than claiming a fresh poll', () => {
  assert.deepEqual(pollIndicator({ poller: null, nowMs: NOW }), { text: 'the poll state is unknown until the stream connects', paused: false, countdown: 'polling disabled' });
});

// ── #998 R998-6: the countdown text ─────────────────────────────────────────

test('#998 R998-6: the countdown reads "next poll in N s" while scheduled, "paused" while paused, "polling disabled" with no schedule armed', () => {
  const scheduled = pollIndicator({ poller: { ...meta().poller, nextAttemptAt: at(-55) }, nowMs: NOW });
  assert.equal(scheduled.countdown, 'next poll in 55 s');

  const paused = pollIndicator({ poller: { ...meta().poller, paused: true, nextAttemptAt: null }, nowMs: NOW });
  assert.equal(paused.countdown, 'paused');

  const disabled = pollIndicator({ poller: { ...meta().poller, nextAttemptAt: null, intervalMs: 0 }, nowMs: NOW });
  assert.equal(disabled.countdown, 'polling disabled');
});
