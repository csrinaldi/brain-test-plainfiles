// run-stage.test.mjs — #682 slice B, REQ-S3-2. The harness grows ONE op.
//
// The doctrinal question this file answers is not "does the op work" but "does
// growing the port fork the SDD artifact lifecycle". ADR-0019 rejected the fork
// and permitted the growth, in two different rejected alternatives, and the
// difference between them is which stages may be routed.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { VALID_OPS, CLI_OPS, dispatch } from './cli.mjs';
import { runStage, STAGE_TIMEOUT_MS } from '../axes/platform/adapters/claude.mjs';
import { SDD_LIFECYCLE_STAGES, COLD_REVIEW_STAGE } from '../lib/stage-engine.mjs';

const okRun = () => ({ status: 0, stdout: '', stderr: '' });

// ── ADR-0019's boundary, at the port ─────────────────────────────────────────

test('#682 B.3: the op is ADDITIVE — `init` keeps its place and its dispatch', async () => {
  assert.ok(VALID_OPS.includes('init'), 'the shipping op may not be displaced by the new one');
  assert.ok(VALID_OPS.includes('run-stage'));

  let called = null;
  await dispatch('fake', 'init', ['a'], {
    backendLoader: async () => ({ init: async (...args) => { called = args; } }),
  });
  assert.deepEqual(called, ['a'], '`init` still routes to the backend unchanged');
});

test('#682 B.3: `run-stage` routes to the backend, kebab→camel like every other op', async () => {
  let seen = null;
  await dispatch('fake', 'run-stage', [{ stage: COLD_REVIEW_STAGE }], {
    backendLoader: async () => ({ runStage: async (a) => { seen = a; } }),
  });
  assert.deepEqual(seen, { stage: COLD_REVIEW_STAGE });
});

test('#682 B.3 → #323 S2: a lifecycle stage without routed EVIDENCE cannot spawn — the conditions check is the only door', async () => {
  // The assertion that lets ADR-0033 land without resolving Compuerta 1. It is
  // code, not a comment: an argument about which stages are routed is only as
  // good as the thing that keeps it true.
  for (const stage of SDD_LIFECYCLE_STAGES) {
    await assert.rejects(
      () => runStage({ stage, prompt: 'p', _run: okRun }),
      /without routed evidence/,
      `"${stage}" is one of the four — spawning it demands assertRoutedStage's result (Amendment 1, condition 4)`,
    );
  }
  // And the complement, so this cannot pass on a list that forbids everything:
  // `ok` rather than the whole object: F.9 added `elapsedMs`, whose value is a
  // clock reading and not what this test is about.
  assert.equal((await runStage({ stage: COLD_REVIEW_STAGE, prompt: 'p', _run: okRun })).ok, true,
    'a stage OUTSIDE the four must route — otherwise the guard is just "nothing works"');
});

// ── the engine's outcomes, and the fold they must not make ───────────────────

test('#682 B.3: a non-zero exit is a FAILURE — never an empty result', async () => {
  const cases = [
    ['a non-zero status', () => ({ status: 2, stderr: 'boom\nmore' }), /exited with status 2 — boom/],
    ['a timeout (status null + error)', () => ({ status: null, error: new Error('ETIMEDOUT') }), /failed to run: ETIMEDOUT/],
    ['a spawn that throws', () => { throw new Error('ENOENT'); }, /could not be spawned: ENOENT/],
  ];
  for (const [label, run, re] of cases) {
    const r = await runStage({ stage: COLD_REVIEW_STAGE, prompt: 'p', _run: run });
    assert.equal(r.ok, false, `${label} must fail`);
    assert.match(r.reason, re, `${label} must name what happened`);
  }
});

test('#682 B.3: a hung engine is not a success — `status: null` is read, not ignored', async () => {
  // spawnSync reports a timeout through `error`, not `status`. A guard reading
  // only `status !== 0` lets `null` through as falsy-equal-to-nothing and the
  // run reads as clean. That is the fold, one layer below the verdict.
  const r = await runStage({ stage: COLD_REVIEW_STAGE, prompt: 'p', _run: () => ({ status: null }) });
  assert.equal(r.ok, false);
  assert.match(r.reason, /without a status \(timed out\?\)/);
});

test('#682 B.3: an empty prompt is refused — an engine with nothing to do is not a run', async () => {
  for (const prompt of [undefined, null, '', '   ']) {
    const r = await runStage({ stage: COLD_REVIEW_STAGE, prompt, _run: okRun });
    assert.equal(r.ok, false);
    assert.match(r.reason, /no prompt/);
  }
});

// ── the model, and what brain refuses to know about it ───────────────────────

