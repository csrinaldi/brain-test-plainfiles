import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createForgeCache } from './forge-cache.mjs';
import { createPoller } from './poller.mjs';

// ── test doubles ─────────────────────────────────────────────────────────

function makeVcs({ callLog, issues = [{ number: 1, title: 't', labels: [], assignees: [] }], prs = [] }) {
  return {
    issueList: async () => { callLog.push('issueList'); return issues.map((i) => ({ ...i })); },
    mrList: async () => { callLog.push('mrList'); return prs.map((p) => ({ ...p })); },
    issueView: async ({ number }) => { callLog.push(`issueView:${number}`); return { number, body: 'b' }; },
    prReviews: async ({ number }) => { callLog.push(`prReviews:${number}`); return []; },
  };
}

/** Every write verb throws — the same proof `snapshot.test.mjs`'s `readOnlyPort()` gives buildSnapshot, applied here to the poller. */
function readOnlyWriteVerbs(reads) {
  const port = {};
  for (const w of ['mrCreate', 'mrAutoMerge', 'issueCreate', 'issueUpdate', 'prReviewComment', 'issueComment', 'labelAdd', 'labelRemove', 'branchProtect']) {
    port[w] = async () => { throw new Error(`write verb ${w} called by the poller`); };
  }
  return Object.assign(port, reads);
}

/** A controllable `setTimeout`/`clearTimeout` pair with exactly one pending timer at a time. */
function fakeScheduler() {
  let seq = 0;
  const timers = new Map();
  return {
    setTimeout: (fn) => { const id = ++seq; timers.set(id, fn); return id; },
    clearTimeout: (id) => { timers.delete(id); },
    pending: () => timers.size,
    runNext: () => {
      const id = [...timers.keys()][0];
      const fn = timers.get(id);
      timers.delete(id);
      return fn();
    },
  };
}

// ── R881-4 S1: an unchanged issue never costs a poll of its own ───────────
//
// The claim ruling 2 actually bought is that the body lane's cost does not
// scale with the number of open issues: N unchanged issues do NOT produce N
// `issueView` calls. It is not "zero calls" — the least-recently-refreshed
// catch-up (design.md Q1/D2 (c)) still spends its B = 5 share, because a body
// edit that moves no list-level field is invisible to the fast lane and would
// otherwise never be re-read at all. N = 60 here precisely so a bounded tick
// and an unconditional re-fetch cannot be confused for one another.

test('#881: R881-4 S1 — N unchanged issues cost at most B calls on the next poll, not N', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  const callLog = [];
  const BODY_CAP = 5;
  const ISSUE_COUNT = 60;
  const issues = Array.from({ length: ISSUE_COUNT }, (_, i) => ({ number: i + 1, title: `t${i + 1}`, labels: [], assignees: [] }));
  const vcs = makeVcs({ callLog, issues });
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  await poller.start(); // cold start — every issue's body is fetched once
  assert.equal(callLog.filter((c) => c.startsWith('issueView:')).length, ISSUE_COUNT);

  callLog.length = 0;
  now.t += 60000;
  await scheduler.runNext(); // nothing in issueList changed
  const spent = callLog.filter((c) => c.startsWith('issueView:'));
  assert.equal(spent.length, BODY_CAP, 'the second poll re-reads only the B least-recently-refreshed bodies, never one call per unchanged issue');
  poller.close();
});

// ── R881-4 S2: disable, manual poll, and the /once collapse ────────────────

test('#881: R881-4 S2 — disabling stops the timer; "poll now" still triggers exactly one poll; two /once calls inside 5s collapse', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  const callLog = [];
  const vcs = makeVcs({ callLog });
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  await poller.start(); // cold start
  assert.equal(scheduler.pending(), 1, 'the regular interval is scheduled after a successful tick');

  const pausedState = poller.pause();
  assert.equal(pausedState.paused, true);
  assert.equal(scheduler.pending(), 0, 'pausing clears the scheduled tick — the timer stops firing');

  now.t += 10000;
  await poller.once(); // "poll now" still works while paused
  assert.equal(callLog.filter((c) => c === 'issueList').length, 2, 'cold start + exactly one manual poll');

  now.t += 1000; // inside the 5s collapse window
  const before = callLog.length;
  await poller.once();
  assert.equal(callLog.length, before, 'a second /once inside 5s collapses into the first result — no new call');

  now.t += 6000; // past the collapse window
  await poller.once();
  assert.equal(callLog.filter((c) => c === 'issueList').length, 3, 'past the collapse window, /once polls again');

  poller.close();
});

