// stage-seam.test.mjs — #682 slice 3, B.6.
//
// The central oracle reads the REAL adapter directories (the old `backends/`,
// split by axis in #1141) and drives the REAL
// seam against every backend in it. It is not a fixture list, on purpose:
//
//   A fixture naming `plain`, `gentle-ai`, `antigravity` would pass forever
//   while a seventh backend arrived without `runStage` and fell through
//   untested. Worse, it would agree with any hardcode a future edit introduced —
//   which is exactly how N6 survived in B.5, where the only routing fixture used
//   the same two strings the hardcode picked. An oracle whose input set is
//   written down beside the thing it tests can only confirm what was already
//   believed.
//
// So the input set is the filesystem, and the assertion is conditional on what
// each backend actually exports: implements `runStage` → its answer must reach
// the caller; does not → the seam must REFUSE and name it. Adding a backend, or
// adding `runStage` to an existing one, moves it between the two branches with
// no edit here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { makeRunStageSeam, RUN_STAGE_OP } from './stage-seam.mjs';
import { dispatch, VALID_OPS } from './cli.mjs';
import { COLD_REVIEW_STAGE } from '../lib/stage-engine.mjs';
import { HARNESS_ADAPTER_AXES, harnessAdapterDir, harnessAdapterUrl } from '../axes/lib/harness-adapter-url.mjs';

/**
 * A forge CLI reporting NO session. Injected into every call, because
 * `runColdReviewStage` refuses without it (judgment:cold-2, fourth cold review):
 * the seam used to default to the real runner, so a test that forgot spawned the
 * machine's own `gh` and its result depended on whether the developer was logged
 * in — measured, ten failures on a machine with a keyring session, green here
 * only because this container has no `gh` at all.
 */
const LOGGED_OUT = () => ({ status: 1, stderr: 'not logged into any hosts' });

const BACKENDS_DIRS = HARNESS_ADAPTER_AXES.map((axis) => fileURLToPath(harnessAdapterDir(axis)));

/** Every real backend name, read from disk rather than listed here. */
function realBackends() {
  return [...new Set(BACKENDS_DIRS.flatMap((dir) => readdirSync(dir)
    .filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'))
    .map((f) => f.replace(/\.mjs$/, ''))))];
}

const CALL = { stage: COLD_REVIEW_STAGE, prompt: 'review the diff', model: 'zz-9', cwd: '/tmp' };

test('the op the seam routes through is one the dispatcher accepts', () => {
  // Cheap, and it is the join that would break silently: a seam naming an op
  // `VALID_OPS` does not carry would refuse EVERY engine, and every refusal
  // would look like a correctly-refused missing backend.
  assert.ok(VALID_OPS.includes(RUN_STAGE_OP), `${RUN_STAGE_OP} must be a valid op`);
});

test('every real backend either answers or is REFUSED — measured against the directory', async () => {
  const seam = makeRunStageSeam();
  const names = realBackends();
  assert.ok(names.length >= 4, `precondition: the backends directory has real entries (got ${names.length})`);

  const implementers = [];
  const refused = [];

  for (const name of names) {
    const mod = await import(harnessAdapterUrl(name));
    const implementsIt = typeof mod.runStage === 'function';

    if (implementsIt) {
      implementers.push(name);
      continue;   // driven below, through a stub — spawning a real engine here is not this test's job
    }

    const result = await seam({ ...CALL, engine: name });
    assert.equal(result.ok, false, `"${name}" implements no runStage and must be refused`);
    assert.match(
      result.reason, new RegExp(`"${name}"`),
      'the refusal must NAME the engine — "the run refused" is not something an operator can act on'
    );
    assert.match(
      result.reason, /Refusing rather than falling back/,
      'and must say it did not substitute another engine'
    );
    refused.push(name);
  }

  // The two sets partition the directory. Asserted so a backend that somehow
  // reached neither branch cannot pass unnoticed.
  assert.deepEqual(
    [...implementers, ...refused].sort(), [...names].sort(),
    'every backend must land in exactly one branch'
  );
  assert.ok(refused.length > 0, 'this test is vacuous unless at least one backend lacks runStage');
});

