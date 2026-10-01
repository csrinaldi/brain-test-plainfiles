// supersedes.test.mjs — unit tests for issue #805's pure classifier.
// `classifySupersedes({ id, localIds, upstream })` decides which of three
// things is wrong with a `--supersedes <id>` value, local store first — the
// `upstream` thunk is called at most once, and only on a local miss (A1).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { classifySupersedes, SUPERSEDES_ID_RE } from './supersedes.mjs';
import { buildRecord } from './format.mjs';

/** A thunk that records how many times it was called and returns `result`. */
function spyUpstream(result) {
  const spy = () => {
    spy.calls += 1;
    return result;
  };
  spy.calls = 0;
  return spy;
}

// ---------------------------------------------------------------------------
// malformed — pure, before any read
// ---------------------------------------------------------------------------

for (const bad of ['rec-XYZ', 'rec-abcdef0123456789a', 'rec-ABCDEF0123456789', '', 42, null, undefined]) {
  test(`classifySupersedes: malformed value ${JSON.stringify(bad)} is refused before any read`, () => {
    const localIds = spyUpstream(new Set());
    const upstream = spyUpstream({ ok: true, byId: new Map() });
    const result = classifySupersedes({ id: bad, localIds, upstream });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'malformed');
    assert.deepEqual(result.detail, { value: bad });
    assert.equal(localIds.calls, 0, 'a malformed id must be refused with zero IO — the local store must never be read');
    assert.equal(upstream.calls, 0);
  });
}

// ---------------------------------------------------------------------------
// local hit — the thunk is never called
// ---------------------------------------------------------------------------

test('classifySupersedes: a local hit succeeds and never calls the upstream thunk', () => {
  const id = 'rec-0123456789abcdef';
  const upstream = spyUpstream({ ok: true, byId: new Map() });
  const result = classifySupersedes({ id, localIds: () => new Set([id]), upstream });
  assert.deepEqual(result, { ok: true, source: 'local' });
  assert.equal(upstream.calls, 0);
});

// ---------------------------------------------------------------------------
// local miss + upstream hit
// ---------------------------------------------------------------------------

test('classifySupersedes: a local miss with an upstream hit succeeds, source upstream', () => {
  const id = 'rec-0123456789abcdef';
  const upstream = spyUpstream({ ok: true, ref: 'origin/main', byId: new Map([[id, 'blob']]) });
  const result = classifySupersedes({ id, localIds: () => new Set(), upstream });
  assert.deepEqual(result, { ok: true, source: 'upstream' });
  assert.equal(upstream.calls, 1);
});

// ---------------------------------------------------------------------------
// local miss + upstream miss
// ---------------------------------------------------------------------------

test('classifySupersedes: a local miss with an upstream miss is refused not-in-store', () => {
  const id = 'rec-0123456789abcdef';
  const upstream = spyUpstream({ ok: true, ref: 'origin/main', byId: new Map() });
  const result = classifySupersedes({ id, localIds: () => new Set(), upstream });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'not-in-store');
  assert.deepEqual(result.detail, { id, ref: 'origin/main' });
  assert.equal(upstream.calls, 1);
});

// ---------------------------------------------------------------------------
// local miss + could not verify — reason copied verbatim, never mapped
// ---------------------------------------------------------------------------

test('classifySupersedes: a degraded upstream is refused could-not-verify, reason verbatim', () => {
  const id = 'rec-0123456789abcdef';
  const upstream = spyUpstream({ ok: false, ref: null, reason: 'no upstream ref resolved (tried origin/HEAD, origin/main)' });
  const result = classifySupersedes({ id, localIds: () => new Set(), upstream });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'could-not-verify');
  assert.deepEqual(result.detail, {
    id,
    reason: 'no upstream ref resolved (tried origin/HEAD, origin/main)',
  });
  assert.equal(upstream.calls, 1);
  // Never remapped to not-in-store.
  assert.notEqual(result.reason, 'not-in-store');
});

// ---------------------------------------------------------------------------
// configError rides through, on either arm, unchanged
// ---------------------------------------------------------------------------

test('classifySupersedes: configError on an ok:true upstream arm is carried through on success', () => {
  const id = 'rec-0123456789abcdef';
  const upstream = spyUpstream({ ok: true, ref: 'origin/main', byId: new Map([[id, 'blob']]), configError: 'bad json' });
  const result = classifySupersedes({ id, localIds: () => new Set(), upstream });
  assert.equal(result.ok, true);
  assert.equal(result.configError, 'bad json');
});

test('classifySupersedes: configError on an ok:false upstream arm is carried through on refusal', () => {
  const id = 'rec-0123456789abcdef';
  const upstream = spyUpstream({ ok: false, ref: null, reason: 'no upstream ref resolved', configError: 'bad json' });
  const result = classifySupersedes({ id, localIds: () => new Set(), upstream });
  assert.equal(result.ok, false);
  assert.equal(result.configError, 'bad json');
});

// ---------------------------------------------------------------------------
// the thunk is called at most once, across every branch
// ---------------------------------------------------------------------------

test('classifySupersedes: the upstream thunk is called at most once per call', () => {
  const id = 'rec-0123456789abcdef';
  for (const upstreamResult of [
    { ok: true, ref: 'origin/main', byId: new Map([[id, 'blob']]) },
    { ok: true, ref: 'origin/main', byId: new Map() },
    { ok: false, ref: null, reason: 'no upstream ref resolved' },
  ]) {
    const upstream = spyUpstream(upstreamResult);
    classifySupersedes({ id, localIds: () => new Set(), upstream });
    assert.ok(upstream.calls <= 1, `expected at most one call, got ${upstream.calls}`);
  }
});

// ---------------------------------------------------------------------------
// producer-oracle pin — buildRecord's own id satisfies the grammar declared here
// ---------------------------------------------------------------------------

test('classifySupersedes: SUPERSEDES_ID_RE matches a real buildRecord() id (producer is the oracle)', () => {
  const rec = buildRecord({
    type: 'decision',
    actor: '@crinaldi',
    actorKind: 'human',
    ts: '2026-07-04T12:00:00Z',
    project: 'brain',
    content: 'We chose union merge.',
    title: 'x',
  });
  assert.match(rec.id, SUPERSEDES_ID_RE);
});
