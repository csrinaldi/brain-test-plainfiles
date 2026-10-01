// stage-timeout.test.mjs — #682 slice 3, F.9.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STAGE_TIMEOUT_MS } from '../../axes/platform/adapters/claude.mjs';
import {
  TIMEOUT_IN_FORCE_TODAY,
  MIN_STAGE_TIMEOUT_MS,
  resolveStageTimeout,
  formatDuration,
} from './stage-timeout.mjs';

test('an absent key keeps the shipped ceiling — the default does not move', () => {
  // Raising it for everyone on one data point would be the same guess in the
  // other direction. A short ceiling fails loudly; a long one hangs quietly.
  assert.equal(resolveStageTimeout({}).timeoutMs, TIMEOUT_IN_FORCE_TODAY);
  assert.equal(resolveStageTimeout(null).timeoutMs, TIMEOUT_IN_FORCE_TODAY);
  assert.equal(resolveStageTimeout({ reviewer: {} }).timeoutMs, TIMEOUT_IN_FORCE_TODAY);
});

test('a configured value is honoured', () => {
  assert.equal(resolveStageTimeout({ reviewer: { stageTimeoutMs: 2_400_000 } }).timeoutMs, 2_400_000);
});

test('a non-integer REFUSES rather than defaulting', () => {
  // The operator asked for something; running the shipped ceiling instead would
  // die at a limit they thought they had raised.
  for (const bad of ['40m', 12.5, true, {}, []]) {
    assert.throws(
      () => resolveStageTimeout({ reviewer: { stageTimeoutMs: bad } }),
      /must be a whole number of milliseconds/,
      `${JSON.stringify(bad)} should refuse`,
    );
  }
});

test('a value below the floor refuses, and says why', () => {
  assert.throws(
    () => resolveStageTimeout({ reviewer: { stageTimeoutMs: 5_000 } }),
    /below the .* floor/,
  );
});

test('the floor itself is allowed — the boundary is not the error', () => {
  assert.equal(
    resolveStageTimeout({ reviewer: { stageTimeoutMs: MIN_STAGE_TIMEOUT_MS } }).timeoutMs,
    MIN_STAGE_TIMEOUT_MS,
  );
});

test('the refusal names the key an operator would edit', () => {
  assert.throws(
    () => resolveStageTimeout({ reviewer: { stageTimeoutMs: 'mucho' } }),
    /reviewer\.stageTimeoutMs/,
  );
});

// ── formatDuration: the messages an operator acts on ──────────────────────

test('formatDuration reads as a human duration at every scale', () => {
  assert.equal(formatDuration(450), '450ms');
  assert.equal(formatDuration(4_793), '4.8s');          // the operator's own probe
  assert.equal(formatDuration(600_000), '10m');         // the ceiling that was hit
  assert.equal(formatDuration(754_000), '12m 34s');
});

test('formatDuration never renders a number it was not given', () => {
  for (const bad of [undefined, null, NaN, -1, 'x']) {
    assert.equal(formatDuration(bad), 'an unknown time');
  }
});


// ── judgment:cold-6 (fourth cold review) — ONE number, with a reader ───────

test('cold-6: the backend default and the configured default are the SAME number', () => {
  // They were two separate `10 * 60_000` literals with no import between them,
  // under a docstring claiming the default was "one number rather than one per
  // backend". Nothing compared them, so nothing would have said when they drifted
  // — and with `timeoutMs` dropped at the seam (cold-1), the backend's copy was
  // the one in force while the operator's config was validated against the other.
  assert.equal(STAGE_TIMEOUT_MS, TIMEOUT_IN_FORCE_TODAY);
  assert.equal(TIMEOUT_IN_FORCE_TODAY, resolveStageTimeout({}).timeoutMs);
});


// ── judgment:cold-4 (fifth cold review) — the seconds place must ROLL OVER ──

test('cold-4: a duration near a minute boundary never renders 60 seconds', () => {
  // MEASURED as the defect: `Math.round(s % 60)` rounds AFTER the remainder, so
  // 599_600ms rendered as "9m 60s" and 119_600 as "1m 60s". The only multi-minute
  // case in this file was 754_000 -> "12m 34s", nowhere near a boundary.
  //
  // It reaches an operator twice: the ceiling a timeout refusal names, and the
  // cost every run reports. A duration reading "9m 60s" is a measurement nobody
  // can trust, which is the shape this whole ticket exists to remove.
  assert.equal(formatDuration(599_600), '10m');
  assert.equal(formatDuration(599_500), '10m');
  assert.equal(formatDuration(599_999), '10m');
  assert.equal(formatDuration(119_600), '2m');
  for (let ms = 59_000; ms <= 3_600_000; ms += 331) {
    assert.doesNotMatch(formatDuration(ms), / 60s$/, `${ms}ms rendered a 60-second remainder`);
  }
});

test('cold-4: the BRANCH and the RENDER agree at the 90-second seam', () => {
  // `s < 90` decided on the unrounded value while `toFixed(1)` rendered the
  // rounded one, so the 50ms below 90s printed "90.0s" — a seconds form for a
  // duration the next millisecond calls "1m 30s".
  assert.equal(formatDuration(89_960), '1m 30s');
  assert.equal(formatDuration(90_000), '1m 30s');
  assert.equal(formatDuration(89_940), '89.9s');
});

test('cold-4: the shapes that already worked still do', () => {
  assert.equal(formatDuration(450), '450ms');
  assert.equal(formatDuration(4_793), '4.8s');     // the operator's own probe
  assert.equal(formatDuration(754_000), '12m 34s');
  assert.equal(formatDuration(600_000), '10m');
});
