// substrate.test.mjs — Tests for the capability-aware substrate detector (PR2a).
//
// detectSubstrate() generalizes brain-protect.mjs's {enforced, reason, remedy} shape
// to all of governance and reports the highest ARMED rung (1=merge, 2=release,
// 3=auto-correct, 4=floor). Every probe is injected via `probes` so these tests run
// fully offline: no network, no git state, no ambient env/fs coupling. `env` is
// ALWAYS passed explicitly (never defaulted to process.env) so this suite behaves
// identically locally and inside GitHub Actions (where GITHUB_ACTIONS=true would
// otherwise silently flip rung-3 detection — see CI fragility note in apply-progress).
//
// Run with: npm test (node --test)

import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { detectSubstrate } from './substrate.mjs';
import { checkContexts } from './governance-checks.mjs';
import { setSpawn } from './lib/exec.mjs';
import * as gitlab from '../axes/vcs/adapters/gitlab.mjs';

afterEach(() => setSpawn(spawnSync));

// ── Floor fallback (no probes/config) ───────────────────────────────────────────

test('detectSubstrate: no probes/config/vcs degrades to rung 4 (floor), never crashes', async () => {
  const result = await detectSubstrate({ env: {} });

  assert.equal(result.rung, 4);
  assert.equal(result.enforced, false);
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'reason must be a non-empty string');
  assert.ok(typeof result.remedy === 'string' && result.remedy.length > 0, 'remedy must be a non-empty string');
  assert.ok(result.rungs && typeof result.rungs === 'object', 'rungs must be present');
});

test('detectSubstrate: called with no arguments at all never throws (default env)', async () => {
  // Only assert it resolves without throwing — deliberately does not assert `rung`,
  // since a bare call falls back to the REAL process.env/fs, which is only
  // acceptable for "does it crash", never for a deterministic rung assertion.
  await assert.doesNotReject(async () => detectSubstrate());
});

// ── Rung 3 — auto-correct (post-merge CI presence) ──────────────────────────────

test('detectSubstrate: rung 3 armed when the postMergeCi probe returns true', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => true,
    },
  });

  assert.equal(result.rung, 3);
  assert.equal(result.enforced, true);
  assert.equal(result.rungs[3].active, true);
});

test('detectSubstrate: rung 3 inactive when the postMergeCi probe returns false', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => false,
    },
  });

  assert.equal(result.rung, 4);
  assert.equal(result.rungs[3].active, false);
  assert.ok(typeof result.rungs[3].reason === 'string' && result.rungs[3].reason.length > 0);
  assert.ok(typeof result.rungs[3].remedy === 'string' && result.rungs[3].remedy.length > 0);
});

// ── Rung 3 — 13-row decision table (issue #468, design "Decision table") ────────
//
// evalRung3 is a pure total function over `RunLedgerEvidence`. Every row below
// asserts the FULL six-field shape (REQ-R3-6): available, active, verifiable,
// mechanism, reason, remedy. `observedAt` is always supplied BY the injected
// evidence — never read ambiently — so the skew/staleness rows (E7/E8) are deterministic
// without a clock freeze.

const SIX_FIELDS = ['available', 'active', 'verifiable', 'mechanism', 'reason', 'remedy'];

function assertShape(rung3, label) {
  for (const field of SIX_FIELDS) {
    assert.ok(field in rung3, `${label}: missing field "${field}"`);
  }
}

test('rung 3 decision table (L1): bare true is legacy declared-armed — active, unverified', async () => {
  const result = await detectSubstrate({ env: {}, probes: { postMergeCi: async () => true } });
  assertShape(result.rungs[3], 'L1');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: true, active: true, verifiable: false },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-ci-declared');
});

test('rung 3 decision table (L2): bare false is legacy declared-absent — inactive, unverified, non-empty reason/remedy', async () => {
  const result = await detectSubstrate({ env: {}, probes: { postMergeCi: async () => false } });
  assertShape(result.rungs[3], 'L2');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: true, active: false, verifiable: false },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-ci-absent');
  assert.ok(result.rungs[3].reason);
  assert.ok(result.rungs[3].remedy);
});

test('rung 3 decision table (L3): no probe wired degrades to uncomputable, never active', async () => {
  const result = await detectSubstrate({ env: {}, probes: {} });
  assertShape(result.rungs[3], 'L3');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: false, active: false, verifiable: true },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
});

test('rung 3 decision table (L3): a throwing probe (undefined via safeProbe) degrades to uncomputable, NOT to the false/L2 branch', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: { postMergeCi: () => { throw new Error('boom'); } },
  });
  assert.equal(result.rungs[3].available, false, 'undefined must never collapse into the false/L2 branch');
  assert.equal(result.rungs[3].active, false);
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
});

test('rung 3 decision table (E1): workflowPresent:false reports absent, same mechanism as L2', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: { postMergeCi: async () => ({ workflowPresent: false, read: 'skipped', lastRun: null, error: null, observedAt: 1000 }) },
  });
  assertShape(result.rungs[3], 'E1');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: true, active: false, verifiable: true },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-ci-absent');
});

test('rung 3 decision table (E2): read:unsupported (non-GitHub provider) reports uncomputable', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: { postMergeCi: async () => ({ workflowPresent: true, read: 'unsupported', lastRun: null, error: null, observedAt: null }) },
  });
  assertShape(result.rungs[3], 'E2');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: false, active: false, verifiable: true },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-unsupported');
});

test('rung 3 decision table (E3): read:failed (auth/network/rate-limit/bad JSON) reports uncomputable, never active', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: { postMergeCi: async () => ({ workflowPresent: true, read: 'failed', lastRun: null, error: 'gh: authentication required', observedAt: null }) },
  });
  assertShape(result.rungs[3], 'E3');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: false, active: false, verifiable: true },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
  assert.match(result.rungs[3].reason, /authentication required/);
});

