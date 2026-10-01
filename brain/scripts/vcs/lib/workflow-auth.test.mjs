// workflow-auth.test.mjs — #480's acceptance suite: the ten shapes that defeated
// (or falsely tripped) the guard from PR #476.
//
// The ticket names them A1–A10 and states the bar directly: A1–A7 must be CAUGHT,
// A9 must NOT be flagged. They are driven here as one table rather than ten prose
// tests, because the property under test is "no spelling of a command changes the
// answer" — and a table is the only shape in which adding the eleventh spelling is
// a one-line change instead of a new test nobody writes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync, symlinkSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { auditWorkflowAuth, stepBlocks, parseSubcommandManifest } from './workflow-auth.mjs';

// brain/scripts/vcs/lib → the repository root is FOUR levels up, not three. Three
// lands on `brain/`, where no entry point resolves, and every fixture then reports
// "unresolvable" — a suite that would have looked like a working guard flagging
// everything, rather than a broken path.
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const audit = (yaml) => auditWorkflowAuth(yaml, { file: 'probe', repoRoot: REPO_ROOT });

/** A compliant workflow with one extra step spliced in — so every fixture differs
 *  from the last ONLY in the shape under test. */
const wrap = (step) => [
  'permissions: { contents: write, pull-requests: read }',
  'jobs:',
  '  g:',
  '    steps:',
  '      - name: benign',
  '        run: echo hi',
  step,
].join('\n');

// The ten shapes, verbatim from #480's attack matrix.
const SHAPES = [
  ['A1', 'folded scalar (run: >), no credential', true,
    '      - name: evil\n        run: >\n          node brain/scripts/brain-audit.mjs "a..b"'],
  ['A2', 'single-line run:, no credential', true,
    '      - name: evil\n        run: node brain/scripts/brain-audit.mjs "a..b"'],
  ['A3', 'step whose FIRST key is run: (no id/name/uses)', true,
    '      - run: node brain/scripts/brain-audit.mjs "a..b"'],
  ['A4', 'a gh verb outside (api|issue|label|pr|auth)', true,
    '      - name: evil\n        run: gh release list'],
  ['A5', 'the audit reached through npm run', true,
    '      - name: evil\n        run: npm run brain:audit -- "a..b"'],
  ['A6', 'the path spelled .MJS', true,
    '      - name: evil\n        run: node ./brain/scripts/brain-audit.MJS "a..b"'],
  ['A7', 'the binary reached through a shell variable', true,
    '      - name: evil\n        run: |\n          GH=gh\n          "$GH" api repos/o/r/pulls/1'],
  ['A8', 'env: present but EMPTY', true,
    '      - name: evil\n        env:\n        run: node brain/scripts/brain-audit.mjs "a..b"'],
  ['A9', 'the credential from secrets.GITHUB_TOKEN — legitimate, must NOT flag', false,
    '      - name: fine\n        env:\n          VCS_TOKEN: ${{ secrets.GITHUB_TOKEN }}\n        run: node brain/scripts/brain-audit.mjs "a..b"'],
  ['A10', 'the credential named only inside a comment', true,
    '      - name: evil\n        # VCS_TOKEN: ${{ github.token }}\n        run: node brain/scripts/brain-audit.mjs "a..b"'],
];

for (const [id, why, mustFlag, step] of SHAPES) {
  test(`#480 ${id}: ${why}`, () => {
    const v = audit(wrap(step));
    assert.equal(v.length > 0, mustFlag, `${id} — violations were:\n${v.join('\n') || '(none)'}`);
  });
}

test('#480: the ten shapes as ONE property — no spelling changes the answer', () => {
  // The per-shape tests above locate a regression; this one states the invariant.
  // A guard that passes nine and fails one is still defeated, and a summary
  // assertion is what makes that visible as a single red line.
  const escapes = SHAPES
    .filter(([, , mustFlag, step]) => (audit(wrap(step)).length > 0) !== mustFlag)
    .map(([id]) => id);
  assert.deepEqual(escapes, []);
});

// ── the false-positive class the previous guard created ─────────────────────

