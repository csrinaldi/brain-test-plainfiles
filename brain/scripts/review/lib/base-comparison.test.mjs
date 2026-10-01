// base-comparison.test.mjs — issue #408.
//
// The unit half. The claim that matters — "a finding routed to follow_ups[] by a REAL
// run" — is proven in test/review-regulated/, because #408's exit criterion explicitly
// refuses a unit test that hand-feeds `causal_disposition`. What is pinned here is
// everything the e2e cannot vary cheaply: the uncomputable direction, the laziness
// rule, and the workflow-mirroring command list.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BASE_REPRODUCIBLE_GATES, commandsFor, gateNameOf, needsBaseProbe, probeBase, classifyAgainstBase,
} from './base-comparison.mjs';
import { applyCausalAdmission } from './causal-admission.mjs';

const blocker = (id) => ({ id, severity: 'blocker', evidence: `prStatusRollup: ${id}` });

// ── which findings a base re-run can speak to ───────────────────────────────

test('#408: only a BLOCKING, base-reproducible gate triggers the probe', () => {
  // Both halves matter. Re-running at base is the most expensive thing the reviewer
  // does; it may only happen when the answer changes a verdict.
  assert.equal(needsBaseProbe([blocker('gate:local-checks')]), true);
  assert.equal(needsBaseProbe([{ ...blocker('gate:local-checks'), severity: 'editorial' }]), false,
    'an editorial finding routed to follow_ups blocks exactly as much as before — nothing');
  assert.equal(needsBaseProbe([blocker('gate:issue-link')]), false,
    'issue-link reads THIS PR body — asking whether it fails at base is meaningless, not hard');
  assert.equal(needsBaseProbe([blocker('budget')]), false);
  assert.equal(needsBaseProbe([]), false);
});

test('#408: exactly one gate is base-reproducible, and that is a measurement', () => {
  // Seven of the eight required jobs are diff- or PR-scoped BY CONSTRUCTION. If this
  // list ever grows, the header's measurement is what has to be re-taken first.
  assert.deepEqual([...BASE_REPRODUCIBLE_GATES], ['local-checks']);
  assert.equal(gateNameOf({ id: 'gate:local-checks' }), 'local-checks');
  assert.equal(gateNameOf({ id: 'detection:phase-order' }), null);
  assert.equal(gateNameOf({ id: 'budget' }), null);
  assert.equal(gateNameOf(undefined), null);
});

test('#408: the command list MIRRORS the workflow, including its .brain-source condition', () => {
  // governance.yml runs the unit suite only `if hashFiles('.brain-source') != ''`. A
  // probe that ran the suite in a consumer would answer a question the gate never
  // asked — and would make every consumer pay a suite run to learn nothing.
  const consumer = commandsFor('local-checks', '/wt', () => false);
  const source = commandsFor('local-checks', '/wt', () => true);
  assert.equal(consumer.length, 2, 'a consumer runs repo:check + brain:nav only');
  assert.equal(source.length, 3, 'the brain source repo also runs the suite');
  assert.ok(!JSON.stringify(consumer).includes('--test'));
  assert.ok(JSON.stringify(source).includes('--test'));
  assert.deepEqual(commandsFor('issue-link', '/wt', () => true), [],
    'a gate with no honest reproduction has no commands, never a guessed one');
});

// ── the classifier ──────────────────────────────────────────────────────────

test('#408: a gate that fails at base too becomes pre-existing, and KEEPS its evidence', () => {
  const { findings } = classifyAgainstBase({
    findings: [{ ...blocker('gate:local-checks'), causal_disposition: 'introduced' }],
    baseProbe: { failed: ['local-checks'], command: 'git worktree add … && node …' },
  });
  assert.equal(findings[0].causal_disposition, 'pre-existing');
  assert.match(findings[0].evidence, /prStatusRollup: gate:local-checks/,
    'the original quote must survive — a claim must keep the thing it is a claim about');
  assert.match(findings[0].evidence, /local-checks is ALSO red at base/,
    'ALSO red, not "the same failure" — a base broken for reason A under a head broken for reason B looks identical to this probe');
});

test('#408: a gate that is GREEN at base stays introduced — this change broke it', () => {
  const { findings } = classifyAgainstBase({
    findings: [{ ...blocker('gate:local-checks'), causal_disposition: 'introduced' }],
    baseProbe: { failed: [], command: 'cmd' },
  });
  assert.equal(findings[0].causal_disposition, 'introduced');
  assert.ok(!/base/.test(findings[0].evidence), 'and its evidence is not decorated with a non-finding');
});

