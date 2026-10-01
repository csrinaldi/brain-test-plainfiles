import { test } from 'node:test';
import assert from 'node:assert/strict';

import { initialPageState, applyFrame, parseFrame, streamFailed, controlFailed, sectionOf, requestSequence } from './frames.mjs';

const snapshot = (over = {}) => ({ generatedAt: '2026-09-16T00:00:00Z', graph: { ok: true, value: { nodes: [], edges: [] } }, changes: { ok: true, value: [] }, ...over });
const meta = (over = {}) => ({ project: 'o/r', watcher: { ok: true, watched: 3, failed: [] }, poller: { paused: false, lastPolledAt: '2026-09-16T00:00:00Z', lastOkAt: '2026-09-16T00:00:00Z', lastError: null, forgeAsOf: {} }, ...over });

test('#881: the initial state holds nothing and SAYS the stream has not connected — never a silent blank page', () => {
  const state = initialPageState();
  assert.equal(state.snapshot, null);
  assert.equal(state.meta, null);
  assert.equal(state.stream.ok, false);
  assert.match(state.stream.reason, /has not connected/);
  assert.deepEqual(state.refs, []);
});

test('#881: a sync frame replaces the snapshot and the meta, and marks the stream live', () => {
  const state = applyFrame(initialPageState(), 'sync', { generatedAt: '2026-09-16T00:00:00Z', snapshot: snapshot(), meta: meta() });
  assert.equal(state.snapshot.generatedAt, '2026-09-16T00:00:00Z');
  assert.equal(state.meta.project, 'o/r');
  assert.equal(state.stream.ok, true);
  assert.equal(state.lastFrameAt, '2026-09-16T00:00:00Z');
});

test('#881: a sync frame with no meta (the REST /api/snapshot read) keeps the meta already known', () => {
  const live = applyFrame(initialPageState(), 'sync', { generatedAt: 'a', snapshot: snapshot(), meta: meta() });
  const after = applyFrame(live, 'sync', { generatedAt: 'b', snapshot: snapshot({ generatedAt: 'b' }) });
  assert.equal(after.meta.project, 'o/r', 'the REST read carries no meta; it must not erase what the stream said');
  assert.equal(after.snapshot.generatedAt, 'b');
});

test('#881: Q5/D6 — a section frame patches exactly one section and leaves every other one alone', () => {
  const live = applyFrame(initialPageState(), 'sync', { generatedAt: 'a', snapshot: snapshot(), meta: meta() });
  const patched = applyFrame(live, 'section', { name: 'graph', section: { ok: false, reason: 'the issue list could not be read' }, generatedAt: 'b', cause: 'poll' });
  assert.deepEqual(patched.snapshot.graph, { ok: false, reason: 'the issue list could not be read' });
  assert.deepEqual(patched.snapshot.changes, live.snapshot.changes, 'an untouched section keeps its value');
  assert.equal(patched.snapshot.generatedAt, 'b', 'the patched snapshot carries the frame\'s own time');
  assert.notEqual(patched.snapshot, live.snapshot, 'state is replaced, never mutated in place');
  assert.deepEqual(live.snapshot.graph, { ok: true, value: { nodes: [], edges: [] } }, 'the previous state is untouched');
});

test('#881: a section frame before the first sync is SAID, not dropped and not applied to nothing', () => {
  const state = applyFrame(initialPageState(), 'section', { name: 'graph', section: { ok: true, value: {} }, generatedAt: 'b' });
  assert.equal(state.snapshot, null);
  assert.equal(state.stream.ok, false);
  assert.match(state.stream.reason, /before the first sync/);
});

test('#881 R881-9: a section frame naming a section this snapshot does not have is SAID, never written blindly', () => {
  const live = applyFrame(initialPageState(), 'sync', { generatedAt: 'a', snapshot: snapshot(), meta: meta() });

  const unknown = applyFrame(live, 'section', { name: 'nosuchsection', section: { ok: true }, generatedAt: 'b' });
  assert.equal(unknown.snapshot, live.snapshot, 'the held snapshot is untouched — a frame cannot invent a section this server does not serve');
  assert.equal(unknown.stream.ok, false);
  assert.match(unknown.stream.reason, /"nosuchsection"/, 'the unknown name is named, the way an unknown event name is');

  const nameless = applyFrame(live, 'section', { section: { ok: true }, generatedAt: 'b' });
  assert.equal(nameless.snapshot, live.snapshot, 'a frame with no name must not write a section called "undefined"');
  assert.equal(nameless.stream.ok, false);
  assert.ok(!('undefined' in nameless.snapshot), 'the string "undefined" is not a section name');
});

