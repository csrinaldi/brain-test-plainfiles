// deny-set.test.mjs — Unit tests for REQ-H1-14: the hardcoded label
// deny-set (protocol §9, design.md §7). Fail-closed ALLOW-LIST: only the
// tightening namespaces pass; every denied/unknown label is refused BEFORE
// `vcs.labelAdd` is ever invoked — proven with a spy VCS that throws if
// `labelAdd` is reached.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  isAllowedLabel,
  assertAllowed,
  guardedLabelAdd,
  isAllowedRemoveLabel,
  assertAllowedRemove,
  guardedLabelRemove,
} from './deny-set.mjs';

function refusingSpy() {
  const calls = [];
  return {
    calls,
    vcs: {
      labelAdd: async (...args) => {
        calls.push(args);
        throw new Error('labelAdd must NEVER be invoked for a denied label');
      },
    },
  };
}

function acceptingSpy() {
  const calls = [];
  return {
    calls,
    vcs: {
      labelAdd: async ({ project, number, labels }) => {
        calls.push({ project, number, labels });
        return { ok: true };
      },
    },
  };
}

// ── DENY: known loosen/unlock labels + one unknown label ───────────────────

const DENIED = ['status:approved', 'size:exception', 'skip:memory-gate', 'override:main', 'kind:whatever'];

for (const label of DENIED) {
  test(`assertAllowed refuses "${label}"`, () => {
    assert.throws(() => assertAllowed([label]), /refused label/);
  });

  test(`isAllowedLabel("${label}") is false`, () => {
    assert.equal(isAllowedLabel(label), false);
  });

  test(`guardedLabelAdd refuses "${label}" BEFORE vcs.labelAdd is invoked (spy never called)`, async () => {
    const { vcs, calls } = refusingSpy();
    await assert.rejects(
      () => guardedLabelAdd(vcs, { project: 'csrinaldi/brain', number: 42, labels: [label] }),
      /refused label/,
    );
    assert.deepEqual(calls, [], `labelAdd must never be reached for denied label "${label}"`);
  });
}

// ── ALLOW: the tightening namespaces ────────────────────────────────────────

// `needs-decision` (H1-5b, REQ-H1-13/escalation inbox candidate 4993202904,
// decided IN by plan 5011584432): the escalation-inbox tightening label —
// applied when a verdict carries `escalate: 'human'`. Pure tightening,
// same rationale as `needs-ruling`.
const ALLOWED = ['decision', 'seq:1', 'reviewed:approved', 'reviewed:stale', 'needs-ruling', 'needs-decision'];

for (const label of ALLOWED) {
  test(`isAllowedLabel("${label}") is true`, () => {
    assert.equal(isAllowedLabel(label), true);
  });

  test(`assertAllowed does not throw for "${label}"`, () => {
    assert.doesNotThrow(() => assertAllowed([label]));
  });

  test(`guardedLabelAdd applies "${label}" through to vcs.labelAdd`, async () => {
    const { vcs, calls } = acceptingSpy();
    const result = await guardedLabelAdd(vcs, { project: 'csrinaldi/brain', number: 42, labels: [label] });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [{ project: 'csrinaldi/brain', number: 42, labels: [label] }]);
  });
}

// ── Fail-closed: allow-list is the fence, not the deny examples ────────────

test('an unknown label not in the deny examples is STILL refused (allow-list, not a blacklist)', () => {
  assert.equal(isAllowedLabel('totally-made-up-label'), false);
  assert.throws(() => assertAllowed(['totally-made-up-label']), /refused label/);
});

test('assertAllowed checks EVERY label in a batch — one denied label refuses the whole call', () => {
  assert.throws(() => assertAllowed(['decision', 'status:approved']), /refused label/);
});

test('empty labels array never throws — nothing to refuse', () => {
  assert.doesNotThrow(() => assertAllowed([]));
});

// ── guardedLabelRemove: the REMOVE allow-list is NARROWER than ADD ─────────
// (H1-5c, board.mjs's chokepoint, protocol §9). Only the reviewer's OWN
// derived index — seq:*/reviewed:* — may ever be removed. `decision`,
// `needs-ruling`, `needs-decision` (human/circuit intent — adding them is
// tightening, removing them is LOOSENING) and `status:approved` (human-only)
// must NEVER be removed by the reviewer, even though `decision`/
// `needs-ruling`/`needs-decision` ARE on the ADD allow-list.

function refusingRemoveSpy() {
  const calls = [];
  return {
    calls,
    vcs: {
      labelRemove: async (...args) => {
        calls.push(args);
        throw new Error('labelRemove must NEVER be invoked for a denied label');
      },
    },
  };
}

function acceptingRemoveSpy() {
  const calls = [];
  return {
    calls,
    vcs: {
      labelRemove: async ({ project, number, labels }) => {
        calls.push({ project, number, labels });
        return { ok: true };
      },
    },
  };
}

const DENIED_REMOVE = ['decision', 'needs-ruling', 'needs-decision', 'status:approved', 'kind:whatever'];

for (const label of DENIED_REMOVE) {
  test(`isAllowedRemoveLabel("${label}") is false — REMOVE allow-list excludes it`, () => {
    assert.equal(isAllowedRemoveLabel(label), false);
  });

  test(`assertAllowedRemove refuses "${label}"`, () => {
    assert.throws(() => assertAllowedRemove([label]), /refused label removal/);
  });

  test(`guardedLabelRemove refuses "${label}" BEFORE vcs.labelRemove is invoked (spy never called)`, async () => {
    const { vcs, calls } = refusingRemoveSpy();
    await assert.rejects(
      () => guardedLabelRemove(vcs, { project: 'csrinaldi/brain', number: 42, labels: [label] }),
      /refused label removal/,
    );
    assert.deepEqual(calls, [], `labelRemove must never be reached for denied removal "${label}"`);
  });
}

const ALLOWED_REMOVE = ['seq:1', 'reviewed:approved'];

for (const label of ALLOWED_REMOVE) {
  test(`isAllowedRemoveLabel("${label}") is true`, () => {
    assert.equal(isAllowedRemoveLabel(label), true);
  });

  test(`assertAllowedRemove does not throw for "${label}"`, () => {
    assert.doesNotThrow(() => assertAllowedRemove([label]));
  });

  test(`guardedLabelRemove applies "${label}" through to vcs.labelRemove`, async () => {
    const { vcs, calls } = acceptingRemoveSpy();
    const result = await guardedLabelRemove(vcs, { project: 'csrinaldi/brain', number: 42, labels: [label] });
    assert.deepEqual(result, { ok: true });
    assert.deepEqual(calls, [{ project: 'csrinaldi/brain', number: 42, labels: [label] }]);
  });
}

test('assertAllowedRemove checks EVERY label in a batch — one denied removal refuses the whole call', () => {
  assert.throws(() => assertAllowedRemove(['seq:1', 'decision']), /refused label removal/);
});

test('empty removal labels array never throws', () => {
  assert.doesNotThrow(() => assertAllowedRemove([]));
});
