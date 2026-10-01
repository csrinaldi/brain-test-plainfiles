// poller.mjs — the forge poll loop: three lanes bounded by the Q1/D2 budget
// (#881 PR 2). The ONLY caller of any `gh`-backed VCS read verb this server
// makes (D1) — `buildSnapshot` never sees a live port, only the cache this
// module fills through `forge-cache.mjs`'s setters.
//
// Fast lane, every tick: `issueList` + `mrList` — their rows ARE the change
// key (Q1: no ETag, no `updated_at` anywhere in the provider). Review lane,
// every tick, capped at 10 PRs, round-robin beyond the cap (`min(P,10)`).
// Body lane: on the very first tick ever ("cold start"), every open issue,
// uncapped — the page cannot render a graph at all otherwise, and this
// happens exactly once per process. On every later tick the body lane spends
// at most B = 5 calls in three priority buckets: brand-new issue numbers
// (same tick, capped at 20, so a new issue never sits `unreadable`), then
// issues whose fast-lane row changed, then the longest-unrefreshed issues.
// That last bucket runs even when the first two are empty — it is what bounds
// the staleness of body-only facts, which no list-level field can signal
// (design.md Q1/D2 (c)). A brand-new number beyond the cap of 20 is queued,
// not dropped: it has no previous row, so the "changed" test could never see
// it again, and by the end of its own tick it has stopped being new.
//
// The body lane's TOTAL per tick is bounded at BODY_CAP + NEW_BODY_CAP (25)
// even when every open issue changes in the same tick (a bulk label rename
// is one ordinary GitHub action, not an adversarial input). `changed` rows
// that do not fit this tick's budget are never dropped — they stay in a
// FIFO pending set and drain on the following ticks, oldest-changed-first,
// until every one of them has had its body refreshed at least once (see
// `pendingBodyRefresh` below; judgment:cold-4).
//
// A poll failure NEVER empties a section it once filled (R881-9): the fast
// lane's own failure aborts the whole tick before any cache setter runs, so
// every previously-cached section keeps its last known value; per-item
// review/body failures are caught individually and simply skip that one
// item's cache write.

const REVIEW_CAP = 10;
const BODY_CAP = 5;
const NEW_BODY_CAP = 20;
const ONCE_COLLAPSE_MS = 5000;

function rowsEqual(a, b) {
  return a.title === b.title
    && JSON.stringify(a.labels ?? []) === JSON.stringify(b.labels ?? [])
    && JSON.stringify(a.assignees ?? []) === JSON.stringify(b.assignees ?? []);
}

/**
 * createPoller() — the three lanes, pause/resume/once (D2, D7, #881 PR 2).
 *
 * @param {{
 *   vcs: {issueList: Function, mrList: Function, issueView: Function, prReviews: Function},
 *   cache: {setIssueList: Function, setMrList: Function, setIssueView: Function, setPrReviews: Function},
 *   project?: string|null,
 *   interval?: number, enabled?: boolean,
 *   _setTimeout?: Function, _clearTimeout?: Function, _now?: () => Date,
 *   onTick?: (state: object) => void,
 *   initialError?: string|null,
 * }} opts
 */
