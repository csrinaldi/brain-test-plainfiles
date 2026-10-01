// actor-check.test.mjs — Unit tests for evaluateActor (REQ-L5-1, REQ-L5-2, design §5)
// and the gh I/O wrapper + CLI. Run with: npm test (node --test).
//
// Wrapper tests use plain-data fakes injected via `deps` — no test spawns a real
// `gh` process (CI-fragility discipline, same as run-check.test.mjs and
// phase-order-check.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setSpawn } from './lib/exec.mjs';
import { renderDecision } from '../review/lib/decision-block.mjs';
import { testTmp } from '../lib/test-tmp.mjs';

import {
  denyingList,
  evaluateActor,
  extractIssueNumber,
  filterLabeledEvents,
  gatherActorCheckInputs,
  runActorCheck,
  compareTimestamps,
  evaluateSignedDecision,
  describeUnevaluatedSignedEvidence,
  LITE_SIGNED_EVIDENCE_SOURCES,
  resolveHeadSha,
  main,
} from './actor-check.mjs';

// ── Pure evaluator — evaluateActor (design §5 step 5) ─────────────────────────

test('self-approval: actor === author, not allow-listed, no admin override → fail', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' } }],
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /self/i);
});

test('botAllowlist: actor in botAllowlist → pass, even though actor !== author', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'release-bot' } }],
    botAllowlist: ['release-bot'],
  });
  assert.equal(result.level, 'pass');
});

test('botAllowlist: actor in botAllowlist → pass, even when actor === author', () => {
  // A bot account could coincide with the author field in edge cases (e.g.
  // automated PRs) — allow-listing is authoritative over the self-match check.
  const result = evaluateActor({
    author: 'release-bot',
    labeledEvents: [{ actor: { login: 'release-bot' } }],
    botAllowlist: ['release-bot'],
  });
  assert.equal(result.level, 'pass');
});

test('adminOverride: allow-listed override:* label present → pass, logged', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' } }],
    adminOverride: true,
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /override/i);
});

test('no labeled event found for status:approved → warn + pass (never fail on missing evidence)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [],
  });
  assert.equal(result.level, 'warn');
  assert.match(result.reason, /no.*labeled.*event/i);
});

test('re-labeling: most recent labeled event\'s actor wins (remove -> re-add)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [
      { actor: { login: 'alice' } }, // original self-applied label, later removed
      { actor: { login: 'bob' } }, // re-added by a human reviewer — this one counts
    ],
  });
  assert.equal(result.level, 'pass');
});

test('re-labeling: most recent labeled event is the self-applied one → fail', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [
      { actor: { login: 'bob' } }, // an earlier, valid human approval
      { actor: { login: 'alice' } }, // re-applied by the author afterwards — this one counts
    ],
  });
  assert.equal(result.level, 'fail');
});

test('human-applied approval, actor differs from author → pass', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'bob' } }],
  });
  assert.equal(result.level, 'pass');
});

// ── FIX2: actor must be compared against the PR author OR the issue author ────
//
// REQ-L5-1 (spec.md:398-400) requires failing when the approval actor equals
// "the PR author or the issue author" — two distinct entities. The Bob/Alice
// gap: Bob files issue #N, Alice opens the PR, Bob self-labels his own issue
// status:approved → actor "bob" !== prAuthor "alice", so a check that only
// compares against the PR author wrongly PASSes.

test('FIX2: actor === issueAuthor (distinct from PR author), not bot/override → fail (Bob/Alice self-approval via issue author)', () => {
  const result = evaluateActor({
    author: 'alice', // PR author
    issueAuthor: 'bob', // issue author
    labeledEvents: [{ actor: { login: 'bob' } }],
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /self/i);
});

test('FIX2: actor === issueAuthor but issueAuthor is allow-listed → pass', () => {
  const result = evaluateActor({
    author: 'alice',
    issueAuthor: 'release-bot',
    labeledEvents: [{ actor: { login: 'release-bot' } }],
    botAllowlist: ['release-bot'],
  });
  assert.equal(result.level, 'pass');
});

test('FIX2 regression: actor === PR author still fails, even with a distinct third-party issueAuthor present', () => {
  const result = evaluateActor({
    author: 'alice',
    issueAuthor: 'carol',
    labeledEvents: [{ actor: { login: 'alice' } }],
  });
  assert.equal(result.level, 'fail');
});

test('FIX2: actor differs from both PR author and issue author → pass', () => {
  const result = evaluateActor({
    author: 'alice',
    issueAuthor: 'bob',
    labeledEvents: [{ actor: { login: 'carol' } }],
  });
  assert.equal(result.level, 'pass');
});

// FIX1 fail-open guard (unpaginated gh api list fetch truncates to page 1) now
// lives with the code it guards: EXTRACTED into github.mjs#labelEvents (issue
// #239 A3, the m3 close) — see providers.test.mjs's
// "github.labelEvents source includes --paginate" source-scan.

// ── extractIssueNumber (reuses the issue-link extraction rules, governance.yml) ─

test('extractIssueNumber: base=main requires a closing keyword (Closes/Fixes/Resolves #N)', () => {
  assert.equal(extractIssueNumber('Closes #144', 'main'), 144);
  assert.equal(extractIssueNumber('fixes #7 and more', 'main'), 7);
  assert.equal(extractIssueNumber('Resolved #99', 'main'), 99);
});

test('extractIssueNumber: base=main with only "Part of #N" → null (not a closing keyword)', () => {
  assert.equal(extractIssueNumber('Part of #144', 'main'), null);
});

test('extractIssueNumber: base!=main (slice PR) accepts "Part of #N"', () => {
  assert.equal(extractIssueNumber('Part of #144', 'feat/tracker'), 144);
});

test('extractIssueNumber: base!=main also accepts a closing keyword', () => {
  assert.equal(extractIssueNumber('Closes #144', 'feat/tracker'), 144);
});

test('extractIssueNumber: no match anywhere → null', () => {
  assert.equal(extractIssueNumber('no issue reference here', 'main'), null);
  assert.equal(extractIssueNumber('', 'feat/tracker'), null);
});

// ── gh I/O wrapper — gatherActorCheckInputs (DI fakes, no real gh) ──────────────

function makeFakeDeps({ labeledEvents = [], issueLabels = [], issueAuthor = null, botAllowlist = [] } = {}) {
  return {
    fetchLabeledEvents: () => labeledEvents,
    fetchIssue: () => ({ labels: issueLabels, author: issueAuthor }),
    readBotAllowlist: () => botAllowlist,
  };
}

test('gatherActorCheckInputs: resolves issue number, fetches labeled events + issue (labels + author), reads allowlist', async () => {
  const deps = makeFakeDeps({
    labeledEvents: [{ actor: { login: 'bob' } }],
    issueLabels: ['status:approved'],
    issueAuthor: 'carol',
    botAllowlist: ['release-bot'],
  });
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    deps,
  });
  assert.equal(inputs.author, 'alice');
  assert.equal(inputs.issueAuthor, 'carol');
  assert.deepEqual(inputs.labeledEvents, [{ actor: { login: 'bob' } }]);
  assert.deepEqual(inputs.botAllowlist, ['release-bot']);
  assert.equal(inputs.adminOverride, false);
});

test('gatherActorCheckInputs: adminOverride true only when an override:* label is BOTH present and allow-listed', async () => {
  const deps = makeFakeDeps({
    labeledEvents: [{ actor: { login: 'alice' } }],
    issueLabels: ['status:approved', 'override:incident-response'],
    botAllowlist: ['override:incident-response'],
  });
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    deps,
  });
  assert.equal(inputs.adminOverride, true);
});

test('gatherActorCheckInputs: an override:* label present but NOT allow-listed does not grant adminOverride (no blanket bypass)', async () => {
  const deps = makeFakeDeps({
    labeledEvents: [{ actor: { login: 'alice' } }],
    issueLabels: ['status:approved', 'override:unlisted'],
    botAllowlist: [],
  });
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    deps,
  });
  assert.equal(inputs.adminOverride, false);
});

// ── tier-scoped override:* (issue #358 Q5, REQ-TIER-6) ─────────────────────

test('gatherActorCheckInputs: regulated tier refuses an allow-listed override:* label — adminOverride false, overrideRefused true', async () => {
  const deps = makeFakeDeps({
    labeledEvents: [{ actor: { login: 'alice' } }],
    issueLabels: ['status:approved', 'override:incident-response'],
    botAllowlist: ['override:incident-response'],
  });
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    tier: 'regulated',
    deps,
  });
  assert.equal(inputs.adminOverride, false, 'regulated must never honor override:*');
  assert.equal(inputs.overrideRefused, true, 'the refusal must be surfaced, never silent');
});

test('evaluateActor: regulated + an allow-listed override:* still fails self-approval, naming the tier refusal (REQ-TIER-6)', () => {
  const result = evaluateActor({
    author: 'alice',
    issueAuthor: 'alice',
    labeledEvents: [{ actor: { login: 'alice' } }],
    botAllowlist: [],
    adminOverride: false,
    overrideRefused: true,
    tier: 'regulated',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /self-approval/);
  assert.match(result.reason, /not honored at the "regulated" tier/);
});

test('evaluateActor: lite tier with NO override label present passes on evidence, verdict never mentions override (design §4, "lite passes on its own evidence")', () => {
  const result = evaluateActor({
    author: 'alice',
    issueAuthor: 'bob',
    labeledEvents: [{ actor: { login: 'carol' }, at: '2024-01-01T00:10:00Z' }],
    commits: [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:00:00Z' }],
    botAllowlist: [],
    adminOverride: false,
    overrideRefused: false,
    tier: 'lite',
  });
  assert.equal(result.level, 'pass');
  assert.doesNotMatch(result.reason, /override/i);
});

// ── REQ-L5-1′: evidence tiering (issue #358 Q5 Phase 4) ────────────────────
//
// `lite` evaluates ONLY the distinct-act evidence (evaluateDistinctAct):
// self-approval is not checked — a solo maintainer applying their own
// approval strictly after their own push passes. `standard`/`regulated` keep
// the pre-tiering distinct-actor (self-approval) check UNCHANGED
// (REQ-TIER-10's no-op-migration guarantee — see the tests above, which
// never supply `commits` and still exercise `standard`'s behavior via the
// default tier). `regulated` additionally requires the approver to have
// authored no commit on the branch.

test('compareTimestamps: label strictly after the head commit → true', () => {
  assert.equal(compareTimestamps('2024-01-01T00:10:00Z', '2024-01-01T00:00:00Z'), true);
});

test('compareTimestamps: label at or before the head commit → false', () => {
  assert.equal(compareTimestamps('2024-01-01T00:00:00Z', '2024-01-01T00:00:00Z'), false);
  assert.equal(compareTimestamps('2023-12-31T23:00:00Z', '2024-01-01T00:00:00Z'), false);
});

test('compareTimestamps: either timestamp missing → null (uncomputable, never assumed)', () => {
  assert.equal(compareTimestamps(undefined, '2024-01-01T00:00:00Z'), null);
  assert.equal(compareTimestamps('2024-01-01T00:00:00Z', undefined), null);
  assert.equal(compareTimestamps(null, null), null);
});

test('evaluateActor: lite — solo maintainer self-applies the approved label strictly after their own head-commit push → pass on distinct-act (design §4/REQ-L5-1′, #329)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:10:00Z' }],
    commits: [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:00:00Z' }],
    tier: 'lite',
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /distinct-act/i);
});

// AMENDED by ADR-0026 Amendment 1 (#418): this pinned the pre-amendment rule
// with the approver's OWN commit, which no longer re-arms. The intent —
// "approval before the code is not an approval" — is unchanged and still
// enforced, but only over FOREIGN commits, so the case is restated with a
// third-party author. The approver-authored variant is now REQ-418-2 below.
test('evaluateActor: lite — approval applied BEFORE a FOREIGN commit was pushed → fail (approval before the code is not an approval)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: 'mallory', at: '2024-01-01T00:10:00Z' }],
    tier: 'lite',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /not strictly after/i);
});

// PR #503 cold-review round 1, finding 3: a caller that never threads the
// `decisions` field at all (issue #473 pre-existed this field) must get the
// BYTE-IDENTICAL reason string it got before issue #473 landed — no
// `(brain-decision/1: ...)` annotation appended. The expected string below is
// copied verbatim from the true base branch's (feat/issue-473-s1-parser-
// extraction, pre-slice-2) `evaluateActor` output for this exact fixture —
// derived by running that file's own `evaluateActor`, not guessed. `decisions`
// is absent from the input object (not `null`): that is the LEGACY state — a
// caller that fetched nothing and never intended to. `decisions === null`
// (fetch attempted, uncomputable) legitimately still annotates, unchanged.
test('evaluateActor: lite — legacy caller with NO `decisions` field at all → reason is byte-identical to pre-#473 base (no brain-decision/1 annotation)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: 'mallory', at: '2024-01-01T00:10:00Z' }],
    tier: 'lite',
  });
  assert.equal(result.level, 'fail');
  assert.equal(
    result.reason,
    'the approved label was applied at 2024-01-01T00:00:00Z, not strictly after the latest foreign commit — ' +
      'authored by "mallory" and pushed at 2024-01-01T00:10:00Z — so the approval predates work the approver has ' +
      'not seen. Re-apply the approved label after reviewing that commit (REQ-L5-1′ "lite" evidence, ADR-0026 ' +
      'Amendment 1).',
  );
});