test('#480: the credential is matched by KEY, never by the expression that fills it', () => {
  // PR #476 pinned `${{ github.token }}` literally, which rejected
  // `${{ secrets.GITHUB_TOKEN }}` — the literal remediation text of #467 — and would
  // reject a PAT or a GitHub App token. Every one of these is a real credential.
  for (const expr of ['${{ github.token }}', '${{ secrets.GITHUB_TOKEN }}', '${{ secrets.BRAIN_PAT }}', '${{ steps.app.outputs.token }}']) {
    const y = wrap(`      - name: fine\n        env:\n          VCS_TOKEN: ${expr}\n        run: node brain/scripts/brain-audit.mjs "a..b"`);
    assert.deepEqual(audit(y), [], `${expr} is a credential and must not be flagged`);
  }
});

test('#480: a style-only key reorder does not change the verdict', () => {
  // `- name: … / id: …` and `- id: … / name: …` are identical YAML. The previous
  // guard's named pin missed the second, so a formatting change broke the check.
  const a = wrap('      - name: evil\n        id: audit\n        run: node brain/scripts/brain-audit.mjs "a..b"');
  const b = wrap('      - id: audit\n        name: evil\n        run: node brain/scripts/brain-audit.mjs "a..b"');
  assert.deepEqual(audit(a).length, audit(b).length);
  assert.ok(audit(a).length > 0, 'both orderings must be caught, not both missed');
});

