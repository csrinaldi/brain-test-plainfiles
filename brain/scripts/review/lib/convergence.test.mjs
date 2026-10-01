// convergence.test.mjs — #682 slice 3, C.1, REQ-682-5.
//
// THE REQUIREMENT IS INDEPENDENCE, AND A TEST CAN GET THAT WRONG IN ONE
// PARTICULAR WAY. Both bounds happen to be small integers, and §7's is 3; a test
// asserting "maxRounds is 3 and rev-bound is 3" would pass under an
// implementation that read ONE constant twice — the exact conflation REQ-682-5
// exists to forbid. It would also pass under an implementation where
// `maxRounds` defaulted to §7's number for no reason.
//
// So the oracle is two knobs, moved one at a time:
//
//   move `maxRounds`     → the produce loop changes, §7's escalation does not.
//   move `priorRevCount` → §7's escalation changes, the produce loop does not.
//
// Neither assertion mentions a shared number, and no implementation reading one
// bound twice can satisfy both.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveConvergence, ROUNDS_IN_FORCE_TODAY } from './convergence.mjs';
import { gatherInferentialInputs } from '../evaluators/inferential.mjs';
import { buildVerdict } from '../verdict.mjs';

/** A generator that produces a distinct finding every round, so rounds are countable. */
function countingGenerator(calls) {
  return async ({ round }) => {
    calls.push(round);
    return [{ id: `f-${round}`, severity: 'correction', evidence_class: 'inferential', evidence: `round ${round}` }];
  };
}

const HEAD = 'a'.repeat(40);

/** §7's bound, observed through the only thing that reports it: the verdict. */
function escalatesOnRevBound(priorRevCount) {
  const v = buildVerdict({
    headSha: HEAD,
    conclusion: 'REVISE',
    conclusionCauses: ['blocker'],
    protocol: 'brain-review/2',
    priorRevCount,
    findings: [{ id: 'b1', severity: 'blocker', evidence_class: 'deterministic', evidence: 'x', cites: 'REQ-1' }],
  });
  return v.escalate === 'human';
}

// ── the independence proof ──────────────────────────────────────────────────

test('moving maxRounds changes the produce loop and leaves §7 alone', async () => {
  // Deliberately NOT 3. If the loop were reading §7's constant, this asks for a
  // number that constant cannot supply.
  const calls = [];
  const { maxRounds } = resolveConvergence({ reviewer: { convergence: { maxRounds: 5 } } });
  const result = await gatherInferentialInputs({ maxRounds, deps: { generate: countingGenerator(calls) } });

  assert.deepEqual(calls, [1, 2, 3, 4, 5], 'the produce loop ran the number of rounds it was given');
  assert.equal(result.rounds, 5);
  assert.equal(result.generated.length, 5);

  // And §7's bound did not move with it: still off below 3, on at 3.
  assert.equal(escalatesOnRevBound(2), false, '§7 is unaffected by maxRounds');
  assert.equal(escalatesOnRevBound(3), true, '§7 is unaffected by maxRounds');
});

test('moving priorRevCount changes §7 and leaves the produce loop alone', async () => {
  assert.equal(escalatesOnRevBound(2), false);
  assert.equal(escalatesOnRevBound(3), true, '§7 fires on the third posted revision');

  // The run's round count is untouched by how many times this PR was reviewed
  // before. A reviewer on its fourth revision still gets a full run.
  const calls = [];
  const { maxRounds } = resolveConvergence({ reviewer: { convergence: { maxRounds: 4 } } });
  await gatherInferentialInputs({ maxRounds, deps: { generate: countingGenerator(calls) } });

  assert.equal(calls.length, 4, 'the produce loop is not shortened by the PR\'s revision history');
});

test('the two bounds are configured through different keys entirely', () => {
  // `maxRounds` is read from config; §7's is read from the PR's own history and
  // has no key at all. A config that sets one cannot reach the other.
  assert.deepEqual(resolveConvergence({ reviewer: { convergence: { maxRounds: 9 } } }), { maxRounds: 9 });
  assert.deepEqual(
    resolveConvergence({ reviewer: { inferential: { enabled: true } } }),
    { maxRounds: ROUNDS_IN_FORCE_TODAY },
    'a reviewer config that says nothing about convergence gets the default, not a neighbour\'s value'
  );
});

// ── the default is a measurement, not a preference ──────────────────────────

test('an absent key runs exactly what ran before the key existed', async () => {
  const calls = [];
  const { maxRounds } = resolveConvergence({});

  assert.equal(maxRounds, ROUNDS_IN_FORCE_TODAY);
  await gatherInferentialInputs({ maxRounds, deps: { generate: countingGenerator(calls) } });

  // ONE call. REQ-682-5's second clause is "the bound in force today applies,
  // UNCHANGED" — measured against `gatherInferentialInputs`, which called
  // `generate` once, not against a round number that seemed reasonable.
  assert.deepEqual(calls, [1], 'an unset key must not change a single existing run');
});