// ── R881-4 S3: last-polled state is visible ─────────────────────────────────

test('#881: R881-4 S3 — last-polled state is visible after success and after failure', async () => {
  const now = { t: 0 };
  let fail = false;
  const vcs = {
    issueList: async () => { if (fail) throw new Error('gh: rate limited'); return []; },
    mrList: async () => { if (fail) throw new Error('gh: rate limited'); return []; },
    issueView: async () => ({}),
    prReviews: async () => [],
  };
  const poller = createPoller({ vcs, cache: createForgeCache(), project: 'o/r', _now: () => new Date(now.t) });

  await poller.once();
  let s = poller.state();
  assert.equal(s.paused, false);
  assert.equal(s.lastPolledAt, new Date(now.t).toISOString());
  assert.equal(s.lastOkAt, new Date(now.t).toISOString());
  assert.equal(s.lastError, null);

  fail = true;
  now.t += 60000;
  await poller.once();
  s = poller.state();
  assert.equal(s.lastPolledAt, new Date(now.t).toISOString(), 'lastPolledAt updates on every attempt, success or failure');
  assert.equal(s.lastOkAt, new Date(now.t - 60000).toISOString(), 'lastOkAt only moves on a successful poll');
  assert.match(s.lastError, /gh: rate limited/);
  poller.close();
});

// ── R881-9 S2 / D2: a failed poll never empties a filled section ───────────

test('#881: R881-9 S2 — a failed poll keeps the previous cache and sets lastError with a time', async () => {
  const now = { t: 0 };
  let fail = false;
  const issues = [{ number: 1, title: 't1', labels: [], assignees: [] }];
  const vcs = {
    issueList: async () => { if (fail) throw new Error('gh: 502'); return issues; },
    mrList: async () => { if (fail) throw new Error('gh: 502'); return []; },
    issueView: async ({ number }) => ({ number, body: 'b' }),
    prReviews: async () => [],
  };
  const cache = createForgeCache();
  const poller = createPoller({ vcs, cache, project: 'o/r', _now: () => new Date(now.t) });

  await poller.once();
  assert.deepEqual(await cache.port.issueList(), issues);

  fail = true;
  now.t += 60000;
  await poller.once();
  assert.match(poller.state().lastError, /gh: 502/);
  assert.deepEqual(await cache.port.issueList(), issues, 'the cache still serves the last successful poll — nothing was emptied');
  poller.close();
});

// ── #881 judgment:cold-6: an `initialError` starts the poller paused, in band ──
//
// The real CLI entry never resolved a live forge port (server.mjs:394-397's
// own comment claimed this was deliberate) — `deps.forgeSource` was always
// `undefined`, so the poller's four verbs always threw
// "no forge port was supplied to the poller" and `prs`/`reviews`/issue
// bodies never left `{ok:false}` outside a test. `main()` now resolves a
// real port and, on failure, constructs the poller with `initialError` so
// the reason is visible on `state()` before any tick, and `start()` is a
// no-op — no tick ever runs against a port that would only throw.

test('#881: judgment:cold-6 — createPoller({ initialError }) starts paused with lastError and lastPolledAt set, no tick runs even via start()', () => {
  const now = { t: 1726272000000 };
  const callLog = [];
  const vcs = makeVcs({ callLog });
  const scheduler = fakeScheduler();
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', _now: () => new Date(now.t),
    initialError: 'no VCS token',
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout,
  });

  const state = poller.state();
  assert.equal(state.paused, true);
  assert.match(state.lastError, /no VCS token/);
  assert.equal(state.lastPolledAt, new Date(now.t).toISOString(), 'the reason carries a time, the same shape a real failed tick would leave');
  assert.equal(state.lastOkAt, null);

  poller.start(); // paused: a no-op, exactly like `enabled: false`
  assert.equal(scheduler.pending(), 0, 'no timer was armed');
  assert.deepEqual(callLog, [], 'the port was never called — an initial resolution error means no tick, ever, until a manual resume');
  poller.close();
});

