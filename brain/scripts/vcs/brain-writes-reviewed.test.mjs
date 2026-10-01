// brain-writes-reviewed.test.mjs — Unit tests for evaluateBrainWritesReviewed
// (REQ-L6-1 evidence path, design §6.1) and the gh I/O wrapper + CLI.
// Run with: npm test (node --test).
//
// Wrapper tests use plain-data fakes injected via `deps` — no test spawns a real
// `gh` or `git` process (CI-fragility discipline, same as actor-check.test.mjs
// and phase-order-check.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setSpawn } from './lib/exec.mjs';
import { testTmp } from '../lib/test-tmp.mjs';

import {
  evaluateBrainWritesReviewed,
  gatherBrainWritesReviewedInputs,
  runBrainWritesReviewedCheck,
  main,
} from './brain-writes-reviewed.mjs';

// ── Pure evaluator — evaluateBrainWritesReviewed (design §6.1) ────────────────

test('no brain/core or brain/project touched → pass (no Tier-2 requirement)', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['README.md', 'src/app.ts'],
    reviews: [],
    author: 'alice',
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /no brain/i);
});

test('touchesBrain matches brain/project/** too, not only brain/core/**', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/project/notes.md'],
    reviews: [{ state: 'APPROVED', author: 'bob' }],
    author: 'alice',
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /bob/);
});

test('approver !== author, not bot-allow-listed → pass', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/managed-paths.mjs'],
    reviews: [{ state: 'APPROVED', author: 'bob' }],
    author: 'alice',
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /bob/);
});

test('only self-approval (author is sole approver) → fail', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/managed-paths.mjs'],
    reviews: [{ state: 'APPROVED', author: 'alice' }],
    author: 'alice',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /self/i);
});

test('adminOverride: allow-listed override:* label present → pass, logged (bypasses self-approval fail)', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/managed-paths.mjs'],
    reviews: [{ state: 'APPROVED', author: 'alice' }],
    author: 'alice',
    adminOverride: true,
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /override/i);
});

test('no reviews at all (missing/unsupported reviews API) → warn + pass, never crashes', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/managed-paths.mjs'],
    reviews: [],
    author: 'alice',
  });
  assert.equal(result.level, 'warn');
  assert.match(result.reason, /review/i);
});

test('reviews exist but zero APPROVED (only COMMENTED/CHANGES_REQUESTED) → warn + pass', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/managed-paths.mjs'],
    reviews: [
      { state: 'COMMENTED', author: 'bob' },
      { state: 'CHANGES_REQUESTED', author: 'carol' },
    ],
    author: 'alice',
  });
  assert.equal(result.level, 'warn');
});

test('mixed states: only APPROVED reviews count toward approvers (a COMMENTED-only reviewer does not save a self-approval)', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/managed-paths.mjs'],
    reviews: [
      { state: 'APPROVED', author: 'alice' },
      { state: 'COMMENTED', author: 'bob' },
    ],
    author: 'alice',
  });
  assert.equal(result.level, 'fail');
});

test('mixed states: a real human APPROVED review passes even alongside unrelated COMMENTED noise', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/managed-paths.mjs'],
    reviews: [
      { state: 'COMMENTED', author: 'carol' },
      { state: 'APPROVED', author: 'bob' },
    ],
    author: 'alice',
  });
  assert.equal(result.level, 'pass');
});

test('dedup: the same approver appearing twice (re-approval after re-request) is deduped, still fails on self-approval', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/managed-paths.mjs'],
    reviews: [
      { state: 'APPROVED', author: 'alice' },
      { state: 'APPROVED', author: 'alice' },
    ],
    author: 'alice',
  });
  assert.equal(result.level, 'fail');
});

test('bot-only approval (approver is bot-allow-listed, distinct from author but not human) → fail', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/managed-paths.mjs'],
    reviews: [{ state: 'APPROVED', author: 'release-bot' }],
    author: 'alice',
    botAllowlist: ['release-bot'],
  });
  assert.equal(result.level, 'fail');
});

// ── gh/git I/O wrapper — gatherBrainWritesReviewedInputs (DI fakes, no real gh/git) ─