test('#408: an UNCOMPUTABLE probe leaves findings blocking, and says so', () => {
  // The safe direction: a failed base check costs a false block, never a false pass.
  const { findings, conditions } = classifyAgainstBase({
    findings: [{ ...blocker('gate:local-checks'), causal_disposition: 'introduced' }],
    baseProbe: null,
    probeAttempted: true,
  });
  assert.equal(findings[0].causal_disposition, 'introduced');
  assert.equal(conditions.length, 1);
  assert.match(conditions[0], /evidence uncomputable: base comparison/);
});

test('#408: uncomputable is NOT `unknown` — that would summon a human on every PR', () => {
  // `unknown` forces STOP + escalate:human per finding. A base probe failing for infra
  // reasons would then escalate every gate finding on every review: the escalation
  // storm #394 exists to prevent.
  const { findings } = classifyAgainstBase({
    findings: [{ ...blocker('gate:local-checks'), causal_disposition: 'introduced' }],
    baseProbe: null, probeAttempted: true,
  });
  assert.notEqual(findings[0].causal_disposition, 'unknown');
});

test('#408: a probe that was never NEEDED reports nothing — silence, not a condition', () => {
  const { conditions } = classifyAgainstBase({
    findings: [blocker('budget')], baseProbe: null, probeAttempted: false,
  });
  assert.deepEqual(conditions, [], 'reporting "could not compare" on a review that never needed to is noise');
});

// ── the probe itself ────────────────────────────────────────────────────────

test('#408: probeBase runs in a PER-RUN detached worktree and tears it down LAST', () => {
  const calls = [];
  const r = probeBase({
    baseSha: 'basesha', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp',
    _exists: () => true,
    _mkdtemp: (prefix) => `${prefix}XY7z`,
    _exec: (file, args) => { calls.push([file, ...args].join(' ')); return ''; },
  });
  assert.deepEqual(r.failed, [], 'both checks passed at base');
  assert.deepEqual(r.unreproducible, []);

  // PER-RUN, not keyed on the base sha (cold review F2): two PRs off the same `main`
  // tip would share a sha-keyed path, and the second run's teardown would delete the
  // first's LIVE worktree — after which its next command fails and reads as a red base.
  assert.match(calls[0], /git worktree add --detach \/tmp\/brain-review-base-XY7z basesha/);
  assert.ok(!calls[0].includes('basesha basesha'), 'the sha must not be the path');

  // AND TORN DOWN LAST, which is the assertion that observes the `finally` rather than
  // some other remove. The previous form was `filter(...).length >= 1` while TWO
  // remove sites existed — deleting the finally left every test green and leaked a
  // worktree per run (cold review F3). One site now, and its POSITION is what is pinned.
  const removes = calls.filter(c => c.includes('worktree remove'));
  assert.equal(removes.length, 1, 'exactly one teardown — the pre-emptive remove is gone with the shared path');
  assert.equal(calls[calls.length - 1], removes[0], 'the teardown must be the LAST call: anything after it runs against a deleted tree');
});

test('#408: two concurrent probes on the SAME base do not share a worktree', () => {
  // The regression cold review F2 reproduced end to end: with a sha-keyed path, run B's
  // first act deleted run A's live worktree and a HEALTHY base came back `pre-existing`
  // for both.
  const paths = [];
  const mk = (prefix) => `${prefix}${paths.length}`;
  for (const _ of [0, 1]) {
    probeBase({
      baseSha: 'same', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp', _exists: () => true, _mkdtemp: mk,
      _exec: (file, args) => { if (args.includes('add')) paths.push(args[args.length - 2]); return ''; },
    });
  }
  assert.equal(new Set(paths).size, 2, `two runs must get two paths — got ${JSON.stringify(paths)}`);
});

test('#408: a NON-ZERO EXIT marks the gate red at base and STOPS — the rest add nothing', () => {
  const ran = [];
  const r = probeBase({
    baseSha: 'b', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp', _exists: () => true,
    _mkdtemp: (p) => `${p}x`,
    _exec: (file, args) => {
      const cmd = [file, ...args].join(' ');
      if (cmd.includes('worktree')) return '';
      ran.push(cmd);
      if (cmd.includes('check-refs')) { const e = new Error('exit 1'); e.status = 1; throw e; }
      return '';
    },
  });
  assert.deepEqual(r.failed, ['local-checks']);
  assert.deepEqual(r.unreproducible, []);
  assert.equal(ran.length, 1, 'once the gate is red at base, the remaining steps prove nothing new');
});

