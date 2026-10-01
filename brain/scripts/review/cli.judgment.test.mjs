// cli.judgment.test.mjs — issue #682. THE COMPOSITION, driven through `main()`.
//
// WHY THIS FILE EXISTS. Two adversarial cold reviews of PR #740/#741 reached the
// same root cause independently: every mutation the first cut survived varied
// the UNITS and none varied the COMPOSITION. Replacing the challenger call in
// `cli.mjs` with `null` left the full suite green at 4094/4094, and all four
// blockers the second review found lived in the wiring, not in the evaluators.
//
// The axes they named as never varied are the sections below: the protocol, the
// axis, the id space, the conclusion, and the generator's failure modes. Each
// one is now driven end to end through the real verb.

import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { main } from './cli.mjs';
import { parseVerdict } from './lib/parse-verdict.mjs';
import { ID_PREFIX } from './evaluators/inferential.mjs';
import { UNCHALLENGED, ROUTED_HUMAN } from './evaluators/refuter.mjs';
import { REQUIRED_JOBS } from '../vcs/governance-checks.mjs';
import { tierParams } from '../vcs/governance-tiers.mjs';
import { resolveJudgment, JUDGMENT_PROTOCOL } from './lib/resolve-challenger.mjs';

/** Every required gate green — the same fixture `cli.test.mjs` uses. An empty
 *  rollup is NOT green: the tranche evaluator reads it as uncomputable evidence
 *  and REVISEs, which would have made the conclusion cases below pass for the
 *  wrong reason. */
const greenRollup = () => REQUIRED_JOBS.map((name) => ({ name, status: 'COMPLETED', conclusion: 'SUCCESS' }));

const HEAD = 'f'.repeat(40);

// The double must HONOUR the token (#604): one that returns a fixed login for
// any credential models the credential-injecting environment the negative
// control refuses, so it cannot stand in for a healthy one. Same shape as
// `cli.test.mjs`/`identity.test.mjs`.
const honestWhoami = (logins) => async ({ token }) => {
  if (Object.hasOwn(logins, token)) return { username: logins[token] };
  throw new Error('gh: Bad credentials (HTTP 401)');
};

/** A green tranche run, with every seam this file needs injectable. */
/**
 * A forge CLI that reports NO session, injected into every stage-driving test.
 *
 * WITHOUT IT THESE TESTS SPAWN THE REAL `gh`/`glab` (judgment:cold-2 of the
 * fourth cold review — the first one that EXECUTED the chain). `probeDeps` in
 * `run-cold-review-stage.mjs` falls back to the real runner when no
 * `forgeProbe` is supplied, so on any machine holding a `gh auth login` keyring
 * session — the exact state `producer-forge-reach.mjs`'s header says it
 * observed — the probe returns `reachable`, the stage refuses before spawning,
 * and ten tests here fail. MEASURED with a stub `gh` that exits 0: 43 pass, 10
 * FAIL. `npm test` is a required gate.
 *
 * It went unnoticed because THIS container has no `gh` installed, so the probe
 * answered `absent` and the suite was green for a reason that has nothing to do
 * with the code — a test whose oracle is the host. `producer-forge-reach.test.mjs`
 * carries a comment warning about precisely this, one layer down, written in the
 * same commit that introduced it here.
 */
const LOGGED_OUT = () => ({ status: 1, stderr: 'not logged into any hosts' });

// Candidate snapshots are a production precondition. Give the cold-boot double
// a real empty directory so composition tests exercise that precondition instead
// of accidentally asking snapshotCandidate() to read an impossible placeholder.
const coldWorktrees = [];
after(() => coldWorktrees.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function deps({ config, protocol, generate, tier = 'regulated', refuterRunner } = {}) {
  const d = {
    project: 'csrinaldi/brain',
    provider: 'github',
    baseSha: 'BASE',
    tier,
    config,
    getChangedFiles: () => ['a.mjs'],
    identityDeps: {
      readConfig: () => ({ handle: 'brain-reviewer', tokenEnv: 'BRAIN_REVIEWER_TOKEN' }),
      readEnv: () => ({ BRAIN_REVIEWER_TOKEN: 'shh' }),
      whoami: honestWhoami({ shh: 'brain-reviewer' }),
    },
    coldBootDeps: {
      fetchPr: async () => ({ number: 42, author: 'alice', labels: [], body: '', headRefOid: HEAD }),
      // A worktree path, because production always has one: cold-boot builds a
      // detached checkout and judgment:cold-3 makes the stage REFUSE without it.
      // A double that omits it is less faithful than the code it stands in for.
      cloneDetached: async () => { const worktreePath = mkdtempSync(join(tmpdir(), 'cli-cold-worktree-')); coldWorktrees.push(worktreePath); return { detached: true, worktreePath }; },
      readRecords: () => [],
      fetchReviews: async () => [],
    },
    trancheDeps: {
      fetchRollup: async () => greenRollup(),
      diffNumstat: () => '10\t5\ta.mjs\n',
      readIgnoreList: () => [],
      tier: 'standard',
    },
    writeVerbs: {},
  };
  if (protocol !== undefined) d.protocol = protocol;
  if (generate !== undefined) d.inferentialDeps = { generate };
  if (refuterRunner !== undefined) d.refuterRunner = refuterRunner;
  return d;
}

const CFG = (axis) => ({
  reviewer: { inferential: { enabled: true, challenger: axis ? { axis } : undefined } },
});

const reasoned = (over = {}) => ([{
  id: 'J1', severity: 'blocker',
  evidence: 'the parser is correct; the semantics are inverted',
  cites: 'reviewer-protocol.md §6.1',
  ...over,
}]);

/** Runs the real verb at --dry-run and returns { code, body, verdict }. */
async function run(options) {
  const lines = [];
  const code = await main({ argv: ['--pr', '42', '--dry-run'], log: (s) => lines.push(s), error: () => {}, ...deps(options) });
  const body = lines.join('\n');
  return { code, body, verdict: parseVerdict({ body }), lines };
}

// ── AXIS 1: the protocol ─────────────────────────────────────────────────────

test('composition: at brain-review/1 the judgment half does not run, and nothing declares it', async () => {
  // THE BLOCKER. `standard` ships `{inferentialEnabled: true, reviewProtocol:
  // 'brain-review/1'}`. With two gates the producer ran and the refuter was
  // skipped entirely: a reasoned blocker, never challenged, never escalated, in
  // a verdict declaring `controls_not_applied: []`. #552's ruled-against state.
  const { code, body } = await run({
    tier: 'standard', protocol: 'brain-review/1', config: CFG('human'), generate: async () => reasoned(),
  });

  assert.equal(code, 0);
  assert.doesNotMatch(body, /evidence_class: inferential/,
    'a reasoned finding must not be produced into a protocol that cannot carry it');
  assert.doesNotMatch(body, /controls: .*inferential/,
    'and nothing may declare the inferential control on a run where it did not apply');
});

test('composition: at brain-review/2 the same inputs DO run the judgment half', async () => {
  const { body } = await run({ protocol: 'brain-review/2', config: CFG('human'), generate: async () => reasoned() });
  assert.match(body, /evidence_class: inferential/);
  assert.match(body, /controls: .*"inferential"/);
});

// ── AXIS 2: the axis reaches the wire (REQ-682-3) ────────────────────────────

test('composition: the verdict DECLARES the axis that challenged the reasoned findings', async () => {
  // REQ-682-3 was claimed delivered by slice 2 and was not implemented at all:
  // `resolveAxis`'s value was consumed as a boolean and discarded, and no task in
  // any slice put it on the wire.
  const a = await run({ protocol: 'brain-review/2', config: CFG('human'), generate: async () => reasoned() });
  const b = await run({ protocol: 'brain-review/2', config: CFG('cross-family'), generate: async () => reasoned() });

  assert.match(a.body, /challenger_axis: human/);
  assert.match(b.body, /challenger_axis: cross-family/);
  assert.notEqual(a.body, b.body,
    'two evidentiary strengths must not render byte-identically — #683 one field over');
});

test('composition: no reasoned finding, no axis line — #690\'s wallpaper rule', async () => {
  const { body } = await run({ protocol: 'brain-review/2', config: CFG('human'), generate: async () => [] });
  assert.doesNotMatch(body, /challenger_axis:/,
    'an axis that challenged nothing is not evidence about this verdict');
});

test('composition: an unbuilt axis posts a verdict that says so — it does not crash', async () => {
  const { code, body } = await run({
    protocol: 'brain-review/2', config: CFG('cross-family'), generate: async () => reasoned(),
  });
  assert.equal(code, 0, 'a posted fail-closed verdict beats an unhandled rejection');
  assert.match(body, new RegExp(`refuter_outcome: ${UNCHALLENGED}`));
  assert.match(body, /escalate: human/);
});

// ── AXIS 3: the id space ─────────────────────────────────────────────────────

test('composition: a produced id cannot address a deterministic finding', async () => {
  const { body, verdict } = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: async () => reasoned({ id: 'gate:phase-order' }),
  });
  assert.match(body, new RegExp(`id: ${ID_PREFIX}gate:phase-order`));
  const ids = (verdict?.findings ?? []).map(f => f.id);
  assert.equal(ids.filter(i => i === 'gate:phase-order').length, 0,
    'the producer must not be able to emit a bare gate id');
});