test('rung 3 decision table (E4): read:ok with lastRun:null reports unproven (workflow wired, zero terminal runs)', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: { postMergeCi: async () => ({ workflowPresent: true, read: 'ok', lastRun: null, error: null, observedAt: 5000 }) },
  });
  assertShape(result.rungs[3], 'E4');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: true, active: false, verifiable: true },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-unproven');
});

test('rung 3 decision table (E5): lastRun missing conclusion reports uncomputable, never a fresh success', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 1, conclusion: undefined, completedAt: new Date(1000).toISOString(), htmlUrl: 'https://x/run/1' },
        error: null,
        observedAt: 2000,
      }),
    },
  });
  assertShape(result.rungs[3], 'E5-conclusion');
  assert.equal(result.rungs[3].available, false);
  assert.equal(result.rungs[3].active, false);
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
});

test('rung 3 decision table (E5): lastRun with unparseable completedAt reports uncomputable', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 1, conclusion: 'success', completedAt: 'not-a-date', htmlUrl: 'https://x/run/1' },
        error: null,
        observedAt: 2000,
      }),
    },
  });
  assert.equal(result.rungs[3].available, false);
  assert.equal(result.rungs[3].active, false);
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
});

test('rung 3 decision table (E5): observedAt:null reports uncomputable — staleness cannot be computed', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 1, conclusion: 'success', completedAt: new Date(1000).toISOString(), htmlUrl: 'https://x/run/1' },
        error: null,
        observedAt: null,
      }),
    },
  });
  assert.equal(result.rungs[3].available, false);
  assert.equal(result.rungs[3].active, false);
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
});

test('rung 3 decision table (E5): observedAt:NaN reports uncomputable, never a fresh success (issue #468 blocker — typeof NaN === "number")', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 1, conclusion: 'success', completedAt: new Date(1000).toISOString(), htmlUrl: 'https://x/run/1' },
        error: null,
        observedAt: NaN,
      }),
    },
  });
  assert.equal(result.rungs[3].available, false, 'NaN observedAt must never yield available:true');
  assert.equal(result.rungs[3].active, false, 'NaN observedAt must never arm rung 3 — age comparisons against NaN are always false, which used to fall through to the arming row E9');
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
});

test('rung 3 decision table (E5): observedAt:-Infinity reports uncomputable, never a fresh success', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 1, conclusion: 'success', completedAt: new Date(1000).toISOString(), htmlUrl: 'https://x/run/1' },
        error: null,
        observedAt: -Infinity,
      }),
    },
  });
  assert.equal(result.rungs[3].available, false, 'non-finite observedAt must never yield available:true');
  assert.equal(result.rungs[3].active, false, 'non-finite observedAt must never arm rung 3');
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
});

test('rung 3 decision table: a skewed local clock (observedAt far BEFORE completedAt) reports uncomputable, never a fresh success', async () => {
  // completedAt is GitHub's clock, observedAt is the local wall clock. A local
  // clock running hours behind (VM resumed from suspend, container without
  // NTP) yields a large negative age — must not be read as "very fresh".
  const completedAt = Date.parse('2026-08-05T00:00:00Z');
  const observedAt = completedAt - (2 * 60 * 60 * 1000); // 2h BEFORE completedAt — well past any reasonable skew tolerance
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 1, conclusion: 'success', completedAt: '2026-08-05T00:00:00Z', htmlUrl: 'https://x/run/1' },
        error: null,
        observedAt,
      }),
    },
  });
  assert.equal(result.rungs[3].active, false, 'a negative age beyond skew tolerance must never arm rung 3');
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
});

test('rung 3 decision table: workflowPresent omitted entirely (not === false) is treated as absent, never falls through to arm', async () => {
  // Evidence that omits `workflowPresent` altogether must not silently be
  // treated as "present" — the guard at substrate.mjs must require an
  // explicit truthy presence, not merely reject a strict `false`.
  const completedAt = Date.parse('2026-08-05T00:00:00Z');
  const observedAt = completedAt + (10 * 60 * 60 * 1000);
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        // workflowPresent intentionally omitted
        read: 'ok',
        lastRun: { id: 1, conclusion: 'success', completedAt: '2026-08-05T00:00:00Z', htmlUrl: 'https://x/run/1' },
        error: null,
        observedAt,
      }),
    },
  });
  assert.equal(result.rungs[3].active, false, 'missing workflowPresent must never arm rung 3');
  assert.equal(result.rungs[3].mechanism, 'postmerge-ci-absent', 'missing workflowPresent must be treated the same as workflowPresent:false');
});

test('rung 3 decision table (E6): last terminal run failed reports inert, reason carries the run URL', async () => {
  const observedAt = Date.parse('2026-08-01T00:00:00Z');
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 42, conclusion: 'failure', completedAt: '2026-07-31T23:00:00Z', htmlUrl: 'https://github.com/o/r/actions/runs/42' },
        error: null,
        observedAt,
      }),
    },
  });
  assertShape(result.rungs[3], 'E6');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: true, active: false, verifiable: true },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-failing');
  assert.match(result.rungs[3].reason, /https:\/\/github\.com\/o\/r\/actions\/runs\/42/);
});