function makeFakeDeps({ changedFiles = [], reviews = [], botAllowlist = [], overrideActors = [] } = {}) {
  return {
    diffNameOnly: () => changedFiles,
    fetchReviews: () => reviews,
    readBotAllowlist: () => botAllowlist,          // governance.reviewActors (L6 human-approver exclusion)
    readOverrideActors: () => overrideActors,      // governance.approvalActors (override:* whitelist)
  };
}

test('gatherBrainWritesReviewedInputs: resolves changedFiles via diffNameOnly, reviews via fetchReviews, allowlist via readBotAllowlist', async () => {
  const deps = makeFakeDeps({
    changedFiles: ['brain/core/foo.mjs'],
    reviews: [{ state: 'APPROVED', author: 'bob' }],
    botAllowlist: ['release-bot'],
  });
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    // Pinned to 'standard' (issue #358 Q5 Phase 4): this repo's own
    // brain.config.json declares "tier": "lite" (design.md §5), under which
    // `reviews` is never fetched at all — an unpinned tier would silently
    // exercise a different evidence form than this test means to check.
    tier: 'standard',
    deps,
  });
  assert.deepEqual(inputs.changedFiles, ['brain/core/foo.mjs']);
  assert.deepEqual(inputs.reviews, [{ state: 'APPROVED', author: 'bob' }]);
  assert.deepEqual(inputs.botAllowlist, ['release-bot']);
  assert.equal(inputs.author, 'alice');
  assert.equal(inputs.adminOverride, false);
});

test('gatherBrainWritesReviewedInputs: adminOverride true only when an override:* label is BOTH present and listed in governance.approvalActors', async () => {
  const deps = makeFakeDeps({ overrideActors: ['override:incident-response'] });
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: ['override:incident-response'],
    deps,
  });
  assert.equal(inputs.adminOverride, true);
});

// P272-OVERRIDE-KEY option (b): the override:* whitelist reads
// governance.approvalActors, NOT governance.reviewActors. reviewActors is a pure
// identity list — an override:* string listed ONLY there must NOT be honored.
test('gatherBrainWritesReviewedInputs (P272-OVERRIDE-KEY): an override:* string in governance.reviewActors (botAllowlist) but NOT in governance.approvalActors (overrideActors) does NOT grant adminOverride', async () => {
  const deps = makeFakeDeps({ botAllowlist: ['override:incident-response'], overrideActors: [] });
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: ['override:incident-response'],
    deps,
  });
  assert.equal(inputs.adminOverride, false,
    'override:* strings resolve against approvalActors only — reviewActors is a pure identity list, never an override whitelist');
});

test('gatherBrainWritesReviewedInputs: an override:* label present but NOT allow-listed does not grant adminOverride (no blanket bypass)', async () => {
  const deps = makeFakeDeps({ botAllowlist: [] });
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: ['override:unlisted'],
    deps,
  });
  assert.equal(inputs.adminOverride, false);
});

// ── tier-scoped override:* (issue #358 Q5, REQ-TIER-6) ─────────────────────

test('gatherBrainWritesReviewedInputs: regulated tier refuses an allow-listed override:* label — adminOverride false, overrideRefused true', async () => {
  const deps = makeFakeDeps({ overrideActors: ['override:incident-response'] });
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: ['override:incident-response'],
    tier: 'regulated',
    deps,
  });
  assert.equal(inputs.adminOverride, false, 'regulated must never honor override:*');
  assert.equal(inputs.overrideRefused, true, 'the refusal must be surfaced, never silent');
});

test('evaluateBrainWritesReviewed: regulated + an allow-listed override:* still fails self-approval, naming the tier refusal (REQ-TIER-6)', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/foo.mjs'],
    reviews: [{ state: 'APPROVED', author: 'alice' }],
    author: 'alice',
    botAllowlist: [],
    adminOverride: false,
    overrideRefused: true,
    tier: 'regulated',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /self-approved/);
  assert.match(result.reason, /not honored at the "regulated" tier/);
});

test('evaluateBrainWritesReviewed: lite tier with NO override label present passes on agent-authorship-style evidence, verdict never mentions override', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/foo.mjs'],
    reviews: [{ state: 'APPROVED', author: 'carol' }],
    author: 'alice',
    botAllowlist: [],
    adminOverride: false,
    overrideRefused: false,
    tier: 'lite',
  });
  assert.equal(result.level, 'pass');
  assert.doesNotMatch(result.reason, /override/i);
});