// ── ADR-0026 Amendment 1 / issue #418 — re-arm only on foreign commits ──────
//
// At `lite` the approver is ALLOWED to be the author, so comparing against
// the head commit asked "did you keep working on your own branch" — linear
// cost, near-zero value at n=1, and a structural blocker for the automated
// review loop (#409). The comparison target moves to the latest FOREIGN
// commit: authored by neither the approver nor a registered
// `governance.reviewActors` identity. The `reviewActors` exemption is only
// safe because #413 made the reviewer identity verifiable against its token.

test('evaluateActor: lite — the approver\'s OWN later pushes do not re-arm the approval (REQ-418-2, #418)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [
      { sha: 'abc', login: 'alice', at: '2024-01-01T00:10:00Z' },
      { sha: 'def', login: 'alice', at: '2024-01-01T00:20:00Z' },
    ],
    tier: 'lite',
  });
  assert.equal(result.level, 'pass', 'the approver signing their own later commits certifies nothing new');
  assert.match(result.reason, /no push re-arms/i);
});

// ── #581: REQ-418-3 is NARROWED — reviewActors loses the exemption ─────────
//
// Maintainer ruling 2026-08-12: `reviewActors` is READ-ONLY. A read-only
// identity authors no commits, so the exemption is inert in the state it was
// written for and fail-open in the only state where it can fire: a commit
// appearing under a review identity (a compromised token, a misregistration)
// is exactly when the re-arm rule should trigger, and the exemption was what
// stopped it — leaving an approval green over a commit no human saw.
//
// The originating rationale of Amendment 1 survives intact in `agentActors`,
// which is the key it actually describes: "commits the approver's own agent
// made under their instruction." A read-only reviewer was never that.

test('#581: lite — a registered reviewActors identity\'s push DOES re-arm the approval (narrows REQ-418-3)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: 'csrinaldibot', at: '2024-01-01T00:10:00Z' }],
    denyActors: ['csrinaldibot'], // governance.reviewActors
    tier: 'lite',
  });
  assert.equal(result.level, 'fail',
    'a read-only identity has no commits to exempt — a commit under one is off-nominal, and that is ' +
    'precisely when the approval must be re-armed rather than carried over');
});

test('#581: the pass message no longer advertises a reviewActors exemption that does not exist', () => {
  // A reason string that claims an exemption the predicate no longer grants is
  // report-vs-tree drift on a security message — the reader is told the gate
  // does something it does not.
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:10:00Z' }],
    denyActors: ['csrinaldibot'],
    tier: 'lite',
  });
  assert.equal(result.level, 'pass');
  assert.doesNotMatch(result.reason, /reviewActors/,
    `the exemption is gone; the message must not still claim it: ${result.reason}`);
});

test('#581 blast radius: the agentActors exemption is UNTOUCHED (Amendment 3 survives)', () => {
  // If this goes red, the wrong exemption was removed. Amendment 3's rationale
  // is the one that still holds: an agent acting inside the approved loop under
  // the approver's instruction is not work the approver has not seen.
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: 'alice-agent', at: '2024-01-01T00:10:00Z' }],
    agentActors: ['alice-agent'],
    tier: 'lite',
  });
  assert.equal(result.level, 'pass', 'agentActors still exempts — Amendment 3 is not in scope of #581');
});

test('evaluateActor: lite — a THIRD-PARTY push still re-arms; the stale-green property survives (REQ-418-1, #418)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [
      { sha: 'abc', login: 'alice', at: '2024-01-01T00:05:00Z' },
      { sha: 'def', login: 'mallory', at: '2024-01-01T00:10:00Z' },
    ],
    denyActors: ['csrinaldibot'],
    tier: 'lite',
  });
  assert.equal(result.level, 'fail', 'work the approver has not seen must still invalidate the approval');
});

// Negative control: green on BOTH the pre- and post-amendment code by design.
// It pins that the exemption never reaches an identity the platform cannot
// vouch for — the guard against an over-permissive relaxation, the same class
// as #413's case-insensitivity control.
test('evaluateActor: lite — unresolvable commit authorship counts as FOREIGN and re-arms (REQ-418-4, #418)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: null, at: '2024-01-01T00:10:00Z' }], // GitLab / unattributed author
    tier: 'lite',
  });
  assert.equal(result.level, 'fail', 'relief must never extend to an identity the provider cannot resolve');
});

test('evaluateActor: lite — no foreign commit at all → any approval event satisfies the evidence (REQ-418-5, #418)', () => {
  const result = evaluateActor({
    author: 'alice',
    // Label predates every commit — under the pre-amendment rule this failed.
    labeledEvents: [{ actor: { login: 'alice' }, at: '2023-12-31T00:00:00Z' }],
    commits: [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:10:00Z' }],
    tier: 'lite',
  });
  assert.equal(result.level, 'pass');
});

test('evaluateActor: lite — logins fold case; a case-different approver login is the same account (REQ-418-4, #418)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'Alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:10:00Z' }],
    tier: 'lite',
  });
  assert.equal(result.level, 'pass', 'refusing on case alone would be a false positive');
});

test('evaluateActor: lite — the refusal names the foreign author and its timestamp (REQ-418-7, #418)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'def', login: 'mallory', at: '2024-01-01T00:10:00Z' }],
    tier: 'lite',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /mallory/, 'the operator must be able to tell WHICH commit to review');
  assert.match(result.reason, /2024-01-01T00:10:00Z/);
  assert.match(result.reason, /re-apply the approved label/i, 'the next action must be derivable from the message');
});

test('evaluateActor: standard — a reviewActors identity\'s push does NOT exempt anything (REQ-418-6, #418)', () => {
  // The amendment is lite-only. At standard the approver is never the author,
  // so the distinct-actor rule and its message must be untouched.
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:10:00Z' }],
    commits: [{ sha: 'abc', login: 'csrinaldibot', at: '2024-01-01T00:00:00Z' }],
    denyActors: [],
    tier: 'standard',
  });
  assert.equal(result.level, 'fail', 'standard still refuses self-approval regardless of who pushed');
  assert.match(result.reason, /self-applied/i);
});

test('evaluateActor: lite — commits uncomputable (null) → fail closed (an unreadable approval is not an approval)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:10:00Z' }],
    commits: null,
    tier: 'lite',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /unreadable/i);
});

test('evaluateActor: lite — label event carries no timestamp → fail closed', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' } }], // no `at`
    commits: [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:00:00Z' }],
    tier: 'lite',
  });
  assert.equal(result.level, 'fail');
});

test('evaluateActor: regulated — distinct actor passes self-approval, but the approver also authored a commit on the branch → fail (REQ-L5-1′)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'bob' }, at: '2024-01-01T00:10:00Z' }],
    commits: [
      { sha: 'a1', login: 'alice', at: '2023-12-31T00:00:00Z' },
      { sha: 'b2', login: 'bob', at: '2024-01-01T00:00:00Z' }, // bob (the approver) pushed a commit earlier
    ],
    tier: 'regulated',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /authored at least one commit/i);
});

test('evaluateActor: regulated — distinct actor AND no commit authored by the approver → pass', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'bob' }, at: '2024-01-01T00:10:00Z' }],
    commits: [{ sha: 'a1', login: 'alice', at: '2023-12-31T00:00:00Z' }],
    tier: 'regulated',
  });
  assert.equal(result.level, 'pass');
});

test('evaluateActor: regulated — commit authorship uncomputable (e.g. GitLab\'s all-null logins) → warn, never a false fail', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'bob' }, at: '2024-01-01T00:10:00Z' }],
    commits: [{ sha: 'a1', login: null, at: '2023-12-31T00:00:00Z' }],
    tier: 'regulated',
  });
  assert.equal(result.level, 'warn');
});

test('evaluateActor: standard — unchanged, self-approval fails with no commits/timestamp evidence supplied at all (REQ-TIER-10 no-op-migration guarantee)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' } }], // no `at`, no `commits` — must not matter at standard
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /self/i);
});

// ── gatherActorCheckInputs: commits are fetched only when the tier needs them ──

test('gatherActorCheckInputs: standard tier never calls fetchCommits (REQ-TIER-10 no-op-migration guarantee)', async () => {
  let fetchCommitsCalled = false;
  const deps = {
    ...makeFakeDeps({ labeledEvents: [{ actor: { login: 'bob' } }] }),
    fetchCommits: () => { fetchCommitsCalled = true; return []; },
  };
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    prNumber: 7,
    tier: 'standard',
    deps,
  });
  assert.equal(fetchCommitsCalled, false, 'standard must never fetch commits — it is not part of its evidence form');
  assert.equal(inputs.commits, null);
});

test('gatherActorCheckInputs: lite tier fetches commits via the injected fetchCommits when a prNumber is available', async () => {
  const fakeCommits = [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:00:00Z' }];
  const deps = {
    ...makeFakeDeps({ labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:10:00Z' }] }),
    fetchCommits: prNumber => { assert.equal(prNumber, 7); return fakeCommits; },
  };
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    prNumber: 7,
    tier: 'lite',
    deps,
  });
  assert.deepEqual(inputs.commits, fakeCommits);
});

test('gatherActorCheckInputs: regulated tier fetches commits via the injected fetchCommits', async () => {
  const fakeCommits = [{ sha: 'abc', login: 'bob', at: '2024-01-01T00:00:00Z' }];
  const deps = {
    ...makeFakeDeps({ labeledEvents: [{ actor: { login: 'carol' } }] }),
    fetchCommits: () => fakeCommits,
  };
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    prNumber: 7,
    tier: 'regulated',
    deps,
  });
  assert.deepEqual(inputs.commits, fakeCommits);
});

test('gatherActorCheckInputs: lite tier with no resolvable prNumber → commits stays null (never throws)', async () => {
  const deps = makeFakeDeps({ labeledEvents: [{ actor: { login: 'alice' } }] });
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    tier: 'lite',
    deps,
  });
  assert.equal(inputs.commits, null);
});

// ── runActorCheck: lite end-to-end through the wrapper (ctx.prNumber wiring) ──

test('runActorCheck: lite end-to-end — ctx.prNumber feeds gatherActorCheckInputs, distinct-act evidence passes', async () => {
  const deps = {
    ctx: { author: 'alice', repo: 'org/repo', targetBranch: 'main', body: 'Closes #144', prNumber: 7 },
    tier: 'lite',
    fetchLabeledEvents: () => [{ actor: { login: 'alice' }, at: '2024-01-01T00:10:00Z' }],
    fetchIssue: () => ({ labels: ['status:approved'], author: 'alice' }),
    fetchCommits: () => [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:00:00Z' }],
    readBotAllowlist: () => [],
  };
  const result = await runActorCheck(deps);
  assert.equal(result.level, 'pass');
});

test('gatherActorCheckInputs: no resolvable issue number → empty labeledEvents + null issueAuthor (feeds the warn+pass branch)', async () => {
  const deps = makeFakeDeps({ labeledEvents: [{ actor: { login: 'bob' } }] });
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'no issue reference',
    baseBranch: 'main',
    repo: 'org/repo',
    deps,
  });
  assert.deepEqual(inputs.labeledEvents, []);
  assert.equal(inputs.issueAuthor, null);
});

// ── FIX2 wiring: gatherActorCheckInputs must surface issueAuthor ───────────────
//
// The wrapper already fetches the issue object to read its labels; the issue
// author (`issue.user.login`) must be surfaced from that SAME call, not a
// second gh round-trip.

test('FIX2: gatherActorCheckInputs surfaces issueAuthor from the same fetchIssue call used for labels (no second API round-trip)', async () => {
  let fetchIssueCallCount = 0;
  const deps = {
    fetchLabeledEvents: () => [{ actor: { login: 'bob' } }],
    fetchIssue: () => {
      fetchIssueCallCount += 1;
      return { labels: ['status:approved'], author: 'bob' };
    },
    readBotAllowlist: () => [],
  };
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    deps,
  });
  assert.equal(inputs.issueAuthor, 'bob');
  assert.equal(fetchIssueCallCount, 1, 'issue must be fetched exactly once — labels and author come from the same call');
});