test('rung 3 decision table (E8): a successful run older than POSTMERGE_STALE_MS reports inactive (stale), independent of outcome', async () => {
  const completedAt = Date.parse('2026-07-01T00:00:00Z');
  const observedAt = completedAt + (49 * 60 * 60 * 1000); // 49h later — just past the 48h window
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 7, conclusion: 'success', completedAt: '2026-07-01T00:00:00Z', htmlUrl: 'https://github.com/o/r/actions/runs/7' },
        error: null,
        observedAt,
      }),
    },
  });
  assertShape(result.rungs[3], 'E8');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: true, active: false, verifiable: true },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-stale');
});

test('rung 3 decision table (E9): a successful run within POSTMERGE_STALE_MS arms rung 3, run-ledger mechanism', async () => {
  const completedAt = Date.parse('2026-08-05T00:00:00Z');
  const observedAt = completedAt + (10 * 60 * 60 * 1000); // 10h later — within the 48h window
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 9, conclusion: 'success', completedAt: '2026-08-05T00:00:00Z', htmlUrl: 'https://github.com/o/r/actions/runs/9' },
        error: null,
        observedAt,
      }),
    },
  });
  assertShape(result.rungs[3], 'E9');
  assert.deepEqual(
    { available: result.rungs[3].available, active: result.rungs[3].active, verifiable: result.rungs[3].verifiable },
    { available: true, active: true, verifiable: true },
  );
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger');
  assert.equal(result.rungs[3].reason, null);
  assert.equal(result.rungs[3].remedy, null);
});

// Totality check: across the whole decision table, only L1 and E9 ever produce
// active:true — every other row (including every uncomputable row) stays
// active:false, no matter how "close" the evidence looks to success.
test('rung 3 decision table: only L1 (legacy true) and E9 (fresh success) ever produce active:true', async () => {
  const rows = [
    ['L2', async () => false],
    ['L3-missing', async () => undefined],
    ['E1-explicit-false', async () => ({ workflowPresent: false, read: 'skipped', lastRun: null, error: null, observedAt: 1 })],
    ['E1-omitted', async () => ({ read: 'ok', lastRun: { id: 1, conclusion: 'success', completedAt: '2026-08-05T00:00:00Z', htmlUrl: 'u' }, error: null, observedAt: Date.parse('2026-08-05T00:00:00Z') + (10 * 60 * 60 * 1000) })],
    ['E2', async () => ({ workflowPresent: true, read: 'unsupported', lastRun: null, error: null, observedAt: null })],
    ['E3', async () => ({ workflowPresent: true, read: 'failed', lastRun: null, error: 'boom', observedAt: null })],
    // Deliberately carries a FRESH SUCCESSFUL lastRun: with `lastRun: null` this
    // row stayed active:false even with the read-state guard deleted (it merely
    // fell through to E4, also inactive), so it passed for the wrong reason and
    // the guard had no coverage at all. With this evidence, deleting the guard
    // arms rung 3 on a read state outside the contract — and the row goes red.
    ['unrecognized-read', async () => ({ workflowPresent: true, read: 'weird', lastRun: { id: 1, conclusion: 'success', completedAt: '2026-08-05T00:00:00Z', htmlUrl: 'u' }, error: null, observedAt: Date.parse('2026-08-05T00:00:00Z') + (60 * 60 * 1000) })],
    ['E4', async () => ({ workflowPresent: true, read: 'ok', lastRun: null, error: null, observedAt: 5 })],
    ['E5-malformed', async () => ({ workflowPresent: true, read: 'ok', lastRun: { id: 1, completedAt: 'bad' }, error: null, observedAt: 5 })],
    ['E5-NaN-observedAt', async () => ({ workflowPresent: true, read: 'ok', lastRun: { id: 1, conclusion: 'success', completedAt: '2026-07-01T00:00:00Z', htmlUrl: 'u' }, error: null, observedAt: NaN })],
    ['E5-Infinity-observedAt', async () => ({ workflowPresent: true, read: 'ok', lastRun: { id: 1, conclusion: 'success', completedAt: '2026-07-01T00:00:00Z', htmlUrl: 'u' }, error: null, observedAt: Infinity })],
    ['E6', async () => ({ workflowPresent: true, read: 'ok', lastRun: { id: 1, conclusion: 'failure', completedAt: '2026-07-01T00:00:00Z', htmlUrl: 'u' }, error: null, observedAt: Date.parse('2026-07-01T00:00:00Z') })],
    ['E7-clock-skew', async () => ({ workflowPresent: true, read: 'ok', lastRun: { id: 1, conclusion: 'success', completedAt: '2026-08-05T00:00:00Z', htmlUrl: 'u' }, error: null, observedAt: Date.parse('2026-08-05T00:00:00Z') - (2 * 60 * 60 * 1000) })],
    ['E8-stale', async () => ({ workflowPresent: true, read: 'ok', lastRun: { id: 1, conclusion: 'success', completedAt: '2026-07-01T00:00:00Z', htmlUrl: 'u' }, error: null, observedAt: Date.parse('2026-07-01T00:00:00Z') + (49 * 60 * 60 * 1000) })],
  ];

  for (const [label, postMergeCi] of rows) {
    const result = await detectSubstrate({ env: {}, probes: { postMergeCi } });
    assert.equal(result.rungs[3].active, false, `row ${label} must not produce active:true`);
  }

  const e9 = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'ok',
        lastRun: { id: 1, conclusion: 'success', completedAt: '2026-08-05T00:00:00Z', htmlUrl: 'u' },
        error: null,
        observedAt: Date.parse('2026-08-05T00:00:00Z') + (10 * 60 * 60 * 1000),
      }),
    },
  });
  assert.equal(e9.rungs[3].active, true, 'E9 (fresh success) must produce active:true');

  const l1 = await detectSubstrate({ env: {}, probes: { postMergeCi: async () => true } });
  assert.equal(l1.rungs[3].active, true, 'L1 (legacy true) must produce active:true');
});