test('#682 B.3: the model rides as given, and an absent one adds no flag at all', async () => {
  let args = null;
  const spy = (_cmd, a) => { args = a; return okRun(); };

  // #1010 — every run also carries --settings {disableAllHooks: true}
  // (claude.test.mjs pins that flag on its own); this test's job is only the
  // MODEL flag, so it is asserted independently of the fixed --settings tail
  // rather than re-pinning the whole array here.
  await runStage({ stage: COLD_REVIEW_STAGE, prompt: 'revisá esto', model: 'vendor/whatever:2026', _run: spy });
  assert.deepEqual(args.slice(0, 4), ['-p', 'revisá esto', '--model', 'vendor/whatever:2026'],
    'the id passes through untouched — brain never validates it against a catalogue (#323)');

  await runStage({ stage: COLD_REVIEW_STAGE, prompt: 'revisá esto', _run: spy });
  assert.deepEqual(args.slice(0, 2), ['-p', 'revisá esto'],
    'no model means no flag — brain does not invent a default the operator did not choose');
  assert.equal(args.includes('--model'), false, 'no model means no --model flag anywhere in argv');
});

test('#682 B.3: the engine gets a wall clock, and it is passed to the runner', async () => {
  let opts = null;
  await runStage({ stage: COLD_REVIEW_STAGE, prompt: 'p', _run: (_c, _a, o) => { opts = o; return okRun(); } });
  assert.equal(opts.timeoutMs, STAGE_TIMEOUT_MS, 'an unbounded spawn hangs the whole verb');
  assert.ok(STAGE_TIMEOUT_MS > 0);
});

// ── the SITE axis, from #682's second cold review ────────────────────────────
//
// judgment:cold-4 was fixed at `defaultRun`, which had dropped the `cwd` it was
// handed, and pinned there with a test that spawns a real child. That hardened
// the LAST layer and left the layer that SUPPLIES the value unpinned: deleting
// `cwd` from this file's own `_run(...)` call left the whole suite green, which
// restores exactly the production behaviour the finding describes — the engine
// running in the parent's directory while the verdict binds itself to a head.
//
// Same defect, one layer up, and it is the site the finding's own call chain
// named. This repo's `red-proof-blind-along-an-unvaried-axis.md` calls it the
// SITE axis: a fix proved at one site is not proved at the others.
//
// The assertion here is deliberately about DELIVERY, not honouring — this test
// hands in a spy, and a spy can only report what it was given. Honouring is
// `agent-runtime.test.mjs`'s job, with a real child. Two layers, two oracles.

test('#682 cold-4 (SITE): runStage DELIVERS cwd to the runner, not only timeoutMs', async () => {
  let opts = null;
  await runStage({
    stage: COLD_REVIEW_STAGE, prompt: 'p', cwd: '/somewhere/specific',
    _run: (_c, _a, o) => { opts = o; return okRun(); },
  });
  assert.equal(
    opts.cwd, '/somewhere/specific',
    'the runner never received the cwd — the engine would review the parent process directory ' +
    'instead of the tree the caller named, and the artifact check would then report ' +
    '"the engine exited cleanly but wrote no artifact": a true refusal with a false diagnosis'
  );
});

// ── The producer's environment — #682's second cold review, judgment:cold-2 ──
//
// `runStage`'s docstring said, in capitals, "IT HOLDS NO VCS CREDENTIAL AND
// POSTS NOTHING", and ADR-0033 rests on it: an arbitrary engine is safe to run
// as a producer precisely because it cannot reach the pull request. Nothing
// enforced it — the spawn passed no `env`, so the child inherited
// `process.env` whole and the only lock was a sentence of prompt text.
//
// These assert the enforcement at the layer that spawns, and they assert the
// DEFAULT: a caller that passes no `credentialEnv` at all must still get a
// producer that cannot authenticate as brain's poster, because otherwise the
// property holds only for callers who remembered.
//
// THE FIXTURE VALUES ARE NAMED, NOT SPELT INLINE. `check-refs.mjs`'s
// `hardcoded-secret` rule matches `token: "…"` on sight, and
// `check-refs-rules.mjs` carries no exemptions ON PURPOSE — #616 removed two
// dead ones after finding that an exemption which matches nothing still blinds
// the rule for that path. So a fixture that spells its value inline after a
// credential-shaped key either puts CI red or buys a suppression that costs
// more than the line saves. These constants are the honest form: the file
// contains no credential-shaped literal at all, which is what the rule is
// actually asking for — and the rule is line-based, so a COMMENT quoting the
// offending form trips it too. This paragraph learned that the same way.

