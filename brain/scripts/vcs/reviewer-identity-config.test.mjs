// reviewer-identity-config.test.mjs — issue #367 (#266 task 7.3).
//
// A doctrine tripwire over the SHIPPED `brain.config.json`, not over a fixture.
//
// Why this file exists at all: the lock-3 mechanism is already tested by #266's
// t1/t2 (`actor-check.test.mjs`, `brain-writes-reviewed.test.mjs`), but BOTH
// build their own config around a FIXTURE identity (`brain-reviewer[bot]`).
// They would stay green if the real committed config put the real reviewer
// handle into `governance.approvalActors` — green in test, inert in production.
// That is the defect class M10 (#335) exists to close, and the one that let
// PR #360's first attempt ship a doctrine reversal under 8 green gates.
//
// The load-bearing assertion is the third one, and it asserts ABSENCE. A check
// that merely required "approvalActors has some value" would be satisfied by
// the one forbidden value, which is exactly the trap the superseded #330
// tripwire fell into.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateActor } from './actor-check.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

function shippedConfig() {
  return JSON.parse(readFileSync(join(repoRoot, 'brain.config.json'), 'utf8'));
}

/** Defensive read: both governance keys default to [] when absent, mirroring
 * `actor-check.mjs:227` and `brain-writes-reviewed.mjs:183`. */
function actorList(config, key) {
  const v = config?.governance?.[key];
  return Array.isArray(v) ? v : [];
}

test('the shipped config names a reviewer handle (activates the §10 self-review guard)', () => {
  const handle = shippedConfig()?.reviewer?.handle;

  // An empty handle leaves `evaluateSelfReview` unable to compare, so
  // `review/cli.mjs:114-122` (P290-ABSTAIN-FAIL-OPEN) warns and proceeds —
  // every run on this repo is then a self-review that announces itself.
  assert.equal(typeof handle, 'string', 'reviewer.handle must be a string');
  assert.notEqual(handle.trim(), '', 'reviewer.handle must be populated — an empty handle leaves the §10 guard inactive');
});

test('the reviewer handle IS in governance.reviewActors (L6 excludes it from the human-approver count)', () => {
  const config = shippedConfig();
  const handle = config?.reviewer?.handle;

  // L6 reads ONLY `governance.reviewActors` (brain-writes-reviewed.mjs:183) and
  // resolves the human approver as
  //   approvers.find(a => a !== author && !botAllowlist.includes(a))
  // so a reviewer absent from this list would be COUNTED as the human review of
  // a brain/** change.
  assert.ok(
    actorList(config, 'reviewActors').includes(handle),
    `reviewer.handle "${handle}" must be listed in governance.reviewActors, or an APPROVED review from it would satisfy L6 as the human signature`,
  );
});

test('the reviewer handle is NOT in governance.approvalActors (§3/§11 lock 3 — never, under any circumstance)', () => {
  const config = shippedConfig();
  const handle = config?.reviewer?.handle;

  // L5 reads ONLY `governance.approvalActors` (actor-check.mjs:227), where
  // membership AUTHORIZES applying `status:approved` — the merge keystroke.
  // reviewer-protocol.md §11: "Do not register any reviewer handle in
  // governance.approvalActors — ever." One key, two opposite meanings; this is
  // the dual-semantics hazard §3 exists to dissolve.
  //
  // Asserted as absence from the whole list rather than as "handle !== x" so it
  // cannot be satisfied by a wrong value.
  assert.equal(
    actorList(config, 'approvalActors').includes(handle),
    false,
    `reviewer.handle "${handle}" must NEVER appear in governance.approvalActors — that would authorize the reviewer to self-apply status:approved (lock 3)`,
  );
});

test('the two governance actor keys share no identity at all (no key feeds two gates)', () => {
  const config = shippedConfig();
  const review = actorList(config, 'reviewActors');
  const approval = actorList(config, 'approvalActors');

  // Binding ruling R2 from #266: "no key feeds two gates". The narrower test
  // above pins the reviewer handle specifically; this one holds the invariant
  // for any identity added to either list later, so a future third identity
  // cannot quietly acquire both semantics.
  const overlap = review.filter(a => approval.includes(a));
  assert.deepEqual(overlap, [], `identities must not appear in both reviewActors and approvalActors — found: ${overlap.join(', ')}`);
});

// ── issue #375 — the shipped config must actually DENY, not just be well-shaped
//
// The four tests above assert the config's SHAPE. This one asserts its
// BEHAVIOUR: it feeds the shipped `governance.reviewActors` straight into the
// real L5 evaluator and pins that the shipped `reviewer.handle` is refused.
//
// Kept separate from `actor-check.test.mjs`'s unit tests on purpose. Those use
// a fixture identity, so they would stay green if the shipped config named a
// handle that no longer matched the deny list — the exact green-in-test /
// inert-in-production gap that let the reviewer unlock a real PR (#374's
// transient `actor-check` SUCCESS, caused by csrinaldibot applying the approved
// label). Shape and behaviour are two different claims; assert both.

test('#375: the SHIPPED reviewer handle is DENIED by L5 when it applies the approved label', () => {
  const config = shippedConfig();
  const handle = config?.reviewer?.handle;

  const result = evaluateActor({
    // Neither author is the reviewer — so rule 5 (self-approval) cannot be what
    // catches it. Only the deny-set can.
    author: 'some-pr-author',
    issueAuthor: 'some-issue-author',
    labeledEvents: [{ actor: { login: handle } }],
    denyActors: actorList(config, 'reviewActors'),
    botAllowlist: actorList(config, 'approvalActors'),
  });

  assert.equal(
    result.level,
    'fail',
    `the shipped reviewer.handle "${handle}" must be refused by L5 — a review identity may never unlock the approved label (reviewer-protocol.md §9)`,
  );
});