test('rung 3: an unrecognized read state is UNCOMPUTABLE, not merely inactive — the decision table stays total', async () => {
  // The totality row above proves such evidence never arms. This proves it lands
  // on the right ROW: a read state outside the four-value contract is a thing
  // the reader could not interpret, which is uncomputable — not the honest,
  // claimable "no terminal run yet" (E4) it would otherwise be confused with.
  const result = await detectSubstrate({
    env: {},
    probes: {
      postMergeCi: async () => ({
        workflowPresent: true,
        read: 'weird',
        lastRun: { id: 1, conclusion: 'success', completedAt: '2026-08-05T00:00:00Z', htmlUrl: 'u' },
        error: null,
        observedAt: Date.parse('2026-08-05T00:00:00Z') + (60 * 60 * 1000),
      }),
    },
  });

  assert.equal(result.rungs[3].available, false, 'an uninterpretable read state is uncomputable, never a verdict');
  assert.equal(result.rungs[3].active, false);
  assert.equal(result.rungs[3].mechanism, 'postmerge-run-ledger-uncomputable');
});

// ── Rung 2 — release (release-gate presence) ────────────────────────────────────

test('detectSubstrate: rung 2 armed when the releaseGate probe returns true (rung 3 absent)', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      releaseGate: async () => true,
    },
  });

  assert.equal(result.rung, 2);
  assert.equal(result.enforced, true);
  assert.equal(result.rungs[2].active, true);
  // Below rung 1 (no branchProtection probe wired here), so the top-level
  // reason/remedy surface rung 1's blocker — the actionable next step to climb.
  assert.ok(typeof result.reason === 'string' && result.reason.length > 0);
  assert.ok(typeof result.remedy === 'string' && result.remedy.length > 0);
});

test('detectSubstrate: rung 2 wins over rung 3 when both are armed (higher rung takes priority)', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      releaseGate: async () => true,
      postMergeCi: async () => true,
    },
  });

  assert.equal(result.rung, 2);
});

// ── Rung 2 verdict matrix — structural efficacy, not file presence (#337) ───────
//
// evalRung2 now derives its verdict from STRUCTURAL evidence (trigger + audit
// invocation + write permissions), never from mere workflow-file presence
// (REQ-L2-1). All six rows of design.md's verdict matrix, each independently
// injected via `probes.releaseGate` — fully offline, zero fs coupling (fixtures
// are inline template literals, not disk reads).

test('rung 2 verdict matrix (1/6): config.governance.releaseGate declared true — armed but unverified (declaration, not proof)', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      releaseGate: async () => ({ declared: true, workflowPresent: false, workflowText: null }),
    },
  });

  assert.equal(result.rungs[2].active, true);
  assert.equal(result.rungs[2].verifiable, false, 'a declaration is not a structural proof');
  assert.equal(result.rungs[2].mechanism, 'release-gate-config-declared');
  assert.equal(result.rung, 2);
});

test('rung 2 verdict matrix (2/6): antecedent-capable trigger + brain:audit + contents:write — active AND verifiable', async () => {
  const workflowText = `name: release\n\non:\n  workflow_dispatch:\n\npermissions: { contents: write }\n\njobs:\n  audit-gate:\n    steps:\n      - run: node brain/scripts/brain-audit.mjs "$PREV_TAG..HEAD"\n`;
  const result = await detectSubstrate({
    env: {},
    probes: {
      releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText }),
    },
  });

  assert.equal(result.rungs[2].active, true);
  assert.equal(result.rungs[2].verifiable, true, 'a structural read of trigger+audit+permissions IS a proof');
  assert.equal(result.rungs[2].mechanism, 'release-gate-workflow-structural');
  assert.equal(result.rungs[2].reason, null);
  assert.equal(result.rung, 2);
});

test('rung 2 verdict matrix (3/6): post-fact trigger only (brain\'s actual release.yml shape: push:tags) — inert, verifiable', async () => {
  // Mirrors brain's real .github/workflows/release.yml: on push:tags, the tag
  // already exists by the time the workflow starts — nothing it does can block
  // that tag's creation (design D3), regardless of the audit-gate job inside it.
  const workflowText = `name: release\n\non:\n  push:\n    tags: ['v*']\n\npermissions: { contents: read }\n\njobs:\n  audit-gate:\n    steps:\n      - run: node brain/scripts/brain-audit.mjs "$PREV_TAG..HEAD"\n`;
  const result = await detectSubstrate({
    env: {},
    probes: {
      releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText }),
    },
  });

  assert.equal(result.rungs[2].active, false, 'post-fact trigger cannot block a tag that already exists');
  assert.equal(result.rungs[2].verifiable, true, 'the trigger IS structurally readable — the verdict is a confirmed inert, not an unknown');
  assert.equal(result.rungs[2].mechanism, 'release-gate-workflow-structural');
  assert.match(result.rungs[2].reason, /cannot block tags/i);
  assert.match(result.rungs[2].remedy, /#210/);
  assert.notEqual(result.rung, 2, 'rung 2 must not be selected when inert — brain\'s own repo demotes 2 -> 3');
});

test('rung 2 verdict matrix (4/6): antecedent-capable trigger + audit present but missing contents:write — inert, verifiable', async () => {
  const workflowText = `name: release\n\non:\n  push:\n    branches: [main]\n\npermissions: { contents: read }\n\njobs:\n  audit-gate:\n    steps:\n      - run: node brain/scripts/brain-audit.mjs HEAD~1..HEAD\n`;
  const result = await detectSubstrate({
    env: {},
    probes: {
      releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText }),
    },
  });

  assert.equal(result.rungs[2].active, false, 'without contents:write the workflow cannot itself gate tag creation');
  assert.equal(result.rungs[2].verifiable, true);
  assert.match(result.rungs[2].reason, /contents:\s*write/i);
});