// ── A5: the poller only ever calls the four read verbs ─────────────────────

test('#881: A5 — composed with a write-throwing port, a full tick completes with no write verb invoked', async () => {
  const callLog = [];
  const vcs = readOnlyWriteVerbs(makeVcs({
    callLog,
    issues: [{ number: 1, title: 't', labels: [], assignees: [] }],
    prs: [{ number: 9, title: 'p', headBranch: 'x' }],
  }));
  const poller = createPoller({ vcs, cache: createForgeCache(), project: 'o/r' });
  const s = await poller.once();
  assert.equal(s.lastError, null);
  assert.deepEqual(callLog.sort(), ['issueList', 'issueView:1', 'mrList', 'prReviews:9'].sort());
  poller.close();
});

// ── hardening: close() during an in-flight tick must leave no timer, and must
// FAIL, not HANG, if that guarantee ever regresses ──────────────────────────
//
// Mutation-testing the fix in c2352550 found a gap: removing `closed = true`
// from `close()` did not turn any existing test red — it made `node --test`
// HANG instead, because those tests use the REAL setTimeout/clearTimeout, so
// the leaked scheduleNext() after close() arms a real, uncleared timer that
// keeps the process alive. A CI job with no per-test timeout would sit there,
// not report a failure. This test uses the injected fake scheduler so the
// same regression turns into a fast, deterministic assertion failure instead.

test('#881: poller.close() during an in-flight tick leaves no timer scheduled once that tick settles — fails fast, never hangs', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  let resolveIssueList;
  const gate = new Promise((resolve) => { resolveIssueList = resolve; });
  const vcs = {
    issueList: async () => { await gate; return []; },
    mrList: async () => [],
    issueView: async () => ({}),
    prReviews: async () => [],
  };
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  const inFlight = poller.start(); // begins tick(), which awaits `gate` — still in flight
  poller.close(); // close() while that tick has not settled yet
  resolveIssueList();
  await inFlight; // let the in-flight tick's .finally() (which calls scheduleNext()) run to completion

  assert.equal(scheduler.pending(), 0, 'no timer remains scheduled once the in-flight tick settles after close()');
});

// ── #998 R998-6: state() carries intervalMs and nextAttemptAt ──────────────

test('#998 R998-6: state() carries intervalMs and a nextAttemptAt armed to now + interval right after a successful tick; paused clears it', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 1726272000000 };
  const vcs = makeVcs({ callLog: [] });
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  await poller.start();
  let s = poller.state();
  assert.equal(s.intervalMs, 60000);
  assert.equal(s.nextAttemptAt, new Date(now.t + 60000).toISOString(), 'armed from the injected clock, never Date.now()');

  poller.pause();
  s = poller.state();
  assert.equal(s.nextAttemptAt, null, 'a paused poller has nothing scheduled');
  assert.equal(s.intervalMs, 60000, 'intervalMs itself is a static fact, unaffected by pause');

  poller.resume();
  s = poller.state();
  assert.equal(s.nextAttemptAt, new Date(now.t + 60000).toISOString(), 'resuming re-arms the countdown from the same clock');

  poller.close();
});

test('#998 R998-6: createPoller({initialError}) starts with nextAttemptAt null — nothing is scheduled before the first resume', () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  const vcs = makeVcs({ callLog: [] });
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000, initialError: 'no VCS token',
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });
  assert.equal(poller.state().nextAttemptAt, null);
  poller.close();
});

// ── cold review of #1008/PR6: once() DOES re-arm the countdown ─────────────
//
// The comment above `nextAttemptAt`'s declaration used to claim a manual
// once() "does not itself re-arm the interval" — false, measured here:
// once()'s own runTick() calls scheduleNext() in its .finally() on every
// completed tick, the same path a regular scheduled tick already takes.

test('#998 R998-6: a manual once() re-arms nextAttemptAt from the moment the tick settles, not the moment it was called', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 5000 };
  const vcs = makeVcs({ callLog: [] });
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  await poller.once();
  assert.equal(poller.state().nextAttemptAt, new Date(65000).toISOString(), 'once() at t=5000 with a 60000ms interval re-arms to 65000');
  poller.close();
});