test('FIX2 end-to-end: Bob files the issue, Alice opens the PR, Bob self-labels his own issue status:approved → fail', async () => {
  const deps = {
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    // Pinned to 'standard' — see the "main: pass verdict" comment above
    // (issue #358 Q5 Phase 4): this test is about the distinct-actor
    // self-approval check, not tier-scoped evidence ('lite' does not
    // evaluate self-approval at all — this repo's own brain.config.json
    // declares 'lite', so an unpinned tier would silently exercise a
    // different evidence form here).
    tier: 'standard',
    fetchLabeledEvents: () => [{ actor: { login: 'bob' } }],
    fetchIssue: () => ({ labels: ['status:approved'], author: 'bob' }),
    readBotAllowlist: () => [],
  };
  const result = await runActorCheck(deps);
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /self/i);
});

// ── runActorCheck / main — never throws; a gh failure fails closed when the ──
// gate is required (issue #358 Q5 Phase 5 review finding 1) ───────────────────
//
// runActorCheck/gatherActorCheckInputs/main are async as of A3 (they await the
// labelEvents CONTRACT verb dispatched via getVcs — a Promise-returning call);
// tests here await them directly instead of asserting a synchronous throw.
//
// `actor-check` is `required` at EVERY tier (GATE_MATRIX, REQ-TIER-2's
// never-tiered core) — so an API failure now fails closed regardless of
// tier, matching evaluateDistinctAct's existing fail-closed handling of an
// unreadable `prCommits`. This CHANGES prior behavior (was: unconditional
// warn) — the asymmetry finding this fixes.

test('runActorCheck: gh api failure inside the wrapper → fail closed, never throws (actor-check is required at every tier)', async () => {
  const deps = {
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    tier: 'standard',
    fetchLabeledEvents: () => {
      throw new Error('gh api failed: rate limited');
    },
    fetchIssue: () => ({ labels: ['status:approved'], author: 'bob' }),
    readBotAllowlist: () => [],
  };
  const result = await runActorCheck(deps);
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /rate limited/);
  assert.match(result.reason, /failing closed/i);
});

test('runActorCheck: gh api failure at "lite" tier ALSO fails closed (actor-check never demotes)', async () => {
  const deps = {
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    tier: 'lite',
    prNumber: 7,
    fetchCommits: () => {
      throw new Error('gh api failed: rate limited');
    },
    fetchLabeledEvents: () => [],
    fetchIssue: () => ({ labels: [], author: 'bob' }),
    readBotAllowlist: () => [],
  };
  const result = await runActorCheck(deps);
  assert.equal(result.level, 'fail');
});

test('runActorCheck: gh api failure resolves the tier from readConfig when deps.tier is absent, defaulting to "standard" (fail-closed-safe) on a broken config', async () => {
  const deps = {
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    readConfig: () => {
      throw new Error('ENOENT: no such file');
    },
    fetchLabeledEvents: () => {
      throw new Error('gh api failed: rate limited');
    },
    fetchIssue: () => ({ labels: ['status:approved'], author: 'bob' }),
    readBotAllowlist: () => [],
  };
  const result = await runActorCheck(deps);
  assert.equal(result.level, 'fail');
});

test('runActorCheck: missing PR_AUTHOR/repo context → warn + pass, never throws', async () => {
  const result = await runActorCheck({ author: undefined, repo: undefined });
  assert.equal(result.level, 'warn');
});

test('runActorCheck: happy path end-to-end through the wrapper — human approval passes', async () => {
  const deps = {
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    // Pinned to 'standard' — see the "main: pass verdict" comment above
    // (issue #358 Q5 Phase 4).
    tier: 'standard',
    fetchLabeledEvents: () => [{ actor: { login: 'bob' } }],
    fetchIssue: () => ({ labels: ['status:approved'], author: 'alice' }),
    readBotAllowlist: () => [],
  };
  const result = await runActorCheck(deps);
  assert.equal(result.level, 'pass');
});

// ── main() / CLI — exit code mapping ────────────────────────────────────────────

async function captureLogs(fn) {
  const lines = [];
  const orig = console.log;
  console.log = msg => lines.push(msg);
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}

test('main: fail verdict → exit code 1', async () => {
  const deps = {
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    fetchLabeledEvents: () => [{ actor: { login: 'alice' } }],
    fetchIssue: () => ({ labels: ['status:approved'], author: 'alice' }),
    readBotAllowlist: () => [],
  };
  let exitCode;
  const lines = await captureLogs(async () => {
    exitCode = await main(deps);
  });
  assert.equal(exitCode, 1);
  assert.equal(lines[0], 'actor-check: fail');
});

test('main: warn verdict → exit code 0', async () => {
  const deps = {
    author: 'alice',
    prBody: 'no issue reference',
    baseBranch: 'main',
    repo: 'org/repo',
    fetchLabeledEvents: () => [{ actor: { login: 'bob' } }],
    fetchIssue: () => ({ labels: [], author: null }),
    readBotAllowlist: () => [],
  };
  let exitCode;
  const lines = await captureLogs(async () => {
    exitCode = await main(deps);
  });
  assert.equal(exitCode, 0);
  assert.equal(lines[0], 'actor-check: warn');
});

test('main: pass verdict → exit code 0', async () => {
  const deps = {
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    // Pinned to 'standard' (issue #358 Q5 Phase 4): this repo's own
    // brain.config.json declares "tier": "lite" (design.md §5), and this test
    // is about the wrapper's exit-code mapping, not tier-scoped evidence — an
    // unpinned tier would silently pick up the real repo's 'lite' evidence
    // form (distinct-act) instead of the distinct-actor check this test means
    // to exercise.
    tier: 'standard',
    fetchLabeledEvents: () => [{ actor: { login: 'bob' } }],
    fetchIssue: () => ({ labels: ['status:approved'], author: 'alice' }),
    readBotAllowlist: () => [],
  };
  let exitCode;
  const lines = await captureLogs(async () => {
    exitCode = await main(deps);
  });
  assert.equal(exitCode, 0);
  assert.equal(lines[0], 'actor-check: pass');
});

// ── D2 pins (#905, spec.md "actor-check stays unmodified", ruling D2) ───────
//
// `actor-check` gains NO lane-specific code: a lane PR already warns and
// exits 0 today (no issue number in the body → `labeledEvents: []` →
// `evaluateActor` returns `warn` → `main()` maps anything not `fail` to exit
// 0), and `denyActors` = `governance.reviewActors` = `[csrinaldibot]` IS the
// unattended lane's poster identity — an author-side deny check would fail
// every unattended lane. These are NEW named tests even though both
// assertions are already true today: RED here means "the assertion is absent
// from the file", not "the code fails it" — once added they are green
// without touching actor-check.mjs.

test('D2 pin: a lane-shaped PR body (no issue number) → evaluateActor returns warn, main() exits 0', async () => {
  const deps = {
    author: 'csrinaldibot',
    prBody: 'memory: host1 2026-09-10 (2 records)', // no issue reference at all
    baseBranch: 'main',
    repo: 'org/repo',
    fetchLabeledEvents: () => { throw new Error('must not be called — no issue number to fetch events for'); },
    fetchIssue: () => { throw new Error('must not be called — no issue number extracted'); },
    readBotAllowlist: () => [],
  };
  let exitCode;
  const lines = await captureLogs(async () => {
    exitCode = await main(deps);
  });
  assert.equal(exitCode, 0);
  assert.equal(lines[0], 'actor-check: warn');
});

test('D2 pin: a labeled PR whose approver is in denyActors → evaluateActor returns fail, main() exits 1', async () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'csrinaldibot' } }],
    denyActors: ['csrinaldibot'], // governance.reviewActors
  });
  assert.equal(result.level, 'fail');

  const deps = {
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    tier: 'standard',
    fetchLabeledEvents: () => [{ actor: { login: 'csrinaldibot' } }],
    fetchIssue: () => ({ labels: ['status:approved'], author: 'alice' }),
    readBotAllowlist: () => [],
    readDenyActors: () => ['csrinaldibot'],
  };
  let exitCode;
  const lines = await captureLogs(async () => {
    exitCode = await main(deps);
  });
  assert.equal(exitCode, 1);
  assert.equal(lines[0], 'actor-check: fail');
});

// ── ci-context seam wiring (ADR-0016) ─────────────────────────────────────────
//
// `author`, `prBody`, `baseBranch`, `repo` now source from an injected
// `deps.ctx` (built by ci-context.mjs's loadContext()) instead of
// process.env.PR_AUTHOR/PR_BODY/BASE_BRANCH/GITHUB_REPOSITORY. `deps.author`
// etc. still take precedence (existing tests above never pass `ctx` and are
// unaffected). Per CP-A0 ruling 1, `author` now means the PR AUTHOR sourced
// from the API payload (ctx.author) — never PR_AUTHOR env.

test('ci-context seam: ctx.author/ctx.repo/ctx.targetBranch feed the wrapper when deps.author/repo/baseBranch are absent', async () => {
  const deps = {
    ctx: { author: 'alice', repo: 'org/repo', targetBranch: 'main', body: 'Closes #144' },
    // Pinned to 'standard' — see the "main: pass verdict" comment above
    // (issue #358 Q5 Phase 4): this test is about ctx-seam wiring, not
    // tier-scoped evidence.
    tier: 'standard',
    fetchLabeledEvents: () => [{ actor: { login: 'bob' } }],
    fetchIssue: () => ({ labels: ['status:approved'], author: 'alice' }),
    readBotAllowlist: () => [],
  };
  const result = await runActorCheck(deps);
  assert.equal(result.level, 'pass');
});

test('ci-context seam: no ctx.author and no deps.author → warn (never falls back to process.env.PR_AUTHOR)', async () => {
  const result = await runActorCheck({ ctx: { author: null, repo: null } });
  assert.equal(result.level, 'warn');
});

test('ci-context seam: DETECTION consumer — ctx.body null (API failure) falls back to env.PR_BODY via resolveDetectionBody', async () => {
  const deps = {
    ctx: { author: 'alice', repo: 'org/repo', targetBranch: 'main', body: null },
    env: { PR_BODY: 'Closes #144' },
    // Pinned to 'standard' — see the "main: pass verdict" comment above
    // (issue #358 Q5 Phase 4): this test is about the PR_BODY fallback, not
    // tier-scoped evidence.
    tier: 'standard',
    fetchLabeledEvents: () => [{ actor: { login: 'bob' } }],
    fetchIssue: () => ({ labels: ['status:approved'], author: 'carol' }),
    readBotAllowlist: () => [],
  };
  const result = await runActorCheck(deps);
  // extractIssueNumber only resolves an issue (and thus a non-empty labeledEvents
  // path) when prBody carries "Closes #N" — proving the PR_BODY fallback was used.
  assert.equal(result.level, 'pass');
});