test('rung 2 verdict matrix (5/6): no workflow wired and not declared — inert, verifiable (absent)', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      releaseGate: async () => ({ declared: false, workflowPresent: false, workflowText: null }),
    },
  });

  assert.equal(result.rungs[2].active, false);
  assert.equal(result.rungs[2].verifiable, true);
  assert.equal(result.rungs[2].mechanism, 'release-gate-absent');
  assert.match(result.rungs[2].reason, /no release-gate wired/i);
});

test('rung 2 verdict matrix (6/6): workflow present but unparseable (no recognizable on: block) — inert AND unverifiable', async () => {
  const workflowText = 'this is not a valid workflow file at all, no trigger block present';
  const result = await detectSubstrate({
    env: {},
    probes: {
      releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText }),
    },
  });

  assert.equal(result.rungs[2].active, false);
  assert.equal(result.rungs[2].verifiable, false, 'unparseable must be honestly unverifiable, never a confirmed inert');
  assert.equal(result.rungs[2].mechanism, 'release-gate-unparseable');
});

test('rung 2 verdict matrix: a workflowText read error (null, e.g. fs read failure) is treated as unparseable, never crashes', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText: null }),
    },
  });

  assert.equal(result.rungs[2].active, false);
  assert.equal(result.rungs[2].verifiable, false);
});

test('rung 2 verdict matrix (deferred to #210): audit job present but DAG unproven (no needs: link to tag-creation step) — must report verifiable:false', async () => {
  // This scenario is documented in spec.md but currently undetectable without
  // parsing the full job DAG (detecting needs: links). Phase 3 only checks trigger
  // type + audit invocation + permissions; Phase 4 (#210) will add full DAG
  // validation. For now, this test marks the test expectation and documents that
  // it is deferred.
  const workflowText = `name: release
on:
  workflow_dispatch:
jobs:
  audit:
    runs-on: ubuntu-latest
    steps:
      - run: node brain-audit.mjs HEAD~1..HEAD
  tag:
    runs-on: ubuntu-latest
    permissions: { contents: write }
    steps:
      - run: git tag v1.0.0
`;
  const result = await detectSubstrate({
    env: {},
    probes: { releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText }) },
  });

  // DEFERRED: This should report verifiable: false (audit job present but not
  // provably linked to tag step via needs:). Currently reports verifiable: true
  // because DAG validation is Phase 4 work. This test documents the gap and will
  // be tightened when #210 implements full DAG checking.
  assert.equal(
    result.rungs[2].active,
    true,
    'audit + contents:write detected → active:true (correct for current impl)',
  );
  // TODO(#210): Change to assert.equal(result.rungs[2].verifiable, false) once
  // Phase 4 adds needs: link validation.
});

// ── classifyReleaseWorkflowTrigger — both trigger shapes, exercised through
// evalRung2 (module-local, unit-tested via detectSubstrate + injected text,
// same convention as evalPipelineMustSucceedGate elsewhere in this file) ───────

test('classifyReleaseWorkflowTrigger (post-fact): on.release: is classified post-fact, same as push:tags', async () => {
  const workflowText = `name: release\n\non:\n  release:\n    types: [published]\n\npermissions: { contents: write }\n\njobs:\n  gate:\n    steps:\n      - run: node brain/scripts/brain-audit.mjs HEAD~1..HEAD\n`;
  const result = await detectSubstrate({
    env: {},
    probes: { releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText }) },
  });

  assert.equal(result.rungs[2].active, false, 'on.release fires after the release exists — post-fact, cannot block');
  assert.match(result.rungs[2].reason, /cannot block tags/i);
});

test('classifyReleaseWorkflowTrigger (antecedent-capable): on.workflow_dispatch is distinguished from post-fact triggers', async () => {
  const workflowText = `name: release\n\non:\n  workflow_dispatch:\n\npermissions: { contents: write }\n\njobs:\n  gate:\n    steps:\n      - run: node brain/scripts/brain-audit.mjs HEAD~1..HEAD\n`;
  const result = await detectSubstrate({
    env: {},
    probes: { releaseGate: async () => ({ declared: false, workflowPresent: true, workflowText }) },
  });

  assert.equal(result.rungs[2].active, true, 'workflow_dispatch can run before the tag exists — antecedent-capable');
});

// ── Rung 1 — merge (finer branch-protection read, beyond capabilities()) ────────
//
// capabilities() (github.mjs:96-100) maps BOTH 200 and 404 to 'available' — correct
// for "can I call brain:protect?" but it cannot distinguish armed (rung 1 active)
// from available-but-unset. detectSubstrate adds that distinction itself, via the
// injected branchProtection probe's raw { status, contexts } read (design §1 "why
// finer than capabilities()"). checkContexts() (not hardcoded) defines "our
// required contexts" so this test tracks REQUIRED_JOBS without duplicating it.

const OUR_CONTEXTS = checkContexts();

test('detectSubstrate: rung 1 armed on 200 + our required contexts present', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      branchProtection: async () => ({ status: 200, contexts: OUR_CONTEXTS }),
    },
  });

  assert.equal(result.rung, 1);
  assert.equal(result.enforced, true);
  assert.equal(result.reason, null);
  assert.equal(result.remedy, null);
});

test('detectSubstrate: rung 1 NOT armed on 200 without our required contexts (falls through)', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      branchProtection: async () => ({ status: 200, contexts: ['some-other-check'] }),
    },
  });

  assert.notEqual(result.rung, 1);
  assert.equal(result.rungs[1].active, false);
});