// ── REQ-L6-1′: evidence tiering (issue #358 Q5 Phase 4) ────────────────────
//
// `lite`'s WHOLE evidence form is agent-authorship exclusion — it never
// touches `reviews`. `standard`/`regulated` keep the pre-tiering
// distinct-human-approver check UNCHANGED (REQ-TIER-10's no-op-migration
// guarantee — see the tests above, which never supply `codeownersArmed` and
// still exercise `standard` via the default tier). The agent-author hard
// fail applies at EVERY tier, unconditionally — "agent containment does not
// tier" — and is NOT bypassable by `adminOverride`.

test('evaluateBrainWritesReviewed: agent-authored brain/core change fails at every tier, even with adminOverride true (agent containment does not tier)', () => {
  for (const tier of ['lite', 'standard', 'regulated']) {
    const result = evaluateBrainWritesReviewed({
      changedFiles: ['brain/core/foo.mjs'],
      reviews: [{ state: 'APPROVED', author: 'bob' }],
      author: 'csrinaldi-bot',
      botAllowlist: ['csrinaldi-bot'],
      adminOverride: true,
      tier,
    });
    assert.equal(result.level, 'fail', `tier "${tier}" must fail on agent authorship`);
    assert.match(result.reason, /agent containment does not tier/i);
  }
});

test('evaluateBrainWritesReviewed: lite — solo human maintainer authors a brain/core change with NO reviews at all → pass (agent-authorship exclusion is the whole evidence form)', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/foo.mjs'],
    reviews: [],
    author: 'alice',
    botAllowlist: [],
    tier: 'lite',
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /agent-authorship exclusion/i);
});

test('evaluateBrainWritesReviewed: standard — unchanged, self-approval fails with no codeownersArmed evidence supplied at all (REQ-TIER-10 no-op-migration guarantee)', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/foo.mjs'],
    reviews: [{ state: 'APPROVED', author: 'alice' }],
    author: 'alice',
  });
  assert.equal(result.level, 'fail');
  assert.match(result.reason, /self-approved/i);
});

test('evaluateBrainWritesReviewed: regulated — standard evidence (distinct human approver) satisfied, CODEOWNERS armed at rung 1 → pass, noting the enhancement', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/foo.mjs'],
    reviews: [{ state: 'APPROVED', author: 'bob' }],
    author: 'alice',
    tier: 'regulated',
    codeownersArmed: true,
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /codeowners.*armed at rung 1/i);
});

test('evaluateBrainWritesReviewed: regulated — standard evidence satisfied, CODEOWNERS NOT armed at this substrate → still pass (REQ-TIER-5: unavailable enhancement never demotes a satisfied evidence pass)', () => {
  const result = evaluateBrainWritesReviewed({
    changedFiles: ['brain/core/foo.mjs'],
    reviews: [{ state: 'APPROVED', author: 'bob' }],
    author: 'alice',
    tier: 'regulated',
    codeownersArmed: false,
  });
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /not armed at this substrate/i);
});

// ── gatherBrainWritesReviewedInputs: reviews are fetched only when the tier needs them ─

test('gatherBrainWritesReviewedInputs: lite tier never calls fetchReviews (REQ-TIER-10 no-op-migration guarantee — lite\'s evidence never touches reviews)', async () => {
  let fetchReviewsCalled = false;
  const deps = {
    ...makeFakeDeps({ changedFiles: ['brain/core/foo.mjs'] }),
    fetchReviews: () => { fetchReviewsCalled = true; return []; },
  };
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    tier: 'lite',
    deps,
  });
  assert.equal(fetchReviewsCalled, false, 'lite must never fetch reviews — they are not part of its evidence form');
  assert.deepEqual(inputs.reviews, []);
});

test('gatherBrainWritesReviewedInputs: standard tier still fetches reviews (REQ-TIER-10 no-op-migration guarantee)', async () => {
  const deps = makeFakeDeps({
    changedFiles: ['brain/core/foo.mjs'],
    reviews: [{ state: 'APPROVED', author: 'bob' }],
  });
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    tier: 'standard',
    deps,
  });
  assert.deepEqual(inputs.reviews, [{ state: 'APPROVED', author: 'bob' }]);
});