test('#881: Q3/A2 — a refs frame records the worktree head, newest first, capped', () => {
  let state = applyFrame(initialPageState(), 'sync', { generatedAt: 'a', snapshot: snapshot(), meta: meta() });
  for (let i = 0; i < 25; i++) state = applyFrame(state, 'refs', { worktree: `/w/${i}`, head: `feat/${i}`, at: 'now' });
  assert.equal(state.refs.length, 20, 'the ref log is bounded — a rebase must not grow the page without limit');
  assert.equal(state.refs[0].worktree, '/w/24', 'newest first');
});

test('#881: a status frame replaces the meta without touching the snapshot', () => {
  const live = applyFrame(initialPageState(), 'sync', { generatedAt: 'a', snapshot: snapshot(), meta: meta() });
  const after = applyFrame(live, 'status', meta({ poller: { paused: true, lastError: 'boom', lastPolledAt: 't', lastOkAt: null, forgeAsOf: {} } }));
  assert.equal(after.meta.poller.paused, true);
  assert.equal(after.snapshot, live.snapshot, 'the held snapshot is the same object — a status frame is not a repaint of the data');
});

test('#881: an unknown frame name never throws and never clears the page — it says the page may be older than the server', () => {
  const live = applyFrame(initialPageState(), 'sync', { generatedAt: 'a', snapshot: snapshot(), meta: meta() });
  const after = applyFrame(live, 'wat', { hello: true });
  assert.equal(after.snapshot, live.snapshot);
  assert.equal(after.stream.ok, false);
  assert.match(after.stream.reason, /unknown stream frame "wat"/);
});

test('#881 R881-9: a frame that is not JSON comes back as a reason, never as a throw inside the listener', () => {
  // `JSON.parse(event.data)` in the EventSource callback throws where nothing
  // on this page can catch it: the frame is lost AND no band ever says so.
  assert.deepEqual(parseFrame('{"snapshot":null}'), { ok: true, frame: { snapshot: null } });
  const bad = parseFrame('{nope');
  assert.equal(bad.ok, false);
  assert.equal(bad.frame, undefined, 'a failed parse hands back no frame to apply');
  assert.match(bad.reason, /position/, `the reason must name where the text stopped being JSON, got: ${bad.reason}`);
  assert.equal(parseFrame(undefined).ok, false, 'a frame with no data at all is a reason too, not a crash');
});

test('#881: R881-9 — a dropped stream keeps the last snapshot and states the reason', () => {
  const live = applyFrame(initialPageState(), 'sync', { generatedAt: 'a', snapshot: snapshot(), meta: meta() });
  const dropped = streamFailed(live, 'the connection closed');
  assert.equal(dropped.snapshot, live.snapshot, 'previous values stay on screen');
  assert.equal(dropped.stream.ok, false);
  assert.match(dropped.stream.reason, /the connection closed/);
});

test('#881 R881-4: a poll control that failed is its own reason — the stream stays live and every value stays on screen', () => {
  const live = applyFrame(initialPageState(), 'sync', { generatedAt: 'a', snapshot: snapshot(), meta: meta() });
  const after = controlFailed(live, { action: 'once', reason: 'POST /api/poll/once answered 503' });
  assert.deepEqual(after.controls, { ok: false, action: 'once', reason: 'POST /api/poll/once answered 503' });
  assert.deepEqual(after.stream, { ok: true }, 'a button that did not take must not be reported as a dropped stream');
  assert.equal(after.snapshot, live.snapshot);
  assert.deepEqual(initialPageState().controls, { ok: true }, 'nothing has failed before anything has been pressed');
});

test('#881: sectionOf never returns undefined — a missing section is a stated reason, not a blank area', () => {
  const live = applyFrame(initialPageState(), 'sync', { generatedAt: 'a', snapshot: snapshot(), meta: meta() });
  assert.deepEqual(sectionOf(live, 'graph'), { ok: true, value: { nodes: [], edges: [] } });
  assert.equal(sectionOf(live, 'nope').ok, false);
  assert.match(sectionOf(live, 'nope').reason, /"nope" is not in the snapshot/);
  assert.equal(sectionOf(initialPageState(), 'graph').ok, false);
  assert.match(sectionOf(initialPageState(), 'graph').reason, /no snapshot has been read yet/);
});

// ── cold review of #982, correction 2: a stale drawer answer never overwrites a fresher one ──

test('#881: requestSequence — only the latest token is current, so a slower earlier answer is dropped', () => {
  const seq = requestSequence();
  const first = seq.next();
  const second = seq.next();
  assert.equal(seq.isCurrent(first), false, 'the earlier request is stale once a later one started');
  assert.equal(seq.isCurrent(second), true);
  assert.equal(seq.isCurrent(seq.next()), true);
});
