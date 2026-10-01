// brain-protect.test.mjs — regression guard for the CLI-guard incident.
//
// brain-protect.mjs performs a network branch-protection mutation. It MUST only
// run when invoked directly (CLI), never on import. Without the `import.meta.url`
// guard, importing the module executes activateProtection() at top level —
// reading config, dispatching to the provider, and (on failure) calling
// process.exit, which would crash any importer. This test fails closed if the
// guard regresses: a clean import that exports the function proves the guard holds.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { verifyArmedProtection, verifyAfterArm } from './brain-protect.mjs';

test('brain-protect: importing is side-effect-free (CLI guard holds)', async () => {
  const mod = await import('./brain-protect.mjs');
  assert.equal(
    typeof mod.activateProtection,
    'function',
    'activateProtection must be exported',
  );
  // Reaching here means the import did NOT invoke activateProtection() — if the
  // CLI guard were removed, the top-level activation would have run on import
  // (network mutation / process.exit), and this test would never get here.
});

// ── verifyArmedProtection (issue #203, deliverable 3 — arm-and-verify) ─────────
//
// Best-effort post-arm verification: warns (never fails) when a required check
// context has no matching check-run yet. The check-run query is injected via
// `listCheckRuns` — no real `gh` call, no config file read, no process.exit.