// ── judgment:cold-1: the review lane is capped on the cold-start tick too ──
//
// The header comment (poller.mjs:6-8) promises "every tick, capped at 10
// PRs, round-robin beyond the cap" for the review lane, with no cold-start
// exception — unlike the body lane, which IS documented uncapped on cold
// start (poller.mjs:9-11). The steady-tick budget test above uses
// PR_COUNT=3, under REVIEW_CAP, so it cannot tell a capped cold tick from an
// uncapped one. This test uses 50 open PRs specifically to distinguish them.

test('#881: judgment:cold-1 — the review lane is capped at REVIEW_CAP on the very first (cold-start) tick, round-robin catches every PR within 5 ticks', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  const callLog = [];
  const PR_COUNT = 50;
  const REVIEW_CAP = 10;
  const prs = Array.from({ length: PR_COUNT }, (_, i) => ({ number: 2000 + i, title: `pr ${i}`, headBranch: `feat/x-${i}` }));
  const vcs = {
    issueList: async () => { callLog.push('issueList'); return []; },
    mrList: async () => { callLog.push('mrList'); return prs.map((p) => ({ ...p })); },
    issueView: async ({ number }) => { callLog.push(`issueView:${number}`); return { number, body: 'b' }; },
    prReviews: async ({ number }) => { callLog.push(`prReviews:${number}`); return []; },
  };
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  await poller.start(); // tick 1 — cold start (previousIssues === null)
  const seen = new Set();
  let reviewedThisTick = 0;
  for (const c of callLog) {
    if (c.startsWith('prReviews:')) { reviewedThisTick += 1; seen.add(Number(c.split(':')[1])); }
  }
  assert.equal(reviewedThisTick, Math.min(PR_COUNT, REVIEW_CAP), 'the cold-start tick reviews min(P,10) PRs, not all 50');

  for (let i = 0; i < 4; i++) {
    now.t += 60000;
    await scheduler.runNext();
    for (const c of callLog) if (c.startsWith('prReviews:')) seen.add(Number(c.split(':')[1]));
  }
  assert.equal(seen.size, PR_COUNT, 'round-robin across 5 consecutive ticks (cold + 4 steady) reads every one of the 50 PRs at least once');

  poller.close();
});

// ── judgment:cold-4: the body lane is bounded even when every issue changes ─
//
// `pickBodyTargets()` (poller.mjs) never capped `changed` — only
// `newNumbers` was capped at NEW_BODY_CAP=20. A tick where every one of 90
// open issues' labels move at once (a bulk label rename, one ordinary
// GitHub action) made `issueView` uncapped: 90 calls in one tick, over 2x
// the corrected worst-bounded-case budget (design.md Q1/D2, `2 + 10 + 25 =
// 37` calls/tick after this fix). The fix bounds the tick's total at
// BODY_CAP + NEW_BODY_CAP = 25; anything that does not fit stays pending and
// drains FIFO on later ticks.