test('gatherBrainWritesReviewedInputs: codeownersArmed defaults to false when not injected (safe direction — REQ-TIER-5)', async () => {
  const deps = makeFakeDeps({ changedFiles: [] });
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    tier: 'regulated',
    deps,
  });
  assert.equal(inputs.codeownersArmed, false);
});

test('gatherBrainWritesReviewedInputs: an injected deps.codeownersArmed is threaded through', async () => {
  const deps = { ...makeFakeDeps({ changedFiles: [] }), codeownersArmed: true };
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    tier: 'regulated',
    deps,
  });
  assert.equal(inputs.codeownersArmed, true);
});

// ── runBrainWritesReviewedCheck: lite end-to-end (agent-authored fails, human passes) ─

test('runBrainWritesReviewedCheck: lite end-to-end — agent-authored brain/core change fails, never reaching fetchReviews', async () => {
  let fetchReviewsCalled = false;
  const deps = {
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'csrinaldi-bot',
    prLabels: [],
    tier: 'lite',
    diffNameOnly: () => ['brain/core/foo.mjs'],
    fetchReviews: () => { fetchReviewsCalled = true; return []; },
    readBotAllowlist: () => ['csrinaldi-bot'],
  };
  const result = await runBrainWritesReviewedCheck(deps);
  assert.equal(result.level, 'fail');
  assert.equal(fetchReviewsCalled, false);
});

test('runBrainWritesReviewedCheck: lite end-to-end — human-authored brain/core change passes with zero reviews', async () => {
  const deps = {
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    tier: 'lite',
    diffNameOnly: () => ['brain/core/foo.mjs'],
    fetchReviews: () => { throw new Error('must not be called at lite'); },
    readBotAllowlist: () => [],
  };
  const result = await runBrainWritesReviewedCheck(deps);
  assert.equal(result.level, 'pass');
});

// FIX1-style fail-open guard (unpaginated gh api list fetch truncates to page
// 1) now lives with the code it guards: EXTRACTED into
// github.mjs#prReviews (issue #239 A3 TASK2/4th-violation fix) — see
// providers.test.mjs's "github.prReviews source includes --paginate".

// ── runBrainWritesReviewedCheck / main — never throws, degrades to warn on
// failure. Async as of A3 TASK2 (the default fetchReviews wrapper awaits the
// prReviews CONTRACT verb dispatched via getVcs — a Promise-returning call).

test('runBrainWritesReviewedCheck: gh api failure inside the wrapper → fails closed at a required tier (issue #942, R6 — mirrors actor-check.mjs\'s existing discipline), never throws', async () => {
  // UPDATED BY ISSUE #942 (R6, R7): this catch was an unconditional `warn` —
  // a throwing input-gathering failure behind that warn was cosmetic, and the
  // stale docstring claiming the job was "detection-only" was the stated (but
  // false) justification. It is now tier-aware, exactly like actor-check.mjs's
  // own gh-api-failure catch: a "cannot verify" is not "no evidence yet"
  // (REQ-L6-2), and `brain-writes-reviewed` is `required` at every tier.
  const deps = {
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    // Pinned to 'standard' (issue #358 Q5 Phase 4): this repo's own
    // brain.config.json declares "tier": "lite" (design.md §5), under which
    // `fetchReviews` is never even called (lite's evidence never touches
    // reviews) — an unpinned tier would make this test vacuous.
    tier: 'standard',
    diffNameOnly: () => ['brain/core/foo.mjs'],
    fetchReviews: () => {
      throw new Error('gh api failed: rate limited');
    },
    readBotAllowlist: () => [],
  };
  const result = await runBrainWritesReviewedCheck(deps);
  assert.equal(result.level, 'fail', 'an unverifiable required gate must fail closed, not warn');
  assert.match(result.reason, /rate limited/);
});

test('runBrainWritesReviewedCheck: missing BASE_SHA/HEAD_SHA/PR_NUMBER/repo/author context → warn + pass, never throws', async () => {
  const result = await runBrainWritesReviewedCheck({ baseSha: undefined, headSha: undefined, repo: undefined, prNumber: undefined, author: undefined });
  assert.equal(result.level, 'warn');
});