/** A marker the assertions look for. Not a credential, and not shaped like one. */
const MARKER = 'fixture-marker';
/** The engine's own — distinct, because this one is asserted PRESENT. */
const ENGINE_OWN = 'engine-own-marker';

test('#682 cold-2: the producer does NOT inherit brain\'s posting credentials', async () => {
  let opts = null;
  const parent = {
    PATH: '/usr/bin',
    HOME: '/home/op',
    BRAIN_REVIEWER_TOKEN: MARKER,
    VCS_TOKEN: MARKER,
    GH_TOKEN: MARKER,
    ANTHROPIC_API_KEY: ENGINE_OWN,
  };

  const r = await runStage({
    stage: COLD_REVIEW_STAGE,
    prompt: 'review',
    _env: parent,
    _run: (_cmd, _args, o) => { opts = o; return okRun(); },
  });
  assert.equal(r.ok, true);

  assert.equal(opts.env.BRAIN_REVIEWER_TOKEN, undefined, 'the reviewer credential reached the producer');
  assert.equal(opts.env.VCS_TOKEN, undefined, 'the VCS credential reached the producer');
  assert.equal(opts.env.GH_TOKEN, undefined, '`gh` gives GH_TOKEN precedence over its own keyring — the producer could post');

  // The engine's OWN credential rides, and must: it authenticates before it
  // reads a diff. "Holds no credential" is precisely "cannot authenticate as
  // brain's poster", and an allowlist that guessed this name wrong would ship a
  // refusal brain could not explain.
  assert.equal(opts.env.ANTHROPIC_API_KEY, ENGINE_OWN);
  assert.equal(opts.env.PATH, '/usr/bin');
  assert.equal(opts.env.HOME, '/home/op');
});

test('#682 cold-2: the scrub is the DEFAULT — a caller that passes nothing still gets it', async () => {
  let opts = null;
  await runStage({
    stage: COLD_REVIEW_STAGE,
    prompt: 'review',
    _env: { PATH: '/usr/bin', BRAIN_REVIEWER_TOKEN: MARKER },
    _run: (_cmd, _args, o) => { opts = o; return okRun(); },
  });
  assert.equal(
    opts.env.BRAIN_REVIEWER_TOKEN, undefined,
    'a stage added tomorrow whose caller forgets `credentialEnv` must not hand the engine the token'
  );
});

test('#682 cold-2: `credentialEnv` WIDENS the set — a repo that renamed reviewer.tokenEnv is covered', async () => {
  let opts = null;
  await runStage({
    stage: COLD_REVIEW_STAGE,
    prompt: 'review',
    credentialEnv: ['REPO_SPECIFIC_REVIEWER_TOKEN'],
    _env: {
      PATH: '/usr/bin',
      REPO_SPECIFIC_REVIEWER_TOKEN: MARKER,
      BRAIN_REVIEWER_TOKEN: MARKER,
    },
    _run: (_cmd, _args, o) => { opts = o; return okRun(); },
  });
  assert.equal(opts.env.REPO_SPECIFIC_REVIEWER_TOKEN, undefined, 'the configured name was not stripped');
  assert.equal(
    opts.env.BRAIN_REVIEWER_TOKEN, undefined,
    'the caller must be able to WIDEN only — passing a list must never narrow the default set'
  );
  assert.equal(opts.env.PATH, '/usr/bin');
});

// ── The two surfaces — judgment:cold-5 ──────────────────────────────────────
//
// `run-stage` was published on the command line by accident: one list served
// both `dispatch()` and the argv entry point. MEASURED on the shipped tree,
// `node harness/cli.mjs run-stage cold-review "review the diff"` exited 0 with
// no output — the backend got two positional strings where the contract is one
// object, destructuring a STRING gave `undefined` for every field, and the
// entry point threw the `{ok:false}` away. You ask it to run a stage, it does
// not run one, and it reports success in silence.

test('#682 cold-5: `run-stage` is dispatchable but NOT a command-line op', async () => {
  assert.ok(VALID_OPS.includes('run-stage'), 'the seam dispatches it — it must stay valid');
  assert.ok(!CLI_OPS.includes('run-stage'), 'argv cannot carry a generated prompt; publishing it there ships a path that cannot work');
  assert.deepEqual(CLI_OPS, ['init'], 'the command-line surface is `init` and nothing else');
});

test('#682 cold-5: every op is CLASSIFIED — a new op cannot default onto the CLI', async () => {
  // The point of deriving both lists from one table: adding an op means
  // answering `cli:` for it. This asserts the derivation rather than comparing
  // two hand-written lists, which is the shape that lets them drift.
  for (const op of CLI_OPS) {
    assert.ok(VALID_OPS.includes(op), `${op} is on the CLI but not dispatchable`);
  }
  assert.ok(CLI_OPS.length < VALID_OPS.length, 'the CLI surface must stay a strict subset');
});