test('an engine with no backend FILE at all is refused, not fallen back from', async () => {
  let dispatched = [];
  const seam = makeRunStageSeam({
    dispatch: async (engine, op, args) => {
      dispatched.push(engine);
      return dispatch(engine, op, args);   // the real dispatcher, real loader
    },
  });

  const result = await seam({ ...CALL, engine: 'no-such-engine-at-all' });

  assert.equal(result.ok, false);
  assert.match(result.reason, /no-such-engine-at-all/);

  // THE FALLBACK IS THE FAILURE MODE. One dispatch, one engine name, and it is
  // the one the operator wrote. A seam that tried a second name would produce a
  // real, well-formatted review from a model nobody chose, with nothing on the
  // verdict saying so.
  assert.deepEqual(dispatched, ['no-such-engine-at-all'], 'exactly one engine may be tried, and it is the named one');
});

test('a throw dispatch does NOT spell out is still a refusal', async () => {
  // The module claims "every throw is a refusal, not just the two `dispatch`
  // spells out". Measured: narrowing the catch to
  // `/not found|does not implement/` left the whole suite GREEN — the claim had
  // no reader, and the seam would have started RETHROWING the day a third
  // failure mode appeared. A rethrow out of `runColdReviewStage` aborts
  // `brain:review` instead of reporting a transport failure the operator can
  // read, so the hole is not theoretical: a backend whose module throws at
  // import time for its own reasons already produces a message matching neither
  // pattern.
  const seam = makeRunStageSeam({
    dispatch: async () => { throw new Error('EACCES: permission denied, open /opt/engines/plain.mjs'); },
  });

  const result = await seam({ ...CALL, engine: 'plain' });

  assert.equal(result.ok, false, 'an unfamiliar failure must refuse, not escape');
  assert.match(result.reason, /EACCES/, 'and must carry what actually went wrong');
  assert.match(result.reason, /Refusing rather than falling back/);
});

test('a non-Error throw is refused too, without crashing on .message', async () => {
  // The catch reads `err.message`. A backend rejecting with a string or an
  // object has no `.message`, and reading it would put `undefined` in the reason
  // — or throw, turning a refusal into an abort.
  for (const thrown of ['a bare string', { code: 'ENOENT' }, 42, null]) {
    const seam = makeRunStageSeam({ dispatch: async () => { throw thrown; } });
    const result = await seam({ ...CALL, engine: 'plain' });
    assert.equal(result.ok, false, `refuses after throwing ${JSON.stringify(thrown)}`);
    assert.match(result.reason, /Refusing rather than falling back/);
  }
});

test("a backend that DOES implement runStage has its answer returned untouched", async () => {
  const answer = { ok: false, reason: 'the engine exited with status 137' };
  const seam = makeRunStageSeam({
    dispatch: async (engine, op, args) => dispatch(engine, op, args, {
      backendLoader: async () => ({ runStage: async () => answer }),
    }),
  });

  const result = await seam({ ...CALL, engine: 'claude' });

  // Identity, not shape. `dispatch` DISCARDED the backend's return value until
  // this slice — `await backend[fn](...args)` with `@returns {Promise<void>}`
  // beside it — so a failed engine reached the caller as `undefined` and
  // `runColdReviewStage` reported "the engine returned no result" for every
  // outcome alike. Harmless while `init` was the only op; live from the moment
  // B.3 added an op whose whole purpose is its answer. Same shape as #734.
  assert.deepEqual(result, answer, "the backend's own answer must survive the dispatcher");
});