test('runBrainWritesReviewedCheck: happy path end-to-end through the wrapper — human approval passes', async () => {
  const deps = {
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    // Pinned to 'standard' (issue #358 Q5 Phase 4) — this test is about the
    // human-APPROVED-review evidence path specifically; without the pin it
    // would coincidentally still pass under this repo's real 'lite' tier,
    // but for the wrong reason (agent-authorship exclusion, never even
    // reaching fetchReviews).
    tier: 'standard',
    diffNameOnly: () => ['brain/core/foo.mjs'],
    fetchReviews: () => [{ state: 'APPROVED', author: 'bob' }],
    readBotAllowlist: () => [],
  };
  const result = await runBrainWritesReviewedCheck(deps);
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
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    // Pinned to 'standard' — see the runBrainWritesReviewedCheck comment
    // above (issue #358 Q5 Phase 4): this test is about self-approval, which
    // 'lite' does not evaluate at all.
    tier: 'standard',
    diffNameOnly: () => ['brain/core/foo.mjs'],
    fetchReviews: () => [{ state: 'APPROVED', author: 'alice' }],
    readBotAllowlist: () => [],
  };
  let exitCode;
  const lines = await captureLogs(async () => {
    exitCode = await main(deps);
  });
  assert.equal(exitCode, 1);
  assert.equal(lines[0], 'brain-writes-reviewed: fail');
});

test('main: warn verdict → exit code 0', async () => {
  const deps = {
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    // Pinned to 'standard' — see the runBrainWritesReviewedCheck comment
    // above (issue #358 Q5 Phase 4): this test is about the no-reviews-yet
    // warn branch, which 'lite' never reaches.
    tier: 'standard',
    diffNameOnly: () => ['brain/core/foo.mjs'],
    fetchReviews: () => [],
    readBotAllowlist: () => [],
  };
  let exitCode;
  const lines = await captureLogs(async () => {
    exitCode = await main(deps);
  });
  assert.equal(exitCode, 0);
  assert.equal(lines[0], 'brain-writes-reviewed: warn');
});

test('main: pass verdict → exit code 0', async () => {
  const deps = {
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    diffNameOnly: () => ['README.md'],
    fetchReviews: () => [],
    readBotAllowlist: () => [],
  };
  let exitCode;
  const lines = await captureLogs(async () => {
    exitCode = await main(deps);
  });
  assert.equal(exitCode, 0);
  assert.equal(lines[0], 'brain-writes-reviewed: pass');
});

// ── ci-context seam wiring (ADR-0016) ─────────────────────────────────────────
//
// baseSha/headSha/prNumber/repo/author/prLabels now source from an injected
// `deps.ctx` (ci-context.mjs's loadContext()) instead of process.env.
// `ctx.labels` (already an array) replaces the PR_LABELS env parsing.

test('ci-context seam: deps.ctx feeds baseSha/headSha/prNumber/repo/author/prLabels when deps.* are absent', async () => {
  const deps = {
    ctx: {
      baseSha: 'base', headSha: 'head', prNumber: 144, repo: 'org/repo',
      author: 'alice', labels: ['override:incident-response'],
    },
    diffNameOnly: () => ['brain/core/foo.mjs'],
    fetchReviews: () => [{ state: 'APPROVED', author: 'bob' }],
    readOverrideActors: () => ['override:incident-response'],
  };
  const result = await runBrainWritesReviewedCheck(deps);
  assert.equal(result.level, 'pass');
});

test('ci-context seam: no ctx and no deps.* context → warn (never reads process.env directly)', async () => {
  const result = await runBrainWritesReviewedCheck({ ctx: {} });
  assert.equal(result.level, 'warn');
});

test('ci-context seam: ctx.labels (array) feeds adminOverride resolution directly — no PR_LABELS string parsing needed', async () => {
  const deps = {
    ctx: {
      baseSha: 'base', headSha: 'head', prNumber: 144, repo: 'org/repo',
      author: 'alice', labels: ['override:incident-response'],
    },
    // Pinned to 'standard' — see the runBrainWritesReviewedCheck comment
    // above (issue #358 Q5 Phase 4): this test is about the override:*
    // bypass, which 'lite' never reaches (it passes on agent-authorship
    // exclusion alone, before the override branch).
    tier: 'standard',
    diffNameOnly: () => ['brain/core/foo.mjs'],
    fetchReviews: () => [{ state: 'APPROVED', author: 'alice' }], // self-approval — would fail without override
    readOverrideActors: () => ['override:incident-response'],
  };
  const result = await runBrainWritesReviewedCheck(deps);
  assert.equal(result.level, 'pass');
  assert.match(result.reason, /override/i);
});