test('#881: judgment:cold-4 — the body lane is bounded to BODY_CAP + NEW_BODY_CAP per tick even when every issue changes at once; the rest drains FIFO', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  const callLog = [];
  const ISSUE_COUNT = 90;
  const BOUND = 25; // BODY_CAP (5) + NEW_BODY_CAP (20)
  let allLabelsMoved = false;
  const baseIssues = Array.from({ length: ISSUE_COUNT }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}`, labels: [], assignees: [] }));
  const vcs = {
    issueList: async () => {
      callLog.push('issueList');
      return baseIssues.map((r) => (allLabelsMoved ? { ...r, labels: ['status:approved'] } : { ...r }));
    },
    mrList: async () => { callLog.push('mrList'); return []; },
    issueView: async ({ number }) => { callLog.push(`issueView:${number}`); return { number, body: 'b' }; },
    prReviews: async () => [],
  };
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  await poller.start(); // tick 1 — cold start, steady: every issue's body is fetched once, no fast-lane change recorded yet
  callLog.length = 0;

  allLabelsMoved = true;
  now.t += 60000;
  await scheduler.runNext(); // tick 2 — every one of the 90 issues' labels move at once
  const tick2Calls = callLog.filter((c) => c.startsWith('issueView:')).length;
  assert.ok(tick2Calls <= BOUND, `tick 2 spent ${tick2Calls} issueView calls, over the ${BOUND} bound`);
  assert.equal(tick2Calls, BOUND, 'the tick is saturated: 90 changed issues against a 25-call bound spends the whole budget');

  const seen = new Set();
  for (const c of callLog) if (c.startsWith('issueView:')) seen.add(Number(c.split(':')[1]));

  const totalTicksNeeded = Math.ceil(ISSUE_COUNT / BOUND); // tick 2 is the first of these
  for (let i = 1; i < totalTicksNeeded; i++) {
    now.t += 60000;
    await scheduler.runNext();
    for (const c of callLog) if (c.startsWith('issueView:')) seen.add(Number(c.split(':')[1]));
  }
  assert.equal(seen.size, ISSUE_COUNT, `every one of the ${ISSUE_COUNT} changed issues is refreshed within ${totalTicksNeeded} ticks of the mass change`);

  poller.close();
});

// ── Q1/D2: the call-count budget over 30 simulated ticks ───────────────────

test('#881: Q1/D2 — 30 simulated ticks hold the budget: cold start once, then 2 + min(P,10) + B per steady tick', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  const callLog = [];
  const ISSUE_COUNT = 90;
  const PR_COUNT = 3;
  let tick = 0;
  const baseIssues = Array.from({ length: ISSUE_COUNT }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}`, labels: [], assignees: [] }));
  const prs = Array.from({ length: PR_COUNT }, (_, i) => ({ number: 1000 + i, title: `pr ${i}`, headBranch: `feat/x-${i}` }));
  const vcs = {
    issueList: async () => {
      callLog.push('issueList');
      tick += 1;
      const rows = baseIssues.map((r) => ({ ...r }));
      if (tick > 1) {
        // exactly one issue's label moves per steady tick, rotating through the set
        const idx = (tick - 2) % ISSUE_COUNT;
        rows[idx] = { ...rows[idx], labels: [`moved-on-tick-${tick}`] };
        baseIssues[idx] = rows[idx];
      }
      return rows;
    },
    mrList: async () => { callLog.push('mrList'); return prs.map((p) => ({ ...p })); },
    issueView: async ({ number }) => { callLog.push(`issueView:${number}`); return { number, body: 'b' }; },
    prReviews: async ({ number }) => { callLog.push(`prReviews:${number}`); return []; },
  };

  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  await poller.start(); // tick 1 — cold start
  assert.equal(callLog.length, 1 /* issueList */ + ISSUE_COUNT + 1 /* mrList */ + PR_COUNT, 'cold start: 1 + I + 1 + P');

  for (let i = 0; i < 29; i++) {
    const before = callLog.length;
    now.t += 60000;
    await scheduler.runNext();
    const spent = callLog.length - before;
    assert.equal(spent, 2 + Math.min(PR_COUNT, 10) + 5, `steady tick ${i + 2}: 2 + min(P,10) + B`);
  }

  poller.close();
});

// ── judgment:cold-1 (tracker PR #970): a bulk import drains, and the ───────
// least-recently-refreshed bucket is never foreclosed
//
// Two halves of one hole in `pickBodyTargets()`:
//
// (1) `newNumbers` was capped at NEW_BODY_CAP=20 and the overflow was simply
//     DROPPED. An issue in the overflow has `prev === undefined`, so the
//     `changed` check could never queue it either; by the end of that same
//     tick it is recorded in `previousIssues` and stops being new. Its body
//     was never fetched and never would be — `forge-cache` misses on it
//     forever and the node renders permanently `status: UNREADABLE`.
//
// (2) The early return fired when nothing was new and nothing was pending,
//     BEFORE the `rest` bucket was computed. design.md:96-100 promises (c) a
//     least-recently-refreshed catch-up "to bound staleness of body-only
//     facts"; the early return foreclosed it, so a body edit that moves no
//     list-level field was invisible until something else happened to move.
//     That is also what left the overflow of (1) unreachable.