test('CP-A0 ruling 1: actor-check.mjs source never reads process.env.PR_AUTHOR (author sourced from ctx.author / API payload only)', () => {
  const srcPath = fileURLToPath(new URL('./actor-check.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.equal(src.includes('process.env.PR_AUTHOR'), false, 'source must not reference process.env.PR_AUTHOR');
});

test('neutrality source-scan (REQ-NEUTRALITY-2): actor-check.mjs source contains no .claude or SKILL.md literal', () => {
  const srcPath = fileURLToPath(new URL('./actor-check.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.equal(src.includes('.claude'), false, 'source must not reference .claude');
  assert.equal(src.includes('SKILL.md'), false, 'source must not reference SKILL.md');
});

// ── REQ-A2-3 (issue #231 A2 phase 1): the approved label is config-driven ──────
//
// governance.approvedLabel (config-migrations.mjs, 0.7.0) + resolveApprovedLabel()
// (governance/approved-label.mjs) replace the hardcoded 'status:approved' literal.
// No comparison anywhere in this file may hardcode the label — it must always
// read the resolved value.

test('REQ-A2-3: actor-check.mjs source contains no literal status:approved (reads the resolved governance.approvedLabel value)', () => {
  const srcPath = fileURLToPath(new URL('./actor-check.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.equal(src.includes('status:approved'), false,
    'source must not hardcode the approved-label literal — use resolveApprovedLabel()');
});

// filterLabeledEvents (issue #239 A3, D1): became a SHARED post-filter over
// the normalized labelEvents() shape (`action`/`label` flat fields), applied
// AFTER either provider's verb normalizes — no longer the raw gh
// `{event, label:{name}}` shape.
test('filterLabeledEvents: matches only "add" events labeled with the resolved approvedLabel, not a hardcoded value', () => {
  const events = [
    { actor: { login: 'alice' }, action: 'add', label: 'status:approved', at: 'T1' },
    { actor: { login: 'bob' }, action: 'add', label: 'status::approved', at: 'T2' },
    { actor: { login: 'carol' }, action: 'remove', label: 'status:approved', at: 'T3' },
  ];
  assert.deepEqual(filterLabeledEvents(events, 'status::approved'), [events[1]]);
  assert.deepEqual(filterLabeledEvents(events, 'status:approved'), [events[0]]);
  assert.deepEqual(filterLabeledEvents(events, 'ready:approved'), []);
});

test('filterLabeledEvents: null (uncomputable labelEvents) → [] (feeds evaluateActor\'s warn branch, REQ-L5-2)', () => {
  assert.deepEqual(filterLabeledEvents(null, 'status:approved'), []);
});

test('gatherActorCheckInputs: an injected fetchLabeledEvents still wins over default resolution (provider/readConfig accepted but unused)', async () => {
  const deps = {
    fetchLabeledEvents: () => [{ actor: { login: 'bob' } }],
    fetchIssue: () => ({ labels: [], author: null }),
    readBotAllowlist: () => [],
    readConfig: () => ({ governance: { approvedLabel: 'ready:approved' } }),
  };
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    provider: 'gitlab',
    deps,
  });
  assert.deepEqual(inputs.labeledEvents, [{ actor: { login: 'bob' } }]);
});

// ── A3 labelEvents dispatch (issue #239 A3, D1/R3 — the m3 close) ─────────────
//
// Pre-A3, defaultFetchLabeledEvents was GitHub-only (`gh api` unconditionally)
// — on a GitLab runner (no `gh` binary) the call threw and the check
// permanently degraded to `warn`. A3 dispatches labelEvents via
// getVcs({ provider: ctx.provider }) (the run-check.mjs#defaultFetchIssue
// finding-#14 pattern) so GitLab EVALUATES (self-approval → fail), not just
// degrades. The pure evaluateActor is untouched — only the wrapper's
// provider-resolved fetch changes.

test('A3: GitLab self-approval — labelEvents dispatches to the gitlab provider via getVcs({provider}), evaluateActor returns fail (REQ-L5-1), not a permanent warn', async () => {
  let receivedProvider;
  const fakeVcs = {
    labelEvents: async ({ project, number }) => {
      assert.equal(project, 'g/r');
      assert.equal(number, 144);
      return [{ actor: { login: 'alice' }, action: 'add', label: 'status::approved', at: '2024-01-01T00:00:00Z' }];
    },
  };
  const result = await runActorCheck({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'g/r',
    provider: 'gitlab',
    getVcs: async (opts) => { receivedProvider = opts.provider; return fakeVcs; },
    fetchIssue: () => ({ labels: ['status::approved'], author: 'alice' }),
    readBotAllowlist: () => [],
    readConfig: () => ({}),
  });
  assert.equal(receivedProvider, 'gitlab', 'getVcs must be called with the runtime ctx.provider (finding #14)');
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /self/i);
});

test('A3: labelEvents returns null (uncomputable) → warn, never fail-closed (REQ-L5-2)', async () => {
  const fakeVcs = { labelEvents: async () => null };
  const result = await runActorCheck({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'g/r',
    provider: 'gitlab',
    getVcs: async () => fakeVcs,
    fetchIssue: () => ({ labels: [], author: null }),
    readBotAllowlist: () => [],
    readConfig: () => ({}),
  });
  assert.equal(result.level, 'warn');
});

test('A3: labelEvents returns an empty add-filtered list (only "remove" events) → warn, never fail-closed (REQ-L5-2)', async () => {
  const fakeVcs = {
    labelEvents: async () => ([
      { actor: { login: 'alice' }, action: 'remove', label: 'status::approved', at: '2024-01-01T00:00:00Z' },
    ]),
  };
  const result = await runActorCheck({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'g/r',
    provider: 'gitlab',
    getVcs: async () => fakeVcs,
    fetchIssue: () => ({ labels: [], author: null }),
    readBotAllowlist: () => [],
    readConfig: () => ({}),
  });
  assert.equal(result.level, 'warn');
});

// ── A3 TASK 1 (fresh-context review finding): defaultFetchIssue was STILL
// gh-CLI-hardcoded — gatherActorCheckInputs needs TWO fetches (labelEvents +
// fetchIssue) before evaluateActor runs; only labelEvents was migrated in the
// first pass. On GitLab CI (no `gh` binary) defaultFetchIssue's raw
// execFileSync('gh', ...) threw ENOENT, masking R3 behind a permanent `warn`
// — the exact same defect class as finding #14 (issue-link) and the
// pre-fix labelEvents wrapper, now closed a third time.
//
// Per lesson #10/#12 (injected deps prove the logic, not that the default is
// sane): this test does NOT inject deps.fetchIssue or deps.fetchLabeledEvents
// — it mocks ONE layer lower, at getVcs (the transport/dispatch layer), so
// the REAL defaultFetchIssue/defaultFetchLabeledEvents wrapper functions run
// end-to-end. A setSpawn spy proves no CLI process is ever spawned on the
// GitLab default path.

test('A3 TASK1: GitLab self-approval via the REAL default path (no injected fetchIssue/fetchLabeledEvents) — defaultFetchIssue dispatches getVcs({provider}).issueView(...), no gh/glab spawn, evaluateActor reaches fail (R3 genuinely met)', async () => {
  const calls = { issueView: null, labelEvents: null };
  const fakeVcs = {
    issueView: async (params) => {
      calls.issueView = params;
      return { number: 144, title: 'x', labels: ['status::approved'], body: 'y', author: 'alice' };
    },
    labelEvents: async (params) => {
      calls.labelEvents = params;
      return [{ actor: { login: 'alice' }, action: 'add', label: 'status::approved', at: '2024-01-01T00:00:00Z' }];
    },
  };
  let receivedProvider;
  let spawnCalled = false;
  setSpawn(() => {
    spawnCalled = true;
    return { status: 0, stdout: '{}', stderr: '' };
  });
  try {
    const result = await runActorCheck({
      author: 'alice',
      prBody: 'Closes #144',
      baseBranch: 'main',
      repo: 'g/r',
      provider: 'gitlab',
      getVcs: async (opts) => { receivedProvider = opts.provider; return fakeVcs; },
      readBotAllowlist: () => [],
      readConfig: () => ({}),
      // deliberately NOT fetchIssue/fetchLabeledEvents — exercising the REAL
      // default wrappers, not a deps-level bypass.
    });

    assert.equal(spawnCalled, false, 'the GitLab default path must never spawn a CLI process (gh/glab)');
    assert.equal(receivedProvider, 'gitlab', 'getVcs must be called with the runtime ctx.provider (finding #14)');
    assert.ok(calls.issueView, 'defaultFetchIssue must dispatch through vcs.issueView, not execFileSync(\'gh\', ...)');
    assert.equal(calls.issueView.project, 'g/r');
    assert.equal(calls.issueView.number, 144);
    assert.ok(calls.labelEvents, 'defaultFetchLabeledEvents must also have dispatched');
    assert.equal(result.level, 'fail', 'R3: GitLab self-approval must EVALUATE to fail via the real default path, not degrade to a permanent warn');
    assert.match(result.reason, /self/i);
  } finally {
    setSpawn(spawnSync);
  }
});

test('A3 TASK1 source-scan: defaultFetchIssue no longer contains execFileSync(\'gh\', ...) — structurally proves the default path cannot spawn gh regardless of provider', () => {
  const srcPath = fileURLToPath(new URL('./actor-check.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  const fnStart = src.indexOf('function defaultFetchIssue');
  assert.notEqual(fnStart, -1, 'defaultFetchIssue not found in source');
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.equal(fnBody.includes('execFileSync'), false, 'defaultFetchIssue must dispatch via getVcs(...).issueView(...), never a raw execFileSync(\'gh\', ...) call');
  assert.match(fnBody, /getVcs|issueView/, 'sanity: dispatch through the vcs adapter is present');
});

// ── REQ-266-6 t1 (issue #266, rev-2 binding condition B, lock 3) ──────────────
//
// The reviewer identity registers ONLY in governance.reviewActors, never in
// governance.approvalActors (design §3 two-key split). L5 (actor-check.mjs) is
// NOT touched by H0-b — at the time this test was written it kept reading
// governance.approvalActors only. Issue #375 later gave L5 a SECOND, DENY-only
// read of governance.reviewActors (see the `#375:` tests below) — this test
// still passes (now via the deny check, which fires before the self-approval
// check this test originally exercised) since #375 only narrows what passes,
// never widens it. This test uses a test-fixture reviewer identity, not a real
// registered handle (task 7.3 is deferred — no reviewer bot handle exists yet).

test('REQ-266-6 t1 (lock-3, issue #266): reviewer identity in governance.reviewActors (NOT governance.approvalActors) does not pass L5 via the allow-listed-automation branch when self-applying status:approved', async () => {
  const dir = testTmp('brain-config-');
  writeFileSync(join(dir, 'brain.config.json'), JSON.stringify({
    governance: {
      approvalActors: [], // the reviewer must NEVER be registered here (design §3, R2)
      reviewActors: ['brain-reviewer[bot]'], // L6-only key (test fixture identity)
    },
  }));
  const result = await runActorCheck({
    author: 'brain-reviewer[bot]',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    cwd: dir,
    fetchLabeledEvents: () => [{ actor: { login: 'brain-reviewer[bot]' } }],
    fetchIssue: () => ({ labels: ['status:approved'], author: 'brain-reviewer[bot]' }),
    // deliberately NOT injecting readBotAllowlist/readConfig — exercising the
    // REAL default reader, which sources L5's botAllowlist from
    // governance.approvalActors ONLY (never governance.reviewActors).
  });
  assert.equal(
    result.level,
    'fail',
    'the reviewer must not be admitted by the allow-listed-automation branch',
  );
  // REASON UPDATED BY ISSUE #375 — the level assertion above, which is this
  // test's load-bearing claim, is unchanged.
  //
  // Originally this asserted /self/i, because the ONLY thing that caught the
  // reviewer here was rule 5 (self-approval): the fixture makes the reviewer
  // the PR author, the issue author AND the label actor at once. That is
  // precisely why this test could not detect the gap #375 fixes — it asserted
  // the reviewer does not pass via the ALLOW-listed branch, a strictly weaker
  // claim than "it fails", and it would have passed identically with no
  // deny-set at all.
  //
  // #375 added a deny check ahead of the allow-list, so the reviewer is now
  // caught earlier and for the stronger reason. Both outcomes satisfy this
  // test's intent, so accept either rather than pinning the weaker one.
  assert.match(result.reason, /self|governance\.reviewActors/i);
});

// ── issue #375 — L5 deny-set (Option A: reviewActors read as a DENY list) ─────
//
// Why these tests exist even though #266's t1 above already touches lock 3:
// t1 sets the PR author, the issue author AND the label actor all to the same
// reviewer identity, so rule 4 (self-approval) fires and returns 'fail'. Its own
// assertion message says so — "self-approval is caught instead". t1 would pass
// identically if `reviewActors` did not exist, which is exactly why the gap
// survived undetected: it asserts the reviewer does not pass via the
// ALLOW-listed branch (rule 3), a strictly weaker claim than "it fails".
//
// These tests make the reviewer a DIFFERENT actor from both authors, so nothing
// but the deny-set can catch it.

test('#375: an actor in denyActors FAILS even when it is neither the PR author nor the issue author', () => {
  const result = evaluateActor({
    author: 'alice',
    issueAuthor: 'bob',
    labeledEvents: [{ actor: { login: 'brain-reviewer[bot]' } }],
    denyActors: ['brain-reviewer[bot]'],
  });

  // Without the deny-set this falls through to rule 5 and PASSES as
  // "human-applied approval, actor differs from both" — a property rule 5
  // asserts in prose but never verifies.
  assert.equal(result.level, 'fail', 'a denied identity must never unlock status:approved');
  assert.match(result.reason, /brain-reviewer\[bot\]/);
});

test('#375: deny beats allow — an actor in BOTH denyActors and botAllowlist FAILS (fail-closed)', () => {
  const result = evaluateActor({
    author: 'alice',
    issueAuthor: 'bob',
    labeledEvents: [{ actor: { login: 'brain-reviewer[bot]' } }],
    botAllowlist: ['brain-reviewer[bot]'],
    denyActors: ['brain-reviewer[bot]'],
  });

  // `reviewer-identity-config.test.mjs` already asserts the two lists never
  // overlap in the shipped config, so this is defense in depth. It pins the
  // resolution of a contradictory config as fail-CLOSED: a misregistration must
  // not hand the reviewer the merge keystroke.
  assert.equal(result.level, 'fail', 'a contradictory config must resolve against the approval, not for it');
});

test('#375: an actor in neither list still passes — the deny-set does not widen rule 4', () => {
  const result = evaluateActor({
    author: 'alice',
    issueAuthor: 'bob',
    labeledEvents: [{ actor: { login: 'carol' } }],
    denyActors: ['brain-reviewer[bot]'],
  });

  // Negative control. Without it, a deny rule that failed everything would
  // satisfy the two tests above and still be wrong.
  assert.equal(result.level, 'pass');
});

test('#375: gatherActorCheckInputs sources denyActors from governance.reviewActors', async () => {
  const dir = testTmp('brain-config-');
  writeFileSync(join(dir, 'brain.config.json'), JSON.stringify({
    governance: {
      approvalActors: ['release-bot'],
      reviewActors: ['brain-reviewer[bot]'],
    },
  }));

  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #144',
    baseBranch: 'main',
    repo: 'org/repo',
    cwd: dir,
    deps: {
      fetchLabeledEvents: () => [{ actor: { login: 'brain-reviewer[bot]' } }],
      fetchIssue: () => ({ labels: ['status:approved'], author: 'bob' }),
    },
  });

  // The two keys must stay separate on the way in: reviewActors → denyActors
  // (L5 denial, new), approvalActors → botAllowlist (L5 allow, existing).
  assert.deepEqual(inputs.denyActors, ['brain-reviewer[bot]']);
  assert.deepEqual(inputs.botAllowlist, ['release-bot']);
});

// ── issue #473 slice 2 — brain-decision/1 as additional `lite` evidence ─────
// (design.md §C, §D, §E2). `evaluateSignedDecision` is a PEER evidence source
// in `evaluateActor`'s `lite` branch, additive-OR with `evaluateDistinctAct`
// (REQ-473-1, REQ-473-6 monotonicity: a non-admissible block only ANNOTATES
// the fallback verdict, design.md §C4 — it never blocks a pass the label
// alone would already grant, and never turns a fail into a pass).

const HEAD_SHA = 'a'.repeat(40);
const OTHER_SHA = 'b'.repeat(40);

/** Builds a `prReviews()`-shaped review carrying a `brain-decision/1` block,
 * defaulting to a happy-path APPROVE at HEAD_SHA. `extraBody` overrides the
 * body entirely, for parse-level fixtures `renderDecision` cannot produce
 * (missing fields). */
function decisionReview({ actor = 'alice', head_sha = HEAD_SHA, decision = 'APPROVE', author = actor, protocol, at = '2026-08-07T00:00:00Z', extraBody } = {}) {
  const body = extraBody ?? renderDecision({ protocol, decision, head_sha, actor, at });
  return { state: 'COMMENTED', author, body };
}

// ── resolveHeadSha (design §D) ───────────────────────────────────────────────

test('resolveHeadSha: returns the last commit\'s sha (PR head, ascending prCommits() list)', () => {
  assert.equal(resolveHeadSha([{ sha: 'a' }, { sha: 'b' }, { sha: HEAD_SHA }]), HEAD_SHA);
});

test('resolveHeadSha: null/empty commits → null (uncomputable, never assumed) — design §D2, distinct from evaluateDistinctAct\'s OWN null handling', () => {
  assert.equal(resolveHeadSha(null), null);
  assert.equal(resolveHeadSha([]), null);
});

// ── evaluateSignedDecision — rule 1: decisions === null (review list unreadable) ─

test('evaluateSignedDecision: decisions === null (PR review list unreadable) → refuse, note names the reason', () => {
  const result = evaluateSignedDecision({ decisions: null, headSha: HEAD_SHA });
  assert.equal(result.admitted, false);
  assert.match(result.note, /unreadable/i);
});

// ── PATH axis — rules 2/3: nothing addressed to this reader → silent (null) ──

test('evaluateSignedDecision: PATH — decisions === [] (no reviews at all) → silent (null), never a note', () => {
  assert.equal(evaluateSignedDecision({ decisions: [], headSha: HEAD_SHA }), null);
});

test('evaluateSignedDecision: PATH — a review with no fence at all (a plain "+1" comment) → silent (null)', () => {
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body: 'looks good, +1' }],
    headSha: HEAD_SHA,
  });
  assert.equal(result, null);
});