test('drift-guard: brain-writes-reviewed.mjs source never reads process.env.PR_LABELS/PR_AUTHOR/BASE_SHA/HEAD_SHA/PR_NUMBER/GITHUB_REPOSITORY directly', () => {
  const srcPath = fileURLToPath(new URL('./brain-writes-reviewed.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  for (const v of ['PR_LABELS', 'PR_AUTHOR', 'BASE_SHA', 'HEAD_SHA', 'PR_NUMBER', 'GITHUB_REPOSITORY']) {
    assert.equal(src.includes(`process.env.${v}`), false, `source must not reference process.env.${v}`);
  }
});

test('neutrality source-scan (REQ-NEUTRALITY-2): brain-writes-reviewed.mjs source contains no .claude or SKILL.md literal', () => {
  const srcPath = fileURLToPath(new URL('./brain-writes-reviewed.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.equal(src.includes('.claude'), false, 'source must not reference .claude');
  assert.equal(src.includes('SKILL.md'), false, 'source must not reference SKILL.md');
});

// ── A3 TASK2 (fresh-context review's class-closure audit — the 4th VIOLATION):
// defaultFetchReviews was STILL gh-CLI-hardcoded, the SAME defect class as
// finding #14 (issue-link) and the pre-fix labelEvents/fetchIssue wrappers in
// actor-check.mjs — on GitLab CI (no `gh` binary) it threw ENOENT, masking
// the L6 gate behind a permanent `warn`. Per lesson #10/#12, this test does
// NOT inject deps.fetchReviews — it mocks ONE layer lower, at getVcs, so the
// REAL defaultFetchReviews wrapper runs end-to-end.

test('A3 TASK2: GitLab self-approval on a brain/core change via the REAL default path (no injected fetchReviews) — defaultFetchReviews dispatches getVcs({provider}).prReviews(...), no gh/glab spawn, evaluateBrainWritesReviewed reaches fail', async () => {
  let receivedProvider;
  let calledParams;
  let spawnCalled = false;
  const fakeVcs = {
    prReviews: async (params) => {
      calledParams = params;
      return [{ state: 'APPROVED', author: 'alice' }];
    },
  };
  setSpawn(() => {
    spawnCalled = true;
    return { status: 0, stdout: '{}', stderr: '' };
  });
  try {
    const result = await runBrainWritesReviewedCheck({
      baseSha: 'base',
      headSha: 'head',
      prNumber: 144,
      repo: 'g/r',
      author: 'alice',
      prLabels: [],
      provider: 'gitlab',
      // Pinned to 'standard' (issue #358 Q5 Phase 4): this repo's own
      // brain.config.json declares "tier": "lite" (design.md §5), under
      // which the default fetchReviews wrapper is never even called (lite's
      // evidence never touches reviews) — this test is specifically about
      // that wrapper's real getVcs dispatch, so it must not silently run
      // under a tier that skips it.
      tier: 'standard',
      diffNameOnly: () => ['brain/core/foo.mjs'],
      getVcs: async (opts) => { receivedProvider = opts.provider; return fakeVcs; },
      readBotAllowlist: () => [],
      // deliberately NOT fetchReviews — exercising the REAL default wrapper.
    });

    assert.equal(spawnCalled, false, 'the GitLab default path must never spawn a CLI process (gh/glab)');
    assert.equal(receivedProvider, 'gitlab', 'getVcs must be called with the runtime ctx.provider (finding #14)');
    assert.equal(calledParams.project, 'g/r');
    assert.equal(calledParams.number, 144);
    assert.equal(result.level, 'fail', 'self-approval on brain/core must EVALUATE to fail via the real default path');
    assert.match(result.reason, /self/i);
  } finally {
    setSpawn(spawnSync);
  }
});

test('A3 TASK2 source-scan: defaultFetchReviews no longer contains execFileSync(\'gh\', ...) — structurally proves the default path cannot spawn gh regardless of provider', () => {
  const srcPath = fileURLToPath(new URL('./brain-writes-reviewed.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  const fnStart = src.indexOf('function defaultFetchReviews');
  assert.notEqual(fnStart, -1, 'defaultFetchReviews not found in source');
  const fnEnd = src.indexOf('\nfunction ', fnStart + 1);
  const fnBody = src.slice(fnStart, fnEnd === -1 ? undefined : fnEnd);
  assert.equal(fnBody.includes('execFileSync'), false, 'defaultFetchReviews must dispatch via getVcs(...).prReviews(...), never a raw execFileSync(\'gh\', ...) call');
  assert.match(fnBody, /getVcs|prReviews/, 'sanity: dispatch through the vcs adapter is present');
});

// ── governance.reviewActors wiring (issue #266, design §3 two-key split) ──────
//
// Binding ruling R2 ("no key feeds two gates"): L6's default botAllowlist reader
// key MOVES from governance.approvalActors to the NEW governance.reviewActors —
// it does NOT union them. approvalActors is now L5-only (actor-check.mjs). An
// identity present ONLY in approvalActors must NOT appear in L6's botAllowlist —
// that is the distinguishing assertion that a union would fail.

test('governance.reviewActors (issue #266, R2): L6 default botAllowlist reader reads ONLY governance.reviewActors — an approvalActors-only identity is excluded (no key feeds two gates)', async () => {
  const dir = testTmp('brain-config-');
  writeFileSync(join(dir, 'brain.config.json'), JSON.stringify({
    governance: {
      approvalActors: ['release-bot'],       // L5-only — must NOT leak into L6
      reviewActors: ['brain-reviewer[bot]'], // L6-only
    },
  }));
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    cwd: dir,
    deps: {
      diffNameOnly: () => ['brain/core/foo.mjs'],
      fetchReviews: () => [],
      // deliberately NOT injecting readBotAllowlist — exercising the REAL
      // default reader, which must read reviewActors alone.
    },
  });
  assert.deepEqual(
    new Set(inputs.botAllowlist),
    new Set(['brain-reviewer[bot]']),
    'L6 botAllowlist must contain ONLY governance.reviewActors; an approvalActors-only identity (release-bot) must NOT feed L6 (R2: no key feeds two gates)',
  );
  assert.ok(
    !inputs.botAllowlist.includes('release-bot'),
    'release-bot is L5-only (governance.approvalActors) — a union implementation would wrongly include it here',
  );
});

// ── REQ-266-6 t2 (issue #266, rev-2 binding condition B, lock 3) ──────────────
//
// The reviewer identity (test fixture — task 7.3 is deferred, no real reviewer
// bot handle exists yet) is registered in governance.reviewActors and threaded
// into L6's botAllowlist. An APPROVED review it authors must NOT be counted as
// the human review.

test('REQ-266-6 t2 (lock-3, issue #266): reviewer identity in governance.reviewActors is excluded from L6\'s human-approver count — an APPROVED review it authors does not satisfy brain-writes-reviewed', async () => {
  const dir = testTmp('brain-config-');
  writeFileSync(join(dir, 'brain.config.json'), JSON.stringify({
    governance: { approvalActors: [], reviewActors: ['brain-reviewer[bot]'] },
  }));
  const result = await runBrainWritesReviewedCheck({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    prLabels: [],
    cwd: dir,
    diffNameOnly: () => ['brain/core/foo.mjs'],
    fetchReviews: () => [{ state: 'APPROVED', author: 'brain-reviewer[bot]' }],
    // deliberately NOT injecting readBotAllowlist — exercising the REAL default
    // reader, which must thread governance.reviewActors into botAllowlist.
  });
  assert.notEqual(result.level, 'pass', 'an APPROVED review authored only by the reviewer identity must never satisfy the Tier-2 human-review gate');
  assert.equal(result.level, 'fail', 'the only APPROVED reviewer is bot-allow-listed (via governance.reviewActors) — same outcome as any bot-only approval');
});

// ── issue #942 (R1, R6, R7, R11): a deny reader propagates; the catch is tier-aware ──
//
// `defaultReadBotAllowlist`/`defaultReadApprovalActors` used to `catch { return
// [] }` — an unreadable brain.config.json excluded nobody from L6's human-
// approver count. They now call `loadBrainConfigOrThrow(cwd)` and drop the
// catch, and the wrapper's own catch (`:407-415`) is now tier-aware
// (`resolveTierForFailure` + `resolveGatePolicy`, mirroring actor-check.mjs) —
// an unconditional `warn` behind a throwing deny reader is cosmetic (R6).

test('T6: runBrainWritesReviewedCheck — unparseable brain.config.json, no reader injected → fail, not warn (R6\'s lock)', async () => {
  const dir = testTmp('brain-config-');
  writeFileSync(join(dir, 'brain.config.json'), '{oops');
  const result = await runBrainWritesReviewedCheck({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    cwd: dir,
    // Injected so the ONLY possible failure in this run is `readBotAllowlist`
    // (`defaultReadBotAllowlist`, the DENY reader this test exists to pin) —
    // without these four, THREE other things independently produce the same
    // `fail` verdict and mask a `readBotAllowlist` regression: `diffNameOnly`'s
    // real `git diff` throwing "not a repository" in this non-git testTmp()
    // dir, AND the sibling ALLOW reader `readOverrideActors`
    // (`defaultReadApprovalActors`) ALSO throwing on the same malformed
    // config right after `readBotAllowlist` runs (`:392-393`) — reverting
    // `readBotAllowlist`'s hardening alone left this test green (measured,
    // issue #942 review). A mutation-guard requirement (T12).
    diffNameOnly: () => ['README.md'],
    fetchReviews: () => [],
    readOverrideActors: () => [],
    readConfig: () => ({}),
  });
  assert.equal(result.level, 'fail', 'a deny/exclusion-list read failure must fail closed, never warn (R6)');
  assert.match(result.reason, /brain\.config\.json/);
});

test('T7: gatherBrainWritesReviewedInputs — no brain.config.json at all → botAllowlist: [] (R11), normal verdict', async () => {
  const dir = testTmp('brain-config-');
  const inputs = await gatherBrainWritesReviewedInputs({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    cwd: dir,
    deps: {
      diffNameOnly: () => ['README.md'],
      fetchReviews: () => [],
    },
  });
  assert.deepEqual(inputs.botAllowlist, [], 'an absent config excludes nobody from the human-approver count (R11)');
  assert.equal(evaluateBrainWritesReviewed(inputs).level, 'pass', 'no brain/** files touched — Tier-2 review not required');
});

test('T8: runBrainWritesReviewedCheck — unparseable config, gate policy forced to "detection" → the warn arm is reachable (guards the dead branch)', async () => {
  // brain-writes-reviewed is `required` at every REAL tier today (GATE_MATRIX),
  // so the `warn` arm has no live route — this test drives it directly via the
  // same injectable override the wrapper's other I/O already uses, proving the
  // branch is correctly SHAPED rather than merely absent (design.md D4, T8).
  const dir = testTmp('brain-config-');
  writeFileSync(join(dir, 'brain.config.json'), '{oops');
  const result = await runBrainWritesReviewedCheck({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    cwd: dir,
    tier: 'lite',
    resolveGatePolicy: () => 'detection',
  });
  assert.equal(result.level, 'warn', 'a detection-tier policy must degrade to warn, never fail');
  assert.match(result.reason, /detection-tier/);
});

// ── issue #942 review (F2): resolveTierForFailure must never throw, even on ──
// an invalid injected `deps.tier` — it runs INSIDE runBrainWritesReviewedCheck's
// catch, after a prior failure has already occurred; a second throw here would
// escape uncaught and break this function's documented never-throws contract.

test('T13: runBrainWritesReviewedCheck — invalid injected tier during a config failure → never throws, degrades to a valid tier', async () => {
  const dir = testTmp('brain-config-');
  writeFileSync(join(dir, 'brain.config.json'), '{oops');
  const result = await runBrainWritesReviewedCheck({
    baseSha: 'base',
    headSha: 'head',
    prNumber: 144,
    repo: 'org/repo',
    author: 'alice',
    cwd: dir,
    tier: 'bogus-tier',
    diffNameOnly: () => ['README.md'],
    fetchReviews: () => [],
  }).catch(err => ({ threw: err }));
  assert.ok(!result.threw, `runBrainWritesReviewedCheck must never throw: ${result.threw?.message}`);
  assert.equal(result.level, 'fail', 'an invalid tier must degrade fail-closed, not silently pass or warn');
});
