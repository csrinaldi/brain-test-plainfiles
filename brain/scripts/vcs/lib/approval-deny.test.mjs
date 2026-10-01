// approval-deny.test.mjs — issue #528.
//
// The load-bearing half of `issueCreate`. A verb that can attach labels to a NEW
// issue is one config key away from letting an agent open its own ticket, approve
// it, and satisfy `issue-link` on a PR nobody ruled on.
//
// These pin the refusal AND the two ways a hardcoded literal would have been inert
// without anyone noticing: a consumer who renames the label, and every GitLab
// consumer, for whom the scoped form would simply not match.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { assertNoApprovalLabel } from './approval-deny.mjs';
import * as github from '../../axes/vcs/adapters/github.mjs';
import * as gitlab from '../../axes/vcs/adapters/gitlab.mjs';

test('#528: the default approval label is refused', () => {
  assert.throws(
    () => assertNoApprovalLabel(['type:bug', 'status:approved'], { provider: 'github' }),
    /refusing to create an issue carrying "status:approved"/,
  );
});

test('#528: ordinary labels pass through untouched', () => {
  assert.doesNotThrow(() => assertNoApprovalLabel(['type:bug', 'priority:high'], { provider: 'github' }));
  assert.doesNotThrow(() => assertNoApprovalLabel([], { provider: 'github' }));
  assert.doesNotThrow(() => assertNoApprovalLabel(undefined, { provider: 'github' }));
});

// A literal `'status:approved'` would be inert here — GitLab's approval label is the
// SCOPED form, so the guard would refuse nothing on that provider while passing every
// test written against GitHub. That is "green in test, inert in production", the exact
// class epic #335 exists to close.
test('#528: GitLab\'s SCOPED form is refused, and the unscoped one is not the approval label there', () => {
  assert.throws(
    () => assertNoApprovalLabel(['status::approved'], { provider: 'gitlab' }),
    /status::approved/,
  );
  assert.doesNotThrow(
    () => assertNoApprovalLabel(['status:approved'], { provider: 'gitlab' }),
    'on GitLab the unscoped form is not the approval label — actor-check does not accept it either',
  );
});

// The product must not hardcode what the consumer declares — the rule #454 settled
// for `agentActors`, applied to the label.
test('#528: a consumer who renames governance.approvedLabel is still guarded', () => {
  const config = { governance: { approvedLabel: 'listo:firmado' } };
  assert.throws(() => assertNoApprovalLabel(['listo:firmado'], { config, provider: 'github' }), /listo:firmado/);
  assert.doesNotThrow(
    () => assertNoApprovalLabel(['status:approved'], { config, provider: 'github' }),
    'and the default stops being the approval label once renamed — the guard follows the config, not a memory of it',
  );
});

test('#528: case does not defeat it — the guard is not a spelling test', () => {
  assert.throws(() => assertNoApprovalLabel(['Status:Approved'], { provider: 'github' }), /Status:Approved/);
});

// The STRUCTURAL lock the ticket asks for: both providers must call it. A comment
// saying "do not pass this label" is not a guard, and neither is a refusal only one
// adapter performs.
for (const [name, mod] of [['github', github], ['gitlab', gitlab]]) {
  test(`#528: ${name}.issueCreate REFUSES the approval label before any transport call`, async () => {
    const label = name === 'gitlab' ? 'status::approved' : 'status:approved';
    // No transport is injected. If the refusal did not fire first, the call would
    // reach the network seam and fail differently — which is itself the assertion.
    await assert.rejects(
      () => mod.issueCreate({ project: 'a/b', title: 't', labels: [label] }),
      /refusing to create an issue carrying/,
      'the refusal must precede the write, not clean up after it',
    );
  });
}

// It THROWS rather than filtering. Silently dropping the label would create the issue
// and report success while the caller believed it had approved something.
test('#528: the refusal is loud — the label is never silently dropped', async () => {
  await assert.rejects(
    () => github.issueCreate({ project: 'a/b', title: 't', labels: ['type:bug', 'status:approved'] }),
    (err) => {
      assert.match(err.message, /HUMAN signature/);
      assert.match(err.message, /#124/);
      return true;
    },
  );
});
