// relabel-retrigger.test.mjs — issue #328 (stale-GREEN gate re-evaluation).
//
// Two things are proven here:
//   1. selectReferencingPrs — the pure PR-discovery filter — correctly
//      identifies which open PRs reference a given issue number, reusing the
//      shared CLOSING_RE/CHAIN_RE vocabulary (issue-ref-patterns.mjs).
//   2. The actual bug fix: evaluateActor (vcs/actor-check.mjs), re-invoked
//      with post-approval data (what a genuine FULL rerun produces), yields a
//      fresh, non-stale verdict — unlike `gh run rerun --failed`, which would
//      never even make this second call because the already-green
//      actor-check job is skipped entirely.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { selectReferencingPrs, run } from './relabel-retrigger.mjs';
import { evaluateActor } from '../vcs/actor-check.mjs';

// ── selectReferencingPrs ─────────────────────────────────────────────────────

test('selectReferencingPrs: "Closes #328" matches issue 328', () => {
  const prs = [{ number: 1, headRefName: 'a', body: 'Closes #328' }];
  assert.deepEqual(selectReferencingPrs(prs, 328).map(p => p.number), [1]);
});

test('selectReferencingPrs: "Part of #328" matches issue 328 (chained-PR reference)', () => {
  const prs = [{ number: 2, headRefName: 'b', body: 'Part of #328' }];
  assert.deepEqual(selectReferencingPrs(prs, 328).map(p => p.number), [2]);
});

test('selectReferencingPrs: near-miss numbers "#3288" and "#32" must NOT match issue 328', () => {
  const prs = [
    { number: 3, headRefName: 'c', body: 'Closes #3288' },
    { number: 4, headRefName: 'd', body: 'Closes #32' },
  ];
  assert.deepEqual(selectReferencingPrs(prs, 328), []);
});

test('selectReferencingPrs: multiple candidates — only the ones actually referencing the issue survive', () => {
  const prs = [
    { number: 1, headRefName: 'a', body: 'Closes #328' },
    { number: 2, headRefName: 'b', body: 'Closes #999' },
    { number: 3, headRefName: 'c', body: 'Part of #328' },
    { number: 4, headRefName: 'd', body: 'an unrelated PR body' },
  ];
  assert.deepEqual(selectReferencingPrs(prs, 328).map(p => p.number), [1, 3]);
});

test('selectReferencingPrs: matching is case-insensitive', () => {
  const prs = [
    { number: 1, headRefName: 'a', body: 'CLOSES #328' },
    { number: 2, headRefName: 'b', body: 'PART OF #328' },
  ];
  assert.deepEqual(selectReferencingPrs(prs, 328).map(p => p.number), [1, 2]);
});

test('selectReferencingPrs: all nine GitHub closing-keyword forms match', () => {
  const forms = ['close', 'closes', 'closed', 'fix', 'fixes', 'fixed', 'resolve', 'resolves', 'resolved'];
  for (const kw of forms) {
    const result = selectReferencingPrs([{ number: 1, headRefName: 'a', body: `${kw} #328` }], 328);
    assert.deepEqual(result.map(p => p.number), [1], `keyword form "${kw}" must match`);
  }
});

test('selectReferencingPrs: a null/missing body never throws and is excluded', () => {
  assert.doesNotThrow(() => selectReferencingPrs([{ number: 1, headRefName: 'a', body: null }], 328));
  assert.deepEqual(selectReferencingPrs([{ number: 1, headRefName: 'a', body: null }], 328), []);
});

test('selectReferencingPrs: a non-first closing reference in the body still matches (regression: matching must not stop at the first hit)', () => {
  const prs = [
    { number: 1, headRefName: 'a', body: 'Closes #10\n\nAlso closes #328 as a followup fix.' },
    { number: 2, headRefName: 'b', body: 'Part of #10, part of #999, part of #328.' },
  ];
  assert.deepEqual(selectReferencingPrs(prs, 328).map(p => p.number), [1, 2]);
});

// ── run(): discovery + filter + rerun wiring (dependency-injected, no network) ──