// ── AXIS 4: the conclusion ───────────────────────────────────────────────────

test('composition: a reasoned blocker BLOCKS — it does not land in an APPROVE', async () => {
  // The judgment half could escalate when it was UNSURE and could not block when
  // it was SURE: `evaluateInferential`'s conclusion was discarded in the merge.
  const { body } = await run({
    protocol: 'brain-review/2', config: CFG('human'), generate: async () => reasoned(),
  });
  assert.doesNotMatch(body, /^verdict: APPROVE$/m,
    'a blocker that does not block is not a blocker');
  assert.match(body, /^verdict: (REVISE|STOP)$/m);
});

test('composition: a green run with no reasoned finding still APPROVEs', async () => {
  const { body } = await run({ protocol: 'brain-review/2', config: CFG('human'), generate: async () => [] });
  assert.match(body, /^verdict: APPROVE$/m, 'the judgment half must not block by existing');
});

// ── AXIS 5: the generator's failure modes ────────────────────────────────────

test('composition: a generator that FAILED refuses the run and posts nothing (#682 criterion 6)', async () => {
  for (const generate of [
    async () => { throw new Error('ECONNREFUSED'); },
    async () => undefined,
    async () => ({ error: 'unreachable' }),
  ]) {
    const { code, body } = await run({ protocol: 'brain-review/2', config: CFG('human'), generate });
    assert.equal(code, 1, 'an uncomputable judgment half must fail closed — protocol §10');
    assert.doesNotMatch(body, /controls:/,
      'and must post NO verdict, rather than one declaring the control applied over nothing');
  }
});

// ── the wiring itself ────────────────────────────────────────────────────────

test('composition: the challenger actually REACHES the refuter through main()', async () => {
  // The blocker from slice 1's review: replacing the `resolveJudgment` call with
  // `null` left the whole suite green, because every test called the resolver
  // directly and none observed `cli.mjs` calling it.
  const { body } = await run({
    protocol: 'brain-review/2', config: CFG('human'), generate: async () => reasoned(),
  });
  assert.match(body, new RegExp(`refuter_outcome: ${ROUTED_HUMAN}`),
    'the human runner constructed by resolveJudgment must have run inside the real verb');
});

test('composition: an unrecognised axis refuses the run and posts nothing', async () => {
  const { code, body } = await run({
    protocol: 'brain-review/2', config: CFG('same-modle'), generate: async () => reasoned(),
  });
  assert.equal(code, 1);
  assert.doesNotMatch(body, /protocol: brain-review/, 'no verdict may be posted on an unknown axis');
});

test('composition: an explicitly injected null runner still exercises the no-runner path', async () => {
  // `??` would have overridden a deliberate `null`; `'refuterRunner' in deps`
  // does not. Nothing in the repo relied on this, but the comment claimed it.
  const { body } = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: async () => reasoned(), refuterRunner: null,
  });
  assert.match(body, new RegExp(`refuter_outcome: ${UNCHALLENGED}`));
});

// ── round 1 of the review loop: the fixes, each pinned where it failed ────────
//
// Every test below reproduces a defect that four independent refuters
// CORROBORATED against the real `main()`. They live here rather than beside
// their units because all six were invisible to unit tests and visible in
// composition — the axis both cold reviews named as the one never varied.

test('A1: a CORROBORATED reasoned blocker changes the conclusion', async () => {
  // The judgment half could escalate when UNSURE and could not block when SURE:
  // the conclusion was decided from the producer's pre-challenge severities,
  // before the challenger ran, and nothing re-derived it.
  const { body } = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: async () => reasoned(),
    refuterRunner: async (bs) => ({ outcomes: bs.map(f => ({ id: f.id, outcome: 'corroborated', rationale: 'r' })) }),
  });
  assert.doesNotMatch(body, /^verdict: APPROVE$/m, 'a blocker the challenge UPHELD must block');
  assert.match(body, /^verdict: REVISE$/m);
});

test('A2: a REFUTED claim stops blocking — the fixer is not asked to comply with a disproved claim', async () => {
  // It left `verdict: REVISE` with ZERO blockers in the list, so the PR could
  // never go green on the strength of a claim the challenge had already shown
  // to be false.
  const { body } = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: async () => reasoned(),
    refuterRunner: async (bs) => ({ outcomes: bs.map(f => ({ id: f.id, outcome: 'refuted', rationale: 'not real' })) }),
  });
  assert.match(body, /^verdict: APPROVE$/m, 'nothing blocks once the only blocker is refuted');
  assert.match(body, /refuted: true/);
  assert.doesNotMatch(body, /severity: blocker/);
});

test('B: an unrecognised challenger outcome is UNCHALLENGED, never "corroborated"', async () => {
  // The switch ended in the corroborated return, so eight out-of-vocabulary
  // values all rendered as "a challenge upheld this finding".
  for (const outcome of ['REFUTED', 'refute', 'unknown', '', 'partially-refuted', null, undefined]) {
    const { body } = await run({
      protocol: 'brain-review/2', config: CFG('human'),
      generate: async () => reasoned(),
      refuterRunner: async (bs) => ({ outcomes: bs.map(f => ({ id: f.id, outcome, rationale: 'r' })) }),
    });
    assert.match(body, new RegExp(`refuter_outcome: ${UNCHALLENGED}`),
      `outcome ${JSON.stringify(outcome)} must not read as a challenge that upheld the finding`);
    assert.match(body, /^escalate: human$/m);
  }
});

test('E: two findings sharing an id, and two with none, stay distinguishable', async () => {
  // Refuting one used to downgrade BOTH, and stamp the second with a rationale
  // written about the first.
  const { body, verdict } = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: async () => ([
      { id: 'J1', severity: 'blocker', evidence: 'first', cites: 'c' },
      { id: 'J1', severity: 'blocker', evidence: 'second', cites: 'c' },
      { severity: 'blocker', evidence: 'third', cites: 'c' },
      { severity: 'blocker', evidence: 'fourth', cites: 'c' },
    ]),
    refuterRunner: async (bs) => ({ outcomes: [{ id: bs[0].id, outcome: 'refuted', rationale: 'only the first' }] }),
  });
  const ids = (verdict?.findings ?? []).map(f => f.id);
  assert.equal(new Set(ids).size, ids.length, `ids must be unique within a batch — got ${ids.join(', ')}`);
  assert.equal((body.match(/refuted: true/g) ?? []).length, 1,
    'refuting one finding must not downgrade its namesake');
});

