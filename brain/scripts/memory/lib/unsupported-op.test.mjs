// unsupported-op.test.mjs — unit tests for the shared "loud, never-cryptic
// deferral" helper (C3 design Decision 5, obs #578's never-cryptic-on-both-
// backends ruling).
//
// unsupportedOp() always throws — the caller's op stays async so
// `await unsupportedOp(...)` rejects, letting cli.mjs's existing
// catch-and-exit-1 path surface the message unmodified.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED: unsupported-op.mjs does not exist yet.
import { unsupportedOp } from './unsupported-op.mjs';

test('unsupportedOp: rejects with a message built via t(key, {op, backend, ...params})', async () => {
  await assert.rejects(
    () => unsupportedOp('index', 'plainfiles'),
    (err) => {
      assert.ok(err instanceof Error, 'must reject with an Error');
      assert.ok(err.message.includes('index'), `message should name the op: ${err.message}`);
      assert.ok(err.message.includes('plainfiles'), `message should name the backend: ${err.message}`);
      return true;
    },
  );
});

test('unsupportedOp: defaults to the memory.op.unsupported key', async () => {
  await assert.rejects(
    () => unsupportedOp('featureCheckpoint', 'plainfiles'),
    (err) => {
      // memory.op.unsupported's English template names the op and backend —
      // asserting both substrings is the observable proxy for "used the
      // default key" without coupling this test to the exact template string.
      assert.ok(err.message.includes('featureCheckpoint'));
      assert.ok(err.message.includes('plainfiles'));
      return true;
    },
  );
});

test('unsupportedOp: an explicit key + params selects a different message (e.g. the engram search refusal)', async () => {
  // `memory.save.engramUnsupported` retired at #874, split A (D7) — `save` is
  // no longer deferred through this helper. `memory.search.engramUnsupported`
  // stays (R14 scope: `search` is still unsupported under engram).
  await assert.rejects(
    () => unsupportedOp('search', 'engram', { key: 'memory.search.engramUnsupported' }),
    (err) => {
      assert.ok(err.message.includes('mem_search'), `expected the engram search refusal to name mem_search: ${err.message}`);
      return true;
    },
  );
});

test('unsupportedOp: always rejects — never resolves, never a silent no-op', async () => {
  let threw = false;
  try {
    await unsupportedOp('search', 'plainfiles');
  } catch {
    threw = true;
  }
  assert.equal(threw, true, 'unsupportedOp must always throw/reject');
});