test('detectSubstrate: rung 1 NOT armed on 404 (available but unset) — falls to rung 4', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      branchProtection: async () => ({ status: 404, contexts: [] }),
    },
  });

  assert.equal(result.rung, 4);
  assert.equal(result.rungs[1].available, true, 'branch protection API is reachable — capability is available');
  assert.equal(result.rungs[1].active, false, 'but not yet configured — not armed');
  assert.ok(/unset|not configured|not armed/i.test(result.rungs[1].reason));
});

test('detectSubstrate: rung 1 NOT armed on 403/tier-locked — unavailable, not just unset', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      branchProtection: async () => ({ status: 403, contexts: [] }),
    },
  });

  assert.equal(result.rung, 4);
  assert.equal(result.rungs[1].available, false, 'tier-locked means the capability itself is unavailable');
  assert.equal(result.rungs[1].active, false);
  assert.ok(typeof result.rungs[1].remedy === 'string' && result.rungs[1].remedy.length > 0);
});

test('detectSubstrate: rung 1 armed via self-hosted pre-receive floor, bypassing the probe entirely', async () => {
  const result = await detectSubstrate({
    config: { vcs: { selfHostedPreReceive: true } },
    env: {},
    probes: {
      // If this were called, the self-hosted override would still have to win —
      // but self-hosted arms WITHOUT needing the probe at all.
      branchProtection: async () => ({ status: 403, contexts: [] }),
    },
  });

  assert.equal(result.rung, 1);
  assert.equal(result.enforced, true);
});

// ── GitLab rung-1 sub-gates (issue #244 A4) ─────────────────────────────────────
//
// GitLab rung-1 splits into three honestly-reported sub-gates —
// pipelineMustSucceed (load-bearing, verifiable:true), protectedBranches
// (complementary, verifiable:true), preReceive (config-declared,
// verifiable:false) — OR-composed. This replaces the selfHostedPreReceive
// short-circuit (:98-100). The no-provider (GitHub) cases above MUST stay
// green with ZERO assertion changes (behavior-preservation, Phase 3).

test('detectSubstrate: GitLab rung-1 — pipelineMustSucceed alone arms rung 1 (CP-A2b mirror state)', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'gitlab' } },
    env: {},
    probes: {
      branchProtection: async () => ({ status: 404, contexts: [], pipelineMustSucceed: true }),
    },
  });

  const gates = result.rungs[1].gates;
  assert.equal(gates.pipelineMustSucceed.active, true, 'pipelineMustSucceed must arm rung-1 alone — presence-alone would wrongly report absent here');
  assert.equal(gates.pipelineMustSucceed.verifiable, true);
  assert.equal(gates.pipelineMustSucceed.mechanism, 'branch-merge-gate-api');
  assert.equal(gates.protectedBranches.active, false, 'no protected branches configured on the mirror — honestly inactive');
  assert.equal(result.rung, 1);
  assert.equal(result.rungs[1].active, true);
});

test('detectSubstrate: GitLab rung-1 — neither sub-gate armed → rung-1 inactive with a remedy', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'gitlab' } },
    env: {},
    probes: {
      branchProtection: async () => ({ status: 404, contexts: [], pipelineMustSucceed: false }),
    },
  });

  assert.equal(result.rungs[1].active, false);
  assert.notEqual(result.rung, 1);
  assert.ok(typeof result.rungs[1].remedy === 'string' && result.rungs[1].remedy.length > 0);
});

test('detectSubstrate: GitLab rung-1 — protectedBranches alone arms rung 1 (per-branch push gate present)', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'gitlab' } },
    env: {},
    probes: {
      branchProtection: async () => ({ status: 200, contexts: [], pipelineMustSucceed: false }),
    },
  });

  const gates = result.rungs[1].gates;
  assert.equal(gates.protectedBranches.active, true);
  assert.equal(gates.protectedBranches.verifiable, true);
  assert.equal(gates.protectedBranches.mechanism, 'protected-branch-api');
  assert.equal(gates.pipelineMustSucceed.active, false);
  assert.equal(result.rung, 1);
});

test('detectSubstrate: GitLab rung-1 — selfHostedPreReceive arms via the preReceive sub-gate, not a short-circuit', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'gitlab', selfHostedPreReceive: true } },
    env: {},
    probes: {
      branchProtection: async () => ({ status: 403, contexts: [], pipelineMustSucceed: false }),
    },
  });

  const gates = result.rungs[1].gates;
  assert.equal(gates.preReceive.active, true);
  assert.equal(gates.preReceive.verifiable, false, 'THE honesty flag — no endpoint reports a bare-repo hook');
  assert.equal(gates.preReceive.mechanism, 'pre-receive-config-declared');
  assert.equal(result.rung, 1, 'the short-circuit is gone — the preReceive sub-gate arms rung-1 itself');
  assert.equal(result.enforced, true);
});

test('detectSubstrate: GitLab rung-1 — pipelineMustSucceed uncomputable (undefined) reports available:false honestly, never a fabricated "not armed"', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'gitlab' } },
    env: {},
    probes: {
      branchProtection: async () => ({ status: 404, contexts: [] }), // no pipelineMustSucceed field — uncomputable
    },
  });

  const gate = result.rungs[1].gates.pipelineMustSucceed;
  assert.equal(gate.available, false, 'uncomputable must surface as available:false, not silently "not configured"');
  assert.equal(gate.active, false);
  assert.ok(typeof gate.remedy === 'string' && gate.remedy.length > 0);
});