test('#480: a job-level or workflow-level env: is NOT claimed to be impossible', () => {
  // The old guard's rationale asserted "GitHub Actions does not inherit a token into
  // a step". It does — #476's own harness disproved it. The consequence was worse
  // than a wrong comment: a maintainer consolidating four duplicated bindings into
  // one job-level env: got a working workflow and a red guard.
  //
  // This guard reads the step block, so an inherited credential is not visible to
  // it. That is a KNOWN limitation and it is asserted here rather than denied, so
  // the next reader learns the truth from the test instead of the fiction from a
  // comment. Consolidating to job level is a real refactor this guard would flag —
  // and the honest response is to widen the guard, not to tell people it cannot be
  // done.
  const jobLevel = [
    'permissions: { contents: write, pull-requests: read }',
    'jobs:',
    '  g:',
    '    env:',
    '      VCS_TOKEN: ${{ github.token }}',
    '    steps:',
    '      - name: audit',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.ok(audit(jobLevel).length > 0,
    'the step-scoped read cannot see a job-level env: — recorded as a limitation, not denied');
});

test('#535: the same job-level limitation extends to PR_NUMBER — a job-level PR_NUMBER is invisible to this guard (known limitation, not denied, D6)', () => {
  // The PR_NUMBER rule (Requirement 5) reads step-scoped `env:` the same way
  // the credential read does — so a job-level PR_NUMBER is exactly as
  // invisible as a job-level VCS_TOKEN above. This is a genuine MISS (an
  // under-approximation, the one direction #480's over-reading discipline does
  // not cover), named here rather than denied.
  const jobLevel = [
    'permissions: { contents: write, pull-requests: read }',
    'jobs:',
    '  g:',
    '    env:',
    '      PR_NUMBER: ${{ github.event.pull_request.number }}',
    '    steps:',
    '      - name: phase-order',
    '        env:',
    '          BASE_SHA: ${{ github.event.pull_request.base.sha }}',
    '          HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
    '          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}',
    '        run: node brain/scripts/vcs/phase-order-check.mjs',
  ].join('\n');
  assert.deepEqual(audit(jobLevel), [],
    'the step-scoped read cannot see a job-level PR_NUMBER — a real miss, recorded as a limitation, not denied');
});

// ── the polarity: undecidable is a violation ────────────────────────────────

test('#480: an entry point that cannot be resolved is a VIOLATION, not an empty answer', () => {
  // The defect class in one line: a checker that returns "nothing to report" for
  // input it could not read turns its own blindness into the gate's approval.
  const unknownVerb = wrap('      - name: evil\n        run: npm run this-verb-does-not-exist');
  assert.match(audit(unknownVerb).join('\n'), /cannot resolve|undecidable/);

  const missingScript = wrap('      - name: evil\n        run: node brain/scripts/does-not-exist.mjs');
  assert.match(audit(missingScript).join('\n'), /cannot resolve|undecidable/);
});

test('#480: an unrecognised binary is treated as reaching the server', () => {
  // The inert list is a SAFE-side list: absence from it costs a false alarm, never
  // a miss. `curl` is the obvious next escape and is not enumerated anywhere.
  const y = wrap('      - name: evil\n        run: curl -s https://api.github.com/repos/o/r/pulls/1');
  assert.ok(audit(y).length > 0, 'a command the guard does not recognise must not read as safe');
});

test('#480: a SHELL COMMENT mentioning gh does not require a credential', () => {
  // The mirror of A10, and the half that comment-stripping actually defends. A10 is
  // caught by anchoring the credential read, not by stripping; stripping earns its
  // place here, where a `# we used to shell out to gh` line in an otherwise inert
  // step would otherwise demand a token for nothing.
  //
  // These workflows are heavily commented, so this is the realistic shape — and a
  // guard that flags a comment is a guard that trains people to ignore it.
  const y = wrap([
    '      - name: fine',
    '        run: |',
    '          set -euo pipefail',
    '          # this used to call gh api repos/o/r/pulls/1 — now it is pure git',
    '          git rev-parse HEAD',
  ].join('\n'));
  assert.deepEqual(audit(y), []);
});

test('#480: a genuinely inert step is NOT flagged — the guard must be usable', () => {
  // The counterweight to the rule above. A guard that flags `git config` is a guard
  // that gets switched off, and then none of this matters.
  const y = wrap('      - name: fine\n        run: |\n          set -euo pipefail\n          git config user.name "x"\n          echo done');
  assert.deepEqual(audit(y), []);
});

// ── the scope condition, which a token alone does not satisfy ───────────────

test('#480/#475: a perfectly-formed credential under a narrow permissions block is a violation', () => {
  const y = [
    'permissions: { contents: write }',
    'jobs:', '  g:', '    steps:',
    '      - name: audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.match(audit(y).join('\n'), /every omitted scope/);
});

test('#480: with NO permissions block the scope rule stays silent', () => {
  // The default token already carries read scope, so demanding the line there is
  // noise — and noise is how a guard stops being read.
  const y = [
    'jobs:', '  g:', '    steps:',
    '      - name: audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.deepEqual(audit(y), []);
});

// ── it covers EVERY workflow that runs the audit, not one of them ───────────

test('#480: both audit workflows are compliant, and both are actually checked', () => {
  const files = [
    '.github/workflows/governance-postmerge.yml',
    '.github/workflows/release.yml',
  ];
  for (const f of files) {
    const text = readFileSync(resolve(REPO_ROOT, f), 'utf8');
    assert.ok(/brain-audit\.mjs/.test(text), `${f} must still be a workflow this guard is responsible for`);
    assert.deepEqual(auditWorkflowAuth(text, { file: f, repoRoot: REPO_ROOT }), []);
  }
});

test('#480: removing the credential from EITHER shipped workflow is caught', () => {
  // Teeth against the real files, not only synthetic ones — the previous guard
  // looked at one workflow and so did not defend the other consumer of the thing it
  // was defending.
  for (const f of ['.github/workflows/governance-postmerge.yml', '.github/workflows/release.yml']) {
    const text = readFileSync(resolve(REPO_ROOT, f), 'utf8');
    const broken = text.replace(/^(\s*)VCS_TOKEN:.*$/m, '$1PLACEHOLDER: x');
    assert.notEqual(broken, text, `the mutation must land in ${f}`);
    assert.ok(auditWorkflowAuth(broken, { file: f, repoRoot: REPO_ROOT }).length > 0, f);
  }
});

// ── the step splitter, driven directly ──────────────────────────────────────

test('#480 A3 at the splitter: a step whose first key is run: is its own step', () => {
  // The worst of the seven: unrecognised as a boundary, it was absorbed into the
  // previous step's block and INHERITED that step's credential for guard purposes.
  const y = [
    '    steps:',
    '      - name: authorised',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: echo one',
    '      - run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  const blocks = stepBlocks(y);
  assert.equal(blocks.length, 2, 'two steps, not one absorbing the other');
  assert.ok(!/VCS_TOKEN/.test(blocks[1]), 'the second step must not inherit the first step\'s credential');
});

// ═══════════════════════════════════════════════════════════════════════════
// issue #535 — per-invocation resolution: a multiplexer's subcommands can
// resolve to DIFFERENT requirements, and PR_NUMBER presence governs the
// ci-context.mjs bootstrap edge.
// ═══════════════════════════════════════════════════════════════════════════

// ── T2 (Requirement 3/5) ────────────────────────────────────────────────────

// #1024 (D9): memory-gate's manifest entry flips to `true` (SUBCOMMAND_PORT_
// REACH['memory-gate']) — its skip:memory-gate applier read genuinely
// reaches getVcs, same as issue-link/base-branch, so it is now flagged for a
// missing VCS_TOKEN UNCONDITIONALLY (directPort, Requirement 3), same as
// diff-size's OWN probe below is flagged via the asymmetric contextPort+
// PR_NUMBER rule. `decision-gate` is the remaining `false`-manifest
// subcommand and replaces memory-gate as this fixture's "contextPort-only,
// PR_NUMBER governs whether it is flagged" probe (Requirement 5).
const fixtureT2 = (decisionGateHasPrNumber) => [
  'permissions: { contents: write, pull-requests: read }',
  'jobs:',
  '  g:',
  '    steps:',
  '      - name: diff-size',
  '        env:',
  '          PR_NUMBER: ${{ github.event.pull_request.number }}',
  '        run: node brain/scripts/governance/run-check.mjs diff-size',
  '      - name: decision-gate',
  ...(decisionGateHasPrNumber
    ? ['        env:', '          PR_NUMBER: ${{ github.event.pull_request.number }}']
    : []),
  '        run: node brain/scripts/governance/run-check.mjs decision-gate',
].join('\n');

test('T2: diff-size (+PR_NUMBER, no credential) is flagged; decision-gate (no PR_NUMBER) yields zero violations', () => {
  const v = audit(fixtureT2(false));
  assert.ok(v.some(m => /diff-size/.test(m) && /VCS_TOKEN/.test(m)), `diff-size must be flagged:\n${v.join('\n')}`);
  assert.ok(!v.some(m => /decision-gate/.test(m)), `decision-gate must NOT be flagged:\n${v.join('\n')}`);
});

test('T2 mutation: adding PR_NUMBER to the decision-gate step now flags it too — the rule is live, not vacuous, in both directions', () => {
  const v = audit(fixtureT2(true));
  assert.ok(v.some(m => /decision-gate/.test(m) && /VCS_TOKEN/.test(m)), `decision-gate with PR_NUMBER must now be flagged:\n${v.join('\n')}`);
});

test('#1024 (D9): memory-gate (no PR_NUMBER, no VCS_TOKEN) IS now flagged — directPort, unconditional (mirrors issue-link/base-branch)', () => {
  const fixture = [
    'permissions: { contents: write, pull-requests: read }',
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: memory-gate',
    '        run: node brain/scripts/governance/run-check.mjs memory-gate',
  ].join('\n');
  const v = audit(fixture);
  assert.ok(v.some(m => /memory-gate/.test(m) && /VCS_TOKEN/.test(m)),
    `memory-gate must be flagged even without PR_NUMBER — its manifest entry is now true:\n${v.join('\n')}`);
});

// ── T3 (Requirement 4) ──────────────────────────────────────────────────────

test('T3: an unknown run-check.mjs subcommand is a violation, with the correct message', () => {
  const y = wrap('      - name: evil\n        run: node brain/scripts/governance/run-check.mjs frobnicate');
  assert.match(audit(y).join('\n'), /cannot resolve|undecidable/);
});

test('T3: a run-check.mjs invocation missing its subcommand argument is also a violation, with the same message', () => {
  const y = wrap('      - name: evil\n        run: node brain/scripts/governance/run-check.mjs');
  assert.match(audit(y).join('\n'), /cannot resolve|undecidable/);
});

test('T3 mutation: the unknown subcommand is STILL flagged even with VCS_TOKEN declared — unresolvable is not curable by producing a credential', () => {
  const y = wrap([
    '      - name: evil',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/governance/run-check.mjs frobnicate',
  ].join('\n'));
  assert.match(audit(y).join('\n'), /cannot resolve|undecidable/);
});

// ── T4 (Requirement 3/6, D8) ─────────────────────────────────────────────────

test('T4: parseSubcommandManifest — empty source is null; the real run-check.mjs source yields exactly its 5 keys', () => {
  assert.equal(parseSubcommandManifest(''), null);
  const src = readFileSync(resolve(REPO_ROOT, 'brain/scripts/governance/run-check.mjs'), 'utf8');
  const manifest = parseSubcommandManifest(src);
  // #967 PR C — base-branch joins the manifest, required at every tier (ruling 1).
  assert.deepEqual(Object.keys(manifest).sort(), ['base-branch', 'decision-gate', 'diff-size', 'issue-link', 'memory-gate']);
});

test('T4 mutation: renaming the SUBCOMMAND_PORT_REACH const makes the manifest unreadable (null), not zero-requirement', () => {
  const src = readFileSync(resolve(REPO_ROOT, 'brain/scripts/governance/run-check.mjs'), 'utf8');
  const mutated = src.replace('SUBCOMMAND_PORT_REACH = {', 'RENAMED_MANIFEST = {');
  assert.notEqual(mutated, src, 'the mutation must land');
  assert.equal(parseSubcommandManifest(mutated), null);
});

test('T4 mutation via the caller: a manifest-less multiplexer whose closure reaches cli.mjs is never silently treated as "no requirement"', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'wfauth-t4-'));
  try {
    mkdirSync(join(tmp, 'scripts'), { recursive: true });
    mkdirSync(join(tmp, 'vcs'), { recursive: true });
    writeFileSync(join(tmp, 'vcs', 'cli.mjs'), 'export function getVcs() {}\n');
    writeFileSync(
      join(tmp, 'scripts', 'multiplexer.mjs'),
      "import { getVcs } from '../vcs/cli.mjs';\n// no SUBCOMMAND_PORT_REACH here — not recognized as a multiplexer\n"
    );
    const y = [
      'jobs:', '  g:', '    steps:',
      '      - name: whatever',
      '        run: node scripts/multiplexer.mjs some-subcommand',
    ].join('\n');
    const v = auditWorkflowAuth(y, { file: 'probe', repoRoot: tmp });
    assert.ok(v.length > 0,
      'a manifest-less multiplexer whose whole-file closure reaches the port must still be flagged (D2 safe fallback), never read as no requirement');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

// ── T5 (Requirement 2/6, D1/D7) ──────────────────────────────────────────────

test('T5: a phase-order-check.mjs step with no credential and no PR_NUMBER is credential-free', () => {
  const y = [
    'permissions: { contents: write, pull-requests: read }',
    'jobs:', '  g:', '    steps:',
    '      - name: phase-order',
    '        env:',
    '          BASE_SHA: ${{ github.event.pull_request.base.sha }}',
    '          HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
    '          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}',
    '        run: node brain/scripts/vcs/phase-order-check.mjs',
  ].join('\n');
  assert.deepEqual(audit(y), []);
});

// ── T10 (D9) — block-style `permissions:` was silently unevaluated ─────────
//
// governance.yml:16-19 is block style (`permissions:\n  contents: read\n...`),
// not flow style (`permissions: { ... }`). The scope regex only recognized
// flow style, so condition 2 of the #479/#475 rule (a credential under a
// permissions block that omits pull-requests) was silently NOT EVALUATED for
// governance.yml — a guard claiming coverage it lacked, the exact #480
// defect class this issue removes.

test('T10: block-style permissions without pull-requests is a violation, even with VCS_TOKEN declared', () => {
  const y = [
    'permissions:',
    '  contents: read',
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.match(audit(y).join('\n'), /every omitted scope/);
});

test('T10 mutation: adding pull-requests: read to the block-style permissions clears the violation', () => {
  const y = [
    'permissions:',
    '  contents: read',
    '  pull-requests: read',
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.deepEqual(audit(y), []);
});

// ── T11 (issue #535 fix) — a comment inside a block-style `permissions:` ────
//
// governance.yml's own style puts explanatory comments inside blocks (its
// `env:` blocks, lines 52-53/55-56/60-61). Before the fix, the block scan
// `break`s on the first line that is not blank and not a `key: value` scope
// line — a comment qualifies, so it either empties `scopeLines` entirely
// (returning `null`, silently skipping the whole rule) or truncates the
// block before a later compliant key is read.

test('T11: a comment as the FIRST line under a block-style permissions: that lacks pull-requests is still flagged, not silently skipped', () => {
  const y = [
    'permissions:',
    '  # only read what we need',
    '  contents: read',
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.match(audit(y).join('\n'), /every omitted scope/);
});

test('T11: a comment BETWEEN scope keys does not truncate the block — pull-requests after the comment still counts as declared', () => {
  const y = [
    'permissions:',
    '  contents: read',
    '  # PR read access for the gate',
    '  pull-requests: read',
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.deepEqual(audit(y), []);
});

// ── T12 (issue #535 WARNING 4) — a `permissions:` header present but parsed
// to ZERO scope lines must still fire the pull-requests check ────────────
//
// permissionsScopes() used to collapse "header present, no scope lines" into
// the SAME `null` as "no permissions: key at all" — the caller treats `null`
// as the intentionally-silent default-token case and skips the check. But an
// explicit empty grant (a block containing only comments, or flow-style
// `permissions: {}`) sets EVERY scope to `none` in Actions semantics — the
// most restrictive case, and the one that most needs the check to fire.

test('T12: a block-style permissions: header containing ONLY comments (zero scope lines) is still flagged, not silently skipped like "no header at all"', () => {
  const y = [
    'permissions:',
    '  # nothing granted here on purpose',
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.match(audit(y).join('\n'), /every omitted scope/);
});

test('T12: flow-style permissions: {} (explicit empty grant) is still flagged', () => {
  const y = [
    'permissions: {}',
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.match(audit(y).join('\n'), /every omitted scope/);
});

test('T12: no permissions: key at all is still the intentionally-silent default-token case (regression — must stay unflagged)', () => {
  const y = [
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.deepEqual(audit(y), []);
});

test('T5 mutation: the same step WITH PR_NUMBER added is flagged — the pruning and the PR_NUMBER conditional both proven', () => {
  const y = [
    'permissions: { contents: write, pull-requests: read }',
    'jobs:', '  g:', '    steps:',
    '      - name: phase-order',
    '        env:',
    '          PR_NUMBER: ${{ github.event.pull_request.number }}',
    '          BASE_SHA: ${{ github.event.pull_request.base.sha }}',
    '          HEAD_SHA: ${{ github.event.pull_request.head.sha }}',
    '          DEFAULT_BRANCH: ${{ github.event.repository.default_branch }}',
    '        run: node brain/scripts/vcs/phase-order-check.mjs',
  ].join('\n');
  assert.ok(audit(y).length > 0, 'adding PR_NUMBER must flag the step — it now reaches the port via the ci-context bootstrap');
});

// ── W1/W2 (issue #535 verify-report remediation) ─────────────────────────────
//
// W1: diff-size's manifest value (`false`) had zero mutation coverage — the
// real governance.yml step always declares PR_NUMBER, so the PR_NUMBER branch
// alone already demands VCS_TOKEN, masking the manifest value. This pins the
// manifest value itself, isolated from PR_NUMBER.
// W2: a corrupt/unreadable manifest does not resolve to the literal
// "unresolvable" message (spec Requirement 4c, amended) — it falls back to
// the D2 whole-file rule, which for run-check.mjs (imports getVcs directly)
// still fails closed. This pins that safety direction against silent drift.

// Mirrors real brain/scripts into a tmp dir (siblings symlinked, so
// run-check.mjs's whole-file closure fallback can genuinely reach the real
// vcs/cli.mjs), with only governance/run-check.mjs replaced by mutated
// content — real production files are never written to.
function withMutatedRunCheck(mutate, fn) {
  const scriptsDir = resolve(REPO_ROOT, 'brain/scripts');
  const src = readFileSync(join(scriptsDir, 'governance', 'run-check.mjs'), 'utf8');
  const mutated = mutate(src);
  assert.notEqual(mutated, src, 'the mutation must land');
  const tmp = mkdtempSync(join(tmpdir(), 'wfauth-mut-'));
  try {
    const tmpScripts = join(tmp, 'brain', 'scripts');
    const tmpGov = join(tmpScripts, 'governance');
    mkdirSync(tmpGov, { recursive: true });
    for (const name of readdirSync(scriptsDir)) {
      if (name !== 'governance') symlinkSync(resolve(scriptsDir, name), join(tmpScripts, name));
    }
    for (const name of readdirSync(join(scriptsDir, 'governance'))) {
      if (name !== 'run-check.mjs') symlinkSync(resolve(scriptsDir, 'governance', name), join(tmpGov, name));
    }
    writeFileSync(join(tmpGov, 'run-check.mjs'), mutated);
    fn(tmp);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const fixtureW1 = () => [
  'permissions: { contents: write, pull-requests: read }',
  'jobs:', '  g:', '    steps:',
  '      - name: diff-size',
  '        run: node brain/scripts/governance/run-check.mjs diff-size',
].join('\n');

test('W1: diff-size without PR_NUMBER and without credential is credential-free — pins the manifest value, isolated from the PR_NUMBER bootstrap edge', () => {
  assert.deepEqual(audit(fixtureW1()), []);
});

test('W1 mutation: flipping diff-size to true in the manifest flags the same step — the manifest value has real teeth', () => {
  withMutatedRunCheck(
    src => src.replace("'diff-size': false,", "'diff-size': true,"),
    tmp => {
      const v = auditWorkflowAuth(fixtureW1(), { file: 'probe', repoRoot: tmp });
      assert.ok(v.some(m => /diff-size/.test(m) && /VCS_TOKEN/.test(m)),
        `flipping diff-size to true must flag the credential-free step:\n${v.join('\n')}`);
    }
  );
});

test('W2: a corrupt manifest still fails closed via the D2 whole-file fallback — memory-gate (credential-free today) gets flagged, never silently passed', () => {
  withMutatedRunCheck(
    src => src.replace('SUBCOMMAND_PORT_REACH = {', 'CORRUPTED_MANIFEST = {'),
    tmp => {
      const y = [
        'permissions: { contents: write, pull-requests: read }',
        'jobs:', '  g:', '    steps:',
        '      - name: memory-gate',
        '        run: node brain/scripts/governance/run-check.mjs memory-gate',
      ].join('\n');
      const v = auditWorkflowAuth(y, { file: 'probe', repoRoot: tmp });
      assert.ok(v.length > 0,
        'a corrupt manifest must fail closed, never silently pass a step it can no longer resolve');
    }
  );
});

// ── #1162: a subcommand followed by `)` (command substitution) still resolves ──
// `win_out="$(node …/cursor.mjs window)"` is the ordinary spelling; the token
// used to be read as `window)`, an unknown subcommand, so the step was
// undecidable. cursor.mjs is a multiplexer: `window`/`accept` touch git only,
// `bootstrap` reaches the port (prior-run evidence).

test('#1162: `$(node cursor.mjs window)` resolves as the git-only subcommand — no credential needed', () => {
  const y = wrap('      - name: w\n        run: |\n          out="$(node brain/scripts/governance/postmerge/cursor.mjs window)"');
  assert.deepEqual(audit(y), []);
});

test('#1162: `$(node cursor.mjs bootstrap …)` reaches the port — flagged without VCS_TOKEN, clean with it', () => {
  const run = '        run: |\n          out="$(node brain/scripts/governance/postmerge/cursor.mjs bootstrap wf.yml --branch main)"';
  assert.ok(audit(wrap(`      - name: b\n${run}`)).some(m => /VCS_TOKEN/.test(m)));
  assert.deepEqual(audit(wrap(`      - name: b\n        env:\n          VCS_TOKEN: \${{ github.token }}\n${run}`)), []);
});