test('evaluateSignedDecision: rule 3 — a review carrying a brain-review/1 block (wrong protocol family) is not addressed to this reader → silent', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ protocol: 'brain-review/1' })],
    headSha: HEAD_SHA,
  });
  assert.equal(result, null);
});

// ── rule 4: addressed but unsupported protocol version → refuse ─────────────

test('evaluateSignedDecision: rule 4 — brain-decision/2 (unsupported version) → refuse, names the version (addressed, unlike rule 3)', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ protocol: 'brain-decision/2' })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
  assert.match(result.note, /brain-decision\/2/);
  assert.match(result.note, /unsupported|version/i);
});

// ── rules 5-9: field-level malformation (parse-level, re-verified end-to-end) ─

test('evaluateSignedDecision: rule 5 — decision field absent → refuse', () => {
  const body = ['```yaml', 'protocol: brain-decision/1', `head_sha: ${HEAD_SHA}`, 'actor: alice', '```'].join('\n');
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
});

test('evaluateSignedDecision: rule 6 — decision present but not exactly APPROVE → refuse', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ decision: 'REJECT' })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
});

test('evaluateSignedDecision: rule 7 — head_sha field absent → refuse', () => {
  const body = ['```yaml', 'protocol: brain-decision/1', 'decision: APPROVE', 'actor: alice', '```'].join('\n');
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
});

test('evaluateSignedDecision: VALUE CLASS — rule 8 head_sha malformed (not 40 hex) → refuse', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ head_sha: 'not-a-valid-sha-at-all' })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
});

test('evaluateSignedDecision: VALUE CLASS — rule 9 head_sha is a 7-char PREFIX of the PR head → refuse (not 40 hex)', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ head_sha: HEAD_SHA.slice(0, 7) })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
});

// ── VALUE CLASS — rules 10/11: head_sha vs PR head (this function's OWN compare) ─

test('evaluateSignedDecision: VALUE CLASS — rule 10 head_sha mismatches the PR head (39-hex-equivalent-length, different value) → refuse, names both SHAs', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ head_sha: OTHER_SHA })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
  assert.match(result.note, new RegExp(OTHER_SHA));
  assert.match(result.note, new RegExp(HEAD_SHA));
});

test('evaluateSignedDecision: VALUE CLASS — a head_sha sharing only a 7-char PREFIX with the real head (rest differs) → refuse (full-length compare, not a prefix compare)', () => {
  const prefixColliding = HEAD_SHA.slice(0, 7) + 'b'.repeat(33); // 'aaaaaaa' + 33 'b's — same first 7 chars as HEAD_SHA, differs after
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ head_sha: prefixColliding })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false, 'a shared 7-char prefix must never be mistaken for a match — the compare is full-length');
});

test('evaluateSignedDecision: VALUE CLASS — head_sha case-folded (hex case is not identity) — a case-different but otherwise-matching head_sha ADMITS', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ head_sha: HEAD_SHA.toUpperCase() })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, true);
});

test('evaluateSignedDecision: rule 11 — PR head unresolvable (headSha null) → refuse', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview()],
    headSha: null,
  });
  assert.equal(result.admitted, false);
  assert.match(result.note, /cannot resolve the pr head/i);
});

// PR #503 cold-review round 1, finding 2: the guard at actor-check.mjs:268
// checked ONLY `headSha === null`; `undefined` or a non-string value (e.g. a
// number) reached `parsed.head_sha.toLowerCase() !== headSha.toLowerCase()`
// and THREW instead of refusing. The contract is "never throws, refuse
// instead" — these two rows drive the SAME rule-11 refusal path with the
// other non-string shapes, mirroring the null case above exactly.
test('evaluateSignedDecision: fail-closed — headSha undefined (never resolved/threaded) → refuse, never throws', () => {
  assert.doesNotThrow(() => {
    const result = evaluateSignedDecision({
      decisions: [decisionReview()],
      headSha: undefined,
    });
    assert.equal(result.admitted, false);
    assert.match(result.note, /cannot resolve the pr head/i);
  });
});

test('evaluateSignedDecision: fail-closed — headSha a non-string (number) → refuse, never throws', () => {
  assert.doesNotThrow(() => {
    const result = evaluateSignedDecision({
      decisions: [decisionReview()],
      headSha: 123,
    });
    assert.equal(result.admitted, false);
    assert.match(result.note, /cannot resolve the pr head/i);
  });
});

// ── rules 12-14: actor field vs review author ─────────────────────────────────

test('evaluateSignedDecision: rule 12 — actor field absent → refuse', () => {
  const body = ['```yaml', 'protocol: brain-decision/1', 'decision: APPROVE', `head_sha: ${HEAD_SHA}`, '```'].join('\n');
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
});

test('evaluateSignedDecision: rule 13 — review author unresolvable (null) → refuse, an unresolvable identity is never treated as a match', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ author: null })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
  assert.match(result.note, /unresolvable/i);
});

test('evaluateSignedDecision: rule 14 — block actor differs from the posting review author → refuse, names both', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ actor: 'alice', author: 'mallory' })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
  assert.match(result.note, /alice/);
  assert.match(result.note, /mallory/);
});

test('evaluateSignedDecision: actor/author comparison case-folds (both providers case-insensitive) — a case-different match ADMITS', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ actor: 'Alice', author: 'alice' })],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, true);
});

// ── rule 15: deny-set — a review identity may never SIGN an approval either ──

test('evaluateSignedDecision: rule 15 — review author is a denyActors (governance.reviewActors) identity → refuse, regardless of head_sha/actor match', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ actor: 'brain-reviewer[bot]', author: 'brain-reviewer[bot]' })],
    headSha: HEAD_SHA,
    denyActors: ['brain-reviewer[bot]'],
  });
  assert.equal(result.admitted, false);
  assert.match(result.note, /reviewActors|never sign/i);
});

// ── rule 16: multiple reviews — evaluate ALL in order, admit if ANY, else collect notes ─

test('evaluateSignedDecision: rule 16 — first review non-admissible, second admissible → ADMITS on the second (evaluate ALL, order preserved)', () => {
  const result = evaluateSignedDecision({
    decisions: [
      decisionReview({ head_sha: OTHER_SHA, author: 'mallory', actor: 'mallory' }),
      decisionReview({ head_sha: HEAD_SHA, author: 'alice', actor: 'alice' }),
    ],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, true);
});

test('evaluateSignedDecision: rule 16 — none admissible across several reviews → refuse, note collects EACH refusal, not just the first (FIELD axis)', () => {
  const result = evaluateSignedDecision({
    decisions: [
      decisionReview({ head_sha: OTHER_SHA, author: 'mallory', actor: 'mallory' }),
      decisionReview({ decision: 'REJECT', author: 'bob', actor: 'bob' }),
    ],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false);
  assert.match(result.note, new RegExp(OTHER_SHA), 'the note must name the FIRST refused block, not just "refused"');
  assert.match(result.note, /malformed|not admissible/i, 'the note must ALSO carry the SECOND review\'s refusal, not just the first (a truncating implementation would drop it)');
});

// ── rule 17: multiple fences in ONE body — only the first is ever read ───────

test('evaluateSignedDecision: rule 17 — a stale FIRST fence refuses even though a fresh SECOND (quoted) fence would be valid', () => {
  const stale = renderDecision({ decision: 'APPROVE', head_sha: OTHER_SHA, actor: 'alice', at: '2026-01-01T00:00:00Z' });
  const fresh = renderDecision({ decision: 'APPROVE', head_sha: HEAD_SHA, actor: 'alice', at: '2026-01-02T00:00:00Z' });
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body: `${stale}\n\nQuoting an earlier reply:\n\n${fresh}` }],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, false, 'the FIRST fence governs — a fresher quoted block does not rescue it (fail-closed direction)');
});

test('evaluateSignedDecision: rule 17 — a valid FIRST fence admits even though a SECOND (ignored) fence would be invalid', () => {
  const fresh = renderDecision({ decision: 'APPROVE', head_sha: HEAD_SHA, actor: 'alice', at: '2026-01-01T00:00:00Z' });
  const brokenSecond = ['```yaml', 'protocol: brain-decision/2', '```'].join('\n');
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body: `${fresh}\n\n${brokenSecond}` }],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, true);
});

// ── FIELD axis — rule 20: an unknown extra field never changes admissibility ──

test('evaluateSignedDecision: FIELD — an unknown extra field (e.g. a future dispositions) does not change admissibility (rule 20)', () => {
  const body = [
    '```yaml',
    'protocol: brain-decision/1',
    'decision: APPROVE',
    `head_sha: ${HEAD_SHA}`,
    'actor: alice',
    'dispositions: something-not-in-slice-1',
    '```',
  ].join('\n');
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, true);
});