test('#682 cold-5: the argv entry point REFUSES run-stage, loudly and by name', async () => {
  // Through a real child process: the `isMain` block is top-level code with no
  // injectable seam, so every in-process test says nothing about it — which is
  // precisely why the defect shipped.
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const cli = fileURLToPath(new URL('./cli.mjs', import.meta.url));

  const r = spawnSync(process.execPath, [cli, 'run-stage', COLD_REVIEW_STAGE, 'review the diff'],
    { encoding: 'utf8', timeout: 30_000 });

  assert.equal(r.status, 1, 'a refused op must exit non-zero — it exited 0 in silence before');
  assert.match(r.stderr, /not a command-line op/);
  assert.match(r.stderr, /stage-seam/, 'the refusal must say where the op IS dispatched from');
  assert.doesNotMatch(r.stderr, /unknown op/, 'an op that plainly exists must not be reported as a typo');
});

test('#682 cold-5: `init` is still a command-line op and still reaches BOTH axes', async () => {
  // The removal must not narrow what shipped. Two axes is deliberate for
  // `init` (ADR-0024): a repo declaring a platform and an engine separately
  // gets both harnesses configured from one command.
  assert.ok(CLI_OPS.includes('init'));

  const seen = [];
  await dispatch('fake-a', 'init', ['x'], { backendLoader: async () => ({ init: async () => { seen.push('a'); } }) });
  assert.deepEqual(seen, ['a'], '`init` still routes to the backend unchanged');
});


// ── F.9 — the timeout is measured, and its evidence is not discarded ───────

test('F.9: a timeout REPORTS the ceiling it hit, not just that it failed', async () => {
  const r = await runStage({
    stage: COLD_REVIEW_STAGE, prompt: 'x', timeoutMs: 600_000,
    _run: () => ({ error: Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' }) }),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason, /did not finish within 10m/, 'the operator must know WHAT limit was hit');
  assert.match(r.reason, /stageTimeoutMs/, 'and which key raises it');
});

test('F.9: whatever the engine said before it was killed RIDES ALONG', async () => {
  // This branch returned r.error.message alone, so on the one failure where
  // knowing what the engine was doing matters most, everything it had printed
  // was thrown away. spawnSync captures both streams up to the kill.
  const r = await runStage({
    stage: COLD_REVIEW_STAGE, prompt: 'x', timeoutMs: 600_000,
    _run: () => ({
      error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }),
      stderr: 'reading brain/scripts/review/cli.mjs\nstill working',
    }),
  });
  assert.match(r.reason, /the engine last said/);
  assert.match(r.reason, /still working/);
});

test('F.9: stdout is used when stderr is empty — the wrong stream is still evidence', async () => {
  const r = await runStage({
    stage: COLD_REVIEW_STAGE, prompt: 'x',
    _run: () => ({ error: Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }), stdout: 'halfway through' }),
  });
  assert.match(r.reason, /halfway through/);
});

test('F.9: a NON-timeout error keeps its own message and does not claim a timeout', async () => {
  const r = await runStage({
    stage: COLD_REVIEW_STAGE, prompt: 'x',
    _run: () => ({ error: Object.assign(new Error('nope'), { code: 'ENOENT' }) }),
  });
  assert.match(r.reason, /failed to run/);
  assert.doesNotMatch(r.reason, /did not finish within/, 'ENOENT is not a slow engine');
  assert.doesNotMatch(r.reason, /stageTimeoutMs/, 'raising the ceiling would not install a binary');
});

test('F.9: elapsed time is reported on SUCCESS too, not only on failure', async () => {
  // The reason nobody could say whether ten minutes was close or absurd is that
  // no successful run had ever reported its cost either.
  const ticks = [1_000, 5_793];              // start, then finish
  const r = await runStage({
    stage: COLD_REVIEW_STAGE, prompt: 'x',
    _now: () => ticks.shift() ?? 5_793,
    _run: () => ({ status: 0 }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.elapsedMs, 4_793);
});

test('F.9: the configured ceiling reaches spawnSync', async () => {
  let seen = null;
  await runStage({
    stage: COLD_REVIEW_STAGE, prompt: 'x', timeoutMs: 2_400_000,
    _run: (_c, _a, opts) => { seen = opts.timeoutMs; return { status: 0 }; },
  });
  assert.equal(seen, 2_400_000, 'a ceiling the caller resolved and the spawn ignored is not a ceiling');
});