test('the arguments reach the backend as ONE options object, not spread positionals', async () => {
  let seen = null;
  const seam = makeRunStageSeam({
    dispatch: async (engine, op, args) => dispatch(engine, op, args, {
      backendLoader: async () => ({ runStage: async (a) => { seen = a; return { ok: true }; } }),
    }),
  });

  await seam({ ...CALL, engine: 'claude' });

  // `dispatch` spreads its args array. The seam passes a single-element array
  // holding the options object; if it ever passed the fields as separate
  // elements they would arrive as `runStage(stage, prompt, ...)` and every field
  // would read as undefined inside a destructured signature — silently, with the
  // engine spawned on an empty prompt.
  // `credentialEnv` is listed because this assertion is EXACT on purpose: it is
  // what catches a field added to the seam and never threaded to the backend.
  // `CALL` does not set one, so it arrives undefined — the backend defaults it.
  //
  // IT COVERS ONE DIRECTION AND THE REAL DEFECT CAME FROM THE OTHER
  // (judgment:cold-1, third cold review). This catches "the seam knows a field
  // and the backend never sees it". What shipped broken was "the CALLER sends a
  // field and the seam never destructures it" — `timeoutMs` was supplied by
  // `runColdReviewStage` and silently absent from this function's parameter
  // list, so nothing here was even asked about it and the assertion stayed
  // exact and green. The cold-1 tests at the bottom of this file close that
  // direction by asserting every argument the caller supplies survives the hop.
  assert.deepEqual(seen, {
    stage: COLD_REVIEW_STAGE, prompt: 'review the diff', model: 'zz-9', cwd: '/tmp',
    timeoutMs: undefined,
    credentialEnv: undefined,
    // #775 — same reason `credentialEnv` is listed: exactness is what catches a
    // field the seam knows and never threads. `CALL` sets none, so it arrives
    // undefined and the backend's no-shadow branch holds.
    forgeConfigDir: undefined,
    output: undefined,
    // #836: S4's evidence rides the same object — absent here because CALL names neither.
    routed: undefined,
    changeId: undefined,
  });
});

test('an unnamed engine is refused before anything is dispatched', async () => {
  let dispatched = false;
  const seam = makeRunStageSeam({ dispatch: async () => { dispatched = true; return { ok: true }; } });

  for (const engine of [undefined, null, '', '   ', 42]) {
    const result = await seam({ ...CALL, engine });
    assert.equal(result.ok, false, `refuses ${JSON.stringify(engine)}`);
    assert.match(result.reason, /cannot be routed to nothing/);
  }
  assert.equal(dispatched, false, 'nothing may be dispatched for an engine that was never named');
});

test('a backend answering nothing at all is a failure, not a success', async () => {
  const seam = makeRunStageSeam({ dispatch: async () => undefined });

  const result = await seam({ ...CALL, engine: 'claude' });

  assert.equal(result.ok, false, 'undefined must not read as success');
  assert.match(result.reason, /returned no result/);
});

