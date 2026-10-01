// plainfiles.unsupported.test.mjs — unit tests for the deferred plainfiles
// ops (C3, issue #246, REQ-C3-5). `index()`, `featureCheckpoint()`, and
// `featureResume()` have no plainfiles-native projection target — each
// rejects with an explicit "unsupported" message naming the op, never a
// silent no-op.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// RED: these are not exported from plainfiles.mjs yet.
import { index, featureCheckpoint, featureResume } from './plainfiles.mjs';

for (const [name, fn] of [
  ['index', index],
  ['featureCheckpoint', featureCheckpoint],
  ['featureResume', featureResume],
]) {
  test(`${name}: rejects with an explicit "unsupported" message naming the op — never a silent no-op`, async () => {
    await assert.rejects(
      () => fn(),
      (err) => {
        assert.ok(err instanceof Error, `${name} must reject with an Error`);
        assert.ok(err.message.includes(name), `${name}'s rejection must name the op: ${err.message}`);
        assert.ok(err.message.includes('plainfiles'), `${name}'s rejection must name the backend: ${err.message}`);
        return true;
      },
    );
  });
}