test('#881: a bulk import of new issues beyond NEW_BODY_CAP queues the overflow and drains it under the per-tick bound', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  const callLog = [];
  const NEW_BODY_CAP = 20;
  const BODY_CAP = 5;
  const BOUND = BODY_CAP + NEW_BODY_CAP;

  const cold = Array.from({ length: 5 }, (_, i) => ({ number: i + 1, title: `old ${i + 1}`, labels: [], assignees: [] }));
  const imported = Array.from({ length: 30 }, (_, i) => ({ number: 100 + i, title: `imported ${100 + i}`, labels: [], assignees: [] }));
  let issues = cold;
  const vcs = {
    issueList: async () => { callLog.push('issueList'); return issues.map((r) => ({ ...r })); },
    mrList: async () => { callLog.push('mrList'); return []; },
    issueView: async ({ number }) => { callLog.push(`issueView:${number}`); return { number, body: 'b' }; },
    prReviews: async () => [],
  };
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  const bodiesSince = (from) => callLog.slice(from).filter((c) => c.startsWith('issueView:')).map((c) => Number(c.split(':')[1]));

  await poller.start(); // tick 1 — cold start over the 5 pre-existing issues
  assert.deepEqual(bodiesSince(0).sort((a, b) => a - b), [1, 2, 3, 4, 5], 'cold start fetches every open body once');

  issues = [...cold, ...imported]; // the bulk import lands between tick 1 and tick 2
  let mark = callLog.length;
  now.t += 60000;
  await scheduler.runNext(); // tick 2
  const tick2 = bodiesSince(mark);
  assert.ok(tick2.length <= NEW_BODY_CAP, `tick 2 spent ${tick2.length} issueView calls on brand-new issues, over the NEW_BODY_CAP of ${NEW_BODY_CAP}`);

  const seen = new Set(tick2);
  const drainTicks = Math.ceil((imported.length - NEW_BODY_CAP) / BODY_CAP);
  for (let i = 0; i < drainTicks; i++) {
    mark = callLog.length;
    now.t += 60000;
    await scheduler.runNext();
    const spent = bodiesSince(mark);
    assert.ok(spent.length <= BOUND, `a drain tick spent ${spent.length} issueView calls, over the ${BOUND} per-tick bound`);
    for (const n of spent) seen.add(n);
  }

  const neverFetched = imported.map((r) => r.number).filter((n) => !seen.has(n));
  assert.deepEqual(neverFetched, [], `every imported issue must have its body fetched within ${drainTicks} ticks of the import; these never were`);

  poller.close();
});

test('#881: with nothing new and nothing changed, the body lane still refreshes up to BODY_CAP least-recently-refreshed bodies, oldest first', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  const callLog = [];
  const BODY_CAP = 5;
  const ISSUE_COUNT = 12;

  const rows = Array.from({ length: ISSUE_COUNT }, (_, i) => ({ number: i + 1, title: `issue ${i + 1}`, labels: [], assignees: [] }));
  const moveRow = (number) => { const r = rows.find((x) => x.number === number); r.labels = ['moved']; };
  const vcs = {
    issueList: async () => {
      callLog.push('issueList');
      return rows.map((r) => ({ ...r }));
    },
    mrList: async () => { callLog.push('mrList'); return []; },
    issueView: async ({ number }) => { callLog.push(`issueView:${number}`); return { number, body: 'b' }; },
    prReviews: async () => [],
  };
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  const bodiesSince = (from) => callLog.slice(from).filter((c) => c.startsWith('issueView:')).map((c) => Number(c.split(':')[1]));

  await poller.start(); // tick 1 — every body refreshed, so every issue's refresh tick is 1

  for (const n of [1, 2, 3]) moveRow(n); // tick 2 moves three rows, permanently; whatever tick 2 touches is now fresher than the rest
  let mark = callLog.length;
  now.t += 60000;
  await scheduler.runNext();
  const refreshedOnTick2 = new Set(bodiesSince(mark));

  // tick 3 — the list is byte-for-byte what tick 2 already recorded: nothing moved
  mark = callLog.length;
  now.t += 60000;
  await scheduler.runNext();
  const tick3 = bodiesSince(mark);

  assert.equal(tick3.length, BODY_CAP, 'the least-recently-refreshed catch-up (design.md:96-100 (c)) still spends its B=5 share when no row moved');
  const stale = tick3.filter((n) => refreshedOnTick2.has(n));
  assert.deepEqual(stale, [], 'the catch-up takes the oldest refresh ticks first — it must not re-read a body tick 2 just refreshed while older ones wait');

  poller.close();
});