// ── Propagation proof: the REAL gitlab.mjs#projectMergeSettings null-coercion
// fix survives end-to-end into evalPipelineMustSucceedGate (fresh-context
// review MAJOR — issue #244 A4). Wires the ACTUAL provider function (not a
// hand-rolled fixture returning `null`) as the branchProtection probe, via the
// shared `setSpawn` seam. `GET /projects/:id` succeeds (200, parseable) but
// the body OMITS `only_allow_merge_if_pipeline_succeeds` — a case distinct
// from a failed/unreachable read. Before the null-coercion fix, gitlab.mjs's
// `Boolean(undefined)` fabricated `false` here, which evalPipelineMustSucceedGate
// would have reported as `available:true` ("readable, not configured"),
// masking the honesty violation completely. This test fails if that coercion
// regresses, independent of the providers.test.mjs unit test on gitlab.mjs alone.

test('propagation proof: null from the REAL gitlab.mjs#projectMergeSettings (field absent from a successful read) reaches evalPipelineMustSucceedGate as available:false, never fabricated as "not configured"', async () => {
  setSpawn((cmd, args) => {
    if (cmd === 'glab' && args[0] === 'api' && args[1] === 'projects/csrinaldi%2Fbrain') {
      // 200, parseable, but only_allow_merge_if_pipeline_succeeds is absent.
      return { status: 0, stdout: JSON.stringify({ id: 1, path_with_namespace: 'csrinaldi/brain', default_branch: 'main' }), stderr: '' };
    }
    return { status: 1, stdout: '', stderr: 'unexpected call: ' + cmd + ' ' + args.join(' ') };
  });

  const result = await detectSubstrate({
    config: { vcs: { provider: 'gitlab' } },
    env: {},
    probes: {
      // Mirrors realBranchProtectionProbe's GitLab normalization, but calls
      // the REAL gitlab.mjs function under test (not a fixture double).
      branchProtection: async () => {
        const { onlyAllowMergeIfPipelineSucceeds } = await gitlab.projectMergeSettings({ project: 'csrinaldi/brain' });
        return { status: 404, contexts: [], pipelineMustSucceed: onlyAllowMergeIfPipelineSucceeds };
      },
    },
  });

  const gate = result.rungs[1].gates.pipelineMustSucceed;
  assert.equal(gate.available, false, 'the real function\'s null must survive as available:false — a fabricated false would have reported available:true');
  assert.equal(gate.active, false);
  assert.match(gate.reason, /uncomputable/i);
  assert.doesNotMatch(gate.reason, /is not set/i, 'must not be the "readable, not configured" reason — that would mean null was coerced to false');
  assert.notEqual(result.rung, 1);
});

// ── rungs[1].gates.brainWritesReviewed — per-provider L6 rung-1 sub-probe ───────
//
// Rung 1 is not monolithic: L6 "required code-owner review" is platform-specific.
// GitHub needs branch protection require_code_owner_reviews AND .github/CODEOWNERS;
// GitLab needs Premium+; Bitbucket has no such capability at all. The evidence
// checker (brain-writes-reviewed.mjs, PR6a) is the actual enforcement — this is
// only an OPTIONAL rung-1 enhancement, reported honestly when unavailable.

test('detectSubstrate: brainWritesReviewed armed on GitHub with require_code_owner_reviews + CODEOWNERS', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'github' } },
    env: {},
    probes: {
      brainWritesReviewed: async () => ({ requireCodeOwnerReviews: true, codeownersPresent: true }),
    },
  });

  const gate = result.rungs[1].gates.brainWritesReviewed;
  assert.equal(gate.available, true);
  assert.equal(gate.active, true);
});

test('detectSubstrate: brainWritesReviewed unavailable on GitHub without CODEOWNERS (honest reason)', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'github' } },
    env: {},
    probes: {
      brainWritesReviewed: async () => ({ requireCodeOwnerReviews: true, codeownersPresent: false }),
    },
  });

  const gate = result.rungs[1].gates.brainWritesReviewed;
  assert.equal(gate.available, false);
  assert.ok(/CODEOWNERS/.test(gate.reason));
  assert.ok(typeof gate.remedy === 'string' && gate.remedy.length > 0);
});

test('detectSubstrate: brainWritesReviewed armed on GitLab Premium+', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'gitlab' } },
    env: {},
    probes: {
      brainWritesReviewed: async () => ({ premiumOrHigher: true }),
    },
  });

  const gate = result.rungs[1].gates.brainWritesReviewed;
  assert.equal(gate.available, true);
  assert.equal(gate.active, true);
});

test('detectSubstrate: brainWritesReviewed unavailable on GitLab below Premium', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'gitlab' } },
    env: {},
    probes: {
      brainWritesReviewed: async () => ({ premiumOrHigher: false }),
    },
  });

  const gate = result.rungs[1].gates.brainWritesReviewed;
  assert.equal(gate.available, false);
  assert.ok(/Premium/.test(gate.reason));
});

test('detectSubstrate: brainWritesReviewed reports n/a on Bitbucket (honest, no probe needed)', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'bitbucket' } },
    env: {},
    probes: {},
  });

  const gate = result.rungs[1].gates.brainWritesReviewed;
  assert.equal(gate.available, false);
  assert.ok(/Bitbucket/.test(gate.reason));
});

test('detectSubstrate: brainWritesReviewed degrades honestly when provider is unset', async () => {
  const result = await detectSubstrate({ env: {}, probes: {} });

  const gate = result.rungs[1].gates.brainWritesReviewed;
  assert.equal(gate.available, false);
  assert.ok(typeof gate.reason === 'string' && gate.reason.length > 0);
});