// ── #612 governance-invariance — a whitespace-only value on any of the six ──
// `brain-decision/1` keys must not change admission, before or after the
// `scalar()` repair (design.md §D-C, ADR-0026 Amendment 2, issue #473).
//
// This guard is colocated HERE, with the consumer, not in `yaml-block`'s
// own tests: the durable risk is not "someone edits `scalar`" (the full
// suite already catches that everywhere) — it is "someone edits ONE of
// these gates into a form that distinguishes `''` from `null`" (`at ?? ''`,
// a `typeof === 'string'` check that treats `''` as present). A guard
// placed in `yaml-block`'s own tests never runs in that editor's field of
// view; a guard next to the gates it protects does.
//
// `protocol`, `decision`, `head_sha`, `actor` GATE admission: a
// whitespace-only value on any of them must never let the block admit.
// `at`, `in_reply_to` are audit-only: a whitespace-only value must be
// omitted (never surfaces as an empty-string value) and must never affect
// admission either way.

function decisionBodyWith(overrides) {
  const fields = {
    protocol: 'brain-decision/1',
    decision: 'APPROVE',
    head_sha: HEAD_SHA,
    actor: 'alice',
    at: '2026-08-07T00:00:00Z',
    ...overrides,
  };
  const lines = ['```yaml'];
  for (const key of ['protocol', 'decision', 'head_sha', 'actor', 'at', 'in_reply_to']) {
    if (key in fields) lines.push(`${key}: ${fields[key]}`);
  }
  lines.push('```');
  return lines.join('\n');
}

test('#612 governance invariance: a whitespace-only `protocol` is not addressed to this reader — silent (null), never admitted', () => {
  // The direct pin for "sniffDecisionProtocol('protocol: ') -> null, never
  // addressed": `sniffDecisionProtocol` is private, so this exercises it
  // through its one caller. Before the repair `scalar` returned `''` here,
  // which also failed `DECISION_PROTOCOL_PREFIX_RE` — same silent outcome,
  // by a different route.
  const body = decisionBodyWith({ protocol: ' ' });
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.equal(result, null, 'not addressed — a block with no readable protocol contributes nothing, not even a refusal note');
});

test('#612 governance invariance: a whitespace-only `decision` refuses, never admits', () => {
  const body = decisionBodyWith({ decision: ' ' });
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.notEqual(result?.admitted, true);
});

test('#612 governance invariance: a whitespace-only `head_sha` refuses, never admits', () => {
  const body = decisionBodyWith({ head_sha: ' ' });
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.notEqual(result?.admitted, true);
});

test('#612: the ONE conceded direction — an NBSP-led value stops being admissible, and that is the safe direction', () => {
  // The invariance claim above is "no block becomes admissible that was not,
  // and none stops being". The second half is NOT universal, and the carve-out
  // belongs in a test rather than only in design prose.
  //
  // `protocol: <U+00A0>brain-decision/1` WAS admissible before the repair —
  // JS `.trim()` strips NBSP, so `(.+)` captured it and trim cleaned it up.
  // `(\S.*)` excludes NBSP and `[ \t]*` cannot consume it, so no start position
  // exists and `scalar` answers null. The block goes ADMITTED -> SILENT.
  //
  // That is the direction this repo requires when it is unsure: refusal. A
  // block that stops being admissible costs a re-sign; one that starts being
  // admissible is a forged approval. Pinned so a future "let's also accept
  // unicode whitespace" change has to argue with a test.
  const NBSP = ' ';
  const body = decisionBodyWith({ protocol: `${NBSP}brain-decision/1` });
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.notEqual(result?.admitted, true, 'an NBSP-led protocol must never be admitted');
  assert.equal(result, null, 'and it is silent — not addressed to this reader at all');
});

test('#612 governance invariance: a whitespace-only `actor` refuses, never admits', () => {
  const body = decisionBodyWith({ actor: ' ' });
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.notEqual(result?.admitted, true);
});

test('#612 governance invariance: a whitespace-only `at` is audit-only — omitted, and admission proceeds unaffected', () => {
  const body = decisionBodyWith({ at: ' ' });
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, true, 'a whitespace-only audit field never blocks an otherwise-valid signature');
});

test('#612 governance invariance: a whitespace-only `in_reply_to` is audit-only — omitted, and admission proceeds unaffected', () => {
  const body = decisionBodyWith({ in_reply_to: ' ' });
  const result = evaluateSignedDecision({
    decisions: [{ state: 'COMMENTED', author: 'alice', body }],
    headSha: HEAD_SHA,
  });
  assert.equal(result.admitted, true, 'a whitespace-only audit field never blocks an otherwise-valid signature');
});

// ── LITE_SIGNED_EVIDENCE_SOURCES — the pluggable list (design §C2) ──────────

test('LITE_SIGNED_EVIDENCE_SOURCES: frozen, and its sole default member is evaluateSignedDecision', () => {
  assert.ok(Object.isFrozen(LITE_SIGNED_EVIDENCE_SOURCES));
  assert.equal(LITE_SIGNED_EVIDENCE_SOURCES.length, 1);
  assert.equal(LITE_SIGNED_EVIDENCE_SOURCES[0], evaluateSignedDecision);
});

// ── evaluateActor composite seam — the (b)-swap boundary (design §C2) ────────

test('evaluateActor: lite — signedEvidenceSources is an INJECTED list, not a hardcoded call (order preserved, first-admitted-wins)', () => {
  const calls = [];
  const refusing = () => { calls.push('refusing'); return { admitted: false, note: 'source A refuses' }; };
  const admitting = () => { calls.push('admitting'); return { admitted: true, reason: 'source B admits' }; };
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: HEAD_SHA, login: 'mallory', at: '2024-01-01T00:10:00Z' }],
    tier: 'lite',
    signedEvidenceSources: [refusing, admitting],
  });
  assert.deepEqual(calls, ['refusing', 'admitting'], 'sources must be tried IN ORDER');
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /source B admits/);
});

test('evaluateActor: lite — first-admitted-wins: a SECOND source is never consulted once an earlier one admits', () => {
  const calls = [];
  const admitting = () => { calls.push('first'); return { admitted: true, reason: 'first admits' }; };
  const neverCalled = () => { calls.push('second'); return { admitted: true, reason: 'must never run' }; };
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: HEAD_SHA, login: 'mallory', at: '2024-01-01T00:10:00Z' }],
    tier: 'lite',
    signedEvidenceSources: [admitting, neverCalled],
  });
  assert.deepEqual(calls, ['first']);
  assert.match(result.reason, /first admits/);
});

// ── success criterion (task 2.1) + monotonicity (REQ-473-6) ─────────────────

test('evaluateActor: lite — a brain-decision/1 APPROVE at the current head passes even though the approved-label PREDATES a later foreign commit (issue #473 REQ-473-1, success criterion)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [
      { sha: 'x', login: 'alice', at: '2024-01-01T00:00:00Z' },
      { sha: HEAD_SHA, login: 'mallory', at: '2024-01-01T00:10:00Z' }, // foreign, postdates the label
    ],
    headSha: HEAD_SHA,
    decisions: [decisionReview({ head_sha: HEAD_SHA, author: 'alice', actor: 'alice' })],
    tier: 'lite',
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /brain-decision\/1/i);
});

test('evaluateActor: lite — negative control: WITHOUT any decision block, the identical foreign-commit-after-label input still fails (proves the BLOCK admits it, not the commit list)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [
      { sha: 'x', login: 'alice', at: '2024-01-01T00:00:00Z' },
      { sha: HEAD_SHA, login: 'mallory', at: '2024-01-01T00:10:00Z' },
    ],
    headSha: HEAD_SHA,
    tier: 'lite',
  });
  assert.equal(result.level, 'fail');
});

test('evaluateActor: lite — a non-admissible decision block ANNOTATES an otherwise-passing verdict, never blocks it (design §C4 monotonicity)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:10:00Z' }],
    commits: [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:00:00Z' }],
    decisions: [decisionReview({ head_sha: OTHER_SHA, author: 'alice', actor: 'alice' })], // stale block
    headSha: HEAD_SHA,
    tier: 'lite',
  });
  assert.equal(result.level, 'pass', 'the label alone already satisfies lite — the broken block must not turn this into a fail');
  assert.match(result.reason, new RegExp(OTHER_SHA), 'the note naming the refused block\'s head_sha must be appended to the passing reason');
});

test('evaluateActor: lite — a non-admissible decision block does NOT turn an otherwise-failing label check into a pass (fail stays fail, note appended)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: HEAD_SHA, login: 'mallory', at: '2024-01-01T00:10:00Z' }],
    decisions: [decisionReview({ head_sha: OTHER_SHA, author: 'alice', actor: 'alice' })],
    headSha: HEAD_SHA,
    tier: 'lite',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, new RegExp(OTHER_SHA));
});

// ── issue #673 — the deny branch STATES ITS SCOPE ───────────────────────────
//
// The verdict is correct and none of these tests argue with it. What they pin
// is that the refusal can tell "your signed decision was read and is not
// sufficient" apart from "your signed decision was never read at all". It is
// always the second, and before #673 the deny branch returned before
// `signedNotes` existed, so it could not say so even in principle.
//
// The axes varied, because a note that fires unconditionally would satisfy the
// positive test alone and be a worse defect than the one it replaces:
//   STATE  — admissible block · non-admissible block · no block at all
//   TIER   — lite (reads signatures) vs standard/regulated (never does)
//   CALLER — `decisions` threaded vs a legacy caller that omits it
//   VERDICT— every case above must still be `fail`

// The measured PR #665 shape: the maintainer signs as themself, the label lands
// from the review identity.
const DENIED_LABEL_EVENT = [{ actor: { login: 'csrinaldibot' }, at: '2026-08-15T14:50:00Z' }];

test('#673: deny + an ADMISSIBLE signed block — the refusal says the signature was NOT EVALUATED, and names the remedy', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: DENIED_LABEL_EVENT,
    denyActors: ['csrinaldibot'],
    tier: 'lite',
    headSha: HEAD_SHA,
    decisions: [decisionReview({ head_sha: HEAD_SHA, author: 'csrinaldi', actor: 'csrinaldi' })],
  });

  assert.equal(result.level, 'fail', 'the deny is correct and #673 changes nothing about it');
  assert.match(result.reason, /governance\.reviewActors/, 'the original refusal survives intact');
  assert.match(result.reason, /NOT evaluated/, 'it must say the signature went unread');
  assert.match(result.reason, /#358 Q5/, 'and why: the deny-set precedes the tier evidence forms');
  assert.match(result.reason, /Re-apply the label as a human/, 'the remedy that actually works (requirement 3)');
  assert.doesNotMatch(result.reason, /not sufficient/i,
    'requirement 2: "not evaluated" and "not sufficient" are the two states this ticket exists to separate');
});

test('#673: deny + NO signed block — the refusal must NOT imply a signature was ignored (negative control)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: DENIED_LABEL_EVENT,
    denyActors: ['csrinaldibot'],
    tier: 'lite',
    headSha: HEAD_SHA,
    decisions: [],
  });

  assert.equal(result.level, 'fail');
  // Requirement 4. Without this the whole change could be an unconditional
  // string append — which passes the test above and is the same defect pointed
  // the other way.
  assert.doesNotMatch(result.reason, /brain-decision/i, 'no block exists; claiming one was skipped is a fresh lie');
  assert.doesNotMatch(result.reason, /Re-apply the label as a human/);
});

test('#673: deny + a NON-ADMISSIBLE signed block — says present-but-not-admissible, never promises it will be read', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: DENIED_LABEL_EVENT,
    denyActors: ['csrinaldibot'],
    tier: 'lite',
    headSha: HEAD_SHA,
    // signed against a stale head — the block exists and is addressed to this
    // reader, but re-labeling as a human would admit nothing.
    decisions: [decisionReview({ head_sha: OTHER_SHA, author: 'csrinaldi', actor: 'csrinaldi' })],
  });

  assert.equal(result.level, 'fail');
  assert.match(result.reason, /NOT admissible as it stands/);
  assert.match(result.reason, /re-sign the current head/, 'it carries the source\'s own diagnosis, not a re-derived one');
  assert.doesNotMatch(result.reason, /this signature will be read/,
    'promising admission on a broken block sends the operator back around the same loop');
});

// The value axis the first round of these tests did NOT vary, found by cold
// review: `{admissible, stale, [], undefined}` omits `null` — and `null` is the
// ONLY value production ever supplies from `gatherActorCheckInputs` when
// `prNumber` does not resolve. The four-axis mutation round stayed green
// through the defect for exactly that reason (`red-proof-blind-along-an-unvaried-axis`).