export function createPoller({
  vcs,
  cache,
  project = null,
  interval = 60000,
  enabled = true,
  _setTimeout = setTimeout,
  _clearTimeout = clearTimeout,
  _now = () => new Date(),
  onTick = () => {},
  initialError = null,
} = {}) {
  // `initialError` (#881, judgment:cold-6): the CALLER already knows, before
  // any tick, that `vcs` cannot be polled (forge resolution failed) —
  // forcing `paused` regardless of `enabled` means `start()` is a no-op and
  // no tick ever runs against a port that would only throw. The reason and
  // a time are visible on `state()` immediately, the same shape a real
  // failed tick would leave, so a caller reading `/api/poll/pause`'s
  // response cannot tell the two apart.
  let paused = !enabled || Boolean(initialError);
  let timer = null;
  let inFlight = null;
  let lastOnceAt = -Infinity;
  let previousIssues = null; // Map<number, row> | null — null means "no tick has completed yet"
  const lastBodyRefreshTick = new Map();
  const pendingBodyRefresh = new Set(); // numbers whose fast-lane row changed but have not yet had a body refresh — drains FIFO (judgment:cold-4)
  let tickCount = 0;
  let reviewOffset = 0;

  let lastPolledAt = initialError ? _now().toISOString() : null;
  let lastOkAt = null;
  let lastError = initialError;
  let forgeAsOf = { issues: null, bodies: null, reviews: null };
  // #998 R998-6: the status bar's countdown. Armed by `scheduleNext()` from
  // the SAME injected `_now()` this whole module already uses, never the
  // wall clock (D9: no clock in `lib/`, the caller passes it). A manual
  // `once()` clears any pending timer first, then re-arms the countdown
  // anyway: `runTick()`'s own `.finally()` calls `scheduleNext()` on every
  // completed tick, scheduled or manual alike — cold review of #1008/PR6
  // measured this after an earlier revision of this comment claimed the
  // opposite.
  let nextAttemptAt = null;

  function state() {
    return { paused, lastPolledAt, lastOkAt, lastError, forgeAsOf: { ...forgeAsOf }, intervalMs: interval, nextAttemptAt };
  }

  function pickReviewTargets(prNumbers) {
    if (prNumbers.length <= REVIEW_CAP) return prNumbers;
    const picked = [];
    for (let i = 0; i < REVIEW_CAP; i++) picked.push(prNumbers[(reviewOffset + i) % prNumbers.length]);
    reviewOffset = (reviewOffset + REVIEW_CAP) % prNumbers.length;
    return picked;
  }

  function pickBodyTargets(issueRows) {
    const numbers = issueRows.map((r) => r.number);
    if (previousIssues === null) return numbers; // cold start: every open issue, uncapped

    const numberSet = new Set(numbers);
    for (const n of pendingBodyRefresh) if (!numberSet.has(n)) pendingBodyRefresh.delete(n); // closed issues cannot be refreshed

    // (a) brand-new numbers, ascending, capped at NEW_BODY_CAP. The overflow
    // of a bulk import is QUEUED, never dropped (judgment:cold-1, tracker PR
    // #970): an overflow number has `prev === undefined`, so the `changed`
    // loop below can never queue it, and by the end of this tick it is
    // recorded in `previousIssues` and stops being new — without this queue
    // its body would never be fetched at all and its node would render
    // `UNREADABLE` forever. It is deliberately NOT spent this tick: (a)'s cap
    // is NEW_BODY_CAP, so the overflow drains on the ticks that follow.
    const allNew = numbers.filter((n) => !previousIssues.has(n)).sort((a, b) => a - b);
    const newNumbers = allNew.slice(0, NEW_BODY_CAP);
    const newSet = new Set(newNumbers);
    const deferred = new Set(allNew.slice(NEW_BODY_CAP));
    for (const n of deferred) pendingBodyRefresh.add(n); // insertion order = FIFO drain order

    // (b) numbers whose fast-lane row moved.
    for (const n of numbers) {
      if (newSet.has(n) || deferred.has(n)) continue;
      const prev = previousIssues.get(n);
      const row = issueRows.find((r) => r.number === n);
      if (prev !== undefined && !rowsEqual(prev, row)) pendingBodyRefresh.add(n);
    }

    // The tick's total is bounded at BODY_CAP + NEW_BODY_CAP even when every
    // open issue changed at once — `changed` on its own has no cap, unlike
    // `newNumbers` above. Anything in `pendingBodyRefresh` that does not fit
    // this tick's slice stays there and is picked up, oldest-first, on a
    // later tick (see the `.delete()` in `tick()` below, which only fires on
    // an actual successful fetch).
    const cap = BODY_CAP + NEW_BODY_CAP;
    const changed = [...pendingBodyRefresh]
      .filter((n) => !newSet.has(n) && !deferred.has(n))
      .slice(0, Math.max(cap - newNumbers.length, 0));

    // (c) the least-recently-refreshed catch-up. There is no early return
    // above it: when nothing is new and nothing is pending this bucket is the
    // ONLY thing the body lane does, and foreclosing it is what made the
    // overflow of (a) unreachable forever. A number that has never been
    // fetched has refresh tick -1 and therefore wins this ordering outright.
    const changedSet = new Set(changed);
    const remaining = Math.max(BODY_CAP - newNumbers.length - changed.length, 0);
    const rest = numbers
      .filter((n) => !newSet.has(n) && !changedSet.has(n) && !pendingBodyRefresh.has(n))
      .sort((a, b) => (lastBodyRefreshTick.get(a) ?? -1) - (lastBodyRefreshTick.get(b) ?? -1))
      .slice(0, remaining);
    return [...newNumbers, ...changed, ...rest];
  }

  async function tick() {
    tickCount += 1;
    const attemptAt = _now();
    try {
      const [issueRows, mrRows] = await Promise.all([
        vcs.issueList({ project, state: 'open' }),
        vcs.mrList({ project, state: 'open' }),
      ]);
      cache.setIssueList(issueRows);
      cache.setMrList(mrRows);
      forgeAsOf = { ...forgeAsOf, issues: attemptAt.toISOString() };

      const prNumbers = mrRows.map((p) => p.number);
      // No cold-start exception here (unlike the body lane below): the
      // header comment promises "every tick, capped at 10 PRs" with no
      // carve-out, and `pickReviewTargets` already returns every PR
      // untouched when `prNumbers.length <= REVIEW_CAP`, so a small forge
      // still gets every PR reviewed on the first tick — only a forge with
      // more than REVIEW_CAP open PRs is actually capped, cold or not.
      const reviewTargets = pickReviewTargets(prNumbers);
      await Promise.all(reviewTargets.map(async (number) => {
        try { cache.setPrReviews(number, await vcs.prReviews({ project, number })); } catch { /* previous value stays cached (R881-9) */ }
      }));
      if (reviewTargets.length > 0) forgeAsOf = { ...forgeAsOf, reviews: attemptAt.toISOString() };

      const bodyTargets = pickBodyTargets(issueRows);
      await Promise.all(bodyTargets.map(async (number) => {
        try {
          cache.setIssueView(number, await vcs.issueView({ project, number }));
          lastBodyRefreshTick.set(number, tickCount);
          pendingBodyRefresh.delete(number); // drained — a failed fetch stays pending and is retried next tick
        } catch { /* previous value stays cached (R881-9) */ }
      }));
      if (bodyTargets.length > 0) forgeAsOf = { ...forgeAsOf, bodies: attemptAt.toISOString() };

      previousIssues = new Map(issueRows.map((r) => [r.number, r]));
      lastOkAt = attemptAt.toISOString();
      lastError = null;
    } catch (err) {
      // The fast lane itself failed: nothing this tick is trustworthy, so no
      // cache setter ran above and every previously-cached section is
      // untouched (R881-9).
      lastError = err?.message ?? String(err);
    } finally {
      lastPolledAt = attemptAt.toISOString();
    }
  }

  let closed = false;

  function scheduleNext() {
    // `closed` matters here, not just in `close()` itself: a tick already
    // in flight when `close()` runs keeps resolving in the background, and
    // its own `.finally()` calls `scheduleNext()` — without this guard that
    // would arm a brand-new real timer AFTER the server believes it has shut
    // down, leaking a handle that keeps the process alive (measured: a
    // `node --test` run that passes every assertion but never exits).
    if (closed || paused || interval <= 0) { nextAttemptAt = null; return; }
    nextAttemptAt = new Date(_now().getTime() + interval).toISOString();
    timer = _setTimeout(runTick, interval);
  }

  function runTick() {
    timer = null;
    inFlight = tick().finally(() => {
      inFlight = null;
      onTick(state());
      scheduleNext();
    });
    return inFlight;
  }

  return {
    start() { return paused ? undefined : runTick(); },
    // The countdown goes with the timer, as it does in `pause()`: after
    // `close()` no tick will ever fire, so a surviving `nextAttemptAt` would
    // report a poll that is never coming (#1015 cold review).
    close() { closed = true; if (timer) { _clearTimeout(timer); timer = null; } nextAttemptAt = null; },
    pause() {
      paused = true;
      if (timer) { _clearTimeout(timer); timer = null; }
      nextAttemptAt = null;
      return state();
    },
    resume() {
      // Resuming re-arms the regular interval; it does not itself poll —
      // that is what `once()` ("poll now") is for (R881-4 S2 treats the two
      // as distinct controls). `start()` polls immediately because a
      // process that has NEVER polled needs data as soon as possible; a
      // paused-then-resumed poller already has whatever it last held.
      if (paused) { paused = false; scheduleNext(); }
      return state();
    },
    async once() {
      if (inFlight) return inFlight.then(state);
      const nowMs = _now().getTime();
      if (nowMs - lastOnceAt < ONCE_COLLAPSE_MS) return state();
      lastOnceAt = nowMs;
      if (timer) { _clearTimeout(timer); timer = null; }
      await runTick();
      return state();
    },
    state,
  };
}