test('G: enabled-with-no-transport does not render like disabled', async () => {
  // #552's fold, re-created one layer up: neither state declares `inferential`,
  // so #690's complement says the same thing in both.
  const off = await run({ protocol: 'brain-review/2', config: { reviewer: { inferential: { enabled: false } } } });
  const on = await run({ protocol: 'brain-review/2', config: CFG('human') });

  assert.notEqual(off.body, on.body, 'a repo that turned the judgment half ON must be told it did not run');
  assert.match(on.body, /enabled but no transport is configured/);
  assert.match(off.body, /^conditions: \[\]$/m);
});

test('H: a challenger that throws fails CLOSED with a readable refusal, not a stack trace', async () => {
  // The call sat outside every try block and the entry point has no outer
  // catch, so it surfaced as an unhandled rejection with no verdict — quieter
  // than the fail-closed REVISE the same input produced before the challenger
  // existed.
  const lines = [];
  const errs = [];
  const code = await main({
    argv: ['--pr', '42', '--dry-run'], log: (s) => lines.push(s), error: (s) => errs.push(s),
    ...deps({
      protocol: 'brain-review/2', config: CFG('human'),
      generate: async () => reasoned(),
      refuterRunner: async () => { throw new Error('ECONNRESET'); },
    }),
  });
  assert.equal(code, 1);
  assert.match(errs.join('\n'), /brain:review: the challenger failed — ECONNRESET/);
  assert.doesNotMatch(lines.join('\n'), /protocol: brain-review/,
    'no verdict may be posted when the reasoned findings were never challenged');
});

test('#743: the config and the judgment gate cannot contradict each other', () => {
  // This pin used to walk the TIER TABLE. The #743 ruling took the review system
  // out of that table, so the same property is now asserted over the surface that
  // does decide: `reviewer.inferential.enabled` and `reviewer.protocol`.
  //
  // Two things the earlier cuts got wrong and this keeps: the assertions must not
  // sit inside `if (j.run)` — a pin that passes when nothing runs constrains
  // nothing — and the case list must exercise BOTH sides of the gate, or the loop
  // passes vacuously on a list where the half never runs.
  const CASES = [
    { label: 'nothing declared', config: {}, protocol: JUDGMENT_PROTOCOL, run: true, enabled: true },
    { label: 'explicitly off', config: { reviewer: { inferential: { enabled: false } } },
      protocol: JUDGMENT_PROTOCOL, run: false, enabled: false },
    { label: 'asked for, refused by the protocol', config: {}, protocol: 'brain-review/1',
      run: false, enabled: true },
  ];

  for (const c of CASES) {
    const j = resolveJudgment({ config: c.config, protocol: c.protocol });
    assert.equal(j.run, c.run, `${c.label}: resolved run state`);
    assert.equal(j.enabled, c.enabled, `${c.label}: resolved enabled state`);

    if (j.run) {
      assert.ok(j.challenger, `${c.label}: runs the half with no challenger`);
      assert.ok(j.axis, `${c.label}: runs the half with no declared axis`);
      assert.equal(j.reason, null, `${c.label}: runs, and still reports a reason it did not`);
    } else {
      assert.equal(j.challenger, null, `${c.label}: does not run, yet resolved a challenger`);
      assert.equal(j.axis, null, `${c.label}: does not run, yet declared an axis`);
      assert.ok(j.reason, `${c.label}: refused silently — nothing to report to the operator`);
    }

    // The distinction #741 F2 named, and the reason `enabled` is separate from
    // `run`: a repo that ASKED and was refused must not read like one that never
    // asked. Only the first can be reported.
    if (c.enabled && !c.run) {
      assert.equal(j.enabled, true, `${c.label}: asked-and-refused must still read as ASKED`);
    }
  }

  assert.ok(CASES.some(c => c.run), 'no case runs the half — the on path is untested by this list');
  assert.ok(CASES.some(c => !c.run), 'no case refuses the half — the off path is untested by this list');
  assert.ok(CASES.some(c => c.enabled && !c.run),
    'no case is asked-and-refused — the state that must be REPORTED is untested');
});

test('a runner-reported UNCHALLENGED is COUNTED, not merely marked', async () => {
  // #742: deleting `unansweredCount++` from the runner-reported branch left the
  // full suite green while the verdict's "were NOT challenged" condition
  // vanished end to end. The partial-runner path was asserted on the count; the
  // runner-reported path was not — the same fact, two ways in, one guarded.
  const { body } = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: async () => reasoned(),
    refuterRunner: async (bs) => ({
      outcomes: bs.map(f => ({ id: f.id, outcome: UNCHALLENGED, rationale: 'nothing challenged it' })),
    }),
  });
  assert.match(body, /inferential blocker\(s\) were NOT challenged/,
    'the count is the sole input to the verdict-level condition — marking without counting loses it');
  assert.match(body, /^escalate: human$/m);
});

test('a repo that ASKED for the judgment half and did not get it is told why', async () => {
  // `judgment.reason` was computed on every off path and read nowhere, so a
  // repo that asked and received nothing was told nothing while
  // `resolveJudgment` knew exactly why.
  //
  // THIS TEST WAS WRITTEN ONCE BEFORE AND NEVER REACHED THE COMMIT: it was
  // appended, verified against a mutation, and then deleted by the
  // `git checkout --` that restored that same mutation. The PR body claimed it.
  // Read the commit, not your memory of it.
  const askedExplicitly = await run({
    tier: 'standard', protocol: 'brain-review/1', config: CFG('human'),
  });
  assert.match(askedExplicitly.body, /the judgment half did not run — .*requires brain-review\/2/);

  // And asked BY DEFAULT, which is the common case after the #743 ruling: an
  // absent key means the half is ON, so a repo that declared nothing and runs at
  // `/1` has asked for it just as surely as one that wrote the key.
  const askedByDefault = await run({ tier: 'standard', protocol: 'brain-review/1', config: {} });
  assert.match(askedByDefault.body, /the judgment half did not run — .*requires brain-review\/2/,
    'the default-on half, refused by the protocol, must say so');

  // The repo that never asked sees no noise — #690's wallpaper rule. Reaching
  // this state now takes an EXPLICIT `false`; before the ruling the tier could
  // put a repo here without anyone choosing it.
  const neverAsked = await run({
    tier: 'lite', protocol: 'brain-review/1',
    config: { reviewer: { inferential: { enabled: false } } },
  });
  assert.match(neverAsked.body, /^conditions: \[\]$/m);
  assert.notEqual(askedByDefault.body, neverAsked.body,
    'asked-and-refused must not render like never-asked');
});

// ── slice A · the judgment half runs END TO END, from a file ─────────────────
//
// #682's acceptance criterion 2 asked that producer and challenger land
// together; criterion 3 asks for the real verb. This is the half of 3 that a
// hand-written artifact can prove: file → reader → generate → producer →
// challenger → verdict. No agent is spawned; that is slice B.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { artifactPathFor, ARTIFACT_TAG } from './lib/findings-artifact.mjs';
import { COLD_REVIEW_STAGE } from '../lib/stage-engine.mjs';
import { artifactDeps } from './cli.mjs';

function repoWithArtifact(t, findings, pr = 762) {
  const root = mkdtempSync(join(tmpdir(), 'brain-slice-a-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rel = artifactPathFor(pr);
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(
    join(root, rel),
    `# Cold review of PR #${pr}\n\n\`\`\`${ARTIFACT_TAG}\n${JSON.stringify(findings, null, 2)}\n\`\`\`\n`,
    'utf8',
  );
  return root;
}

test('slice A: a reasoned finding written to the stage artifact reaches the posted verdict', async (t) => {
  const root = repoWithArtifact(t, [{
    id: 'J1', severity: 'blocker',
    evidence: 'the parser is correct; the semantics are inverted',
    cites: 'reviewer-protocol.md §6.1', file: 'brain/scripts/review/verdict.mjs', line: 166,
  }]);

  const { body } = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: artifactDeps(762, root).generate,
  });

  assert.match(body, /the semantics are inverted/, 'the finding must reach the wire');
  assert.match(body, /^controls: \["deterministic", ?"inferential"\]$/m,
    'and the run must DECLARE that the judgment control was applied — it was');
  assert.doesNotMatch(body, /no transport is configured/,
    'the condition that ships today must be gone: there IS a transport now');
});