test('detectSubstrate: brainWritesReviewed probe throwing degrades to unavailable, never crashes', async () => {
  const result = await detectSubstrate({
    config: { vcs: { provider: 'github' } },
    env: {},
    probes: {
      brainWritesReviewed: async () => { throw new Error('network blip'); },
    },
  });

  const gate = result.rungs[1].gates.brainWritesReviewed;
  assert.equal(gate.available, false);
});

// PR2b nit (a) — the brainWritesReviewed probe is only meaningful for providers
// that actually have a rung-1 code-owner-review mechanism (GitHub, GitLab). For
// Bitbucket and an unset provider there is nothing to probe — calling it anyway
// is a wasted network/gh call. The probe call must live inside the
// github/gitlab branches only (or the function must early-return before it).

test('detectSubstrate: brainWritesReviewed probe is never invoked for Bitbucket (no such capability)', async () => {
  let called = false;
  const result = await detectSubstrate({
    config: { vcs: { provider: 'bitbucket' } },
    env: {},
    probes: {
      brainWritesReviewed: async () => { called = true; return {}; },
    },
  });

  assert.equal(called, false, 'Bitbucket has no rung-1 code-owner-review capability — the probe must not be called');
  assert.equal(result.rungs[1].gates.brainWritesReviewed.available, false);
});

test('detectSubstrate: brainWritesReviewed probe is never invoked when provider is unset', async () => {
  let called = false;
  const result = await detectSubstrate({
    env: {},
    probes: {
      brainWritesReviewed: async () => { called = true; return {}; },
    },
  });

  assert.equal(called, false, 'no provider configured — nothing to probe, the probe must not be called');
});

// ── Probe-throws-never-crashes: every rung's probe, not just gates ─────────────

test('detectSubstrate: a throwing branchProtection probe degrades rung 1 to inactive, never crashes', async () => {
  await assert.doesNotReject(async () => {
    const result = await detectSubstrate({
      env: {},
      probes: {
        branchProtection: async () => { throw new Error('gh api timeout'); },
      },
    });
    assert.equal(result.rungs[1].active, false);
    assert.notEqual(result.rung, 1);
  });
});

test('detectSubstrate: a throwing releaseGate probe degrades rung 2 to inactive, never crashes', async () => {
  await assert.doesNotReject(async () => {
    const result = await detectSubstrate({
      env: {},
      probes: {
        releaseGate: () => { throw new Error('fs read error'); },
      },
    });
    assert.equal(result.rungs[2].active, false);
  });
});

test('detectSubstrate: a throwing postMergeCi probe degrades rung 3 to inactive, never crashes', async () => {
  await assert.doesNotReject(async () => {
    const result = await detectSubstrate({
      env: {},
      probes: {
        postMergeCi: () => { throw new Error('boom'); },
      },
    });
    assert.equal(result.rungs[3].active, false);
  });
});

test('detectSubstrate: ALL probes throwing degrades all the way to rung 4, never crashes', async () => {
  await assert.doesNotReject(async () => {
    const result = await detectSubstrate({
      env: {},
      probes: {
        branchProtection: async () => { throw new Error('boom'); },
        releaseGate: async () => { throw new Error('boom'); },
        postMergeCi: async () => { throw new Error('boom'); },
        brainWritesReviewed: async () => { throw new Error('boom'); },
      },
    });
    assert.equal(result.rung, 4);
    assert.equal(result.enforced, false);
  });
});

// ── Highest-armed-rung selection across full combinations ──────────────────────

test('detectSubstrate: all rungs armed selects rung 1 (highest wins)', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      branchProtection: async () => ({ status: 200, contexts: OUR_CONTEXTS }),
      releaseGate: async () => true,
      postMergeCi: async () => true,
    },
  });
  assert.equal(result.rung, 1);
  assert.equal(result.enforced, true);
});

// PR2b nit (b) — rungs arm INDEPENDENTLY of which one is ultimately "selected".
// Locks in that rungs[2] and rungs[3] both report active:true in an "all rungs
// armed" fixture even though the top-level `rung` is 1 (highest wins for
// selection, but every rung's own evidence is still reported honestly).
test('detectSubstrate: all rungs armed — rungs[2] and rungs[3] are both independently active alongside selected rung 1', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      branchProtection: async () => ({ status: 200, contexts: OUR_CONTEXTS }),
      releaseGate: async () => true,
      postMergeCi: async () => true,
    },
  });
  assert.equal(result.rung, 1);
  assert.equal(result.rungs[2].active, true, 'rung 2 evidence arms independently of the selected rung');
  assert.equal(result.rungs[3].active, true, 'rung 3 evidence arms independently of the selected rung');
});

test('detectSubstrate: only rung 3 armed selects rung 3', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      branchProtection: async () => ({ status: 404, contexts: [] }),
      releaseGate: async () => false,
      postMergeCi: async () => true,
    },
  });
  assert.equal(result.rung, 3);
  assert.equal(result.enforced, true);
});

test('detectSubstrate: none armed selects rung 4 (detection-only)', async () => {
  const result = await detectSubstrate({
    env: {},
    probes: {
      branchProtection: async () => ({ status: 403, contexts: [] }),
      releaseGate: async () => false,
      postMergeCi: async () => false,
    },
  });
  assert.equal(result.rung, 4);
  assert.equal(result.enforced, false);
});

test('neutrality source-scan (REQ-NEUTRALITY-2): substrate.mjs source contains no .claude or SKILL.md literal', () => {
  const srcPath = fileURLToPath(new URL('./substrate.mjs', import.meta.url));
  const src = readFileSync(srcPath, 'utf8');
  assert.equal(src.includes('.claude'), false, 'source must not reference .claude');
  assert.equal(src.includes('SKILL.md'), false, 'source must not reference SKILL.md');
});