// ── the distinction the whole module rests on (cold review F1) ──────────────

test('#408: a SPAWN failure is unreproducible, NOT "red at base" — the false-pass direction', () => {
  // ENOENT/ENOBUFS/a signal throw with no numeric `status`. Reading them as "the gate
  // is red at base" turns the reader's own failure into the gate's approval:
  // pre-existing → follow_ups → REVISE softens to APPROVE. A FALSE PASS, in the
  // direction this module claims it can never take.
  for (const err of [
    Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }),
    Object.assign(new Error('ENOBUFS'), { code: 'ENOBUFS', status: null }),
    Object.assign(new Error('killed'), { status: null, signal: 'SIGTERM' }),
  ]) {
    const r = probeBase({
      baseSha: 'b', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp', _exists: () => true,
      _mkdtemp: (p) => `${p}x`,
      _exec: (file, args) => { if (args.includes('worktree')) return ''; throw err; },
    });
    assert.deepEqual(r.failed, [], `${err.code ?? err.signal}: must NOT be recorded as a red base`);
    assert.deepEqual(r.unreproducible, ['local-checks']);
  }
});

test('#408: a command MISSING from the base tree is unreproducible, not red', () => {
  // The real case: a PR that vendors brain for the first time. Its base has no
  // brain/scripts/, every command fails to spawn, and the naive reading defers every
  // blocker the PR has.
  const r = probeBase({
    baseSha: 'b', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp',
    _mkdtemp: (p) => `${p}x`,
    _exists: (p) => !String(p).includes('check-refs'),
    _exec: () => '',
  });
  assert.deepEqual(r.failed, []);
  assert.deepEqual(r.unreproducible, ['local-checks']);
});

test('#408: an unreproducible gate KEEPS its finding blocking and names why', () => {
  const { findings, conditions } = classifyAgainstBase({
    findings: [{ ...blocker('gate:local-checks'), causal_disposition: 'introduced' }],
    baseProbe: { failed: [], unreproducible: ['local-checks'], command: 'cmd' },
  });
  assert.equal(findings[0].causal_disposition, 'introduced', 'not reproducible ⇒ not deferred');
  assert.equal(conditions.length, 1);
  assert.match(conditions[0], /local-checks could not be re-run at base/);
});

test('#408: an unreproducible gate NOBODY reported on produces no condition', () => {
  const { conditions } = classifyAgainstBase({
    findings: [blocker('budget')],
    baseProbe: { failed: [], unreproducible: ['local-checks'], command: 'cmd' },
  });
  assert.deepEqual(conditions, [], 'a gate with no finding needs no excuse');
});

test('#408: a git failure is null (uncomputable), never a crash and never a verdict', () => {
  const r = probeBase({
    baseSha: 'b', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp',
    _exec: (file, args) => { if (args.includes('add')) throw new Error('git exploded'); return ''; },
  });
  assert.equal(r, null);
});

test('#408: with no base sha the probe never touches git — the guard is a refusal, not a shortcut', () => {
  // Asserting only the `null` return passes either way: without the guard the
  // worktree add fails and the catch returns null too. What the guard actually buys
  // is that a review with no resolvable base does not spawn git, create a path named
  // after `null`, and remove it again — so that is what gets asserted.
  const calls = [];
  const r = probeBase({
    baseSha: null, gates: ['local-checks'], cwd: '/repo', tmp: '/tmp',
    _exec: (file, args) => { calls.push([file, ...args].join(' ')); return ''; },
  });
  assert.equal(r, null, 'no base sha ⇒ nothing to compare against');
  assert.deepEqual(calls, [], 'and nothing may be spawned to discover that');

  const noGates = [];
  assert.equal(probeBase({ baseSha: 'b', gates: [], cwd: '/repo', tmp: '/tmp', _exec: (f, a) => { noGates.push(f); return ''; } }), null);
  assert.deepEqual(noGates, [], 'nor when there is no gate to reproduce');
});