test('slice A: the artifact carries `file`+`line`, which is what an inline comment needs', async (t) => {
  const root = repoWithArtifact(t, [{
    id: 'J1', severity: 'blocker', evidence: 'e', cites: 'x §1',
    file: 'brain/scripts/review/verdict.mjs', line: 166,
  }]);
  const { body } = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: artifactDeps(762, root).generate,
  });
  assert.match(body, /file: brain\/scripts\/review\/verdict\.mjs/);
  assert.match(body, /line: 166/);
  // deriveInlineComments turns exactly this pair into a comment on the changed
  // line. A.4 proves it against a posted review; here it is proven to SURVIVE
  // the pipeline, which is the half that was missing.
});

test('slice A: an artifact that exists and is broken posts NOTHING, and says why', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-slice-a-bad-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const rel = artifactPathFor(762);
  mkdirSync(join(root, dirname(rel)), { recursive: true });
  writeFileSync(join(root, rel), `\`\`\`${ARTIFACT_TAG}\n{ not json }\n\`\`\`\n`, 'utf8');

  const { code, body } = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: artifactDeps(762, root).generate,
  });

  assert.notEqual(code, 0, 'a transport that ran and broke must fail closed');
  assert.doesNotMatch(body, /^protocol: brain-review/m,
    'and no verdict may be rendered at all: one declaring `inferential` over findings nobody ' +
    'produced is the uncomputable-evidence APPROVE §10 forbids');

  // The control — the SAME run with a readable artifact does render one, so the
  // assertion above is not passing because this harness never renders anything.
  const good = mkdtempSync(join(tmpdir(), 'brain-slice-a-ok-'));
  t.after(() => rmSync(good, { recursive: true, force: true }));
  mkdirSync(join(good, dirname(rel)), { recursive: true });
  writeFileSync(join(good, rel), `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`, 'utf8');
  const ok = await run({
    protocol: 'brain-review/2', config: CFG('human'),
    generate: artifactDeps(762, good).generate,
  });
  assert.equal(ok.code, 0);
  assert.match(ok.body, /^protocol: brain-review/m);
});

test('slice A: the PRODUCTION path is the artifact — no injected deps at all', async (t) => {
  // The pin the three tests above do NOT provide: each of them hands `main` a
  // `generate` directly, so `deps.inferentialDeps ?? artifactDeps(...)` could be
  // deleted and every one of them would stay green. This drives the real branch
  // — nothing injected but the root the artifact is read from.
  const root = repoWithArtifact(t, [{
    id: 'J1', severity: 'blocker', evidence: 'found by the stage, not by a test double',
    cites: 'reviewer-protocol.md §6.1', file: 'a.mjs', line: 7,
  }], 42);   // 42 is the PR the run helper drives

  const lines = [];
  const code = await main({
    argv: ['--pr', '42', '--dry-run'], log: (s) => lines.push(s), error: () => {},
    root, ...deps({ protocol: 'brain-review/2', config: CFG('human') }),
  });
  const body = lines.join('\n');

  assert.equal(code, 0);
  assert.match(body, /found by the stage, not by a test double/,
    'the verdict must carry a finding that reached it through the production wiring');
  assert.match(body, /^controls: \["deterministic", ?"inferential"\]$/m);
});

test('slice A: with no artifact under the root, the half does not run and says so', async (t) => {
  const root = mkdtempSync(join(tmpdir(), 'brain-slice-a-none-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const lines = [];
  const code = await main({
    argv: ['--pr', '42', '--dry-run'], log: (s) => lines.push(s), error: () => {},
    root, ...deps({ protocol: 'brain-review/2', config: CFG('human') }),
  });
  const body = lines.join('\n');

  assert.equal(code, 0, 'a repo that never ran the stage has not failed at anything');
  assert.match(body, /no transport is configured/,
    'and it is TOLD — the condition that ships today, still correct when the artifact is absent');
});

// ── C.1 — the bound reaches the loop through the REAL verb ──────────────────

test('C.1: reviewer.convergence.maxRounds reaches the produce loop through main()', async () => {
  // THE PRODUCTION GLUE, PINNED. `main` resolves the bound and hands it to
  // `gatherInferentialInputs`; every unit test for the loop passes `maxRounds`
  // directly, so deleting that one argument from the call site left the whole
  // suite GREEN — measured. The config key would have been inert in the real
  // verb while `convergence.test.mjs` proved the loop honours a bound nobody
  // gave it. Same shape as A.3, where `deps.inferentialDeps ?? artifactDeps(…)`
  // was deletable green until a test drove the real branch.
  const rounds = [];
  const { code } = await run({
    config: {
      reviewer: {
        inferential: { enabled: true },
        convergence: { maxRounds: 4 },
      },
    },
    protocol: 'brain-review/2',
    generate: async ({ round }) => {
      rounds.push(round);
      // A distinct finding per round, so the loop cannot converge early and the
      // count is the bound rather than an accident of repetition.
      return [{ id: `R${round}`, severity: 'editorial', evidence: `round ${round}` }];
    },
  });

  assert.equal(code, 0);
  assert.deepEqual(rounds, [1, 2, 3, 4], 'the configured bound must reach the loop, not stop at the resolver');
});

test('C.1: no convergence key means one round through the real verb', async () => {
  const rounds = [];
  await run({
    config: CFG(),
    protocol: 'brain-review/2',
    generate: async ({ round }) => { rounds.push(round); return [{ id: `R${round}`, severity: 'editorial', evidence: 'x' }]; },
  });

  // The complement, and it is not redundant: without it, passing a constant 4 at
  // the call site would satisfy the test above.
  assert.deepEqual(rounds, [1], 'an unset key runs exactly what ran before it existed');
});

test('C.1: an unreadable maxRounds refuses the run rather than reviewing under the old bound', async () => {
  // ASSERTED THROUGH THE ERROR CHANNEL, not by catching a throw (judgment:cold-6).
  // The first cut wrapped this in `.catch(err => ...)` and asserted err.message,
  // which passes for BOTH a real refusal and a raw ERR_UNHANDLED_REJECTION —
  // and the raw one is what production got: `process.exit(await main())` has no
  // outer catch, so the operator saw a Node stack, no `brain:review:` line, and
  // no verdict. The run failed closed either way; what was lost is the only
  // part of a refusal that helps anybody.
  const errs = [];
  const code = await main({
    argv: ['--pr', '42', '--dry-run'], log: () => {}, error: (m) => errs.push(String(m)),
    ...deps({
      config: { reviewer: { inferential: { enabled: true }, convergence: { maxRounds: 'three' } } },
      protocol: 'brain-review/2',
      generate: async () => [{ id: 'x', severity: 'editorial', evidence: 'x' }],
    }),
  });

  assert.equal(code, 1, 'an unreadable bound must refuse — quietly running the old one reviews under a config nobody chose');
  const named = errs.filter((m) => m.includes('brain:review:'));
  assert.ok(named.length > 0, 'the refusal must reach the operator on the error channel, not as a stack trace');
  assert.match(named.join('\n'), /whole number of rounds/, 'and it must say what is wrong with the key');
});

test('C.1: the bound is validated even when NO transport is configured', async () => {
  // The second half of judgment:cold-6, and the worse one. `resolveConvergence`
  // used to sit inside the branch that runs when a transport IS configured, so
  // in a repo with none the key was never read: `maxRounds: "three"` RESOLVED
  // WITH EXIT 0, measured. The refusal arrived on the day someone routed the
  // stage rather than the day they wrote the key — and config is wrong when it
  // is WRITTEN, not when it is finally reached.
  const errs = [];
  const code = await main({
    argv: ['--pr', '42', '--dry-run'], log: () => {}, error: (m) => errs.push(String(m)),
    ...deps({
      config: { reviewer: { inferential: { enabled: true }, convergence: { maxRounds: 'three' } } },
      protocol: 'brain-review/2',
      // no `generate`, so no transport — the state every repo is in before it
      // routes the stage, and the one where this key went unread.
    }),
  });

  assert.equal(code, 1, 'an unreadable bound must refuse whether or not a transport exists to use it');
  assert.match(errs.join('\n'), /whole number of rounds/);
});

// ── C.2a — THE STAGE IS REACHABLE FROM THE VERB ─────────────────────────────
//
// Until this section existed the slice had a producer, a transport and a reader
// that never touched: `runColdReviewStage` and `makeRunStageSeam` had ZERO
// production callers, measured by grep. Everything was tested and nothing was
// reachable — the same defect class the mutation passes kept finding, at slice
// scale rather than at line scale.
//
// These drive the WHOLE chain through `main()`: config routes the stage → the
// seam reaches a (stubbed) engine → the engine writes the artifact → the reader
// finds it → the finding lands in the verdict. No step is injected past the one
// that would otherwise spawn a real model.

/** A repo root the stage can write into, cleaned up after the test. */
function scratchRoot(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cli-stage-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const ROUTED_CFG = {
  reviewer: { inferential: { enabled: true } },
  sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'claude', model: 'zz-9' } } },
};