test('run(): discovers open PRs via mrList+prView, filters to referencing PRs, and forces a full rerun for each match', async () => {
  const rerunCalls = [];
  const fakeVcs = {
    mrList: async () => ([
      { number: 10, title: 't1', headBranch: 'fix/issue-328-a' },
      { number: 11, title: 't2', headBranch: 'fix/other' },
    ]),
    prView: async ({ number }) => ({
      number,
      body: number === 10 ? 'Closes #328' : 'Closes #999',
    }),
    rerunWorkflowRun: async ({ ref }) => {
      rerunCalls.push(ref);
      return { ok: true, runId: 1 };
    },
  };

  const result = await run({ project: 'x/y', issueNumber: 328, getVcs: async () => fakeVcs });
  assert.deepEqual(result.triggered, [10]);
  assert.deepEqual(result.failed, []);
  assert.deepEqual(rerunCalls, ['fix/issue-328-a']);
});

test('run(): never throws even when the vcs provider or PR discovery fails unexpectedly', async () => {
  await assert.doesNotReject(() =>
    run({ project: 'x/y', issueNumber: 328, getVcs: async () => { throw new Error('boom'); } }),
  );
  await assert.doesNotReject(() =>
    run({
      project: 'x/y',
      issueNumber: 328,
      getVcs: async () => ({ mrList: async () => { throw new Error('transport failure'); } }),
    }),
  );
});

test('run(): a failed retrigger is never silent — it surfaces a ::error/warning-style annotation and a non-empty `failed` list, so a broken retrigger mechanism cannot masquerade as a clean no-op run', async () => {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    const result = await run({ project: 'x/y', issueNumber: 328, getVcs: async () => { throw new Error('vcs down'); } });
    assert.equal(result.failed.length > 0, true, 'a vcs-resolution failure must be reported in `failed`, not swallowed into an empty result');
    assert.ok(
      logs.some(l => l.includes('::warning::')),
      'a vcs-resolution failure must emit a GitHub Actions ::warning:: annotation so it is visible without reading raw step logs',
    );
  } finally {
    console.log = originalLog;
  }
});

// ── stale-GREEN regression proof (issue #328) ───────────────────────────────
//
// This is the proof that the fix actually fixes the bug: a genuine
// RE-INVOCATION of evaluateActor — exactly what governance-relabel.yml's
// FULL rerun forces governance.yml's actor-check job to do — produces a
// fresh, non-stale verdict. `gh run rerun --failed` would never even reach
// this second call, because a job that returned warn/pass (green) the first
// time is not "failed" and gets skipped entirely — that is the stale-GREEN
// bug (PR #322 merged on a verdict computed before the fact it depends on
// existed).

test('stale-GREEN regression: evaluateActor re-invoked with post-approval labeledEvents produces a fresh, non-stale verdict', () => {
  // Pre-approval: zero labeled events for the approved label — the state
  // actor-check saw the FIRST time it ran, before the label existed.
  const preApproval = evaluateActor({ author: 'alice', issueAuthor: 'alice', labeledEvents: [] });
  assert.equal(
    preApproval.level,
    'warn',
    'pre-approval: no labeled event yet — must warn, never fail on missing evidence (REQ-L5-2)',
  );

  // Post-approval, self-applied: the label has now landed (what a genuine
  // re-run — triggered by this change's governance-relabel.yml — observes).
  // A stale rerun (--failed, skipping the already-green job) would NEVER
  // make this call at all; a genuine full rerun does, and must now FAIL.
  const postApprovalSelf = evaluateActor({
    author: 'alice',
    issueAuthor: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, action: 'add', label: 'status:approved', at: '2026-07-30T00:00:00Z' }],
  });
  assert.equal(
    postApprovalSelf.level,
    'fail',
    'a genuine re-invocation after approval must correctly detect self-approval — the stale-GREEN warn from before the label existed must never survive a real re-run',
  );

  // Post-approval, distinct approver: correctly resolves to pass, proving
  // the fresh re-evaluation is not simply "always fail after re-running".
  const postApprovalDistinct = evaluateActor({
    author: 'alice',
    issueAuthor: 'alice',
    labeledEvents: [{ actor: { login: 'bob' }, action: 'add', label: 'status:approved', at: '2026-07-30T00:00:00Z' }],
  });
  assert.equal(
    postApprovalDistinct.level,
    'pass',
    'a genuine re-invocation with a distinct approver must correctly resolve to pass, not a fabricated fail',
  );
});
