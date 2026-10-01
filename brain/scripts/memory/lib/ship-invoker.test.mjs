// ship-invoker.test.mjs — the pure decision behind `cli.mjs ship`'s invoker
// guard (#1012, design.md's Interfaces/Contracts section). `decideShipInvoker`
// is a pure function of `{ args, env }`; no spawn, no CLI, so the whole
// matrix is cheap to test in process. The CLI-level tests (cli.ship-invoker
// .test.mjs, cli.ship.test.mjs) only prove where the call sits and that its
// result is threaded through correctly — this file proves the decision
// itself, for every branch of the check order:
//
//   (1) argv syntax → (2) bypass → (3) NODE_TEST_CONTEXT → (4) presence
//
// A malformed --invoker is refused even under a seam (order (1) before (2))
// — the seam excuses a MISSING marker, never a MALFORMED one.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { INVOKERS, REFUSAL, decideShipInvoker } from './ship-invoker.mjs';

// ── the three valid values ──────────────────────────────────────────────────

for (const invoker of INVOKERS) {
  test(`#1012 decideShipInvoker: --invoker ${invoker} is allowed`, () => {
    const result = decideShipInvoker({ args: ['--invoker', invoker], env: {} });
    assert.deepEqual(result, { allowed: true, invoker, bypass: null });
  });
}

test('#1012 decideShipInvoker: INVOKERS is exactly hook, sweep, manual', () => {
  assert.deepEqual([...INVOKERS], ['hook', 'sweep', 'manual']);
});

// ── argv syntax: malformed forms are invokerInvalid, seam or not ───────────

test('#1012 decideShipInvoker: --invoker with no value is invokerInvalid', () => {
  const result = decideShipInvoker({ args: ['--invoker'], env: {} });
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.INVALID);
});

test('#1012 decideShipInvoker: --invoker immediately followed by another flag is invokerInvalid', () => {
  const result = decideShipInvoker({ args: ['--invoker', '--json'], env: {} });
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.INVALID);
});

test('#1012 decideShipInvoker: the --invoker=value form is invokerInvalid (only the two-token form is accepted)', () => {
  const result = decideShipInvoker({ args: ['--invoker=hook'], env: {} });
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.INVALID);
});

test('#1012 decideShipInvoker: an unrecognized value is invokerInvalid', () => {
  const result = decideShipInvoker({ args: ['--invoker', 'ci'], env: {} });
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.INVALID);
  assert.equal(result.params.value, 'ci');
});

test('#1012 decideShipInvoker: a repeated --invoker flag is invokerInvalid', () => {
  const result = decideShipInvoker({ args: ['--invoker', 'hook', '--invoker', 'sweep'], env: {} });
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.INVALID);
});

test('#1012 decideShipInvoker: a repeated --invoker flag is invokerInvalid EVEN under the seam — a malformed marker is a caller bug, the seam excuses only a MISSING one', () => {
  const result = decideShipInvoker({
    args: ['--invoker', 'hook', '--invoker', 'sweep'],
    env: { BRAIN_VCS_TEST_MODULE: '/fixtures/fake-vcs-port.mjs' },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.INVALID);
});

test('#1012 decideShipInvoker: an unrecognized value is invokerInvalid even under --dry-run', () => {
  const result = decideShipInvoker({ args: ['--invoker', 'ci', '--dry-run'], env: {} });
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.INVALID);
});

// ── bypass: seam presence or --dry-run excuses a MISSING marker ────────────

test('#1012 decideShipInvoker: BRAIN_VCS_TEST_MODULE present with no --invoker is allowed, bypass vcs-test-module, invoker null', () => {
  const result = decideShipInvoker({ args: [], env: { BRAIN_VCS_TEST_MODULE: '/fixtures/fake-vcs-port.mjs' } });
  assert.deepEqual(result, { allowed: true, invoker: null, bypass: 'vcs-test-module' });
});

test('#1012 decideShipInvoker: --dry-run with no --invoker is allowed, bypass dry-run, invoker null', () => {
  const result = decideShipInvoker({ args: ['--dry-run'], env: {} });
  assert.deepEqual(result, { allowed: true, invoker: null, bypass: 'dry-run' });
});

test('#1012 decideShipInvoker: a BLANK seam (set but empty) still bypasses THIS guard — the blank-seam refusal lives downstream in cli.mjs', () => {
  const result = decideShipInvoker({ args: [], env: { BRAIN_VCS_TEST_MODULE: '' } });
  assert.deepEqual(result, { allowed: true, invoker: null, bypass: 'vcs-test-module' });
});

// ── NODE_TEST_CONTEXT: refused independent of a valid --invoker ───────────

test('#1012 decideShipInvoker: NODE_TEST_CONTEXT set with a valid --invoker is invokerUnderTest, unless bypassed', () => {
  const result = decideShipInvoker({
    args: ['--invoker', 'manual'],
    env: { NODE_TEST_CONTEXT: 'child-v8' },
  });
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.UNDER_TEST);
});

test('#1012 decideShipInvoker: NODE_TEST_CONTEXT set is excused by BRAIN_VCS_TEST_MODULE', () => {
  const result = decideShipInvoker({
    args: ['--invoker', 'manual'],
    env: { NODE_TEST_CONTEXT: 'child-v8', BRAIN_VCS_TEST_MODULE: '/fixtures/fake-vcs-port.mjs' },
  });
  assert.deepEqual(result, { allowed: true, invoker: 'manual', bypass: 'vcs-test-module' });
});

test('#1012 decideShipInvoker: NODE_TEST_CONTEXT set is excused by --dry-run', () => {
  const result = decideShipInvoker({
    args: ['--invoker', 'manual', '--dry-run'],
    env: { NODE_TEST_CONTEXT: 'child-v8' },
  });
  assert.deepEqual(result, { allowed: true, invoker: 'manual', bypass: 'dry-run' });
});

// ── presence: no marker, no bypass, no test context ────────────────────────

test('#1012 decideShipInvoker: no --invoker, no bypass, no NODE_TEST_CONTEXT is invokerMissing', () => {
  const result = decideShipInvoker({ args: [], env: {} });
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.MISSING);
});

test('#1012 decideShipInvoker: an empty args array and empty env object are safe defaults', () => {
  const result = decideShipInvoker({});
  assert.equal(result.allowed, false);
  assert.equal(result.key, REFUSAL.MISSING);
});