test('#673: deny + an UNCOMPUTABLE review list — reports UNKNOWN, never fabricates a block that may not exist', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: DENIED_LABEL_EVENT,
    denyActors: ['csrinaldibot'],
    tier: 'lite',
    decisions: null, // gatherActorCheckInputs threads this whenever prNumber does not resolve
    headSha: null,
  });

  assert.equal(result.level, 'fail');
  assert.match(result.reason, /UNKNOWN/, '`null` is not a determinate value and must not be reported as one');
  // The regression this pins: an operator who never signed anything was told
  // their block "is present … NOT admissible" and sent to go correct it.
  assert.doesNotMatch(result.reason, /is present on this PR/,
    'an unreadable review list is not evidence that a block exists (#604: "could not establish" is not "established clean")');
  assert.doesNotMatch(result.reason, /correct the block/);
});

test('#673: the non-admissible branch does NOT prescribe a universal remedy — rules 11, 13 and 15 have nothing to correct', () => {
  // Rule 15: the block is structurally perfect and honestly signed; its only
  // defect is WHO signed it. "Correct the block" sends the operator around a
  // second loop — the exact cost #673 was filed to remove.
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: DENIED_LABEL_EVENT,
    denyActors: ['csrinaldibot'],
    tier: 'lite',
    headSha: HEAD_SHA,
    decisions: [decisionReview({ head_sha: HEAD_SHA, author: 'csrinaldibot', actor: 'csrinaldibot' })],
  });

  assert.equal(result.level, 'fail');
  assert.match(result.reason, /may never sign an approval/, 'the source\'s own diagnosis is carried');
  assert.doesNotMatch(result.reason, /correct the block/,
    'there is nothing about this block to correct — the remedy is a different signer');
  assert.match(result.reason, /the note above is what the block itself would need/,
    'the sentence defers to the source note instead of overriding it');
});

test('#673: a non-array denyActors still returns a verdict — a reporting helper may never turn a fail into a throw', () => {
  // Pre-#673 this returned a clean `fail` via String#includes. Threading the
  // value into `evaluateSignedDecision`'s `.some()` made it throw, and
  // `evaluateActor` sits OUTSIDE runActorCheck's try/catch.
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: DENIED_LABEL_EVENT,
    denyActors: 'csrinaldibot', // a scalar where a list was configured
    tier: 'lite',
    headSha: HEAD_SHA,
    decisions: [decisionReview({ head_sha: HEAD_SHA, author: 'csrinaldi', actor: 'csrinaldi' })],
  });

  assert.equal(result.level, 'fail', 'the docblock promises this never throws');
});

test('#673: deny at standard/regulated — silent about signatures, because no signature is evidence there', () => {
  for (const tier of ['standard', 'regulated']) {
    const result = evaluateActor({
      author: 'alice',
      labeledEvents: DENIED_LABEL_EVENT,
      denyActors: ['csrinaldibot'],
      tier,
      headSha: HEAD_SHA,
      decisions: [decisionReview({ head_sha: HEAD_SHA, author: 'csrinaldi', actor: 'csrinaldi' })],
    });

    assert.equal(result.level, 'fail', `${tier}: verdict unchanged`);
    // "Re-apply as a human and this will be read" is FALSE at these tiers —
    // `signedEvidenceSources` is never consulted outside `lite`. A confident
    // answer about the wrong subject is the #669 shape, not a fix for #673.
    assert.doesNotMatch(result.reason, /brain-decision/i, `${tier}: must not describe evidence this tier never reads`);
  }
});

test('#673: a legacy caller that never threads `decisions` gets a byte-identical refusal', () => {
  const base = {
    author: 'alice',
    labeledEvents: DENIED_LABEL_EVENT,
    denyActors: ['csrinaldibot'],
    tier: 'lite',
  };
  const legacy = evaluateActor(base); // `decisions` omitted entirely
  const expected =
    'the approved label was applied by "csrinaldibot", which is registered in governance.reviewActors ' +
    '— a review identity may never apply the approved label (reviewer-protocol.md §9; that label is human-only).';

  assert.equal(legacy.level, 'fail');
  assert.equal(legacy.reason, expected, 'silence for a caller that never threaded the field (PR #503 finding 3)');
});

test('#673: the scope note reads through the INJECTED sources list, never a hardcoded call', () => {
  const calls = [];
  const admitting = () => { calls.push('injected'); return { admitted: true, reason: 'injected source admits' }; };
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: DENIED_LABEL_EVENT,
    denyActors: ['csrinaldibot'],
    tier: 'lite',
    decisions: [],
    signedEvidenceSources: [admitting],
  });

  // Same (b)-swap boundary the `lite` branch honors (design §C2). A source
  // added tomorrow is described by the deny branch without a second edit.
  assert.deepEqual(calls, ['injected'], 'the deny branch must consult the injected list');
  assert.equal(result.level, 'fail', 'an ADMITTING source still never rescues a denied identity');
  assert.match(result.reason, /NOT evaluated/);
});

test('#673: describeUnevaluatedSignedEvidence is silent on every non-lite tier and on empty evidence', () => {
  const admissible = [decisionReview({ head_sha: HEAD_SHA, author: 'csrinaldi', actor: 'csrinaldi' })];

  assert.equal(describeUnevaluatedSignedEvidence({ tier: 'standard', decisions: admissible, headSha: HEAD_SHA }), '');
  assert.equal(describeUnevaluatedSignedEvidence({ tier: 'regulated', decisions: admissible, headSha: HEAD_SHA }), '');
  assert.equal(describeUnevaluatedSignedEvidence({ tier: 'lite', decisions: [], headSha: HEAD_SHA }), '');
  assert.equal(describeUnevaluatedSignedEvidence({ tier: 'lite', headSha: HEAD_SHA }), '', 'decisions undefined → silent');
  assert.notEqual(describeUnevaluatedSignedEvidence({ tier: 'lite', decisions: admissible, headSha: HEAD_SHA }), '',
    'positive control — the silence above is a decision, not a broken probe');
});

test('#673: the override:* refusal note still lands, and lands last', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: DENIED_LABEL_EVENT,
    denyActors: ['csrinaldibot'],
    tier: 'lite',
    headSha: HEAD_SHA,
    decisions: [decisionReview({ head_sha: HEAD_SHA, author: 'csrinaldi', actor: 'csrinaldi' })],
    overrideRefused: true,
  });

  assert.equal(result.level, 'fail');
  assert.match(result.reason, /NOT evaluated/);
  assert.match(result.reason, /REQ-TIER-6\.\)$/, 'withRefusalNote appends after the scope note, not into the middle of it');
});

// ── design §C5 property 1 — the label stays a required precondition ─────────

test('evaluateActor: lite — no labeled event at all → warn+pass even with an ADMISSIBLE decision block present (design §C5 property 1: the block never bypasses the label precondition)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [],
    headSha: HEAD_SHA,
    decisions: [decisionReview({ head_sha: HEAD_SHA, author: 'alice', actor: 'alice' })],
    tier: 'lite',
  });
  assert.equal(result.level, 'warn', 'a signed block alone must never bypass the "no labeled event" precondition');
});

// ── gatherActorCheckInputs: decisions/headSha threading (design §D, REQ-473-10) ─

test('gatherActorCheckInputs: standard tier never calls fetchDecisions (REQ-473-10 no-op-migration guarantee)', async () => {
  let called = false;
  const deps = { ...makeFakeDeps({ labeledEvents: [{ actor: { login: 'bob' } }] }), fetchDecisions: () => { called = true; return []; } };
  const inputs = await gatherActorCheckInputs({
    author: 'alice', prBody: 'Closes #144', baseBranch: 'main', repo: 'org/repo', prNumber: 7, tier: 'standard', deps,
  });
  assert.equal(called, false, 'standard must never fetch decisions — it is not part of its evidence form');
  assert.equal(inputs.decisions, null);
});

test('gatherActorCheckInputs: regulated tier never calls fetchDecisions', async () => {
  let called = false;
  const deps = { ...makeFakeDeps({ labeledEvents: [{ actor: { login: 'bob' } }] }), fetchDecisions: () => { called = true; return []; } };
  const inputs = await gatherActorCheckInputs({
    author: 'alice', prBody: 'Closes #144', baseBranch: 'main', repo: 'org/repo', prNumber: 7, tier: 'regulated', deps,
  });
  assert.equal(called, false);
  assert.equal(inputs.decisions, null);
});

test('gatherActorCheckInputs: lite tier fetches decisions via the injected fetchDecisions when a prNumber is available; headSha resolves from the ALREADY-fetched commits (no second prView, design §D4)', async () => {
  const fakeDecisions = [decisionReview({ head_sha: HEAD_SHA })];
  const deps = {
    ...makeFakeDeps({ labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:10:00Z' }] }),
    fetchDecisions: prNumber => { assert.equal(prNumber, 7); return fakeDecisions; },
    fetchCommits: () => [{ sha: HEAD_SHA, login: 'alice', at: '2024-01-01T00:00:00Z' }],
  };
  const inputs = await gatherActorCheckInputs({
    author: 'alice', prBody: 'Closes #144', baseBranch: 'main', repo: 'org/repo', prNumber: 7, tier: 'lite', deps,
  });
  assert.deepEqual(inputs.decisions, fakeDecisions);
  assert.equal(inputs.headSha, HEAD_SHA);
});

test('gatherActorCheckInputs: lite tier with no resolvable prNumber → decisions/headSha stay null (never throws)', async () => {
  const deps = makeFakeDeps({ labeledEvents: [{ actor: { login: 'alice' } }] });
  const inputs = await gatherActorCheckInputs({
    author: 'alice', prBody: 'Closes #144', baseBranch: 'main', repo: 'org/repo', tier: 'lite', deps,
  });
  assert.equal(inputs.decisions, null);
  assert.equal(inputs.headSha, null);
});

// ── SITE axis — gatherActorCheckInputs has TWO return statements; both must thread ─

test('gatherActorCheckInputs: SITE — the early return (no resolvable issue number) still carries decisions/headSha, not only the normal-path return (actor-check.mjs:670)', async () => {
  const fakeDecisions = [decisionReview({ head_sha: HEAD_SHA })];
  const deps = {
    fetchDecisions: () => fakeDecisions,
    fetchCommits: () => [{ sha: HEAD_SHA, login: 'alice', at: '2024-01-01T00:00:00Z' }],
  };
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'no issue reference here',
    baseBranch: 'main',
    repo: 'org/repo',
    prNumber: 7,
    tier: 'lite',
    deps,
  });
  assert.equal(inputs.labeledEvents.length, 0, 'sanity: this exercises the early-return branch (no issue number resolved)');
  assert.deepEqual(inputs.decisions, fakeDecisions, 'the early return must also thread decisions');
  assert.equal(inputs.headSha, HEAD_SHA, 'the early return must also thread headSha');
});

test('SITE — actor-check.mjs never CALLS .prView(; headSha is derived from the already-fetched commits list (design §D4, no second source of truth for "the head")', () => {
  const srcPath = fileURLToPath(new URL('./actor-check.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.equal(/\.prView\(/.test(src), false, 'headSha must come from resolveHeadSha(commits), never a second prView() call — a doc comment MAY name it, code must not call it');
});

// ── REQ-473-6 monotonicity — the pre-existing evaluateDistinctAct matrix is untouched ─
//
// No new assertions here by design: the entire pre-existing test block above
// this section (lines 1-1227) is re-run byte-for-byte unmodified by this same
// `npm test` invocation — that IS the monotonicity proof (task 2.10). Adding a
// parallel "re-run" block here would test node:test's own re-execution, not
// this change.

// ── ADR-0026 Amendment 3 / issue #454 — an agent identity inside the loop ────
//
// The gate's purpose is "the approval postdates work the approver has SEEN".
// That is not served by re-arming on commits the approver's own agent made under
// their instruction; it is served against commits from OUTSIDE the approved loop.
// `governance.agentActors` names the inside, the same way `reviewActors` already
// does for the cold reviewer, and for the same evidential reason.
//
// The key is separate from `reviewActors` on purpose (see defaultReadAgentActors):
// reusing it would get every behaviour right and the MEANING wrong, and a consumer
// with an agent but no cold reviewer would meet a refusal whose stated reason is
// false. It ships ABSENT — no migration — because a key that weakens a gate may
// never arrive by upgrade.

test('evaluateActor: lite — a registered agentActors identity\'s pushes do not re-arm (REQ-454-1, #454)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: 'some-agent', at: '2024-01-01T00:10:00Z' }],
    agentActors: ['some-agent'],
    tier: 'lite',
  });
  assert.equal(result.level, 'pass',
    'the approver\'s own agent, working under the instruction the approval covers, certifies nothing new');
  assert.match(result.reason, /no push re-arms/i);
});