test('C.2a: the routed stage runs, writes, and its finding reaches the verdict', async (t) => {
  const root = scratchRoot(t);
  let spawned = null;

  const lines = [];
  const code = await main({
    argv: ['--pr', '42', '--dry-run'],
    log: (s) => lines.push(s),
    error: () => {},
    ...deps({ config: ROUTED_CFG, protocol: 'brain-review/2' }),
    root,
    // The ONLY injection is the thing that would spawn a real model. Everything
    // between here and the verdict is production code.
    stageDeps: { forgeProbe: LOGGED_OUT,
      runStage: async (args) => {
        spawned = args;
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname } = await import('node:path');
        mkdirSync(dirname(join(root, artifactPathFor(42))), { recursive: true });
        writeFileSync(
          join(root, artifactPathFor(42)),
          `# cold review\n\n\`\`\`${ARTIFACT_TAG}\n` +
          JSON.stringify([{
            id: 'C1', severity: 'blocker',
            evidence: 'the stage ran and this came from its artifact',
            cites: 'REQ-S3-3',
          }]) + '\n\`\`\`\n'
        );
        return { ok: true };
      },
    },
  });

  assert.equal(code, 0);

  // 1. The verb reached the seam, with the routing the config named.
  assert.ok(spawned, 'the stage must actually be spawned — this is the call that did not exist');
  assert.equal(spawned.stage, COLD_REVIEW_STAGE);
  assert.equal(spawned.engine, 'claude');
  assert.equal(spawned.model, 'zz-9');
  assert.ok(spawned.prompt.includes(artifactPathFor(42)), 'the role names the path it must write');

  // THE DIFF RANGE, and it is not decoration. Measured: replacing baseRef/headRef
  // with nulls left the suite green — `assembleReviewPrompt` falls back to the
  // vague "the diff of this pull request against its base branch", and the engine
  // then reviews whatever it infers instead of the exact range the verdict binds
  // itself to. A review of the wrong range is still a well-formatted review.
  assert.ok(
    spawned.prompt.includes(`git diff BASE...${HEAD}`),
    'the role must name the resolved base...head range the verdict is about'
  );

  // 2. The artifact is on disk, where the reader looks.
  assert.ok(existsSync(join(root, artifactPathFor(42))), 'the stage wrote its artifact');

  // 3. The finding crossed into the verdict. THIS is the link that was missing:
  //    the reader could always read, but nothing had written.
  const body = lines.join('\n');
  const verdict = parseVerdict({ body });
  assert.ok(
    verdict.findings.some((f) => f.evidence?.includes('came from its artifact')),
    'the artifact the stage wrote must reach the rendered verdict'
  );
  assert.ok(
    !body.includes('no transport is configured'),
    'and the verdict must NOT claim the transport is unconfigured after running it'
  );
});

test('C.2a: the stage runs BEFORE the artifact is looked for', async (t) => {
  const root = scratchRoot(t);
  let existedWhenSpawned = null;

  await main({
    argv: ['--pr', '42', '--dry-run'],
    log: () => {}, error: () => {},
    ...deps({ config: ROUTED_CFG, protocol: 'brain-review/2' }),
    root,
    stageDeps: { forgeProbe: LOGGED_OUT,
      runStage: async () => {
        existedWhenSpawned = existsSync(join(root, artifactPathFor(42)));
        const { writeFileSync, mkdirSync } = await import('node:fs');
        const { dirname } = await import('node:path');
        mkdirSync(dirname(join(root, artifactPathFor(42))), { recursive: true });
        writeFileSync(join(root, artifactPathFor(42)), `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
        return { ok: true };
      },
    },
  });

  // THE ORDERING IS THE WIRING. `makeArtifactGenerate` answers `null` for a file
  // absent AT THE MOMENT IT IS ASKED, so resolving the reader first would make
  // the FIRST review on every PR report "no transport is configured" about a
  // stage that had just written its artifact. The read has to come after.
  assert.equal(existedWhenSpawned, false, 'precondition: the artifact did not exist before the stage ran');
});

test('C.2a: an UNROUTED stage spawns nothing and still reads a hand-written artifact', async (t) => {
  const root = scratchRoot(t);
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(join(root, artifactPathFor(42))), { recursive: true });
  writeFileSync(
    join(root, artifactPathFor(42)),
    `\`\`\`${ARTIFACT_TAG}\n` +
    JSON.stringify([{ id: 'H1', severity: 'editorial', evidence: 'written by hand, no stage involved' }]) +
    '\n\`\`\`\n'
  );

  let spawned = false;
  const lines = [];
  await main({
    argv: ['--pr', '42', '--dry-run'],
    log: (s) => lines.push(s), error: () => {},
    ...deps({ config: CFG(), protocol: 'brain-review/2' }),   // no sdd.map
    root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });

  // Routing the stage is opt-in — `sdd.map` ships empty. A repo that has not
  // routed it must not have an engine spawned on its behalf, and the file-only
  // path that slice A shipped must keep working exactly as it did.
  assert.equal(spawned, false, 'an unrouted stage spawns nothing');
  assert.ok(
    parseVerdict({ body: lines.join('\n') }).findings.some((f) => f.evidence?.includes('written by hand')),
    'and the artifact is still read'
  );
});

test('C.2a: an injected generator replaces the stage rather than running beside it', async (t) => {
  const root = scratchRoot(t);
  let spawned = false;

  await main({
    argv: ['--pr', '42', '--dry-run'],
    log: () => {}, error: () => {},
    ...deps({ config: ROUTED_CFG, protocol: 'brain-review/2', generate: async () => reasoned() }),
    root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });

  // A caller supplying its own generator has supplied the thing the stage exists
  // to produce. Spawning anyway burns a model call whose output nothing reads —
  // and would make every existing test in this file spawn an engine.
  assert.equal(spawned, false, 'an injected generator means the stage is what was replaced');
});

test('C.2a: a FAILED stage refuses the run and does not report "no transport"', async (t) => {
  const root = scratchRoot(t);
  const errors = [];

  const code = await main({
    argv: ['--pr', '42', '--dry-run'],
    log: () => {}, error: (s) => errors.push(s),
    ...deps({ config: ROUTED_CFG, protocol: 'brain-review/2' }),
    root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => ({ ok: false, reason: 'the engine exited with status 137' }) },
  });

  assert.equal(code, 1, 'a failed stage refuses the run');

  const said = errors.join('\n');
  assert.match(said, /the cold-review stage failed/);
  assert.match(said, /status 137/, 'and names what actually went wrong');

  // THE FOLD THIS BRANCH EXISTS TO PREVENT. Falling through instead would reach
  // `artifactDeps`, find no file, and render "enabled but no transport is
  // configured" — telling an operator who configured an engine that they did
  // not. Same words, opposite fact.
  assert.ok(
    !said.includes('no transport is configured'),
    'a configured engine that broke must not be reported as an unconfigured one'
  );
});

test('C.2a: a routed engine with no backend refuses through the REAL seam', async (t) => {
  const root = scratchRoot(t);
  const errors = [];

  // No `runStage` override — this drives `makeRunStageSeam()` and the real
  // dispatcher, so B.6's refusal is exercised from the verb rather than from a
  // unit test standing next to it. Only the forge probe is stubbed, which the
  // merge in cli.mjs now allows: before it, stubbing anything meant rebuilding
  // the seam this test exists to exercise, so it spawned the real `gh`.
  const code = await main({
    argv: ['--pr', '42', '--dry-run'],
    log: () => {}, error: (s) => errors.push(s),
    stageDeps: { forgeProbe: LOGGED_OUT },
    ...deps({
      config: {
        reviewer: { inferential: { enabled: true } },
        sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'no-such-engine-at-all' } } },
      },
      protocol: 'brain-review/2',
    }),
    root,
  });

  assert.equal(code, 1);
  assert.match(errors.join('\n'), /no-such-engine-at-all/, 'the refusal names the engine the operator wrote');
  assert.match(errors.join('\n'), /Refusing rather than falling back/);
});

