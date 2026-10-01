// banners.mjs — degradation, said (#881 PR 4 / B2, R881-9, D2). Pure,
// imported by the browser AND by node:test (D9): no clock (the caller passes
// `nowMs`), no DOM, no fetch.
//
// The two banner texts are the ones design.md names verbatim — the watcher
// band (D2, "when the watcher fails") and the poll-failure band (D2, "the
// poller"). They live HERE, not inside `app.js`'s template strings, for the
// reason tasks.md's T3a wanted a scan in the first place: a string a test can
// only grep for is a string no test can prove is ever shown. Asserted by
// value here; `degradation-banner.test.mjs` then asserts `app.js` really
// wires these builders to the `{ok:false}` branches.
//
// Nothing here ever hides a failure, and nothing here ever hides DATA either:
// a band is added beside the values already on screen, never instead of them
// (`evidence-reader-empty-on-failure.md`).

/** D2: the watcher died, polling continues — the page must not assert a freshness it does not have. */
export function watcherBanner(reason) {
  return `the watcher failed: ${reason} — the canvas updates on the forge poll only; press Refresh for repo changes.`;
}

/**
 * D2 + R881-9 S2: the previous forge values stay on screen, with the age of
 * the data AND the time of the attempt that failed — "as of" alone would
 * leave an operator unable to tell a poll that failed once from one that has
 * been failing for an hour.
 */
export function pollBanner({ lastOkAt, lastPolledAt, lastError }) {
  const asOf = lastOkAt ?? 'never — no poll has completed';
  const attempted = lastPolledAt ? ` (attempted ${lastPolledAt})` : '';
  return `forge as of ${asOf} — last poll failed: ${lastError}${attempted}`;
}

/**
 * R881-4: a poll control's own POST failed. The stream is untouched and the
 * values on screen are current — only the button did not take, so this is
 * said as its own fact rather than as "the live stream dropped".
 */
export function controlBanner({ action, reason }) {
  return `the "${action}" poll control failed: ${reason} — polling is unchanged and the page is still live.`;
}

/**
 * R881-9 S1: every section the snapshot could not compute, named with its
 * reason — including the ones no view on this page renders. A section that
 * fails silently is exactly the shape this repo has already paid for.
 */
export function failedSections(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return [];
  return Object.entries(snapshot)
    .filter(([, section]) => section && typeof section === 'object' && section.ok === false)
    .map(([name, section]) => ({ name, reason: section.reason }));
}

/**
 * degradationBands({stream, meta, snapshot}) -> [{id, text, detail?}], in the
 * order the page shows them: the transport first (it explains why everything
 * else may be stale), then the controls, the watcher, the poller, the sections.
 */
export function degradationBands({ stream, controls, meta, snapshot }) {
  const bands = [];
  if (stream && stream.ok === false) bands.push({ id: 'stream', text: stream.reason });
  if (controls && controls.ok === false) bands.push({ id: 'controls', text: controlBanner(controls) });
  if (meta?.watcher && meta.watcher.ok === false) {
    bands.push({
      id: 'watcher',
      text: watcherBanner(meta.watcher.reason),
      detail: (meta.watcher.failed ?? []).map((f) => `${f.path}: ${f.reason}`),
    });
  }
  if (meta?.poller?.lastError) bands.push({ id: 'poller', text: pollBanner(meta.poller) });
  const failed = failedSections(snapshot);
  if (failed.length > 0) {
    bands.push({
      id: 'sections',
      text: `${failed.length} snapshot section(s) could not be computed; the rest of the page is still drawn from what was read`,
      detail: failed.map((f) => `${f.name}: ${f.reason}`),
    });
  }
  return bands;
}

/** "5 s ago" / "3 min ago" / "2 h ago" — the same wording at every scale, no library. */
function ago(ms) {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return `${Math.round(seconds / 3600)} h ago`;
}

/**
 * The countdown text (#998 R998-6): "next poll in N s" while a tick is
 * armed, "paused" while paused (checked first — a paused poller may still
 * carry a stale `nextAttemptAt` from before it paused), "polling disabled"
 * when nothing is scheduled at all. Reads only the `now` this caller already
 * threads through every other clock read on this page — never the wall
 * clock itself (D9: no clock in `lib/`).
 */
function pollCountdown({ poller, now }) {
  if (poller.paused) return 'paused';
  if (!poller.nextAttemptAt) return 'polling disabled';
  const seconds = Math.max(0, Math.round((Date.parse(poller.nextAttemptAt) - now) / 1000));
  return `next poll in ${seconds} s`;
}

/**
 * The maintainer's ruling, rendered: a visible "forge polled N s ago /
 * paused" indicator beside the two controls, plus the countdown to the next
 * attempt (#998 R998-6). `paused` is returned separately so the page can
 * mark the indicator itself, not only the button; `countdown` is additive —
 * `text` stays exactly what it already was, never a second projection of it.
 */
export function pollIndicator({ poller, nowMs }) {
  if (!poller) return { text: 'the poll state is unknown until the stream connects', paused: false, countdown: 'polling disabled' };
  const when = poller.lastOkAt ? `forge polled ${ago(nowMs - Date.parse(poller.lastOkAt))}` : 'the forge has not been polled yet';
  return {
    text: poller.paused ? `polling is paused — ${when}` : when,
    paused: Boolean(poller.paused),
    countdown: pollCountdown({ poller, now: nowMs }),
  };
}
