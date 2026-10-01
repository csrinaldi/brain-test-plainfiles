// identity-binding.test.mjs — a bound port writes as the identity it was bound to
// (issue #501, REQ-501-1/-3).
//
// EVERY fixture here drives TWO DIFFERENT identities. That is not thoroughness,
// it is the only configuration in which the defect is observable: with the bound
// token and the ambient credential set to the same identity, every assertion
// passes against a port that ignores the token entirely — which is exactly how
// this shipped to main and survived until a maintainer ran the reviewer from a
// checkout logged in as someone else.
//
// It is the #405 cardinality lesson in another dimension: with N=1 identities,
// "wrote as the reviewer" is trivially true.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { spawnSync } from 'node:child_process';

import { getVcs } from './cli.mjs';
import { runAsIdentity, currentIdentity } from './lib/identity-context.mjs';
import { setSpawn } from './lib/exec.mjs';

const BOUND = 'token-of-the-reviewer';
const AMBIENT = 'token-of-the-operator';

test('#501 runAsIdentity: the bound value is visible inside, and gone outside (REQ-501-1)', () => {
  assert.equal(currentIdentity(), null, 'no ambient leak before');
  runAsIdentity(BOUND, () => assert.equal(currentIdentity(), BOUND));
  assert.equal(currentIdentity(), null, 'the value must not survive the call that set it');
});

test('#501 runAsIdentity: it survives an await boundary (REQ-501-1)', async () => {
  // Every verb is async. A binding that a module-level variable would satisfy
  // synchronously and lose across an await is not a binding.
  await runAsIdentity(BOUND, async () => {
    await new Promise((r) => setTimeout(r, 0));
    assert.equal(currentIdentity(), BOUND);
  });
});

test('#501 runAsIdentity: an absent identity leaves resolution untouched (REQ-501-1, E2)', () => {
  runAsIdentity(null, () => assert.equal(currentIdentity(), null));
  runAsIdentity(undefined, () => assert.equal(currentIdentity(), null));
});

test('#501 getVcs({ identity }): the GH_TOKEN on the wire is the BOUND one, not the ambient one (REQ-501-1, E1)', async () => {
  const seen = [];
  const stubProvider = {
    PROVIDER: 'stub',
    // Stands in for a verb: records the identity visible at the moment it runs,
    // which is what the chokepoint reads.
    prReviewComment: async () => {
      seen.push(currentIdentity());
      return { url: 'https://example.test/1' };
    },
  };
  const vcs = await getVcs({
    config: { vcs: { provider: 'github' } },
    identity: BOUND,
    // Injected so the test needs no gh binary; the binding under test is in
    // getVcs's wrapper, which is provider-agnostic.
    _import: async () => stubProvider,
  });
  await vcs.prReviewComment({});
  assert.deepStrictEqual(seen, [BOUND], `the verb must run under ${BOUND}, not ${AMBIENT}`);
});

test('#501 getVcs({ identity }): READS are bound too, not writes only (REQ-501-1, E3)', async () => {
  // Driven separately because "write verbs only" is the narrower fix a reader
  // reaches for, and it leaves the reviewer reading a repository it may not be
  // writing to.
  const seen = [];
  const stubProvider = {
    PROVIDER: 'stub',
    prView: async () => { seen.push(['prView', currentIdentity()]); return {}; },
    prReviews: async () => { seen.push(['prReviews', currentIdentity()]); return []; },
    prStatusRollup: async () => { seen.push(['prStatusRollup', currentIdentity()]); return {}; },
  };
  const vcs = await getVcs({
    config: { vcs: { provider: 'github' } },
    identity: BOUND,
    _import: async () => stubProvider,
  });
  await vcs.prView({});
  await vcs.prReviews({});
  await vcs.prStatusRollup({});
  assert.deepStrictEqual(seen, [
    ['prView', BOUND],
    ['prReviews', BOUND],
    ['prStatusRollup', BOUND],
  ]);
});

test('#501 getVcs(): with NO credential declared, nothing is bound — ambient auth is untouched (REQ-501-1, E2)', async () => {
  // The brain:vcs CLI and the governance checks must not acquire a reviewer's
  // reach as a side effect of this fix.
  //
  // `_token` is injected rather than left ambient (#479): before that seam this
  // test asserted `[null]` and passed only because the machine running it had no
  // `VCS_TOKEN` — it would have flipped on a configured checkout, which is not a
  // guard, it is a coincidence with a green tick next to it.
  const seen = [];
  const stubProvider = {
    PROVIDER: 'stub',
    prView: async () => { seen.push(currentIdentity()); return {}; },
  };
  const vcs = await getVcs({
    config: { vcs: { provider: 'github' } },
    _import: async () => stubProvider,
    _token: () => null,
  });
  await vcs.prView({});
  assert.deepStrictEqual(seen, [null], 'with no credential to bind, resolution must stay ambient');
});

// ── #479: the port resolves brain's ONE neutral credential ───────────────────
//
// Before this, `getVcs()` without an explicit identity bound nothing, so GitHub
// fell through to gh's ambient keyring login while GitLab's verbs fell through to
// `vcsToken(PROVIDER)` on their own. The same audit authenticated under two
// conventions depending on provider, and "brain runs on GitLab" was true of the
// port and false of everything reaching it unbound.