// ── C.3 — THE NEGATIVE CASE, ON THE REAL POSTING PATH ───────────────────────
//
// #682 acceptance criterion 6: an engine that fails posts nothing and says why.
//
// C.2a's tests all run at `--dry-run`, which posts nothing regardless — so they
// could not have caught a broken refusal. "Posts nothing" is only a claim when
// the run is one that WOULD post. These drop `--dry-run` and spy the write
// verbs, so a regression that let a failed judgment half through would show up
// as `prReviewComment: 1`.
//
// FOUR MODES, AND THE FOURTH IS WHAT MAKES THE OTHER THREE MEAN ANYTHING.
// "Refuses on failure" is trivially satisfiable by refusing always; the
// found-nothing case is the control that proves the refusal is selective.
// Their reasons are also asserted PAIRWISE DISTINCT: three failures rendering
// one message is the fold this whole ticket is about, and an operator cannot act
// on "something went wrong".

/** Write verbs, counted. A failed judgment half must leave every counter at 0. */
function spyWriteVerbs() {
  const calls = { prReviewComment: 0, issueComment: 0, labelAdd: 0, labelRemove: 0 };
  return {
    calls,
    prReviewComment: async () => { calls.prReviewComment += 1; return { url: 'unused' }; },
    issueComment: async () => { calls.issueComment += 1; return { url: 'unused' }; },
    labelAdd: async () => { calls.labelAdd += 1; return { ok: true }; },
    labelRemove: async () => { calls.labelRemove += 1; return { ok: true }; },
    prView: async () => ({ headRefOid: HEAD }),
  };
}

/** Runs the real verb on the REAL posting path (no --dry-run). */
async function runPosting(options, extra = {}) {
  const vcs = spyWriteVerbs();
  const lines = [];
  const errors = [];
  const code = await main({
    argv: ['--pr', '42'],
    log: (s) => lines.push(s),
    error: (s) => errors.push(s),
    ...deps(options),
    ...extra,
    writeVerbs: vcs,
  });
  return { code, vcs, lines, errors, said: errors.join('\n') };
}

/** Writes an artifact for PR 42 under `root`, with whatever body is given. */
async function writeArtifact(root, body) {
  const { writeFileSync, mkdirSync } = await import('node:fs');
  const { dirname } = await import('node:path');
  mkdirSync(dirname(join(root, artifactPathFor(42))), { recursive: true });
  writeFileSync(join(root, artifactPathFor(42)), body);
}

// Each mode carries its OWN behaviour as a function of the scratch root. The
// first cut dispatched on `mode.name.includes(...)` to build one of them — a
// branch keyed off a DISPLAY STRING, so renaming a row would silently change
// what it ran, and the row would fall through to the real seam and try to spawn
// an actual `claude` binary. A table whose rows mean different things must say
// so in the table.
const NEGATIVE_MODES = [
  {
    name: 'the engine failed',
    stageDeps: () => ({ runStage: async () => ({ ok: false, reason: 'the engine exited with status 137' }) }),
    expect: /the cold-review stage failed.*status 137/s,
  },
  {
    name: 'the engine exited clean and wrote nothing',
    stageDeps: () => ({ runStage: async () => ({ ok: true }) }),
    expect: /wrote no artifact/,
  },
  {
    name: 'the engine wrote an artifact nothing can read',
    // Present and unreadable: valid JSON in the wrong shape, so the reader
    // REFUSES rather than finding nothing.
    stageDeps: (root) => ({
      runStage: async () => {
        await writeArtifact(root, `\`\`\`${ARTIFACT_TAG}\n{"not":"a findings list"}\n\`\`\`\n`);
        return { ok: true };
      },
    }),
    expect: /could not be read/,
  },
  {
    name: 'the engine has no backend at all',
    routing: { engine: 'no-such-engine-at-all' },
    // NO injection — the REAL seam and the real dispatcher. `null` rather than
    // a function, so the intent is in the data instead of in an absence.
    stageDeps: null,
    expect: /no-such-engine-at-all/,
  },
];

test('C.3: every way the judgment half can fail posts NOTHING and says why', async (t) => {
  const reasons = [];

  for (const mode of NEGATIVE_MODES) {
    const root = scratchRoot(t);
    const config = {
      reviewer: { inferential: { enabled: true } },
      sdd: { map: { [COLD_REVIEW_STAGE]: mode.routing ?? { engine: 'claude', model: 'zz-9' } } },
    };

    const stageDeps = mode.stageDeps?.(root) ?? null;

    const { code, vcs, said } = await runPosting(
      { config, protocol: 'brain-review/2' },
      // The forge probe is stubbed on BOTH arms: a mode that supplies no
      // stageDeps still drives the real seam, and without this it would spawn the
      // machine's `gh` (judgment:cold-2).
      stageDeps
        ? { root, stageDeps: { forgeProbe: LOGGED_OUT, ...stageDeps } }
        : { root, stageDeps: { forgeProbe: LOGGED_OUT } }
    );

    assert.equal(code, 1, `${mode.name}: refuses the run`);
    assert.match(said, mode.expect, `${mode.name}: says why`);

    // THE HALF THIS SECTION EXISTS FOR. A verdict posted here would declare the
    // inferential control applied over findings nobody produced — the
    // uncomputable-evidence APPROVE protocol §10 forbids.
    assert.deepEqual(
      vcs.calls, { prReviewComment: 0, issueComment: 0, labelAdd: 0, labelRemove: 0 },
      `${mode.name}: NOTHING may be written to the PR`
    );

    reasons.push(said);
  }

  // Pairwise distinct. Three failures rendering one message is the fold this
  // ticket keeps finding, and "something went wrong" is not something an
  // operator can act on.
  assert.equal(
    new Set(reasons).size, NEGATIVE_MODES.length,
    'each failure mode must be distinguishable from the others by its message alone'
  );
});