// The (c) bucket alone is NOT enough to save a bulk import's overflow, which
// is why the overflow is queued as well: `rest`'s share is
// `BODY_CAP - new - changed`, so a forge with sustained churn — every tick
// saturating the `changed` bucket — leaves it at zero forever and a
// never-fetched number starves indefinitely, exactly the permanent
// `UNREADABLE` the tracker review found. Queueing the overflow puts it AHEAD
// of that churn in the FIFO instead of behind it.

test('#881: a queued import overflow drains ahead of later churn, even while the changed bucket is saturated every tick', async () => {
  const scheduler = fakeScheduler();
  const now = { t: 0 };
  const callLog = [];
  const NEW_BODY_CAP = 20;
  const BOUND = 25; // BODY_CAP + NEW_BODY_CAP

  const existing = Array.from({ length: 40 }, (_, i) => ({ number: i + 1, title: `old ${i + 1}`, labels: [], assignees: [] }));
  const imported = Array.from({ length: 30 }, (_, i) => ({ number: 100 + i, title: `imported ${100 + i}`, labels: [], assignees: [] }));
  let importLanded = false;
  let churn = 0;
  const vcs = {
    issueList: async () => {
      callLog.push('issueList');
      const rows = existing.map((r) => ({ ...r, labels: churn > 0 ? [`churn-${churn}`] : [] }));
      return importLanded ? [...rows, ...imported.map((r) => ({ ...r }))] : rows;
    },
    mrList: async () => { callLog.push('mrList'); return []; },
    issueView: async ({ number }) => { callLog.push(`issueView:${number}`); return { number, body: 'b' }; },
    prReviews: async () => [],
  };
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  const bodiesSince = (from) => callLog.slice(from).filter((c) => c.startsWith('issueView:')).map((c) => Number(c.split(':')[1]));

  await poller.start(); // tick 1 — cold start over the 40 pre-existing issues

  importLanded = true;
  let mark = callLog.length;
  now.t += 60000;
  await scheduler.runNext(); // tick 2 — 30 arrive at once; 20 are fetched, 10 overflow
  const tick2 = bodiesSince(mark);
  assert.equal(tick2.length, NEW_BODY_CAP, 'tick 2 spends exactly the new-issue cap');
  const overflow = imported.map((r) => r.number).filter((n) => !tick2.includes(n));
  assert.equal(overflow.length, 10, 'ten imported issues did not fit tick 2');

  churn = 1; // from here on every one of the 40 pre-existing rows moves on every tick
  mark = callLog.length;
  now.t += 60000;
  await scheduler.runNext(); // tick 3 — the changed bucket is saturated, so `rest` gets nothing
  const tick3 = bodiesSince(mark);
  assert.ok(tick3.length <= BOUND, `tick 3 spent ${tick3.length} issueView calls, over the ${BOUND} per-tick bound`);
  const starved = overflow.filter((n) => !tick3.includes(n));
  assert.deepEqual(starved, [], 'the queued overflow is drained FIFO ahead of the churn that arrived after it');

  poller.close();
});

test("#1015 cold review: close() clears the countdown — a poll that will never fire must not be reported as pending", async () => {
  const scheduler = fakeScheduler();
  const now = { t: 1726272000000 };
  const vcs = makeVcs({ callLog: [] });
  const poller = createPoller({
    vcs, cache: createForgeCache(), project: 'o/r', interval: 60000,
    _setTimeout: scheduler.setTimeout, _clearTimeout: scheduler.clearTimeout, _now: () => new Date(now.t),
  });

  await poller.start();
  assert.equal(poller.state().nextAttemptAt, new Date(now.t + 60000).toISOString(), 'a settled tick arms the next attempt from the injected clock');
  poller.close();
  assert.equal(poller.state().nextAttemptAt, null, 'after close() no tick will ever fire, so the countdown says nothing rather than a stale future time');
  assert.equal(scheduler.pending(), 0, 'and the timer it was counting down to is gone');
});