test('verifyArmedProtection: warns when a required context has no matching check-run', async () => {
  const logs = [];
  await verifyArmedProtection({
    checks: ['issue-link', 'diff-size'],
    project: 'acme/repo',
    listCheckRuns: async () => ['issue-link'],
    log: (msg) => logs.push(msg),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /diff-size/);
});

test('verifyArmedProtection: no warning when all required contexts have matching check-runs', async () => {
  const logs = [];
  await verifyArmedProtection({
    checks: ['issue-link', 'diff-size'],
    project: 'acme/repo',
    listCheckRuns: async () => ['issue-link', 'diff-size', 'local-checks'],
    log: (msg) => logs.push(msg),
  });
  assert.deepEqual(logs, []);
});

test('verifyArmedProtection: zero check-runs emits a single unverifiable note, not N warnings', async () => {
  const logs = [];
  await verifyArmedProtection({
    checks: ['issue-link', 'diff-size', 'local-checks'],
    project: 'acme/repo',
    listCheckRuns: async () => [],
    log: (msg) => logs.push(msg),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unverifiable|no check-runs/i);
});

// ── verifyArmedProtection — F1: never crash activateProtection (issue #203 review) ─
//
// A future provider's checkRuns/listCheckRuns could throw (or reject) instead of
// swallowing its own errors the way github.mjs does today. That must degrade to
// the same "unverifiable" note, never propagate — armed protection already
// succeeded by the time this runs, and a verification-layer bug must not look
// like an armed-protection failure.

test('verifyArmedProtection: a throwing listCheckRuns resolves (unverifiable), never rejects', async () => {
  const logs = [];
  await assert.doesNotReject(() =>
    verifyArmedProtection({
      checks: ['issue-link'],
      project: 'acme/repo',
      listCheckRuns: async () => { throw new Error('boom'); },
      log: (msg) => logs.push(msg),
    })
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unverifiable|no check-runs/i);
});

test('verifyArmedProtection: a listCheckRuns that returns a rejected promise also resolves (unverifiable)', async () => {
  const logs = [];
  await assert.doesNotReject(() =>
    verifyArmedProtection({
      checks: ['issue-link'],
      project: 'acme/repo',
      listCheckRuns: () => Promise.reject(new Error('network timeout')),
      log: (msg) => logs.push(msg),
    })
  );
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unverifiable|no check-runs/i);
});

// ── verifyAfterArm — F2: distinguish "unsupported" from "no runs yet" (issue #203) ─
//
// A provider without a checkRuns verb (e.g. a hypothetical GitLab provider) would
// otherwise get the misleading "no runs yet — unverifiable until the first PR
// runs" note, which implies it will self-resolve. It never will, because that
// provider has no run-based verb at all. That case must get a DISTINCT note.

test('verifyAfterArm: provider without checkRuns logs "unsupported", never the no-runs-yet note', async () => {
  const logs = [];
  await verifyAfterArm({
    checks: ['issue-link', 'diff-size'],
    project: 'acme/repo',
    branch: 'main',
    provider: 'gitlab',
    providerModule: {}, // no checkRuns function — simulates a provider without the verb
    log: (msg) => logs.push(msg),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /not supported|unsupported/i);
  assert.doesNotMatch(logs[0], /no check-runs|unverifiable/i);
});

test('verifyAfterArm: provider WITH checkRuns still runs run-based verification (no-runs-yet note on zero runs)', async () => {
  const logs = [];
  await verifyAfterArm({
    checks: ['issue-link'],
    project: 'acme/repo',
    branch: 'main',
    provider: 'github',
    providerModule: { checkRuns: async () => [] },
    log: (msg) => logs.push(msg),
  });
  assert.equal(logs.length, 1);
  assert.match(logs[0], /unverifiable|no check-runs/i);
});

// ── #94: requiredReviews is tier-derived, never the provider's default ──────
//
// `brain:protect` derived `checks` from `requiredJobs(tier)` and left the review
// count to the provider, whose signature defaults it to 1. So the value armed on
// the platform did not come from the repo's declared tier at all — and at n=1,
// `required_approving_review_count: 1` is unsatisfiable (GitHub forbids a PR
// author approving their own PR), so a run of an idempotent verb left `main`
// in a state its only maintainer could not merge through, silently.
//
// Measured 2026-08-13 before the fix: the live value was 0 and correct, held by
// nobody having run the verb since 2026-08-05 rather than by anything in code.

import { protectionFor, activateProtection } from './brain-protect.mjs';

const CONFIG = (tier) => ({
  vcs: { provider: 'github' },
  project: { slug: 'acme/widgets' },
  governance: { tier },
});

/** A provider spy that records every branchProtect call verbatim. */
function spyProvider() {
  const calls = [];
  return {
    calls,
    branchProtect: async (args) => { calls.push(args); return { enforced: true }; },
    // verifyAfterArm dispatches on this being absent — keep it absent so the
    // test exercises the arming path only.
  };
}

test('#94: protectionFor derives the review count from the tier, for every tier', () => {
  assert.equal(protectionFor(CONFIG('lite')).requiredReviews, 0,
    'lite: REQ-L6-1′ — a human author suffices for a brain/core write, so no second review is required');
  assert.equal(protectionFor(CONFIG('standard')).requiredReviews, 1,
    'standard: L6 wants a non-author human approver');
  assert.equal(protectionFor(CONFIG('regulated')).requiredReviews, 1,
    'regulated: the same L6 requirement — the "panel >= 2" tier parameter is the reviewer verdict mode, not an approval count');
});

test('#94: activateProtection PASSES the derived count — the provider default is never relied on', async () => {
  for (const [tier, expected] of [['lite', 0], ['standard', 1], ['regulated', 1]]) {
    const provider = spyProvider();
    await activateProtection({ _config: CONFIG(tier), _providerModule: provider });

    assert.equal(provider.calls.length, 1, `${tier}: branchProtect called exactly once`);
    const args = provider.calls[0];
    assert.ok('requiredReviews' in args,
      `${tier}: requiredReviews must be PRESENT in the call — omitting it hands the decision to ` +
      `the provider's parameter default (github.mjs defaults it to 1), which is the defect`);
    assert.equal(args.requiredReviews, expected, `${tier}: armed the tier's value`);
  }
});

test('#94: two consecutive runs send byte-identical protection — the verb is idempotent in what it arms', async () => {
  // The test the whole ticket exists for. Before the fix the second run changed
  // required_approving_review_count from 0 to 1 while reporting nothing, so
  // "idempotent" was true of the verb's intent and false of its effect.
  const provider = spyProvider();
  const config = CONFIG('lite');

  await activateProtection({ _config: config, _providerModule: provider });
  await activateProtection({ _config: config, _providerModule: provider });

  assert.equal(provider.calls.length, 2);
  assert.deepEqual(provider.calls[0], provider.calls[1],
    `two runs of an idempotent verb must send the same protection. Got:\n` +
    `  run 1: ${JSON.stringify(provider.calls[0])}\n  run 2: ${JSON.stringify(provider.calls[1])}`);
});

test('#94: the run REPORTS the armed count and the tier that produced it', async () => {
  // Found by the mutation sweep, not by design: deleting the log line left every
  // other test green. That line is not decoration — the defect this ticket closes
  // was a value nobody could see the origin of, so an unreported count is the
  // original failure with a different number in it.
  const provider = spyProvider();
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await activateProtection({ _config: CONFIG('lite'), _providerModule: provider });
  } finally {
    console.log = realLog;
  }

  const reported = lines.find(l => /Required reviews/i.test(l));
  assert.ok(reported, `no line reported the review count. Got:\n${lines.join('\n')}`);
  assert.match(reported, /\b0\b/, 'the armed value must appear');
  assert.match(reported, /lite/, 'and the tier it came from — a number with no origin is what this ticket closes');
});

test('#348: a PARTIAL success is ANNOUNCED — enforced with a reason prints the note', async () => {
  // Round 2's blocker: branchProtect was taught to report the approval count it
  // could not apply, and this caller read `reason` only in the failure branch —
  // so brain:protect printed "activated successfully" and nothing else. The
  // value became honest while the surface stayed silent, which is the same
  // defect one layer up from the one this ticket closes.
  const partial = {
    calls: [],
    branchProtect: async (args) => {
      partial.calls.push(args);
      return {
        enforced: true,
        reason: 'the branch is protected, but the 1-approval requirement was NOT applied — needs GitLab Premium',
      };
    },
  };
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await activateProtection({ _config: CONFIG('standard'), _providerModule: partial });
  } finally {
    console.log = realLog;
  }

  const out = lines.join('\n');
  assert.match(out, /activated successfully/, 'the protection did succeed, and still says so');
  assert.match(out, /NOT applied/, 'and what it could NOT do is on screen — not only in a return value nobody reads');
});

test('#348: a full success stays quiet — nothing unapplied, nothing announced', async () => {
  const provider = spyProvider();   // returns { enforced: true } with no reason
  const lines = [];
  const realLog = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try {
    await activateProtection({ _config: CONFIG('lite'), _providerModule: provider });
  } finally {
    console.log = realLog;
  }
  assert.ok(!lines.some(l => /Note   :/.test(l)),
    'announcing an unapplied count nobody asked for is the noise that makes real signals unread');
});