test('C.3: the CONTROL — an engine that ran and found nothing DOES post', async (t) => {
  const root = scratchRoot(t);

  const { code, vcs, lines } = await runPosting(
    {
      config: {
        reviewer: { inferential: { enabled: true } },
        sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'claude', model: 'zz-9' } } },
      },
      protocol: 'brain-review/2',
    },
    {
      root,
      stageDeps: { forgeProbe: LOGGED_OUT,
        runStage: async () => {
          await writeArtifact(root, `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
          return { ok: true };
        },
      },
    }
  );

  // WITHOUT THIS, "refuses on failure" is satisfiable by refusing always. "The
  // reviewer ran and found nothing" is a real answer and must reach the PR —
  // it is the distinction REQ-S3-4 draws one layer down, arriving intact at the
  // layer that posts.
  assert.equal(code, 0, 'finding nothing is not a failure');
  assert.equal(vcs.calls.prReviewComment, 1, 'and the verdict is posted exactly once');
  assert.ok(
    lines.some((l) => /protocol: brain-review\/2/.test(l)),
    'a real verdict, on the wire'
  );
});

test('C.3: a failure refuses BEFORE the verdict is rendered, not after', async (t) => {
  const root = scratchRoot(t);

  const { lines, code } = await runPosting(
    {
      config: {
        reviewer: { inferential: { enabled: true } },
        sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'claude' } } },
      },
      protocol: 'brain-review/2',
    },
    { root, stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => ({ ok: false, reason: 'boom' }) } }
  );

  assert.equal(code, 1);

  // Not merely "did not post" — did not RENDER. A verdict printed to stdout and
  // then withheld is still a verdict a human can copy onto the PR by hand, and
  // it would carry the inferential control it never applied. The refusal has to
  // come before the block exists.
  assert.equal(
    lines.filter((l) => /protocol: brain-review/.test(l)).length, 0,
    'no verdict block may be rendered at all on a failed judgment half'
  );
});

test('#682 cold-6: an sdd.map entry naming no engine refuses OUT LOUD, not as a stack', async () => {
  // Reproduced before the fix: this input REJECTED with a raw
  // `Error: stage-engine: sdd.map["cold-review"] names no engine…` and the
  // injected error channel received NOTHING — no `brain:review:` line at all.
  // `process.exit(await main())` has no outer catch, so the operator got a Node
  // stack and no verdict. Failing closed is not the same as saying why.
  const errs = [];
  const code = await main({
    argv: ['--pr', '42', '--dry-run'], log: () => {}, error: (m) => errs.push(String(m)),
    ...deps({
      config: {
        reviewer: { inferential: { enabled: true } },
        sdd: { map: { 'cold-review': { engine: 42 } } },
      },
      protocol: 'brain-review/2',
    }),
  });

  assert.equal(code, 1, 'a routed stage that cannot be resolved must refuse');
  const named = errs.filter((m) => m.includes('brain:review:'));
  assert.ok(named.length > 0, 'and it must reach the operator on the error channel');
  assert.match(named.join('\n'), /names no engine/, 'naming the key that is wrong, so there is something to fix');
});

test('#829: a malformed sdd.map entry is NOT eaten by the lock — the half-verdict disarms it and the typo surfaces', async (t) => {
  // Round 1 of this PR's own cold review: the catch arm ("malformed counts as
  // would-apply") had no test reaching the LOCK — cold-6 runs --dry-run, which
  // short-circuits antiLoop before the predicate is called. This is the
  // scenario the branch exists for: half-verdict of mine at this head, entry
  // malformed, non-dry-run. The lock must disarm (would-apply), the stage must
  // throw its own wrapped refusal, and the operator must read the typo —
  // never a silent "anti-loop" line over a broken routing.
  const errs = [];
  const d = deps({
    config: {
      reviewer: { inferential: { enabled: true } },
      sdd: { map: { 'cold-review': { engine: 42 } } },
    },
    protocol: 'brain-review/2',
  });
  d.coldBootDeps.fetchReviews = async () => [selfHalfVerdictAtHead()];

  const code = await main({
    argv: ['--pr', '42'],                       // NOT a dry run: the lock is live
    log: () => {}, error: (m) => errs.push(String(m)),
    ...d,
  });

  assert.equal(code, 1, 'a routed stage that cannot be resolved must refuse');
  assert.match(errs.join('\n'), /names no engine/,
    "the operator's error message survives the lock — eating it was the failure mode the catch arm exists to prevent");
});

test('#682 cold-5: maxRounds bounds the PRODUCE loop — the challenger still runs exactly once', async () => {
  // THE RULING, GIVEN AN ORACLE. REQ-682-5 used to say the key bounds
  // "produce→challenge rounds"; the implementation bounds produce only, and the
  // requirement was corrected rather than the code — the bound exists so a run
  // cannot loop, and applyCausalAdmission is a straight-line call, so bounding
  // it at N would buy no safety and pay N challenger costs to challenge the same
  // findings.
  //
  // A prose ruling with nothing reading it is the defect this whole ticket is
  // about, so it is asserted: whoever later "fixes" the mismatch by looping the
  // challenger has to face this test and the reason attached to it.
  let produces = 0;
  let challenges = 0;

  const code = await main({
    argv: ['--pr', '42', '--dry-run'], log: () => {}, error: () => {},
    ...deps({
      config: {
        reviewer: {
          inferential: { enabled: true, challenger: { axis: 'same-model' } },
          convergence: { maxRounds: 4 },
        },
      },
      protocol: 'brain-review/2',
      generate: async ({ round }) => {
        produces += 1;
        // Distinct per round, so the loop cannot converge early and hide the count.
        return [{ id: `R${round}`, severity: 'blocker', evidence: `round ${round}`, cites: 'REQ-A' }];
      },
      refuterRunner: async (blockers) => {
        challenges += 1;
        return { outcomes: blockers.map((f) => ({ id: f.id, outcome: 'inconclusive', rationale: 'x' })) };
      },
    }),
  });

  assert.equal(code, 0);
  assert.equal(produces, 4, 'the bound reaches the produce loop — that is the quantity the key controls');
  assert.equal(
    challenges, 1,
    'and the challenger runs ONCE. Four challenges of the same findings is cost, not safety, and it ' +
    'invites four different answers about one claim'
  );
});


// ── judgment:cold-2 — the run decides BEFORE it pays ──────────────────────

/** This reviewer's own verdict, at this head — what the anti-loop lock refuses to repeat. */
const selfVerdictAtHead = () => ({
  author: 'brain-reviewer',
  body: ['```yaml', 'protocol: brain-review/2', `head_sha: ${HEAD}`, 'verdict: COMMENT', '```'].join('\n'),
});

test('cold-2: a repeat run does NOT spawn the engine — it decides before paying', async (t) => {
  const root = scratchRoot(t);
  let spawned = false;
  const lines = [];
  const d = deps({ config: ROUTED_CFG, protocol: 'brain-review/2' });
  d.coldBootDeps.fetchReviews = async () => [selfVerdictAtHead()];

  const code = await main({
    argv: ['--pr', '42'],                       // NOT a dry run: the lock applies
    log: (s) => lines.push(s), error: () => {},
    ...d,
    root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });

  // The whole finding: `STAGE_TIMEOUT_MS` is ten minutes, and every input the
  // lock reads was already in hand at the spawn site.
  assert.equal(spawned, false, 'a run that will post nothing must not pay for an engine first');
  assert.equal(code, 0, 'declining to repeat itself is a clean outcome, not a failure');
  assert.ok(lines.some((l) => l.includes('anti-loop')), 'and the operator is told which rule fired');
});

/** #829 — this reviewer's own verdict at this head, but with the judgment half
 * NOT applied: the state two half-runs left PR #828 in, where the only way to a
 * full verdict was moving the head with a docs commit. */
const selfHalfVerdictAtHead = () => ({
  author: 'brain-reviewer',
  body: ['```yaml', 'protocol: brain-review/2', `head_sha: ${HEAD}`, 'verdict: APPROVE',
    'controls: ["deterministic"]', 'controls_not_applied: ["inferential"]', '```'].join('\n'),
});

test('#829: a HALF-verdict of mine does not lock out the half it lacks — the engine spawns', async (t) => {
  const root = scratchRoot(t);
  let spawned = false;
  const d = deps({ config: ROUTED_CFG, protocol: 'brain-review/2' });
  d.coldBootDeps.fetchReviews = async () => [selfHalfVerdictAtHead()];

  await main({
    argv: ['--pr', '42'],
    log: () => {}, error: () => {},
    ...d, root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });

  assert.equal(spawned, true,
    'there is NO reasoned output at this head — the lock reading verdict EXISTENCE instead of CONTROLS is the #829 defect');
});

test('cold-2: a DRY RUN still spawns — a rehearsal posts nothing, so there is no loop to break', async (t) => {
  const root = scratchRoot(t);
  let spawned = false;
  const d = deps({ config: ROUTED_CFG, protocol: 'brain-review/2' });
  d.coldBootDeps.fetchReviews = async () => [selfVerdictAtHead()];

  await main({
    argv: ['--pr', '42', '--dry-run'],
    log: () => {}, error: () => {},
    ...d,
    root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });

  // Skipping here would take the rehearsal away from an operator who asked for
  // exactly it — the lock guards the PULL REQUEST, and a dry run never reaches one.
  assert.equal(spawned, true, 'a dry run is a rehearsal, and the lock has nothing to protect');
});

test('cold-2: a FIRST run at this head spawns normally', async (t) => {
  const root = scratchRoot(t);
  let spawned = false;
  const d = deps({ config: ROUTED_CFG, protocol: 'brain-review/2' });
  d.coldBootDeps.fetchReviews = async () => [];       // nothing said yet

  await main({
    argv: ['--pr', '42'],
    log: () => {}, error: () => {},
    ...d,
    root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });
  assert.equal(spawned, true, 'the guard must not swallow the run it exists to make cheap');
});

test('cold-2: ANOTHER reviewer\'s verdict at this head does not suppress the run', async (t) => {
  const root = scratchRoot(t);
  let spawned = false;
  const d = deps({ config: ROUTED_CFG, protocol: 'brain-review/2' });
  d.coldBootDeps.fetchReviews = async () => [{ ...selfVerdictAtHead(), author: 'someone-else' }];

  await main({
    argv: ['--pr', '42'],
    log: () => {}, error: () => {},
    ...d,
    root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });
  // Going silent because someone ELSE spoke would be the reviewer refusing the
  // conversation the lock exists to permit.
  assert.equal(spawned, true);
});


// ── judgment:cold-3 — the measured round count reaches a reader ────────────

test('cold-3: the run REPORTS how many produce rounds actually ran', async (t) => {
  // Before this, `rounds` was computed, declared in the @returns shape, and read
  // by nothing outside the tests — the same shape as `shouldRun`'s missing
  // production caller, in the value this slice's own bound produces.
  const { lines } = await run({ config: CFG(), generate: async () => reasoned() });
  assert.ok(
    lines.some((l) => /converged in \d+ produce round\(s\)/.test(l)),
    'a number the run measures and throws away is not a measurement anyone has'
  );
});

test('cold-3: a bound HIGHER than the rounds that ran says so, rather than leaving a subtraction', async (t) => {
  // convergence.mjs's whole argument for keeping the key is that an operator
  // setting 5 "should know that from here rather than from a bill". *Here* was a
  // source comment, which is not a place a run reports to.
  const cfg = {
    reviewer: { inferential: { enabled: true }, convergence: { maxRounds: 5 } },
  };
  const { lines } = await run({ config: cfg, generate: async () => reasoned() });
  const notice = lines.find((l) => l.includes('maxRounds is 5'));
  assert.ok(notice, 'the operator configured 5 and must be told what they actually got');
  assert.match(notice, /converged early|round\(s\) ran/);
});

test('cold-3: a bound EQUAL to the rounds that ran does not nag', async (t) => {
  const cfg = { reviewer: { inferential: { enabled: true }, convergence: { maxRounds: 1 } } };
  const { lines } = await run({ config: cfg, generate: async () => reasoned() });
  assert.equal(
    lines.filter((l) => l.includes('maxRounds is')).length, 0,
    'nothing was over-configured, so there is nothing to report'
  );
});


// ── judgment:cold-2 (third cold review) — the key validates when it is WRITTEN ──

test('cold-2: an UNROUTED repo still refuses a bad stageTimeoutMs', async (t) => {
  // The measured defect: `reviewer.stageTimeoutMs = 'nonsense'` with no sdd.map
  // entry exited 0 with no refusal, while `reviewer.convergence.maxRounds = '3'`
  // in the same shape exited 1 and named the key — because judgment:cold-6 moved
  // THAT resolution up into main() and this one was left behind. The refusal
  // must arrive on the day someone writes the key, not on the day someone
  // finally routes the stage.
  const errs = [];
  const code = await main({
    argv: ['--pr', '42'],
    log: () => {}, error: (s) => errs.push(s),
    ...deps({ config: { reviewer: { inferential: { enabled: true }, stageTimeoutMs: 'nonsense' } },
              protocol: 'brain-review/2' }),
    root: scratchRoot(t),
  });
  assert.equal(code, 1);
  assert.ok(errs.some((e) => e.includes('stageTimeoutMs')), 'the refusal must name the key to edit');
});

test('cold-2: the refusal happens BEFORE the stage is ever spawned', async (t) => {
  let spawned = false;
  await main({
    argv: ['--pr', '42'],
    log: () => {}, error: () => {},
    ...deps({ config: { ...ROUTED_CFG, reviewer: { ...ROUTED_CFG.reviewer, stageTimeoutMs: 12.5 } },
              protocol: 'brain-review/2' }),
    root: scratchRoot(t),
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });
  assert.equal(spawned, false, 'every precondition refuses before any mutation');
});

test('cold-2: a valid ceiling reaches the stage from main()', async (t) => {
  let seen = null;
  await main({
    argv: ['--pr', '42'],
    log: () => {}, error: () => {},
    ...deps({ config: { ...ROUTED_CFG, reviewer: { ...ROUTED_CFG.reviewer, stageTimeoutMs: 2_400_000 } },
              protocol: 'brain-review/2' }),
    root: scratchRoot(t),
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async (a) => { seen = a.timeoutMs; return { ok: true }; } },
  });
  assert.equal(seen, 2_400_000);
});