test('the refusal composes with the stage runner — routed, and reported as a failure', async () => {
  const { runColdReviewStage } = await import('../review/lib/run-cold-review-stage.mjs');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const root = mkdtempSync(join(tmpdir(), 'stage-seam-'));
  try {
    const result = await runColdReviewStage({
      config: { sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'no-such-engine-at-all', model: null } } } },
      prNumber: 765,
      root,
      // judgment:cold-3 made the cold checkout a precondition, and it refuses
      // BEFORE the engine is reached. Supplied here so what this test measures
      // is still the SEAM's refusal rather than the runner's.
      worktreePath: root,
      deps: { forgeProbe: LOGGED_OUT, runStage: makeRunStageSeam() },
    });

    // ROUTED stays true through the failure. That is the whole distinction
    // REQ-S3-1 draws: the operator named an engine, so this is not the
    // no-transport state, and the verdict must not tell them they configured
    // nothing when what they configured could not be reached.
    assert.equal(result.routed, true, 'the operator named an engine — that fact must survive');
    assert.equal(result.ok, false);
    assert.match(result.reason, /no-such-engine-at-all/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('#682 cold-2: `credentialEnv` reaches the backend UNINTERPRETED', async () => {
  // The seam is the third of four layers this value crosses, and a value
  // dropped at a hop is exactly how `cwd` was lost (judgment:cold-4). The seam
  // deliberately does not default it: the backend's default is already
  // fail-closed, and a second default here would be the same policy declared
  // twice with nothing comparing them.
  let seen = null;
  const seam = makeRunStageSeam({
    dispatch: async (_engine, _op, args) => { seen = args[0]; return { ok: true }; },
  });

  await seam({
    engine: 'claude',
    stage: COLD_REVIEW_STAGE,
    prompt: 'p',
    credentialEnv: ['REPO_SPECIFIC_REVIEWER_TOKEN'],
  });
  assert.deepEqual(
    seen.credentialEnv, ['REPO_SPECIFIC_REVIEWER_TOKEN'],
    'the names the review layer resolved from config never reached the spawn'
  );

  await seam({ engine: 'claude', stage: COLD_REVIEW_STAGE, prompt: 'p' });
  assert.equal(seen.credentialEnv, undefined, 'the seam must not invent a set the backend already owns');
});


// ── judgment:cold-1 (third cold review) — the seam is a SITE, and it was blind ──
//
// The whole point of these: every caller-side test injects a `runStage` double
// and never drives this function, so `timeoutMs` was pinned at the backend
// (run-stage.test.mjs) and at the review layer (run-cold-review-stage.test.mjs)
// with the hop between them unvaried. Both suites green, and an operator raising
// `reviewer.stageTimeoutMs` still died at ten minutes — while the backend's own
// timeout message told them to raise it. Measured on a real cold review.

test('cold-1: the seam FORWARDS timeoutMs — the payload is what the backend receives', async () => {
  let payload = null;
  const runStage = makeRunStageSeam({
    dispatch: async (_engine, _op, [args]) => { payload = args; return { ok: true }; },
  });
  await runStage({ engine: 'claude', stage: 'cold-review', prompt: 'p', timeoutMs: 2_400_000 });
  assert.equal(payload.timeoutMs, 2_400_000, 'a ceiling dropped at the seam is a ceiling nobody set');
});

test('cold-1: EVERY argument the caller supplies survives the hop', async () => {
  // Named one by one rather than deep-equalled against a literal: the failure
  // this catches is a field silently missing from the destructure, and a test
  // that only checks the fields it remembers is the same blindness one level up.
  let payload = null;
  const runStage = makeRunStageSeam({
    dispatch: async (_e, _o, [args]) => { payload = args; return { ok: true }; },
  });
  const sent = {
    engine: 'claude', stage: 'cold-review', prompt: 'p', model: 'm',
    cwd: '/w', credentialEnv: ['GH_TOKEN'], timeoutMs: 900_000,
  };
  await runStage(sent);
  for (const [k, v] of Object.entries(sent)) {
    if (k === 'engine') continue;             // consumed here: it selects the backend
    assert.deepEqual(payload[k], v, `\`${k}\` was dropped at the seam`);
  }
});

test('cold-1: an ABSENT timeoutMs stays absent — the seam invents no ceiling', async () => {
  // `undefined` leaves the backend's own parameter default in force, which is
  // already fail-closed. A default invented here would be a second declaration
  // of the same policy with nothing comparing the two — the argument this file
  // already makes about `credentialEnv`.
  let payload = null;
  const runStage = makeRunStageSeam({
    dispatch: async (_e, _o, [args]) => { payload = args; return { ok: true }; },
  });
  await runStage({ engine: 'claude', stage: 'cold-review', prompt: 'p' });
  assert.equal(payload.timeoutMs, undefined);
});

// ── #775 — forgeConfigDir rides through uninterpreted ──────────────────────

test('runStage seam: forgeConfigDir reaches the backend unchanged', async () => {
  let seen = null;
  const runStage = makeRunStageSeam({
    dispatch: async (_engine, _op, [args]) => { seen = args; return { ok: true }; },
  });
  await runStage({
    engine: 'claude', stage: 'cold-review', prompt: 'p', cwd: '/tmp',
    forgeConfigDir: '/tmp/run-1',
  });
  assert.equal(seen.forgeConfigDir, '/tmp/run-1');
});

test('runStage seam: it invents no directory when the caller names none', async () => {
  // The seam declares no policy of its own — same ruling `credentialEnv`
  // already carries one line above. A default here would be a second
  // declaration with nothing comparing the two.
  let seen = null;
  const runStage = makeRunStageSeam({
    dispatch: async (_engine, _op, [args]) => { seen = args; return { ok: true }; },
  });
  await runStage({ engine: 'claude', stage: 'cold-review', prompt: 'p', cwd: '/tmp' });
  assert.equal(seen.forgeConfigDir, undefined);
});

test('runStage seam: it preserves an opaque host output descriptor', async () => {
  let seen = null;
  const output = { mode: 'final-message', tempPath: '/tmp/message.tmp', artifactPath: '/tmp/artifact.md' };
  const runStage = makeRunStageSeam({
    dispatch: async (_engine, _op, [args]) => { seen = args; return { ok: true }; },
  });

  await runStage({ engine: 'codex', stage: 'cold-review', prompt: 'p', output });
  assert.equal(seen.output, output, 'the seam must not reinterpret or rebuild host-owned output paths');

  await runStage({ engine: 'claude', stage: 'cold-review', prompt: 'p' });
  assert.equal(seen.output, undefined, 'an omitted descriptor preserves the existing Claude backend contract');
});