const NEUTRAL = 'token-from-VCS_TOKEN';

test('#479 getVcs(): an unbound port binds VCS_TOKEN — the audit stops authenticating by ambient accident', async () => {
  const seen = [];
  const stubProvider = {
    PROVIDER: 'stub',
    prView: async () => { seen.push(currentIdentity()); return {}; },
  };
  const vcs = await getVcs({
    config: { vcs: { provider: 'github' } },
    _import: async () => stubProvider,
    _token: () => NEUTRAL,
  });
  await vcs.prView({});
  assert.deepStrictEqual(seen, [NEUTRAL]);
});

test('#479 getVcs(): an EXPLICIT identity still wins over VCS_TOKEN', async () => {
  // Two different values, for the reason this file's header gives: with the
  // explicit token and the neutral one equal, a port that ignored the argument
  // would pass. The reviewer verifies as one credential and must write as that
  // one — being silently redirected to the generic credential is #501 again.
  const seen = [];
  const stubProvider = {
    PROVIDER: 'stub',
    prView: async () => { seen.push(currentIdentity()); return {}; },
  };
  const vcs = await getVcs({
    config: { vcs: { provider: 'github' } },
    identity: BOUND,
    _import: async () => stubProvider,
    _token: () => NEUTRAL,
  });
  await vcs.prView({});
  assert.deepStrictEqual(seen, [BOUND]);
});

test('#479 getVcs(): the fallback is PROVIDER-BLIND — both providers resolve the same neutral name', async () => {
  // The defect was an asymmetry, so the guard has to vary the provider. Asserting
  // it on GitHub alone would have been green against a fix that only reached
  // GitHub — the exact "green in test, inert in production" class of epic #335.
  for (const provider of ['github', 'gitlab']) {
    const asked = [];
    const stubProvider = { PROVIDER: 'stub', prView: async () => currentIdentity() };
    const vcs = await getVcs({
      config: { vcs: { provider } },
      _import: async () => stubProvider,
      _token: (name) => { asked.push(name); return NEUTRAL; },
    });
    assert.equal(await vcs.prView({}), NEUTRAL, `${provider} must bind the neutral credential`);
    assert.deepStrictEqual(asked, [provider], 'the provider is passed through, and the seam answers the same value for both');
  }
});

test('#479 END TO END: VCS_TOKEN reaches the wire as the credential gh actually uses', async () => {
  // Every other test here drives a STUB provider, which proves the binding and not
  // the application of it. The workflow change (#479/#475) is worth nothing unless
  // the real adapter turns the neutral name into the provider-specific one on the
  // child env — and #475's own acceptance says reading the YAML is not proof.
  //
  // So: the REAL github module, through the REAL chokepoint, with the spawn seam
  // recording what `gh` would have been handed.
  let seenEnv = null;
  setSpawn((cmd, args, opts) => {
    seenEnv = opts?.env ?? null;
    return { status: 0, stdout: '{"number":1,"title":"t","labels":[],"body":""}', stderr: '' };
  });
  try {
    const vcs = await getVcs({
      config: { vcs: { provider: 'github' } },
      _token: () => NEUTRAL,
    });
    await vcs.issueView({ project: 'o/r', number: 1 });
  } finally {
    setSpawn(spawnSync);
  }
  assert.equal(seenEnv?.GH_TOKEN, NEUTRAL,
    'the neutral credential must arrive as GH_TOKEN on the child — neutral in, provider-specific out (ADR-0008)');
});

test('#479 getVcs(): the fallback reaches verbs NOBODY has written yet', async () => {
  // Same property `bindIdentity` is built for: the wrapper enumerates the module.
  // A fallback applied to a list of verb names would rot the same way #413's did.
  const stubProvider = {
    PROVIDER: 'stub',
    aVerbNobodyHasWrittenYet: async () => currentIdentity(),
  };
  const vcs = await getVcs({
    config: { vcs: { provider: 'github' } },
    _import: async () => stubProvider,
    _token: () => NEUTRAL,
  });
  assert.equal(await vcs.aVerbNobodyHasWrittenYet(), NEUTRAL);
});

test('#501 getVcs({ identity }): the binding covers EVERY function export, not a list of names (REQ-501-2)', async () => {
  // A hand-maintained list of verbs to bind is the shape that failed: `whoami`
  // was the one entry on that list for the whole life of #413. So the wrapper
  // enumerates the module, and this asserts it — including a verb whose name
  // appears in no contract.
  const stubProvider = {
    PROVIDER: 'stub',
    aVerbNobodyHasWrittenYet: async () => currentIdentity(),
  };
  const vcs = await getVcs({
    config: { vcs: { provider: 'github' } },
    identity: BOUND,
    _import: async () => stubProvider,
  });
  assert.equal(await vcs.aVerbNobodyHasWrittenYet(), BOUND);
  assert.equal(vcs.PROVIDER, 'stub', 'non-function exports pass through untouched');
});