test('#408: probeBase strips NODE_TEST_CONTEXT from the child env', () => {
  // Inherited, it trips node's recursive-test guard: the child SKIPS every file and
  // exits 0, which reads as "the suite passes at base" — the exact inversion of the
  // claim. Recorded in defaultRunReversion; the same trap, one module over.
  let seenEnv = null;
  process.env.NODE_TEST_CONTEXT = 'child';
  try {
    probeBase({
      baseSha: 'b', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp', _exists: () => true,
      _exec: (file, args, opts) => { if (args.includes('--test')) seenEnv = opts.env; return ''; },
    });
  } finally { delete process.env.NODE_TEST_CONTEXT; }
  assert.ok(seenEnv, 'sanity: the suite command must have run');
  assert.equal(seenEnv.NODE_TEST_CONTEXT, undefined);
});

// ── the pipeline order ──────────────────────────────────────────────────────

test('#408: admission classifies against base BEFORE the refuter forks', async () => {
  // THE FIRST VERSION OF THIS TEST OBSERVED NOTHING, and a cold review caught it (F4).
  // It injected a runner and asserted the runner saw `null` — but `evaluateRefuter`
  // only calls a runner when an `evidence_class: 'inferential'` BLOCKER exists, and
  // the fixture had none. So it compared null to null having watched nothing happen,
  // and swapping the pipeline to refute-first left the whole suite green. That is
  // `evidence-reader-empty-on-failure` in the assertion layer — the exact class this
  // repo's own doctrine names, in a test written to guard an ordering claim.
  //
  // Two fixes, both required. The finding must be INFERENTIAL so the refuter actually
  // forks, and the runner's real signature is `runner(inferentialBlockers)` — an
  // ARRAY, not `{ findings }`; the old stub would have thrown if it had ever fired.
  let seen = null;
  const inferential = { ...blocker('gate:local-checks'), evidence_class: 'inferential' };
  const { findings } = await applyCausalAdmission({
    findings: [inferential],
    baseProbe: { failed: ['local-checks'], unreproducible: [], command: 'cmd' },
    probeAttempted: true,
    runner: async (blockers) => { seen = blockers.map(f => f.causal_disposition); return { outcomes: [] }; },
  });
  assert.deepEqual(seen, ['pre-existing'],
    'the refuter must see the CLASSIFIED disposition — if it sees `introduced`, the classifier ran after it');
  assert.equal(findings[0].causal_disposition, 'pre-existing');
});


test('#408: annotation still defaults to introduced when no probe ran', async () => {
  const { findings, conditions } = await applyCausalAdmission({ findings: [blocker('gate:local-checks')] });
  assert.equal(findings[0].causal_disposition, 'introduced');
  assert.equal(findings[0].evidence_class, 'deterministic');
  assert.deepEqual(conditions, []);
});

test('#842: when `git worktree remove` itself fails, the dir dies via _rm AND the registration is pruned', () => {
  const removed = [];
  const execs = [];
  probeBase({
    baseSha: 'b', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp', _exists: () => true,
    _mkdtemp: (p) => `${p}x`,
    _exec: (file, args) => {
      execs.push(args.join(' '));
      if (args.includes('remove')) throw new Error('fatal: not a working tree');
      return '';
    },
    _rm: (p, opts) => removed.push({ p, opts }),
  });
  assert.deepEqual(removed, [{ p: '/tmp/brain-review-base-x', opts: { recursive: true, force: true } }],
    'the belt runs when the worktree remove cannot — a crashed add must not become an orphan');
  assert.ok(execs[execs.length - 1] === 'worktree prune',
    'the registration dies too (#843 r2): a bare rm leaves a stale .git/worktrees/ entry in the OPERATOR\'S repo');
});

test('#843 r2: on the happy path the remove is the whole teardown — no rm, no prune noise', () => {
  const removed = [];
  const execs = [];
  probeBase({
    baseSha: 'b', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp', _exists: () => true,
    _mkdtemp: (p) => `${p}x`,
    _exec: (file, args) => { execs.push(args.join(' ')); return ''; },
    _rm: (p, opts) => removed.push({ p, opts }),
  });
  assert.deepEqual(removed, [], 'a successful worktree remove already deleted the dir');
  assert.ok(!execs.some((c) => c === 'worktree prune'), 'nothing to prune when git itself removed it');
});

test('#842: the _rm belt is best-effort — its own failure never masks the probe result', () => {
  const r = probeBase({
    baseSha: 'b', gates: ['local-checks'], cwd: '/repo', tmp: '/tmp', _exists: () => true,
    _mkdtemp: (p) => `${p}x`,
    _exec: () => '',
    _rm: () => { throw new Error('EBUSY'); },
  });
  assert.ok(r && Array.isArray(r.failed), 'the probe result survives a failed cleanup');
});