test('the default is what the loop uses when no maxRounds is passed at all', async () => {
  const calls = [];
  await gatherInferentialInputs({ deps: { generate: countingGenerator(calls) } });
  assert.deepEqual(calls, [1], 'the parameter default is the imported constant, not a second literal');
});

// ── the bound bounds, and convergence stops early ───────────────────────────

test('a generator that repeats itself converges before the bound', async () => {
  let calls = 0;
  const result = await gatherInferentialInputs({
    maxRounds: 6,
    deps: { generate: async () => { calls += 1; return [{ id: 'same', severity: 'editorial', evidence: 'x' }]; } },
  });

  // Round 2 is entirely duplicates, so the loop stops rather than spending four
  // more model calls to be told the same thing. This is also what today's file
  // transport does by construction — `makeArtifactGenerate` reads one static
  // file every round.
  assert.equal(calls, 2, 'stops on the first round that produces nothing new');
  assert.equal(result.generated.length, 1, 'and the repeat is not a second sighting');
  assert.equal(result.rounds, 2);
});

test('findings with no id dedup by their content, not by all being undefined', async () => {
  // THE FALLBACK BRANCH, which had no test: every other fixture here carries an
  // `id`, so replacing `JSON.stringify(f)` with a random key left the suite
  // green. The hazard it guards is asymmetric and silent — with `undefined` as
  // the key for every id-less finding, the FIRST one is kept and every later
  // one is discarded as a duplicate, so a generator that omits ids loses real,
  // distinct findings and the verdict reports fewer than were found.
  const distinct = await gatherInferentialInputs({
    maxRounds: 3,
    deps: {
      generate: async ({ round }) => [
        { severity: 'editorial', evidence: `finding from round ${round}` },
      ],
    },
  });
  assert.equal(distinct.generated.length, 3, 'distinct id-less findings must all survive');

  const repeated = await gatherInferentialInputs({
    maxRounds: 3,
    deps: { generate: async () => [{ severity: 'editorial', evidence: 'the same thing again' }] },
  });
  assert.equal(repeated.generated.length, 1, 'and an identical id-less finding is still one sighting');
  assert.equal(repeated.rounds, 2, 'which is convergence, so the loop stops');
});

test('finding nothing converges immediately, and stays the distinct empty state', async () => {
  let calls = 0;
  const result = await gatherInferentialInputs({
    maxRounds: 4, deps: { generate: async () => { calls += 1; return []; } },
  });

  assert.equal(calls, 1, 'an empty first round has converged');
  assert.deepEqual(result.generated, [], '"ran and found nothing" — an array, not null');
  assert.equal(result.failed, false, 'and not a failure');
});

test('a failure in a LATER round discards the earlier rounds rather than reporting a partial', async () => {
  const result = await gatherInferentialInputs({
    maxRounds: 3,
    deps: {
      generate: async ({ round }) => {
        if (round === 1) return [{ id: 'f-1', severity: 'blocker', evidence: 'real', cites: 'REQ-1' }];
        throw new Error('the model became unreachable');
      },
    },
  });

  // Keeping round 1's finding would hand the verdict a PARTIAL list it renders
  // as complete: "the model died after round 1" presented as "this is what the
  // reviewer found". Same fold as the array coercion this evaluator's header
  // rails against, one loop iteration further in.
  assert.equal(result.failed, true);
  assert.equal(result.generated, null, 'no partial list may survive a failed round');
  assert.match(result.reason, /round 2 of 3/, 'and the reason says which round died');
});

test('a non-array from a later round is a failure too, and names its round', async () => {
  const result = await gatherInferentialInputs({
    maxRounds: 3,
    deps: { generate: async ({ round }) => (round === 1 ? [{ id: 'a' }] : undefined) },
  });

  assert.equal(result.failed, true);
  assert.equal(result.generated, null);
  assert.match(result.reason, /undefined on round 2 of 3/);
});

// ── the key fails closed ────────────────────────────────────────────────────

test('an unreadable maxRounds is refused, not defaulted', () => {
  for (const bad of ['3', 2.5, true, [], {}, NaN, Infinity]) {
    assert.throws(
      () => resolveConvergence({ reviewer: { convergence: { maxRounds: bad } } }),
      /must be a whole number of rounds/,
      `refuses ${JSON.stringify(bad)}`
    );
  }
});

test('zero is refused, and the refusal points at the key that means what it means', () => {
  for (const bad of [0, -1, -7]) {
    assert.throws(
      () => resolveConvergence({ reviewer: { convergence: { maxRounds: bad } } }),
      /at least 1/,
      `refuses ${bad}`
    );
  }
  assert.throws(
    () => resolveConvergence({ reviewer: { convergence: { maxRounds: 0 } } }),
    /inferential\.enabled = false/,
    'and names the key that says "do not run" where the verdict can report it'
  );
});

test('an explicit null is unset, not unreadable', () => {
  // `null` cannot mean "no bound" — an unbounded run is not a thing this key can
  // express — so it can only mean the operator cleared it.
  assert.deepEqual(
    resolveConvergence({ reviewer: { convergence: { maxRounds: null } } }),
    { maxRounds: ROUNDS_IN_FORCE_TODAY }
  );
});