// ── judgment:cold-3 — the anti-loop guard skips the SPAWN, not the run ────

test('cold-3: a repeat run still renders its verdict — the output does not depend on the judgment key', async (t) => {
  // MEASURED as the defect: with the half ENABLED stdout was one line; with it
  // DISABLED it was the whole rendered block. Same anti-loop rule, two different
  // operator-facing outputs, keyed on something unrelated to the lock. The
  // verdict body is the only place a non-posting run reports what it found.
  const root = scratchRoot(t);
  let spawned = false;
  const d = deps({ config: ROUTED_CFG, protocol: 'brain-review/2' });
  d.coldBootDeps.fetchReviews = async () => [selfVerdictAtHead()];

  const lines = [];
  const code = await main({
    argv: ['--pr', '42'],
    log: (s) => lines.push(s), error: () => {},
    ...d, root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });

  assert.equal(spawned, false, 'the engine is still skipped — that half was right');
  assert.equal(code, 0);
  const body = lines.join('\n');
  assert.match(body, /protocol: brain-review\/2/, 'the verdict body must still be rendered');
  assert.match(body, /anti-loop/, 'and the rule that fired must still be named');
});

test('cold-3: the skipped judgment half is named as its OWN condition', async (t) => {
  // Never folded into "no transport is configured": that would tell an operator
  // who configured an engine that they did not.
  const root = scratchRoot(t);
  const d = deps({ config: ROUTED_CFG, protocol: 'brain-review/2' });
  d.coldBootDeps.fetchReviews = async () => [selfVerdictAtHead()];

  const lines = [];
  await main({
    argv: ['--pr', '42'], log: (s) => lines.push(s), error: () => {},
    ...d, root,
    stageDeps: { forgeProbe: LOGGED_OUT, runStage: async () => ({ ok: true }) },
  });
  const body = lines.join('\n');
  assert.match(body, /the judgment half was not run/);
  assert.doesNotMatch(body, /no transport is configured/);
});