// The negative control that makes the test above mean something. Identical input,
// key absent — which is also the shipped default for every consumer who never
// declares it, so this pins the no-op-by-default guarantee at the same time.
test('evaluateActor: lite — the SAME commit re-arms when agentActors is absent (REQ-454-2, #454)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: 'some-agent', at: '2024-01-01T00:10:00Z' }],
    tier: 'lite',
  });
  assert.equal(result.level, 'fail',
    'absent the key, behaviour must be byte-identical to pre-#454 — a gate is never weakened by upgrade');
});

test('evaluateActor: lite — an UNRESOLVABLE author still re-arms even with agentActors declared (REQ-454-3, #454)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [{ sha: 'abc', login: null, at: '2024-01-01T00:10:00Z' }],
    agentActors: ['some-agent'],
    tier: 'lite',
  });
  assert.equal(result.level, 'fail',
    'fail-closed on unattributable authorship is the feature — the relief never extends to an identity the provider cannot vouch for');
});

test('evaluateActor: lite — a third party still re-arms while an agent identity is exempt in the same commit list (REQ-454-4, #454)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
    commits: [
      { sha: 'abc', login: 'some-agent', at: '2024-01-01T00:10:00Z' },
      { sha: 'def', login: 'mallory', at: '2024-01-01T00:20:00Z' },
    ],
    agentActors: ['some-agent'],
    tier: 'lite',
  });
  assert.equal(result.level, 'fail', 'the exemption must narrow the foreign set, never empty it');
});

// §9 is untouched, and this is the assertion that says so. Exemption from
// re-arming and permission to approve are DIFFERENT POWERS; #454 grants only the
// first. If an agent identity is also registered as a review identity, the deny
// branch still refuses it the label — deny-before-allow, tier-agnostic (#375).
test('evaluateActor: an agent identity that is ALSO a review identity may still never APPLY the label (§9 unchanged, #454)', () => {
  const result = evaluateActor({
    author: 'alice',
    labeledEvents: [{ actor: { login: 'some-agent' }, at: '2024-01-01T00:30:00Z' }],
    commits: [{ sha: 'abc', login: 'alice', at: '2024-01-01T00:10:00Z' }],
    denyActors: ['some-agent'],
    agentActors: ['some-agent'],
    tier: 'lite',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /may never apply the approved label/i);
});

test('gatherActorCheckInputs: governance.agentActors is read and threaded (REQ-454-5, #454)', async () => {
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #1',
    baseBranch: 'main',
    repo: 'acme/x',
    prNumber: 7,
    tier: 'lite',
    deps: {
      readConfig: () => ({ governance: { tier: 'lite' } }),
      readBotAllowlist: () => [],
      readDenyActors: () => [],
      readAgentActors: () => ['some-agent'],
      fetchLabeledEvents: async () => [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
      fetchIssue: async () => ({ labels: [], author: 'alice' }),
      fetchCommits: async () => [{ sha: 'abc', login: 'some-agent', at: '2024-01-01T00:10:00Z' }],
      fetchDecisions: async () => [],
    },
  });
  assert.deepEqual(inputs.agentActors, ['some-agent'],
    'a reader that is never threaded is a reader that does nothing in production');
  assert.equal(evaluateActor(inputs).level, 'pass');
});

// The three tests above drive `evaluateActor` directly, so none of them ever runs
// `defaultReadAgentActors`. Mutation M3 measured the cost: making the reader return
// a non-empty default left every one of them green while the SHIPPED gate silently
// exempted an identity no consumer had declared — a gate weakened by upgrade, which
// is the single outcome the no-migration rule exists to prevent. An injected-only
// guarantee guards nothing (#510 paid for this lesson one ticket ago).
test('gatherActorCheckInputs: the REAL reader returns [] for a config with no agentActors key (REQ-454-6, #454)', async () => {
  const dir = testTmp('agent-actors-');
  writeFileSync(join(dir, 'brain.config.json'),
    JSON.stringify({ governance: { tier: 'lite', reviewActors: ['some-bot'] } }), 'utf8');

  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    prBody: 'Closes #1',
    baseBranch: 'main',
    repo: 'acme/x',
    prNumber: 7,
    cwd: dir,               // the real readers run against this config
    tier: 'lite',
    deps: {
      fetchLabeledEvents: async () => [{ actor: { login: 'alice' }, at: '2024-01-01T00:00:00Z' }],
      fetchIssue: async () => ({ labels: [], author: 'alice' }),
      fetchCommits: async () => [{ sha: 'abc', login: 'some-agent', at: '2024-01-01T00:10:00Z' }],
      fetchDecisions: async () => [],
    },
  });

  assert.deepEqual(inputs.agentActors, [],
    'an undeclared key must read as [] — a default value here would exempt an identity nobody registered');
  assert.equal(evaluateActor(inputs).level, 'fail',
    'and the gate must behave exactly as it did before #454 for every consumer who never declares the key');
});

// ── #124: the identity that may DO the work may not GRANT the approval ───────
// Measured before this change, everything else held equal:
//   labelled by a human                      -> pass
//   labelled by an identity in reviewActors  -> fail   (machinery works)
//   labelled by an identity in agentActors   -> PASS   (the gap)
// The agent's real identity is registered in this repo's config, the deny path
// is built and tested, and the two never met.

const humanApproved = {
  author: 'csrinaldi',
  commits: [{ sha: 'a', login: 'csrinaldi', at: '2026-09-04T00:00:00Z' }],
  tier: 'lite',
};
const labelledBy = (login) => [{ actor: { login }, at: '2026-09-05T00:00:00Z' }];

test('#124: an approval applied by a registered AGENT identity is refused', () => {
  const r = evaluateActor({
    ...humanApproved,
    labeledEvents: labelledBy('claude'),
    denyActors: ['claude'],       // the union the reader now produces
    agentActors: ['claude'],
  });
  assert.equal(r.level, 'fail', 'an agent may act under an approval; it may not grant one (ADR-0026 \'What is unchanged\' §9)');
  assert.match(r.reason, /agentActors/, 'and the refusal names the key the operator must edit');
  assert.doesNotMatch(r.reason, /registered in governance\.reviewActors/,
    'naming the wrong key sends the operator to the wrong config line');
});

test('#124: a REVIEW identity is still refused, and still named as one', () => {
  const r = evaluateActor({
    ...humanApproved,
    labeledEvents: labelledBy('csrinaldibot'),
    denyActors: ['csrinaldibot'],
    agentActors: ['claude'],
  });
  assert.equal(r.level, 'fail');
  assert.match(r.reason, /reviewActors/, 'the pre-existing message is unchanged for the identity it was written for');
});

test('#124: a human approval is unchanged in every respect', () => {
  const r = evaluateActor({
    ...humanApproved,
    labeledEvents: labelledBy('csrinaldi'),
    denyActors: ['csrinaldibot', 'claude'],
    agentActors: ['claude'],
  });
  assert.equal(r.level, 'pass');
});

test('#124 (R124-2): Amendment 3 survives — the agent COMMITS, the human approves', () => {
  // The opposite answer to the opposite question about the same identity: an
  // agent's commits under the approver's instruction do not re-arm an approval.
  // Merging the two lists at the source would repeal this by accident.
  const r = evaluateActor({
    author: 'alice',
    labeledEvents: labelledBy('alice'),
    commits: [{ sha: 'abc', login: 'alice-agent', at: '2026-09-05T00:10:00Z' }],
    agentActors: ['alice-agent'],
    denyActors: [],
    tier: 'lite',
  });
  assert.equal(r.level, 'pass', 'the commit exemption is about work the approver has seen — untouched');
});

test('#124 (R124-3): an unreadable actor does not silently PASS — and the existing warn is not repealed', () => {
  // #124 asks for "fail closed". The shipped behaviour is `warn`, and it is
  // SPECIFIED: REQ-L5-2, "never failing on missing evidence", named in the
  // reason itself. This test asserts the property #124 actually needs — the
  // approval is not waved through — without silently repealing a requirement
  // that predates it. Whether missing evidence should harden from warn to fail
  // is a doctrine question, recorded in the proposal, not decided here.
  const r = evaluateActor({ ...humanApproved, labeledEvents: [], denyActors: ['claude'], agentActors: ['claude'] });
  assert.notEqual(r.level, 'pass', 'no readable actor is not a human signature');
  assert.equal(r.level, 'warn', 'and it is REQ-L5-2 speaking, unchanged by this PR');
  assert.match(r.reason, /REQ-L5-2/, 'the reason names the requirement that chose this level');
});

test('#124 (round 1): BOTH deny reports name the same key — the label branch and rule 15', () => {
  // The first cut taught only the label branch to name the key. Rule 15 reuses
  // the identical denyActors union and kept saying `governance.reviewActors`
  // for an identity that is only an agent — the same message repaired on one
  // path and left wrong on the other.
  assert.deepEqual(denyingList('claude', ['claude']), { key: 'governance.agentActors', clause: 'an agent identity' });
  assert.deepEqual(denyingList('CLAUDE', ['claude']), { key: 'governance.agentActors', clause: 'an agent identity' },
    'logins fold case on both providers');
  assert.deepEqual(denyingList('csrinaldibot', ['claude']), { key: 'governance.reviewActors', clause: 'a review identity' });

  const label = evaluateActor({
    ...humanApproved,
    labeledEvents: labelledBy('claude'),
    denyActors: ['claude'],
    agentActors: ['claude'],
  });
  assert.match(label.reason, /governance\.agentActors/, 'the label branch names the agent key');
  assert.doesNotMatch(label.reason, /registered in governance\.reviewActors/,
    'and never sends the operator to the wrong config line');
});

// ── #124 round 6: the SIGN path names its key too, end to end ────────────────
// Rule 15 was the branch this PR repaired in round 1 and the only one left
// without an end-to-end regression test — the exact shape the file's own
// comments describe having happened three times: "the same message repaired on
// one path and left wrong on the other".

test('#124: rule 15 names governance.agentActors when the signer is an AGENT identity', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ head_sha: HEAD_SHA, actor: 'alice-agent', author: 'alice-agent' })],
    headSha: HEAD_SHA,
    denyActors: ['alice-agent'],      // the union the reader produces
    agentActors: ['alice-agent'],
  });
  assert.equal(result.admitted, false, 'an agent may not sign an approval either');
  assert.match(result.note, /governance\.agentActors/, 'and the note names the key the operator must edit');
  assert.doesNotMatch(result.note, /governance\.reviewActors/, 'never the wrong one');
});

test('#124: rule 15 still names governance.reviewActors for a review identity', () => {
  const result = evaluateSignedDecision({
    decisions: [decisionReview({ head_sha: HEAD_SHA, actor: 'brain-reviewer[bot]', author: 'brain-reviewer[bot]' })],
    headSha: HEAD_SHA,
    denyActors: ['brain-reviewer[bot]'],
    agentActors: ['alice-agent'],
  });
  assert.equal(result.admitted, false);
  assert.match(result.note, /governance\.reviewActors/, 'the pre-existing message is unchanged for its own identity');
});

// ── issue #942 (R1, R3, R11): a deny reader propagates; an absent config stays green ──
//
// `defaultReadDenyActors` used to `catch { return [] }` — an unreadable
// brain.config.json denied nobody. It now calls `loadBrainConfigOrThrow(cwd)`
// and drops the catch, so the throw routes through `runActorCheck`'s existing
// tiered catch (`resolveTierForFailure` + `resolveGatePolicy`, D4.1 — no new
// plumbing).

test('T4: runActorCheck — unparseable brain.config.json, no readDenyActors injected → fail, reason names the file', async () => {
  const dir = testTmp('brain-config-throw-');
  writeFileSync(join(dir, 'brain.config.json'), '{oops');
  const result = await runActorCheck({
    author: 'alice',
    repo: 'org/repo',
    baseBranch: 'main',
    cwd: dir,
  });
  assert.equal(result.level, 'fail', 'an unparseable deny-list config must fail closed, not warn');
  assert.match(result.reason, /brain\.config\.json/);
});

test('T5: runActorCheck — no brain.config.json at all → not "fail" for a config-read reason; deny set empty (R11)', async () => {
  const dir = testTmp('brain-config-throw-');
  const inputs = await gatherActorCheckInputs({
    author: 'alice',
    repo: 'org/repo',
    baseBranch: 'main',
    cwd: dir,
  });
  assert.deepEqual(inputs.denyActors, [], 'an absent config denies nobody (R11)');

  const result = await runActorCheck({
    author: 'alice',
    repo: 'org/repo',
    baseBranch: 'main',
    cwd: dir,
  });
  assert.notEqual(result.level, 'fail', 'must not fail for a config-read reason on an absent config');
  assert.doesNotMatch(result.reason ?? '', /brain\.config\.json/, 'an absent config must never be reported as unreadable');
});
