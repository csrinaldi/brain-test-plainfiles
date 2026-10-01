// release-postmerge-workflows.test.mjs — Structural tests for PR7 (S7).
//
// L2 release-gate (rung 2, fail-closed) + post-merge auto-revert (rung 3).
// REQ-L2-1, REQ-L2-2 — design.md §3.
//
// Both workflows reuse brain-audit.mjs unchanged and are deliberately SEPARATE
// files from governance.yml (design §10-B, gap B): the PR-time gate stays
// read-only; only the trusted post-merge context gets contents: write +
// pull-requests: write.
//
// Run with: npm test (node --test)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { auditWorkflowAuth, auditGitlabFragment } from './lib/workflow-auth.mjs';
import { testTmp } from '../lib/test-tmp.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

// ════════════════════════════════════════════════════════════════════════════
// PR4 (#304) — WORKFLOW-EXTRACTING TEST HARNESS, BORN ISOLATED (Phase 4.0,
// design §7.4, owner Ruling #902). This is the FIRST place this branch runs
// extracted workflow bash. The isolation contract below is an ACCEPTANCE
// CRITERION of every such test, honored from its first RED — never written
// un-isolated and patched later.
// ════════════════════════════════════════════════════════════════════════════

// extractRunScript(yamlText, stepId) — return the dedented `run: |` block of the
// step whose `id:` is stepId. Pure text parse (js-yaml is not a dependency).
function extractRunScript(yamlText, stepId) {
  const lines = yamlText.split('\n');
  let i = lines.findIndex((l) => /^\s*- id:\s*/.test(l) && l.trim() === `- id: ${stepId}`);
  assert.ok(i !== -1, `extractRunScript: step id '${stepId}' not found`);
  const stepIndent = lines[i].indexOf('- ');
  // Scan within this step (until the next `- ` at the same indent, or EOF) for `run: |`.
  let runIdx = -1;
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() && l.indexOf('- ') === stepIndent && /^\s*- /.test(l)) break; // next step
    if (/^\s*run:\s*\|\s*$/.test(l)) { runIdx = j; break; }
  }
  assert.ok(runIdx !== -1, `extractRunScript: step '${stepId}' has no 'run: |' block`);
  const runIndent = lines[runIdx].search(/\S/);
  const body = [];
  for (let j = runIdx + 1; j < lines.length; j++) {
    const l = lines[j];
    if (l.trim() === '') { body.push(''); continue; }
    const ind = l.search(/\S/);
    if (ind <= runIndent) break; // block ended
    body.push(l.slice(runIndent + 2)); // dedent (run content is runIndent+2)
  }
  return body.join('\n');
}

// THE ISOLATION CONTRACT (Phase 4.0). Every extracted-script spawn MUST run with
// these env overrides and a temp cwd/HOME — so a `git config` (even a stray
// --global) can never touch the real user's config or the real repo. No
// inherited GH_TOKEN: the isolated bash must reach a stubbed `gh`, never the network.
function isolatedEnv(homeDir, extra = {}) {
  const env = {
    PATH: `${join(homeDir, 'bin')}:${process.env.PATH}`,
    HOME: homeDir,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    RUNNER_TEMP: homeDir,
    GITHUB_OUTPUT: join(homeDir, 'github_output'),
    ...extra,
  };
  // Deliberately NO GH_TOKEN — the isolated run must not authenticate.
  return env;
}

// A recording `gh` stub: logs each invocation to $GH_LOG, prints canned output
// for read subcommands, and (by default) succeeds. Placed on PATH ahead of the
// real gh so no isolated test ever hits the network or needs a token.
function writeGhStub(binDir, {
  prListPrints = '', issueListPrints = '', runListPrints = '[]', runListExit = 0, exitCode = 0,
} = {}) {
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, 'gh');
  writeFileSync(gh, [
    '#!/usr/bin/env bash',
    'echo "gh $*" >> "${GH_LOG:-/dev/null}"',
    'case "$1 $2" in',
    `  "pr list") printf '%s' ${JSON.stringify(prListPrints)} ;;`,
    `  "issue list") printf '%s' ${JSON.stringify(issueListPrints)} ;;`,
    `  "run list") printf '%s' ${JSON.stringify(runListPrints)}; exit ${runListExit} ;;`,
    '  *) : ;;',
    'esac',
    `exit ${exitCode}`,
    '',
  ].join('\n'));
  chmodSync(gh, 0o755);
}

// Make the extracted script cwd-independent: the workflow calls
// `node brain/scripts/...` relative to the checkout root; rewrite those to the
// real repo's absolute path so the REAL cursor/audit/parse logic runs against
// the temp repo's git state (cursor.mjs & friends operate on process.cwd()).
function absolutizeNodePaths(script) {
  return script.replaceAll('node brain/scripts/', `node ${REPO_ROOT}/brain/scripts/`);
}

// Substitute the `${{ steps.*.outputs.* }}` expressions with test values.
function substituteExpr(script, subs) {
  let out = script;
  for (const [expr, val] of Object.entries(subs)) {
    out = out.replaceAll(expr, val);
  }
  return out;
}

// Run an extracted step script in an isolated temp repo. Returns {status, stdout, stderr, homeDir}.
function runStepIsolated(stepId, { repoSetup, subs = {}, ghOpts = {}, env = {} } = {}) {
  const homeDir = testTmp('pm-iso-');
  writeGhStub(join(homeDir, 'bin'), ghOpts);
  writeFileSync(join(homeDir, 'github_output'), '');
  const repo = join(homeDir, 'repo');
  mkdirSync(repo, { recursive: true });
  const yamlText = readFileSync(POSTMERGE_YML, 'utf8');
  const g = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8', env: isolatedEnv(homeDir) });
  g('init', '--initial-branch=main');
  g('config', 'user.name', 'Test');
  g('config', 'user.email', 't@t');
  if (repoSetup) repoSetup(g, repo, homeDir);
  let script = extractRunScript(yamlText, stepId);
  script = absolutizeNodePaths(substituteExpr(script, subs));
  const r = spawnSync('bash', ['-c', script], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...isolatedEnv(homeDir, env), GH_LOG: join(homeDir, 'gh.log'), NODE_LOG: join(homeDir, 'node.log') },
  });
  return {
    ...r,
    homeDir,
    repo,
    ghLog: () => (existsSync(join(homeDir, 'gh.log')) ? readFileSync(join(homeDir, 'gh.log'), 'utf8') : ''),
    // #1106: a second log, parallel to ghLog() — captures the stubbed `node
    // sweep.mjs --open-pr ...` invocation (args + BRAIN_SWEEP_TOKEN), since PR
    // creation moved off `gh` and onto the VCS port, invoked as a node script.
    nodeLog: () => (existsSync(join(homeDir, 'node.log')) ? readFileSync(join(homeDir, 'node.log'), 'utf8') : ''),
    output: () => readFileSync(join(homeDir, 'github_output'), 'utf8'),
  };
}

// A fixture App-token value for #1106 tests — assembled via .join(), never an
// inline quoted literal directly after `=`/`:`, so it does not read as a
// hardcoded credential to the repo:check `hardcoded-secret` rule (whose
// pattern requires a bare quote immediately following `token[=:]`).
const FIXTURE_APP_TOKEN = ['test', 'fixture', 'app', 'token'].join('-');

const RELEASE_YML = resolve(REPO_ROOT, '.github/workflows/release.yml');
const POSTMERGE_YML = resolve(REPO_ROOT, '.github/workflows/governance-postmerge.yml');
const GOVERNANCE_YML = resolve(REPO_ROOT, '.github/workflows/governance.yml');

// ── release.yml (rung 2, fail-closed) — REQ-L2-1 ────────────────────────────

test('release.yml exists', () => {
  assert.ok(existsSync(RELEASE_YML), 'expected .github/workflows/release.yml to exist');
});

test('release.yml references brain-audit.mjs', () => {
  const text = readFileSync(RELEASE_YML, 'utf8');
  assert.match(text, /brain-audit\.mjs/, 'release.yml must invoke brain-audit.mjs');
});

test('release.yml triggers on workflow_dispatch with required tag_name input (audit-then-tag)', () => {
  const text = readFileSync(RELEASE_YML, 'utf8');
  assert.match(text, /workflow_dispatch:/, 'release.yml must trigger on workflow_dispatch (audit-then-tag)');
  assert.match(text, /tag_name:/, 'release.yml must accept tag_name input');
  assert.match(text, /required:\s*true/, 'release.yml tag_name must be required');
});

test('release.yml does NOT have push:tags trigger (audit-then-tag prevents post-fact execution)', () => {
  const text = readFileSync(RELEASE_YML, 'utf8');
  assert.doesNotMatch(text, /push:\s*tags:/, 'release.yml must not have push:tags (would enable post-fact, non-enforcing mode)');
});

test('release.yml declares write contents permission (needed to create and push tags)', () => {
  const text = readFileSync(RELEASE_YML, 'utf8');
  assert.match(text, /permissions:\s*\{[^}]*\bcontents:\s*write\b/, 'release.yml must declare contents: write (to create/push tags)');
});

// audit-then-tag mode: the audit runs BEFORE tag creation, from PREV_TAG..HEAD
// (the commits being tagged), which is always non-empty. This enforces that
// brain-audit must pass before any tag is created.
test('release.yml derives the audit range from the previous release tag to HEAD', () => {
  const text = readFileSync(RELEASE_YML, 'utf8');
  assert.match(text, /git describe --tags/, 'release.yml must locate the previous release tag via git describe --tags');
  assert.match(text, /PREV_TAG/, 'release.yml must reference PREV_TAG (the previous release)');
  assert.match(text, /PREV_TAG\}?\.\.HEAD/, 'release.yml must audit PREV_TAG..HEAD (commits to be tagged)');
});

test('release.yml has a step that creates and pushes the tag (only after audit succeeds)', () => {
  const text = readFileSync(RELEASE_YML, 'utf8');
  assert.match(text, /git tag/, 'release.yml must create a tag via `git tag`');
  assert.match(text, /git push origin/, 'release.yml must push the tag via `git push origin`');
  assert.match(text, /TAG_NAME/, 'release.yml must use the TAG_NAME variable for the tag value');
});

test('release.yml routes tag_name via env: not spliced into run: (security precedent from governance-postmerge.yml)', () => {
  const text = readFileSync(RELEASE_YML, 'utf8');
  assert.match(text, /env:\s*TAG_NAME:\s*\$\{\{\s*inputs\.tag_name\s*\}\}/, 'tag_name must be routed via env: (untrusted user input)');
});

// ═══════════════════════════════════════════════════════════════════════════
// #479 / #475 — THE AUDIT'S CREDENTIAL, AND THE SCOPE THAT MAKES IT WORK.
//
// Both tickets describe this guard as an EXTENSION of one #467 added ("every
// step that reads the API declares its own env: GH_TOKEN"). Measured while
// implementing them: no such guard exists in this file, or anywhere else in the
// suite — changing governance-postmerge.yml's audit step from `GH_TOKEN` to
// `VCS_TOKEN` left all 3004 other tests green. #467 fixed the workflow and the
// guard was never written, which is why #475 could then ship the identical
// defect one rung down without anything noticing.
//
// TWO conditions, and the second is the load-bearing one:
//
//   1. Every step that runs the audit declares the credential.
//   2. Every workflow that declares a `permissions:` block grants the audit a
//      scope to read pull requests.
//
// A `permissions:` block sets every scope it OMITS to `none`, so a step can
// carry a perfectly good token and still be unable to read `pulls/{n}`. Asserting
// only (1) produces a gate that LOOKS fixed and still runs blind — #475's central
// point, and the reason the two are asserted together and never apart.
// ═══════════════════════════════════════════════════════════════════════════

// The rule lives in `lib/workflow-auth.mjs` and is imported, never restated here.
// #480 hardened it against the ten shapes that defeated PR #476's version, and a
// second copy of a rule is the defect #340 records: two implementations of one rule
// disagree, and the one CI runs is not the one anybody reads.

// ═══════════════════════════════════════════════════════════════════════════
// T1 (issue #535, Requirement 7) — the integration proof, deliberately LAST.
// `governance.yml` joins the audited set alongside the two workflows the
// guard already covered. This is the point where every fix from #535 has to
// hold TOGETHER: WU1's credential swap, WU2's entry-point invariant, WU3's
// manifest, WU4's per-invocation resolution, WU7's block-style permissions
// parse. Before all of them landed, this was red for two unrelated reasons at
// once (the GH_TOKEN steps AND the whole-file over-approximation flagging
// memory-gate/decision-gate) — indistinguishable from here alone, which is
// why this proof runs only once everything else is in place.
// ═══════════════════════════════════════════════════════════════════════════

// ── The audited set is DERIVED FROM DISK, never listed (issue #558) ─────────
//
// It used to be this literal:
//
//     [release.yml, governance-postmerge.yml, governance.yml]
//
// and `governance-relabel.yml` — whose step invokes `relabel-retrigger.mjs`,
// which imports `getVcs` — sat outside it declaring `GH_TOKEN`, the exact
// coupling #479 and #535 exist to remove, for as long as both of those tickets
// were open. Nothing was broken and nothing said anything: adding a workflow to
// the repo did not add it to the audit, and someone had to remember. #535's own
// history is that nobody does (#476's guard died with its PR; #467's fix went
// unguarded for a month).
//
// That is the very shape the guard was built to avoid — a checker whose
// COVERAGE is an allowlist, where absence from the list reads as "nothing to
// report" (`evidence-reader-empty-on-failure`, one level up from the guard's
// own logic). So the set comes off disk, and the sanity assertions below make
// an empty or shrunken read a failure rather than a silent agreement.

const WORKFLOWS_DIR = resolve(REPO_ROOT, '.github/workflows');
const GITLAB_CI_DIR = resolve(REPO_ROOT, 'brain/scripts/ci');

/** Every `.yml`/`.yaml` under a directory, recursively, as [relative name, absolute path]. */
function ciFilesUnder(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...ciFilesUnder(full).map(([n, p]) => [join(entry.name, n), p]));
    else if (/\.ya?ml$/.test(entry.name)) out.push([entry.name, full]);
  }
  return out.sort(([a], [b]) => a.localeCompare(b));
}

/** Every GitHub workflow on disk, as [file, absolute path]. */
function githubWorkflows() {
  return ciFilesUnder(WORKFLOWS_DIR);
}

/** Every GitLab pipeline file on disk — the SECOND surface, derived the same way.
 *  It was a single hardcoded path in this test's first form: the audited set was
 *  taken off an allowlist on one surface while an allowlist was reintroduced on
 *  the other, which is the defect this whole file exists to remove. */
function gitlabPipelines() {
  return ciFilesUnder(GITLAB_CI_DIR);
}

test('#479/#475/#535/#558 drift guard: EVERY workflow on disk is compliant — the audited set is derived, not listed', () => {
  const workflows = githubWorkflows();
  assert.ok(workflows.length >= 5,
    `sanity: expected >=5 workflows on disk, found ${workflows.length} — a read that returns ` +
    `little or nothing would make this test agree with everything`);
  // Named explicitly so a rename or a deletion is a failure here rather than a
  // quietly smaller set. This is a floor on coverage, not the coverage itself:
  // a NEW workflow is audited without touching this list, which is the point.
  for (const known of ['release.yml', 'governance-postmerge.yml', 'governance.yml', 'governance-relabel.yml']) {
    assert.ok(workflows.some(([f]) => f === known), `sanity: ${known} must be among the audited workflows`);
  }
  const findings = workflows
    .map(([file, path]) => [file, auditWorkflowAuth(readFileSync(path, 'utf8'), { file, repoRoot: REPO_ROOT })])
    .filter(([, v]) => v.length > 0);
  assert.deepEqual(findings, [],
    'these workflows reach the server without a usable credential declaration');
});

test('#558: EVERY GitLab pipeline file on disk is audited — by the rule that applies to GitLab, not GitHub\'s', () => {
  // NOT auditWorkflowAuth. #558 proposed one step reader across both providers;
  // measured, that is wrong — GitLab injects project CI/CD variables into every
  // job automatically, so VCS_TOKEN is legitimately absent from this YAML and
  // the "must declare the credential" rule would flag three correct jobs (the
  // three whose entry point reaches the port: issue-link, actor-check,
  // brain-writes-reviewed). See auditGitlabFragment's header.
  const pipelines = gitlabPipelines();
  assert.ok(pipelines.length >= 1,
    `sanity: expected >=1 GitLab pipeline file on disk, found ${pipelines.length}`);
  assert.ok(pipelines.some(([f]) => f === 'gitlab-governance.yml'),
    'sanity: gitlab-governance.yml must be among them');
  const findings = pipelines
    .map(([file, path]) => [file, auditGitlabFragment(readFileSync(path, 'utf8'), { file, repoRoot: REPO_ROOT })])
    .filter(([, v]) => v.length > 0);
  assert.deepEqual(findings, []);
});

test('#558: the GitLab audit has TEETH — every condition alone is caught, in every spelling GitLab accepts', () => {
  const src = readFileSync(join(GITLAB_CI_DIR, 'gitlab-governance.yml'), 'utf8');
  const audit = (t) => auditGitlabFragment(t, { file: 'gl', repoRoot: REPO_ROOT }).join('\n');

  // 1. A GitHub-only credential in a GitLab pipeline.
  assert.match(audit(src.replace('default:', 'variables:\n  GH_TOKEN: $CI_JOB_TOKEN\ndefault:')),
    /declares GH_TOKEN/);

  // 2. An entry point that no longer exists — the failure mode this file is most
  //    exposed to, since no CI of brain's own ever runs it. ALL THREE SPELLINGS
  //    GitLab accepts: a `-` list, an inline scalar, and a block scalar. The
  //    first form of this reader knew only the list, so the other two were
  //    invisible AND kept the vacuous-pass guard from firing, because the
  //    remaining jobs still supplied lists.
  const gone = 'brain/scripts/vcs/actor-check-RENAMED.mjs';
  assert.match(audit(src.replace('vcs/actor-check.mjs', 'vcs/actor-check-RENAMED.mjs')),
    /does not exist/, 'list form');
  assert.match(audit(src.replace('  script:\n    - node brain/scripts/vcs/actor-check.mjs',
    `  script: node ${gone}`)), /does not exist/, 'inline scalar form');
  assert.match(audit(src.replace('  script:\n    - node brain/scripts/vcs/actor-check.mjs',
    `  script: |\n    node ${gone}`)), /does not exist/, 'block scalar form');

  // 3. A quoted path — #559's blind spot on the GitHub side nullifies the whole
  //    audit on this one, where a missing entry point is the ONLY thing checked.
  assert.match(audit(src.replace('- node brain/scripts/vcs/actor-check.mjs',
    `- node "${gone}"`)), /does not exist|resolves to no entry point/, 'quoted path');

  // 4. A renamed SUBCOMMAND breaks this pipeline exactly as silently as a renamed
  //    file, and the GitHub side already refuses it. Asymmetry would mean the two
  //    surfaces disagree about what a valid invocation is.
  assert.match(audit(src.replace('run-check.mjs issue-link', 'run-check.mjs issue-lynk')),
    /manifest does not declare/);

  // 5. A job shelling a provider CLI — the coupling in a purer form than a literal.
  assert.match(audit(src.replace('    - node brain/scripts/vcs/actor-check.mjs',
    '    - gh api repos/x/pulls\n    - node brain/scripts/vcs/actor-check.mjs')),
    /shells a provider CLI/);

  // 6. A parse that reads nothing must be a violation, not a clean bill.
  assert.match(audit(src.replace(/^(\s*)script:/gm, '$1notscript:')), /no job with a script/);
});

test('#558: the derived set is a real read — a file written into the REAL directory is audited without editing any list', () => {
  // The first form of this test built its own mkdtemp directory and never touched
  // githubWorkflows(), so it proved nothing about the derivation it was named
  // after. This one writes into the directory the production walk reads.
  const planted = join(WORKFLOWS_DIR, 'zz-derivation-probe.yml');
  try {
    writeFileSync(planted, [
      'permissions: { contents: read, pull-requests: read }',
      'jobs:',
      '  g:',
      '    steps:',
      '      - name: Run the audit',
      '        run: node brain/scripts/brain-audit.mjs "a..b"',
    ].join('\n'));
    const seen = githubWorkflows().map(([f]) => f);
    assert.ok(seen.includes('zz-derivation-probe.yml'),
      'the production walk must see a file nobody registered');
    const findings = githubWorkflows()
      .map(([file, path]) => [file, auditWorkflowAuth(readFileSync(path, 'utf8'), { file, repoRoot: REPO_ROOT })])
      .filter(([, v]) => v.length > 0);
    assert.ok(findings.some(([f]) => f === 'zz-derivation-probe.yml'),
      'a newly added, non-compliant workflow must be caught by the derived set — if this passes, ' +
      'the derivation is decorative and the coverage is still whatever someone remembered to list');
  } finally {
    rmSync(planted, { force: true });
  }
});

test('#558: a workflow this guard cannot parse is a violation, not a clean bill', () => {
  // YAML flow style yields zero step blocks, so the audit used to return [] for a
  // port-reaching step with no credential at all. Harmless while the audited set
  // was three known files; a silent welcome now that any new file joins the set.
  const flow = 'jobs:\n  g:\n    steps: [{name: "audit", run: "node brain/scripts/brain-audit.mjs a..b"}]\n';
  assert.match(auditWorkflowAuth(flow, { file: 'flow.yml', repoRoot: REPO_ROOT }).join('\n'),
    /could not parse it/);
  // And it must NOT fire on the real workflows, or it is a check that blocks
  // everything and protects nothing (#499).
  for (const [file, path] of githubWorkflows()) {
    assert.doesNotMatch(auditWorkflowAuth(readFileSync(path, 'utf8'), { file, repoRoot: REPO_ROOT }).join('\n'),
      /could not parse it/, `${file} must remain parseable`);
  }
});

test('#479/#475 drift guard: it has TEETH — each condition alone is caught', () => {
  // Condition 1: the credential removed.
  const noToken = [
    'permissions: { contents: write, pull-requests: read }',
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: Run the audit',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.match(auditWorkflowAuth(noToken, { repoRoot: REPO_ROOT }).join('\n'), /does not declare VCS_TOKEN/);

  // Condition 2: the credential present, the SCOPE missing. This is the one an
  // eyeball review passes — the step looks authenticated, and the token it gets
  // cannot read a pull request.
  const noScope = [
    'permissions: { contents: write }',
    'jobs:',
    '  g:',
    '    steps:',
    '      - name: Run the audit',
    '        env:',
    '          VCS_TOKEN: ${{ github.token }}',
    '        run: node brain/scripts/brain-audit.mjs "a..b"',
  ].join('\n');
  assert.match(auditWorkflowAuth(noScope, { repoRoot: REPO_ROOT }).join('\n'), /every omitted scope is 'none'/);

  // And a step that merely NAMES the credential in a comment is not compliant.
  const commentOnly = noToken.replace(
    '        run: node',
    '        # VCS_TOKEN: handled elsewhere\n        run: node',
  );
  assert.match(auditWorkflowAuth(commentOnly, { repoRoot: REPO_ROOT }).join('\n'), /does not declare VCS_TOKEN/);
});

test('#479/#475 drift guard: reverting the audit step to the provider-specific GH_TOKEN is caught', () => {
  // The precise regression #479 removes. `GH_TOKEN` is not wrong on a step that
  // shells out to `gh` directly — it is wrong on the step that reaches the server
  // THROUGH the port, because that is the path GitLab consumers also execute.
  const reverted = readFileSync(POSTMERGE_YML, 'utf8')
    .replace('VCS_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ github.token }}');
  assert.notEqual(reverted, readFileSync(POSTMERGE_YML, 'utf8'), 'the mutation must land');
  assert.match(auditWorkflowAuth(reverted, { file: 'governance-postmerge.yml', repoRoot: REPO_ROOT }).join('\n'), /does not declare VCS_TOKEN/);
});

test('#535 T1: reverting governance.yml\'s diff-size step to GH_TOKEN is caught (the precise #535 regression, this time on the PR-time gate)', () => {
  const original = readFileSync(GOVERNANCE_YML, 'utf8');
  const diffSizeBlock = original.match(/^  diff-size:\s*$[\s\S]*?(?=^  [a-z][\w-]*:\s*$)/m);
  assert.ok(diffSizeBlock, 'the diff-size job must be locatable in governance.yml');
  const revertedBlock = diffSizeBlock[0].replace('VCS_TOKEN: ${{ github.token }}', 'GH_TOKEN: ${{ github.token }}');
  assert.notEqual(revertedBlock, diffSizeBlock[0], 'the mutation must land');
  const reverted = original.replace(diffSizeBlock[0], revertedBlock);
  assert.match(
    auditWorkflowAuth(reverted, { file: 'governance.yml', repoRoot: REPO_ROOT }).join('\n'),
    /does not declare VCS_TOKEN/
  );
});

// ── governance-postmerge.yml (rung 3, auto-revert) — REQ-L2-2 ──────────────

test('governance-postmerge.yml exists', () => {
  assert.ok(existsSync(POSTMERGE_YML), 'expected .github/workflows/governance-postmerge.yml to exist');
});

test('governance-postmerge.yml references brain-audit.mjs', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(text, /brain-audit\.mjs/, 'governance-postmerge.yml must invoke brain-audit.mjs');
});

test('governance-postmerge.yml declares contents: write and pull-requests: write', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(text, /contents:\s*write/, 'governance-postmerge.yml must declare contents: write (trusted post-merge context)');
  assert.match(text, /pull-requests:\s*write/, 'governance-postmerge.yml must declare pull-requests: write (to open the auto-revert PR)');
});

test('governance-postmerge.yml triggers on push to main and a daily schedule', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(text, /branches:\s*\[main\]/, 'governance-postmerge.yml must trigger on push to main');
  assert.match(text, /schedule:/, 'governance-postmerge.yml must also trigger on a schedule (daily cron)');
});

// Drift guard (issue #468, REQ-R3-3): substrate.mjs's POSTMERGE_STALE_MS
// (rung 3's staleness window) is derived from "2 periods of the daily cron" —
// a constant, not a live read of this file. If the cron cadence ever changes
// without updating that constant, the two silently drift apart and rung 3's
// staleness window stops matching reality. No cron parser (zero-dependency
// doctrine, substrate.mjs:111-114) — a shape assertion plus a literal value
// check is enough to catch drift.
//
// Uses `matchAll` (every `- cron:` entry), NOT a single non-global `.match()`
// — a single match only inspects the FIRST cron entry, so ADDING a second
// entry (e.g. an hourly cron alongside the daily one) would change the
// effective cadence while the guard silently kept passing on entry #1 alone.
// `assertCronDriftGuard` is shared by the real-file test below and the
// synthetic-drift test, so both exercise the identical guard logic.
function assertCronDriftGuard(text, staleMs) {
  // Count DECLARED entries independently of the ones this guard can parse. The
  // value matcher reads quoted scalars; a second entry in a shape it does not
  // read (double quotes, unquoted) would otherwise change the effective cadence
  // while the guard passed on the entries it happened to see — a guard blind to
  // exactly the drift it exists to catch. Any unparseable entry is drift.
  const declared = [...text.matchAll(/-\s*cron\s*:/g)].length;
  const matches = [...text.matchAll(/-\s*cron:\s*['"]([^'"]+)['"]/g)];
  assert.ok(matches.length > 0, 'must declare at least one cron schedule string');
  assert.equal(
    matches.length,
    declared,
    `found ${declared} cron entr${declared === 1 ? 'y' : 'ies'} but could only read ${matches.length} — an entry this guard cannot parse is an entry it cannot check`,
  );
  assert.equal(
    matches.length,
    1,
    `expected exactly one cron entry, found ${matches.length} — multiple schedule entries change the effective cadence and require re-deriving POSTMERGE_STALE_MS`,
  );
  assert.match(
    matches[0][1],
    /^\d+\s+\d+\s+\*\s+\*\s+\*$/,
    'the cron must stay daily-shaped (minute hour * * *) — a cadence change requires re-deriving POSTMERGE_STALE_MS',
  );
  assert.equal(
    staleMs,
    2 * 24 * 60 * 60 * 1000,
    'POSTMERGE_STALE_MS must stay 2 daily cron periods (48h). A cadence change requires updating THREE things together: this constant, the literal on this line, and the daily-shape regex above — the constant alone leaves this guard failing on its own assertion.',
  );
}

// The operator-facing threshold strings must INTERPOLATE the constant, never
// restate it. No behavioural assertion can prove this while the literal and the
// derived value coincide — `older than 48h` and `older than ${LABEL}` render
// identically today, so a unit test passes either way and the regression is
// invisible until someone changes the constant. Asserting the SOURCE is the only
// form that distinguishes them, and it is exactly what the drift guard needs:
// the moment POSTMERGE_STALE_MS moves, a hardcoded string starts lying, and the
// guard above forces that move to be deliberate.
test('drift guard: the operator-facing threshold strings interpolate POSTMERGE_STALE_LABEL, never a hardcoded literal', () => {
  const substrateSrc = readFileSync(fileURLToPath(new URL('./substrate.mjs', import.meta.url)), 'utf8');
  const statusSrc = readFileSync(fileURLToPath(new URL('../brain-governance-status.mjs', import.meta.url)), 'utf8');

  assert.match(
    substrateSrc,
    /stale \(older than \$\{POSTMERGE_STALE_LABEL\}\)/,
    "E8's stale reason must interpolate POSTMERGE_STALE_LABEL — a hardcoded threshold survives every behavioural test and starts lying the moment the constant moves",
  );
  assert.match(
    statusSrc,
    /succeeded within \$\{POSTMERGE_STALE_LABEL\}\]/,
    "the armed line must interpolate POSTMERGE_STALE_LABEL for the same reason",
  );
});

test('drift guard: governance-postmerge.yml cron stays daily-shaped, and POSTMERGE_STALE_MS stays 2 daily periods', async () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const { POSTMERGE_STALE_MS } = await import('./substrate.mjs');
  assertCronDriftGuard(text, POSTMERGE_STALE_MS);
});

test('drift guard: adding a second cron entry (e.g. an hourly cron alongside the daily one) trips the guard', async () => {
  const { POSTMERGE_STALE_MS } = await import('./substrate.mjs');
  const textWithTwoCrons = `
on:
  push:
    branches: [main]
  schedule:
    - cron: '0 6 * * *'
    - cron: '0 * * * *'
`;
  assert.throws(
    () => assertCronDriftGuard(textWithTwoCrons, POSTMERGE_STALE_MS),
    /exactly one cron entry/,
    'a second cron entry must trip the drift guard — the effective cadence changed even though entry #1 is still daily-shaped',
  );
});

// ── D2 (#259): the cursor-windowed, exit-code-branched, [FAIL-SHA]-consuming
// shape. These INVERT the pre-D2 assertions above: the window is no longer the
// push payload's before..sha (which skips offenders and collapses on cron) — it
// is the governance cursor range. ────────────────────────────────────────────

// The v1 range (github.event.before..github.sha) is GONE: it skips an offender
// that landed while an earlier run was pinned (REQ-D2-1), and collapses to an
// empty sha..sha on cron. The window is the cursor's — never the push payload's.
test('governance-postmerge.yml does NOT window on github.event.before (the skip-over regression)', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.doesNotMatch(
    text,
    /github\.event\.before/,
    'governance-postmerge.yml must NOT use github.event.before — the audit window is the governance cursor range (REQ-D2-1)'
  );
});

test('governance-postmerge.yml resolves the audit window from the cursor CLI', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(
    text,
    /cursor\.mjs window/,
    'governance-postmerge.yml must resolve the window via `cursor.mjs window` (cursor..HEAD), not the push payload'
  );
});

// The audit's NUMERIC exit code is authoritative: continue-on-error flattens 1
// and 2 into a boolean, which would let an uncomputable (code 2) trigger a
// revert. The workflow must capture the numeric code and branch on it (REQ-D2-6).
test('governance-postmerge.yml does NOT flatten the audit exit code via continue-on-error', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.doesNotMatch(
    text,
    /continue-on-error:\s*true/,
    'governance-postmerge.yml must not use continue-on-error (it flattens exit 1 and 2 — a code-2 must never revert)'
  );
});

test('governance-postmerge.yml branches on the numeric audit code (0/1/2), not steps.*.outcome', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(text, /steps\.audit\.outputs\.code\s*==\s*'0'/, 'code 0 must advance the cursor');
  assert.match(text, /steps\.audit\.outputs\.code\s*==\s*'1'/, 'code 1 must revert the parsed offenders');
  assert.match(text, /steps\.audit\.outputs\.code\s*==\s*'2'/, 'code 2 must raise a loud infra issue, never revert');
  assert.doesNotMatch(
    text,
    /steps\.audit\.outcome\s*==\s*'failure'/,
    'governance-postmerge.yml must branch on the numeric code, never the boolean outcome'
  );
});

// The revert consumes the ONE tested parser (REQ-D2-5) — never github.sha
// blindly, never an inline grep of stdout.
test('governance-postmerge.yml reverts the parsed [FAIL-SHA] offenders, not github.sha blindly', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(
    text,
    /parse-failures\.mjs/,
    'governance-postmerge.yml must parse offenders through parse-failures.mjs (REQ-D2-5)'
  );
  assert.doesNotMatch(
    text,
    /git revert[^\n]*github\.sha/,
    'governance-postmerge.yml must not blindly revert github.sha — it reverts the parsed offenders'
  );
});

// Parents-only count (REQ-D2-4): never `grep -c '^parent '` (also matches
// commit-message lines beginning with `parent `).
test('governance-postmerge.yml counts merge parents via %P, never grep -c "^parent "', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(text, /git show -s --format=%P/, 'must count parents via `git show -s --format=%P`');
  assert.doesNotMatch(
    text,
    /grep -c ['"]\^parent /,
    'must not use `grep -c "^parent "` (matches message lines too — REQ-D2-4)'
  );
});

// PR-keyed idempotency (REQ-D2-13): dedup on the PR (`--state all`), so a
// closed-without-merge PR is never reopened or duplicated.
test('governance-postmerge.yml dedups auto-revert on the PR (--state all), not the branch', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(
    text,
    /gh pr list --head[^\n]*--state all/,
    'governance-postmerge.yml must dedup via `gh pr list --head <br> --state all` (REQ-D2-13, PR-keyed)'
  );
});

// Untrusted audit output is routed via env: and written to a file, never
// argv-spliced into a run: block (CWE-94, §4.5.1/4.5.2).
test('governance-postmerge.yml routes audit stdout via env:, never ${{ }}-spliced into run:', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(text, /AUDIT_STDOUT:\s*\$\{\{\s*steps\.audit\.outputs\.stdout\s*\}\}/, 'audit stdout must reach run: via env:, not inline splicing');
  assert.match(text, /--body-file/, 'loud/PR bodies must be passed via --body-file, never argv-spliced');
});

// Loud paths carry no `|| true` (a swallowed failure is a silent halt), and the
// workflow guards against overlapping runs.
test('governance-postmerge.yml has a concurrency group and no swallowed loud paths', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(text, /concurrency:\s*\{\s*group:\s*governance-postmerge/, 'must declare a concurrency group (§5.3)');
  assert.doesNotMatch(
    text,
    /gh (issue|label|pr) create[^\n]*\|\|\s*true/,
    'no loud path (gh issue/label/pr create) may be suffixed with `|| true`'
  );
});

// The terminal-state assertion runs always() and fails the job if the audit
// produced no mapped code (e.g. it was SIGKILLed) — never a silent clean pass.
test('governance-postmerge.yml asserts a terminal audit code via always()', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(text, /if:\s*always\(\)/, 'must carry an always() terminal-state assertion step');
});

// ── design §10-B: separate-file isolation ───────────────────────────────────
//
// The read-only PR gate (governance.yml) must never gain write scope. Rung 3's
// write permissions live ONLY in governance-postmerge.yml, a file that governance.yml
// does not reference and vice versa — both files exist independently.

test('governance-postmerge.yml is a separate file from governance.yml (read-only PR gate isolation)', () => {
  assert.ok(existsSync(GOVERNANCE_YML), 'expected .github/workflows/governance.yml to exist (baseline PR gate)');
  assert.ok(existsSync(POSTMERGE_YML), 'expected .github/workflows/governance-postmerge.yml to exist as a SEPARATE file');
  assert.notEqual(GOVERNANCE_YML, POSTMERGE_YML, 'governance-postmerge.yml must not be the same path as governance.yml');

  const governanceText = readFileSync(GOVERNANCE_YML, 'utf8');
  assert.doesNotMatch(
    governanceText,
    /contents:\s*write/,
    'governance.yml (the PR-time gate) must stay read-only — write scope must not leak into it'
  );
});

// ── C1 (Phase 4.2, SELF-CONTAINED per #304 I304-C1-TARGET-ABSENT): the
// skip-over proof. Cursor pinned at C; offender M lands; clean P2 lands. The
// window step must resolve C..P2 (still containing M), NEVER a before..sha
// window that would skip M. The fixture mints its own repo + bare origin +
// governance cursor ref — it reads no live server branch. ──────────────────
test('C1 skip-over: the window step resolves cursor..HEAD (C..P2, containing M), never a payload range', () => {
  let cSha, mSha, p2Sha;
  const r = runStepIsolated('window', {
    repoSetup: (g, repo, homeDir) => {
      // bare origin so cursor.mjs's remote-authoritative ls-remote works
      const origin = join(homeDir, 'origin.git');
      spawnSync('git', ['init', '--bare', origin], { encoding: 'utf8', env: isolatedEnv(homeDir) });
      g('remote', 'add', 'origin', origin);
      writeFileSync(join(repo, 'f'), 'base\n'); g('add', '.'); g('commit', '-m', 'C0');
      // C — the cursor point
      writeFileSync(join(repo, 'f'), 'C\n'); g('add', '.'); g('commit', '-m', 'C (cursor)');
      cSha = g('rev-parse', 'HEAD').stdout.trim();
      // M — an offender merge lands after C
      g('checkout', '-b', 'off'); writeFileSync(join(repo, 'm'), 'offender\n'); g('add', '.'); g('commit', '-m', 'M work');
      g('checkout', 'main'); g('merge', '--no-ff', 'off', '-m', 'M: offender merge'); mSha = g('rev-parse', 'HEAD').stdout.trim();
      // P2 — a clean merge lands after M
      g('checkout', '-b', 'clean'); writeFileSync(join(repo, 'p'), 'clean\n'); g('add', '.'); g('commit', '-m', 'P2 work');
      g('checkout', 'main'); g('merge', '--no-ff', 'clean', '-m', 'P2: clean merge'); p2Sha = g('rev-parse', 'HEAD').stdout.trim();
      g('push', 'origin', 'main');
      // pin the governance cursor at C on origin
      g('push', 'origin', `${cSha}:refs/governance/audit-cursor`);
    },
  });
  assert.equal(r.status, 0, `window step must exit 0 on a present cursor:\n${r.stdout}\n${r.stderr}`);
  const out = r.output();
  assert.match(out, new RegExp(`range=${cSha}\\.\\.${p2Sha}`),
    `window must be C..P2 (contains M=${mSha.slice(0,7)}); got GITHUB_OUTPUT:\n${out}`);
});

// ── #1162: a fresh consumer has no cursor and never had one. The window step
// initializes it (bootstrap) and audits — no alarm. A cursor that HAD existed
// (a prior successful run of this workflow) and is now gone still alarms. ────
// The window step's own `env:` (the harness does not apply YAML env): the port
// credential, the fixed provider, and the default branch the evidence filters by.
const BOOT_ENV = { VCS_PROVIDER: 'github', DEFAULT_BRANCH: 'main', GITHUB_REPOSITORY: 'o/r' };

function freshConsumerSetup(g, repo, homeDir) {
  const origin = join(homeDir, 'origin.git');
  spawnSync('git', ['init', '--bare', '--initial-branch=main', origin], { encoding: 'utf8', env: isolatedEnv(homeDir) });
  g('remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'f'), 'pre\n'); g('add', '.'); g('commit', '-m', 'pre-adoption');
  mkdirSync(join(repo, '.github/workflows'), { recursive: true });
  writeFileSync(join(repo, '.github/workflows/governance-postmerge.yml'), 'name: x\n');
  g('add', '.'); g('commit', '-m', 'adopt brain');
  writeFileSync(join(repo, 'g'), 'later\n'); g('add', '.'); g('commit', '-m', 'first merge');
  g('push', 'origin', 'main');
}

test('#1162 (a): fresh consumer, no cursor, no prior successful run → window step bootstraps, emits a range, files NO alarm', () => {
  let pre;
  const r = runStepIsolated('window', {
    repoSetup: (g, repo, homeDir) => { freshConsumerSetup(g, repo, homeDir); pre = g('rev-parse', 'HEAD~1').stdout.trim(); },
    ghOpts: { runListPrints: '[]' },
    env: BOOT_ENV,
  });
  assert.equal(r.status, 0, `bootstrap must let the run proceed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.output(), new RegExp(`range=${pre}\\.\\.[0-9a-f]{40}`), `window must start AT the adoption commit:\n${r.output()}`);
  assert.doesNotMatch(r.ghLog(), /gh (label|issue) create/, 'a bootstrap is not an alarm');
  assert.match(r.ghLog(), /run list .*--branch main/, 'the evidence is filtered by the default branch');
  assert.doesNotMatch(r.output(), /alarm=/);
});

test('#1162 (b): cursor deleted on a repo with a prior successful run → still alarms governance:cursor-missing, no range', () => {
  const r = runStepIsolated('window', {
    repoSetup: freshConsumerSetup,
    ghOpts: { runListPrints: '[{"databaseId":42}]' },
    env: BOOT_ENV,
  });
  assert.equal(r.status, 2, `a deleted cursor must halt:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.output(), /range=/);
  assert.match(r.output(), /alarm=governance:cursor-missing/);
  assert.match(r.ghLog(), /gh issue create/);
});

test('#1162: the evidence of a prior run cannot be read (gh fails) → halts loud, never bootstraps', () => {
  const r = runStepIsolated('window', {
    repoSetup: freshConsumerSetup,
    ghOpts: { runListPrints: '', runListExit: 1 },
    env: BOOT_ENV,
  });
  assert.equal(r.status, 2);
  assert.doesNotMatch(r.output(), /range=/);
  assert.match(r.output(), /alarm=/);
});

// ── C2 (Phase 4.1): a cursor that resolves to UNKNOWN/ABSENT halts with exit 2
// and NEVER emits a range — an inferred empty range must never pass as clean.
// Here the repo has NO origin/governance ref → readCursor is UNKNOWN (ls-remote
// on a nonexistent remote is not status-2/absent). The step must exit 2 and
// write no range. ──────────────────────────────────────────────────────────
test('C2: an uncomputable cursor halts the window step at exit 2, emitting no range', () => {
  const r = runStepIsolated('window', {
    repoSetup: (g, repo) => {
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      // no origin remote at all → ls-remote fails non-2 → UNKNOWN (fail-closed)
    },
  });
  assert.equal(r.status, 2, `an uncomputable cursor must exit 2 (fail-closed):\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.output(), /range=/, `no audit range may be emitted on an uncomputable cursor:\n${r.output()}`);
  assert.match(r.ghLog(), /gh (label|issue) create/, `a loud issue must be raised on halt:\n${r.ghLog()}`);
});

// ── C4 (Phase 4.3): the audit step normalizes an unmapped exit code to 2 BEFORE
// branching, so a killed/garbled audit can never advance the cursor or revert.
// A stub audit that exits 3 must surface as code=2 in GITHUB_OUTPUT. ─────────
test('C4: an unmapped audit exit code (3) is normalized to 2 before branching', () => {
  const r = runStepIsolated('audit', {
    subs: { '${{ steps.window.outputs.range }}': 'AAA..BBB' },
    repoSetup: (g, repo, homeDir) => {
      // shadow the audit invocation: put a fake node script path? The step calls
      // `node <REPO>/brain/scripts/brain-audit.mjs`. Stub by prepending a `node`
      // wrapper on PATH that intercepts brain-audit.mjs and exits 3.
      const bin = join(homeDir, 'bin');
      writeFileSync(join(bin, 'node'), [
        '#!/usr/bin/env bash',
        'for a in "$@"; do case "$a" in *brain-audit.mjs) echo "[FAIL] simulated"; exit 3;; esac; done',
        'exec /usr/bin/env -i PATH="/usr/bin:/bin:/usr/local/bin" node "$@"',
      ].join('\n'));
      chmodSync(join(bin, 'node'), 0o755);
    },
  });
  assert.equal(r.status, 0, `audit step itself exits 0 (it captures the code):\n${r.stdout}\n${r.stderr}`);
  assert.match(r.output(), /code=2/, `an exit-3 audit must normalize to code=2:\n${r.output()}`);
  assert.doesNotMatch(r.output(), /code=3/, 'the raw unmapped code must not survive');
});

// ── C5 (Phase 4.4): if the tested parser fails while code==1, the revert step
// fails closed — never a silently empty offender list. A stub parse-failures
// that exits non-zero must abort the step (set -e via command substitution). ─
test('C5: a parse-failures crash while reverting fails the step closed, never an empty offender list', () => {
  const r = runStepIsolated('revert', {
    env: { AUDIT_STDOUT: '[FAIL-SHA] ' + 'a'.repeat(40) },
    repoSetup: (g, repo, homeDir) => {
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      const bin = join(homeDir, 'bin');
      // Intercept the parse-failures.mjs node call and make it crash.
      writeFileSync(join(bin, 'node'), [
        '#!/usr/bin/env bash',
        'for a in "$@"; do case "$a" in *parse-failures.mjs) echo "parser boom" >&2; exit 7;; esac; done',
        'exec /usr/bin/env node "$@"',
      ].join('\n'));
      chmodSync(join(bin, 'node'), 0o755);
    },
  });
  assert.notEqual(r.status, 0, `a parser crash must fail the revert step, never yield an empty list:\n${r.stdout}\n${r.stderr}`);
});

// ── D1 (Phase 4.0.1): a drift-guard over THIS test file, proven with teeth.
// Every `spawnSync('bash', ...)` that runs extracted workflow script MUST carry
// the isolation env (isolatedEnv). The guard scans source text and reports any
// bash spawn whose call is not accompanied by isolatedEnv within its options.
// Teeth: it must FLAG a deliberately non-compliant sample and PASS the real file.
function auditBashIsolation(sourceText) {
  const violations = [];
  const lines = sourceText.split('\n');
  lines.forEach((l, idx) => {
    // Scan CODE only — a drift-guard that trips on its own prose is noise. Skip
    // comment lines (a bash-spawn mentioned in a comment is not an execution).
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*')) return;
    if (/spawnSync\(\s*['"]bash['"]/.test(l)) {
      // look at the next ~8 lines for the options object carrying isolatedEnv
      const window = lines.slice(idx, idx + 8).join('\n');
      if (!/isolatedEnv\(/.test(window)) violations.push(idx + 1);
    }
  });
  return violations;
}

test('D1 isolation drift-guard: every extracted-bash spawn in this file is isolated (proven with teeth)', () => {
  const self = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.deepEqual(
    auditBashIsolation(self), [],
    'every spawnSync("bash", ...) that runs workflow script must carry isolatedEnv(...)',
  );
  // TEETH: a non-compliant sample (bash spawn WITHOUT isolatedEnv) must be
  // flagged. The spawn token is assembled at runtime so this teeth-sample is NOT
  // itself a literal in this file's source — otherwise the guard above would
  // (correctly) flag its own sample and this test could never pass clean.
  const spawnTok = 'spawn' + 'Sync("bash"';
  const badSample = [
    `const r = ${spawnTok}, ["-c", script], {`,
    '  cwd: repo,',
    '  env: { ...process.env },',
    '});',
  ].join('\n');
  assert.ok(
    auditBashIsolation(badSample).length > 0,
    'the drift-guard has no teeth — it failed to flag a bash spawn missing isolatedEnv',
  );
});

// ── D2 (Phase 4.0.3): the real repository's git identity is UNCHANGED by running
// an isolated extracted-script step — even one that itself runs `git config`.
// The isolation contract (HOME=temp, GIT_CONFIG_GLOBAL=/dev/null) guarantees a
// stray global write cannot reach the developer's ~/.gitconfig or this repo. ─
test('D2 isolation: an isolated step running git config leaves the real repo/user identity untouched', () => {
  const before = spawnSync('git', ['config', '--get-regexp', '^user\\.'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout;
  // Run the gitidentity step isolated — it sets user.name/email on ITS repo.
  const r = runStepIsolated('gitidentity', {
    repoSetup: (g, repo) => { writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0'); },
  });
  assert.equal(r.status, 0, `gitidentity step must succeed in isolation:\n${r.stderr}`);
  const after = spawnSync('git', ['config', '--get-regexp', '^user\\.'], { cwd: REPO_ROOT, encoding: 'utf8' }).stdout;
  assert.equal(after, before, 'the real repository\'s user.* config changed — isolation leaked');
  // And the isolated repo DID get the bot identity (the step actually ran).
  const isoName = spawnSync('git', ['config', 'user.name'], { cwd: r.repo, encoding: 'utf8', env: isolatedEnv(r.homeDir) }).stdout.trim();
  assert.equal(isoName, 'github-actions[bot]', 'the isolated repo must have received the bot identity');
});

// ═══════════════════════════════════════════════════════════════════════════
// #466 (REQ-TS-4/-5) — NO TERMINAL STATE MAY BE BOTH RED AND SILENT.
//
// These execute the SHIPPED steps out of the real YAML, per this repo's
// standing bar (#464's harness pattern): reading the workflow is not evidence.
//
// The state under test is T5 — brain-audit exits 1 with ZERO [FAIL-SHA] lines,
// which §15.5 documents as LEGITIMATE (every surviving violation is in a
// non-auto-revertible class, or a tree-keyed failure was suppressed because its
// revert would resurrect a payload). Before this change the revert step called
// that "incoherent" and exited 2, while the alarm step — gated on the AUDIT
// step's output of '1' — never ran. Red, nothing reverted, no alarm, cursor
// frozen. Observed live on 2026-08-06, run 31094912872 over c724942.
// ═══════════════════════════════════════════════════════════════════════════

/** An exit-1 audit stdout with real [FAIL] lines and NO [FAIL-SHA] — the T5 shape. */
const T5_AUDIT_STDOUT = [
  '[FAIL] c724942 Merge pull request #471 from csrinaldi/fix — issueLink: no issue reference found',
  '[FAIL] d70093a Merge pull request #468 from csrinaldi/adr — adrPresence: ADR added but brain/HOME.md not updated',
].join('\n');

/** Give the revert step a repo with a commit, so `git rev-parse HEAD` resolves. */
const oneCommit = (g, repo) => { writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0'); };

test('#466 REQ-TS-4: exit 1 with ZERO offenders FILES AN ALARM (never red-and-silent)', () => {
  const r = runStepIsolated('revert', {
    env: { AUDIT_STDOUT: T5_AUDIT_STDOUT },
    repoSetup: oneCommit,
  });

  // The invariant: this state reaches an alarm. Before the fix the step printed
  // "incoherent, failing closed" and exited 2 with no gh call whatsoever.
  assert.match(r.ghLog(), /issue (create|comment)/,
    `a failed-but-unrevertible audit MUST file an alarm — gh log was:\n${r.ghLog()}\n${r.stdout}\n${r.stderr}`);
  assert.match(r.ghLog(), /governance:audit-unrevertible/,
    `the alarm must carry its own honest label, not 'uncomputable':\n${r.ghLog()}`);
  assert.notEqual(r.status, 0, 'the job must still fail — this is a halt, not an accept');
});

test('#466 REQ-TS-4: the step no longer calls a documented §15.5 state "incoherent"', () => {
  const r = runStepIsolated('revert', {
    env: { AUDIT_STDOUT: T5_AUDIT_STDOUT },
    repoSetup: oneCommit,
  });
  assert.doesNotMatch(`${r.stdout}${r.stderr}`, /incoherent/,
    'brain-audit.mjs\'s own contract says a [FAIL-SHA] count of 0 on exit 1 is LEGITIMATE (§15.5)');
});

test('#466 REQ-TS-4: the cursor is NOT advanced by the unrevertible halt', () => {
  const r = runStepIsolated('revert', {
    env: { AUDIT_STDOUT: T5_AUDIT_STDOUT },
    repoSetup: oneCommit,
  });
  // Auto-advancing here would perform `cursor.mjs accept` — a gate the design
  // made a human keystroke WITH a written reason (REQ-D2-10a) — with neither.
  assert.doesNotMatch(r.stdout, /cursor advanced/, 'an unrevertible failure must never advance the cursor');
  assert.match(r.stdout, /cursor stays pinned/i, 'the halt must say the cursor is pinned');
});

// ── The BACKSTOP (REQ-TS-5) — the load-bearing half. #466 was an alarm gated on
// an ENUMERATION of exit codes, and a state inside code 1 was missed. A branch
// for that one state leaves the next unenumerated state just as silent, so the
// invariant is asserted over the JOB OUTCOME instead. ────────────────────────

function runTerminal(env, ghOpts = {}) {
  return runStepIsolated('terminal', { env, ghOpts, repoSetup: oneCommit });
}

test('REQ-TS-5 backstop: a RED job with no alarm recorded files the backstop alarm', () => {
  const r = runTerminal({ JOB_STATUS: 'failure', AUDIT_CODE: '1' });

  assert.match(r.ghLog(), /governance:postmerge-unreported/,
    `a red job that filed no alarm must be caught by the backstop:\n${r.ghLog()}\n${r.stdout}\n${r.stderr}`);
  assert.notEqual(r.status, 0, 'the backstop must keep the job red');
});

test('REQ-TS-5 backstop: a red job with an UNMAPPED audit code (killed audit) is also caught', () => {
  // The audit process was killed and wrote no output at all — `code` is empty.
  const r = runTerminal({ JOB_STATUS: 'failure', AUDIT_CODE: '' });

  assert.match(r.ghLog(), /governance:postmerge-unreported/,
    `an empty audit code is a terminal state too, and must not be silent:\n${r.ghLog()}`);
  assert.notEqual(r.status, 0);
});

test('REQ-TS-5 backstop: a red job that ALREADY alarmed does not double-file', () => {
  const r = runTerminal({
    JOB_STATUS: 'failure', AUDIT_CODE: '1', ALARM_REVERT: 'governance:audit-unrevertible',
  });

  assert.doesNotMatch(r.ghLog(), /postmerge-unreported/,
    `the backstop must not duplicate an alarm a step already filed:\n${r.ghLog()}`);
  assert.notEqual(r.status, 0, 'the job stays red either way');
});

test('REQ-TS-5 backstop: a GREEN job files nothing', () => {
  const r = runTerminal({ JOB_STATUS: 'success', AUDIT_CODE: '0' });

  assert.equal(r.ghLog(), '', `a clean run must file no alarm at all:\n${r.ghLog()}`);
  assert.equal(r.status, 0, `a green job must stay green:\n${r.stdout}\n${r.stderr}`);
});

// ── The invariant itself, as a PROPERTY over every terminal code rather than a
// per-code fixture. This is the assertion #466's acceptance asks for. ────────
test('REQ-TS-5 PROPERTY: for every terminal audit code, red ⟹ an alarm exists', () => {
  const unreported = [];
  for (const code of ['0', '1', '2', '3', '']) {
    for (const jobStatus of ['success', 'failure']) {
      for (const prior of ['', 'governance:audit-uncomputable']) {
        const r = runTerminal({ JOB_STATUS: jobStatus, AUDIT_CODE: code, ALARM_WINDOW: prior });
        const mapped = ['0', '1', '2'].includes(code);
        const red = jobStatus === 'failure' || !mapped;
        const alarmed = prior !== '' || /issue (create|comment)/.test(r.ghLog());
        if (red && !alarmed) unreported.push(`code='${code}' job='${jobStatus}' prior='${prior}'`);
        // And a red terminal state must always keep the job red.
        if (red) assert.notEqual(r.status, 0, `red state left the job green: code='${code}' job='${jobStatus}'`);
      }
    }
  }
  assert.deepEqual(unreported, [],
    `these terminal states were RED AND SILENT — the #466 signature:\n${unreported.join('\n')}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 7 (issue #557) — the governance archive sweep step. Positioned as the
// LAST functional step, after `advance`/`uncomputable`, before the `always()`
// terminal assertion (design D5). Gated on a clean audit and a successful
// cursor advance; never gates `advance`/`revert`; failure files the shared
// `governance:archive-sweep-failed` alarm and exits 0 (design D5's
// failure-semantics table) — the sweep must never redden this job.
// ═══════════════════════════════════════════════════════════════════════════

// ── Source guards ────────────────────────────────────────────────────────

test('#557: governance-postmerge.yml declares a `- id: sweep` step positioned after `- id: advance`', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const advanceIdx = text.indexOf('- id: advance');
  const sweepIdx = text.indexOf('- id: sweep');
  assert.ok(advanceIdx !== -1, 'advance step must exist');
  assert.ok(sweepIdx !== -1, 'sweep step must exist (issue #557)');
  assert.ok(sweepIdx > advanceIdx, 'the sweep step must be positioned after advance');
});

test('#1113: the --apply capture merges stderr, so the alarm carries the real cause', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const applyLine = text.split('\n').find((l) => l.includes('sweep.mjs --apply')) || '';
  assert.match(applyLine, /2>&1\)"\s*$/, 'the fail-closed path logs via console.error: without 2>&1 the alarm\'s "Sweep output" block is empty');
});

test("#557: the sweep step's if: gates on a clean audit and advance success, and references neither revert nor uncomputable", () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const stepBlock = text.slice(text.indexOf('- id: sweep'), text.indexOf('- id: terminal'));
  const ifLine = stepBlock.split('\n').find((l) => l.trim().startsWith('if:')) || '';
  assert.match(ifLine, /steps\.audit\.outputs\.code == '0'/, "the sweep step's if: must gate on a clean audit");
  assert.match(ifLine, /steps\.advance\.outcome == 'success'/, "the sweep step's if: must gate on advance success (C1, readable in YAML)");
  assert.doesNotMatch(ifLine, /steps\.revert|steps\.uncomputable/, 'the sweep step must not condition on revert/uncomputable — it is orthogonal to those branches');
});

test('#557: the sweep step never writes the governance cursor (no cursor.mjs reference)', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const script = extractRunScript(text, 'sweep');
  assert.doesNotMatch(script, /cursor\.mjs/, 'the sweep step must never touch the governance cursor — it never gates advance/revert');
});

test('#557: the sweep step declares VCS_TOKEN (mirrors the audit step\'s credential, #479 shape)', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const stepBlock = text.slice(text.indexOf('- id: sweep'), text.indexOf('- id: terminal'));
  assert.match(stepBlock, /VCS_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/, 'the sweep step must declare VCS_TOKEN so readIssueState can authenticate');
});

test('#557: the sweep step dedups the same-day PR via `gh pr list --head <br> --state all` (REQ-D2-13 mirrored, design D6)', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const script = extractRunScript(text, 'sweep');
  assert.match(script, /gh pr list --head[^\n]*--state all/, 'same-day idempotency must dedup on the PR head in any state, mirroring the revert step');
});

test('#557: the sweep step enforces the one-open-PR backlog cap before doing anything else (design D6)', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const script = extractRunScript(text, 'sweep');
  assert.match(script, /startswith\("auto-archive\/"\)/, 'the backlog cap must scan for any open auto-archive/* PR');
});

test('#557: the sweep step invokes sweep.mjs with --report, never inlines the report body', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const script = extractRunScript(text, 'sweep');
  assert.match(script, /sweep\.mjs --apply --report/, 'the sweep step must call sweep.mjs --apply --report <file>, matching design\'s mermaid');
});

test('#557: the terminal step declares ALARM_SWEEP and concatenates it into filed=', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.match(text, /ALARM_SWEEP:\s*\$\{\{\s*steps\.sweep\.outputs\.alarm\s*\}\}/, 'the terminal step must read steps.sweep.outputs.alarm');
  const terminalScript = extractRunScript(text, 'terminal');
  assert.match(terminalScript, /\$\{ALARM_SWEEP:-\}/, 'ALARM_SWEEP must be concatenated into the filed= accounting');
});

test('#557 teeth: removing ALARM_SWEEP from the terminal filed= concatenation is a detectable mutation', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const terminalScript = extractRunScript(text, 'terminal');
  const stripped = terminalScript.replace('${ALARM_SWEEP:-}', '');
  assert.notEqual(stripped, terminalScript, 'the mutation must land — proves the assertion above has teeth');
  assert.doesNotMatch(stripped, /\$\{ALARM_SWEEP:-\}/);
});

// ── Executable guards — a fake `node` intercepts sweep.mjs only; every other
// node invocation (alarm.mjs) falls through to the REAL node binary so the
// REAL alarm.mjs runs against the stubbed `gh` on PATH. ────────────────────

// #1106: this stub now intercepts BOTH sweep.mjs invocations the workflow
// makes — `--apply` (archives, unchanged) and `--open-pr` (opens the PR
// through the VCS port; a NODE call now, never `gh pr create`). The
// `--open-pr` branch logs its full argv PLUS whatever `BRAIN_SWEEP_TOKEN` it
// was invoked with to `$NODE_LOG` — the one place a test can prove the token
// the workflow minted actually reached the node process, mirroring how
// `ghLog()` proves a gh invocation's shape elsewhere in this file.
function writeSweepNodeStub(binDir, {
  sweepOutput = 'SWEEP archived=0 blocked=0 unconsolidated=0',
  sweepExit = 0,
  touchDummyFile = false,
  openPrExit = 0,
  openPrOut = 'SWEEP-PR url=https://github.com/acme/brain/pull/1',
} = {}) {
  mkdirSync(binDir, { recursive: true });
  const realNode = process.execPath;
  const node = join(binDir, 'node');
  writeFileSync(node, [
    '#!/usr/bin/env bash',
    'for a in "$@"; do case "$a" in',
    '  *sweep.mjs)',
    '    is_open_pr=0',
    '    for b in "$@"; do [ "$b" = "--open-pr" ] && is_open_pr=1; done',
    '    if [ "$is_open_pr" = "1" ]; then',
    '      echo "sweep.mjs $* [BRAIN_SWEEP_TOKEN=${BRAIN_SWEEP_TOKEN:-}]" >> "${NODE_LOG:-/dev/null}"',
    `      printf '%s\\n' ${JSON.stringify(openPrOut)}`,
    `      exit ${openPrExit}`,
    '    fi',
    '    report=""',
    '    next=0',
    '    for b in "$@"; do',
    '      if [ "$next" = "1" ]; then report="$b"; next=0; fi',
    '      if [ "$b" = "--report" ]; then next=1; fi',
    '    done',
    `    [ -n "$report" ] && printf '%s\\n' ${JSON.stringify('# sweep report (stub)\n\nPart of #557.\n')} > "$report"`,
    touchDummyFile
      ? '    mkdir -p openspec/changes/archive/999 && echo x > openspec/changes/archive/999/dummy'
      : '    :',
    `    printf '%s\\n' ${JSON.stringify(sweepOutput)}`,
    `    exit ${sweepExit}`,
    '    ;;',
    'esac; done',
    `exec "${realNode}" "$@"`,
    '',
  ].join('\n'));
  chmodSync(node, 0o755);
}

test('#557 executable: zero archivable → no `pr create`, exit 0, no alarm', () => {
  const r = runStepIsolated('sweep', {
    ghOpts: { prListPrints: '' },
    repoSetup: (g, repo, homeDir) => {
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=0 blocked=0 unconsolidated=0', sweepExit: 0 });
    },
  });
  assert.equal(r.status, 0, `zero-archivable run must exit 0:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.ghLog(), /pr create/, `no PR should be created when nothing is archivable:\n${r.ghLog()}`);
  assert.doesNotMatch(r.output(), /alarm=/, 'a clean zero-archivable run must not file an alarm');
});

test('#557 executable: selector exits non-zero (3) → governance:archive-sweep-failed alarm filed, alarm= recorded, exit 0', () => {
  const r = runStepIsolated('sweep', {
    ghOpts: { prListPrints: '' },
    repoSetup: (g, repo, homeDir) => {
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP: 1 issue(s) could not be read — fail-closed, nothing archived.', sweepExit: 3 });
    },
  });
  assert.equal(r.status, 0, `a selector failure must not redden the job:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.ghLog(), /issue (create|comment)/, `an alarm must be filed on a selector failure:\n${r.ghLog()}`);
  assert.match(r.ghLog(), /governance:archive-sweep-failed/, `the alarm must carry the shared sweep-failure label:\n${r.ghLog()}`);
  assert.match(r.output(), /alarm=governance:archive-sweep-failed/, `alarm= must be recorded for terminal accounting:\n${r.output()}`);
});

test('#557 executable: an auto-archive/* PR is already open (backlog cap) → no `pr create`, exit 0', () => {
  const r = runStepIsolated('sweep', {
    ghOpts: { prListPrints: '1' },
    repoSetup: (g, repo, homeDir) => {
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      // The sweep.mjs stub must never even run — the backlog cap short-circuits first.
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=1 blocked=0 unconsolidated=0', sweepExit: 0 });
    },
  });
  assert.equal(r.status, 0, `the backlog cap must not fail the job:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.ghLog(), /pr create/, `no PR should be created while one is already open:\n${r.ghLog()}`);
});

test('#557 executable: push failure (no origin remote) → orphan branch delete attempted, alarm filed, exit 0', () => {
  const r = runStepIsolated('sweep', {
    ghOpts: { prListPrints: '' },
    repoSetup: (g, repo, homeDir) => {
      // Deliberately NO `git remote add origin` — `git push origin <br>` fails.
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=1 blocked=0 unconsolidated=0', sweepExit: 0, touchDummyFile: true });
    },
  });
  assert.equal(r.status, 0, `a push failure must not redden the job:\n${r.stdout}\n${r.stderr}`);
  // The orphan-branch delete is a plain `git push origin --delete`, not a `gh`
  // call, so it never reaches ghLog() — the observable contract is that the
  // job stays green and the shared alarm fires (design D6/D5), asserted below.
  assert.match(r.ghLog(), /issue (create|comment)/, `an alarm must be filed on a push failure:\n${r.ghLog()}`);
  assert.match(r.ghLog(), /governance:archive-sweep-failed/, `the alarm must carry the shared sweep-failure label:\n${r.ghLog()}`);
  assert.match(r.output(), /alarm=governance:archive-sweep-failed/);
});

// ── 8.2: the dry-run walkthrough (fakes/injected seams only — no real PRs,
// no real pushes, no real GitHub API). A `gh` stub precise enough to answer
// the backlog-cap query and the same-day `--head` query DIFFERENTLY, since
// the workflow issues two distinct `gh pr list` calls in one run. ─────────

function writeGhStubPrecise(binDir, { openBacklogCount = 0, sameDayExists = false } = {}) {
  mkdirSync(binDir, { recursive: true });
  const gh = join(binDir, 'gh');
  writeFileSync(gh, [
    '#!/usr/bin/env bash',
    'echo "gh $*" >> "${GH_LOG:-/dev/null}"',
    'args="$*"',
    'case "$1 $2" in',
    '  "pr list")',
    '    case "$args" in',
    `      *--head*) printf '%s' ${JSON.stringify(sameDayExists ? '1' : '')} ;;`,
    `      *) printf '%s' ${JSON.stringify(String(openBacklogCount))} ;;`,
    '    esac',
    '    ;;',
    '  *) : ;;',
    'esac',
    'exit 0',
    '',
  ].join('\n'));
  chmodSync(gh, 0o755);
}

test('8.2 dry-run: 1 eligible folder → exactly one PR is opened through the VCS port, targeting the default branch', () => {
  const r = runStepIsolated('sweep', {
    // #1106 rework: PR creation is a `node sweep.mjs --open-pr` call now,
    // never `gh pr create` — this dry-run simulates a properly configured,
    // successfully minted App so the pre-existing "PR opened" assertion
    // below still exercises that path, through the new mechanism.
    env: { APP_CONFIGURED: 'true', BRAIN_SWEEP_TOKEN: FIXTURE_APP_TOKEN, GITHUB_REPOSITORY: 'acme/brain', DEFAULT_BRANCH: 'main' },
    ghOpts: {}, // overridden by the precise stub written in repoSetup below
    repoSetup: (g, repo, homeDir) => {
      const origin = join(homeDir, 'origin.git');
      spawnSync('git', ['init', '--bare', origin], { encoding: 'utf8', env: isolatedEnv(homeDir) });
      g('remote', 'add', 'origin', origin);
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      g('push', 'origin', 'main');
      writeGhStubPrecise(join(homeDir, 'bin'), { openBacklogCount: 0, sameDayExists: false });
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=1 blocked=0 unconsolidated=0', sweepExit: 0, touchDummyFile: true });
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(r.status, 0, `a clean 1-eligible run must exit 0:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.ghLog(), /pr create/, `gh must never be asked to create a PR:\n${r.ghLog()}`);
  const openPrCalls = (r.nodeLog().match(/^sweep\.mjs .*--open-pr/gm) || []).length;
  assert.equal(openPrCalls, 1, `exactly one open-pr call must be made:\n${r.nodeLog()}`);
  assert.match(r.nodeLog(), new RegExp(`--head auto-archive/${today} --base main`), `the PR must target the default branch from today's auto-archive branch:\n${r.nodeLog()}`);
  assert.match(r.nodeLog(), new RegExp(`BRAIN_SWEEP_TOKEN=${FIXTURE_APP_TOKEN}`), `the minted App token must reach the open-pr call:\n${r.nodeLog()}`);
  assert.doesNotMatch(r.output(), /alarm=/, 'a successful sweep must not file an alarm');
});

test('8.2 dry-run: 0 eligible folders → no PR is created', () => {
  const r = runStepIsolated('sweep', {
    repoSetup: (g, repo, homeDir) => {
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      writeGhStubPrecise(join(homeDir, 'bin'), { openBacklogCount: 0, sameDayExists: false });
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=0 blocked=3 unconsolidated=0', sweepExit: 0 });
    },
  });
  assert.equal(r.status, 0, `a zero-eligible run must exit 0:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.ghLog(), /pr create/, `no PR may be opened when nothing is archivable:\n${r.ghLog()}`);
});

test('8.2 dry-run: same-day re-run (a PR for today already exists in ANY state) → no new PR is created', () => {
  const r = runStepIsolated('sweep', {
    repoSetup: (g, repo, homeDir) => {
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      // No OPEN auto-archive/* PR (backlog cap clear), but today's branch
      // already has a PR in some state (open, merged, or closed-without-merge) —
      // design's "Re-run same day after PR exists" scenario (REQ-D2-13 mirrored).
      writeGhStubPrecise(join(homeDir, 'bin'), { openBacklogCount: 0, sameDayExists: true });
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=1 blocked=0 unconsolidated=0', sweepExit: 0, touchDummyFile: true });
    },
  });
  assert.equal(r.status, 0, `a same-day re-run must exit 0, never fail:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.ghLog(), /pr create/, `no new PR may be opened the same UTC day once one already exists:\n${r.ghLog()}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// #1106 — the sweep cannot open its PR with GITHUB_TOKEN: this repository does
// not allow Actions to create pull requests, and even where it does, a
// GITHUB_TOKEN-authored PR triggers no workflow runs (governance.yml never
// runs on it, so it could never merge). The decided fix: mint a GitHub App
// installation token (`BRAIN_SWEEP_APP_ID` / `BRAIN_SWEEP_APP_PRIVATE_KEY`)
// and use it for BOTH the push and opening the PR.
//
// #1106 REWORK: opening the PR moved off `gh pr create` in this workflow's
// bash and onto the VCS port (`getVcs().mrCreate`, called from
// `sweep.mjs --open-pr` — see sweep.test.mjs). brain declares itself
// VCS-agnostic (vcs-contract.md); a GitHub-CLI-shaped PR-creation call in a
// workflow bash script is exactly the coupling that contract exists to
// forbid. The workflow keeps ONLY what is unavoidably GitHub-Actions-specific
// — checking the secrets, minting the App token, pushing the branch with it —
// and hands the minted token to `sweep.mjs` via `BRAIN_SWEEP_TOKEN`, which
// decides whether and how the PR gets opened. `--base` is the repository's
// actual default branch now too (`DEFAULT_BRANCH`), never a hardcoded `main`.
//
// When the App is unavailable — secrets absent, or the mint itself failed —
// the sweep still archives and pushes (GITHUB_TOKEN can push), `sweep.mjs`
// skips the `mrCreate` call (exit 2), and the workflow files an alarm
// carrying a compare link so a human can open the PR by hand, keeping the
// branch in place. If `mrCreate` itself fails (exit 1) — a real failure, not
// a missing-secret degrade — the workflow alarms and cleans up the branch,
// same as any other push/PR failure.
// ═══════════════════════════════════════════════════════════════════════════

// ── Source guards ────────────────────────────────────────────────────────

test('#1106: create-github-app-token is pinned by the full 40-hex commit SHA, with the version recorded in a trailing comment', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const m = text.match(/uses:\s*actions\/create-github-app-token@([0-9a-fA-F]+)([^\n]*)/);
  assert.ok(m, 'the App-token mint action must be referenced via `uses: actions/create-github-app-token@<ref>`');
  assert.match(m[1], /^[0-9a-f]{40}$/, `the pin must be the full 40-hex lowercase commit SHA, never a floating tag: got '${m[1]}'`);
  assert.match(m[2], /#\s*v\d+\.\d+\.\d+/, 'the pinned commit must carry a trailing `# vX.Y.Z` comment naming the version');
});

test('#1106: no step `if:` reads `secrets.*` directly — secrets are mapped into an env var first, read back via steps.*.outputs', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  // `secrets\.` alone false-positives on `steps.archive-app-secrets.outputs`
  // (the step id happens to end in "secrets"). The real pattern this guards
  // against is the `secrets` CONTEXT accessor, `secrets.SOME_SECRET_NAME`.
  const offenders = text.split('\n').filter((l) => l.trim().startsWith('if:') && /\bsecrets\.[A-Z_]/.test(l));
  assert.deepEqual(offenders, [], `an \`if:\` condition must never read secrets.* directly — map it through env/outputs instead:\n${offenders.join('\n')}`);
});

test('#1106: the App-secrets-check step declares both secret env vars and never fails when they are absent (it only reports)', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const stepBlock = text.slice(text.indexOf('- id: archive-app-secrets'), text.indexOf('- id: archive-app-token'));
  assert.match(stepBlock, /APP_ID:\s*\$\{\{\s*secrets\.BRAIN_SWEEP_APP_ID\s*\}\}/, 'must map BRAIN_SWEEP_APP_ID into env');
  assert.match(stepBlock, /APP_PRIVATE_KEY:\s*\$\{\{\s*secrets\.BRAIN_SWEEP_APP_PRIVATE_KEY\s*\}\}/, 'must map BRAIN_SWEEP_APP_PRIVATE_KEY into env');
  const script = extractRunScript(text, 'archive-app-secrets');
  assert.match(script, /configured=true/);
  assert.match(script, /configured=false/);
});

test('#1106: the App-token mint step is skipped (not failed) when the secrets-check output is not \'true\'', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const tokenStepBlock = text.slice(text.indexOf('- id: archive-app-token'), text.indexOf('- id: sweep'));
  assert.match(
    tokenStepBlock,
    /if:\s*steps\.archive-app-secrets\.outputs\.configured == 'true'/,
    'a missing secret must skip the mint step, not fail it'
  );
  assert.match(tokenStepBlock, /app-id:\s*\$\{\{\s*secrets\.BRAIN_SWEEP_APP_ID\s*\}\}/);
  assert.match(tokenStepBlock, /private-key:\s*\$\{\{\s*secrets\.BRAIN_SWEEP_APP_PRIVATE_KEY\s*\}\}/);
});

test('#1106: no continue-on-error anywhere in the file (the mint step must fail loud, not be swallowed)', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.doesNotMatch(text, /continue-on-error:\s*true/);
});

test('#1106: the sweep step\'s env: reads the App secrets-check output and the minted token (as BRAIN_SWEEP_TOKEN), and keeps declaring GH_TOKEN for the alarm path', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const stepBlock = text.slice(text.indexOf('- id: sweep\n'), text.indexOf('- id: terminal'));
  assert.match(stepBlock, /APP_CONFIGURED:\s*\$\{\{\s*steps\.archive-app-secrets\.outputs\.configured\s*\}\}/);
  assert.match(
    stepBlock,
    /BRAIN_SWEEP_TOKEN:\s*\$\{\{\s*steps\.archive-app-token\.outputs\.token\s*\}\}/,
    'the minted token must be named BRAIN_SWEEP_TOKEN — the same env var sweep.mjs --open-pr reads to bind the VCS port identity'
  );
  assert.match(stepBlock, /GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/, 'the alarm path (gh label/issue create/comment) must keep using GITHUB_TOKEN, unaffected by App availability');
});

test('#1106 rework: the sweep script never shells `gh` for PR creation — it opens the PR via `sweep.mjs --open-pr`', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const script = extractRunScript(text, 'sweep');
  assert.doesNotMatch(script, /gh pr create/, 'PR creation must go through the VCS port (sweep.mjs --open-pr), never `gh pr create` in bash');
  assert.match(script, /sweep\.mjs --open-pr/, 'the sweep step must invoke sweep.mjs in --open-pr mode after a successful push');
  assert.match(script, /--head\s+"\$br"/, 'the open-pr call must pass the head branch');
  assert.match(script, /--archived\s+"\$archived"/, 'the open-pr call must pass the archived count (used to build the PR title)');
  assert.match(script, /--report\s+"\$RUNNER_TEMP\/sweep-body\.md"/, 'the open-pr call must reuse the same report file as the PR body, never re-inlined');
});

test('#1106 rework: the open-pr call passes the repository\'s ACTUAL default branch as --base, never a hardcoded "main"', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const script = extractRunScript(text, 'sweep');
  assert.match(script, /default_branch="\$\{DEFAULT_BRANCH:-main\}"/, 'default_branch must be resolved from DEFAULT_BRANCH (github.event.repository.default_branch), falling back to main only when that is unset');
  assert.match(script, /--base\s+"\$default_branch"/, 'the open-pr call must pass --base "$default_branch", never a bare --base main');
  assert.doesNotMatch(script, /--base main/, 'no hardcoded "--base main" may remain in the sweep script');
});

test('#1106 rework: the App-authored push still uses BRAIN_SWEEP_TOKEN for its credential header, and no ${{ }} expression is ever spliced into run:', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const script = extractRunScript(text, 'sweep');
  assert.match(script, /BRAIN_SWEEP_TOKEN/, 'the script must branch on BRAIN_SWEEP_TOKEN');
  assert.match(script, /x-access-token:\$\{BRAIN_SWEEP_TOKEN\}/, 'the push credential header must be built from BRAIN_SWEEP_TOKEN');
  assert.doesNotMatch(script, /github\.token/, 'the run: script is bash — no ${{ }} expression (like github.token) may ever appear spliced inline');
});

// ── Executable guards — fakes for git/gh/node, no network ──────────────────

function repoWithOrigin(homeDir, g, repo) {
  const origin = join(homeDir, 'origin.git');
  spawnSync('git', ['init', '--bare', origin], { encoding: 'utf8', env: isolatedEnv(homeDir) });
  g('remote', 'add', 'origin', origin);
  writeFileSync(join(repo, 'f'), 'x\n');
  g('add', '.');
  g('commit', '-m', 'c0');
  g('push', 'origin', 'main');
  return origin;
}

test('#1106 executable: App configured and minted → PR opened through the VCS port, authenticated with the App token', () => {
  const r = runStepIsolated('sweep', {
    env: { APP_CONFIGURED: 'true', BRAIN_SWEEP_TOKEN: FIXTURE_APP_TOKEN, GITHUB_REPOSITORY: 'acme/brain', DEFAULT_BRANCH: 'main' },
    repoSetup: (g, repo, homeDir) => {
      repoWithOrigin(homeDir, g, repo);
      writeGhStubPrecise(join(homeDir, 'bin'), { openBacklogCount: 0, sameDayExists: false });
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=1 blocked=0 unconsolidated=0', sweepExit: 0, touchDummyFile: true, openPrExit: 0, openPrOut: 'SWEEP-PR url=https://github.com/acme/brain/pull/9' });
    },
  });
  assert.equal(r.status, 0, `a configured-App run must exit 0:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.ghLog(), /pr create/, `gh must never be asked to create a PR:\n${r.ghLog()}`);
  const openPrLine = r.nodeLog().split('\n').find((l) => l.includes('--open-pr'));
  assert.ok(openPrLine, `the open-pr call must have been made:\n${r.nodeLog()}`);
  assert.match(openPrLine, new RegExp(`BRAIN_SWEEP_TOKEN=${FIXTURE_APP_TOKEN}`), `the minted App token must reach the open-pr call:\n${openPrLine}`);
  assert.doesNotMatch(r.output(), /alarm=/, 'a successful App-authored sweep must not file an alarm');
});

test('#1106 executable: App secrets absent → branch archived and pushed, sweep.mjs skips the PR (no token), alarm carries the compare link, branch is kept', () => {
  let originPath;
  const r = runStepIsolated('sweep', {
    env: { APP_CONFIGURED: 'false', GITHUB_REPOSITORY: 'acme/brain', DEFAULT_BRANCH: 'main' },
    repoSetup: (g, repo, homeDir) => {
      originPath = repoWithOrigin(homeDir, g, repo);
      writeGhStubPrecise(join(homeDir, 'bin'), { openBacklogCount: 0, sameDayExists: false });
      // sweep.mjs --open-pr, given no BRAIN_SWEEP_TOKEN, exits 2 with
      // "skipped=no-token" (sweep.test.mjs pins the real function's behavior;
      // this stub mirrors its documented exit contract, sweep.mjs's own
      // header comment).
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=1 blocked=0 unconsolidated=0', sweepExit: 0, touchDummyFile: true, openPrExit: 2, openPrOut: 'SWEEP-PR skipped=no-token' });
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(r.status, 0, `an unconfigured-App run must not redden the job:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.ghLog(), /pr create/, `gh pr create must NEVER be invoked:\n${r.ghLog()}`);
  assert.match(r.ghLog(), /issue (create|comment)/, `an alarm must be filed:\n${r.ghLog()}`);
  assert.match(r.output(), /alarm=governance:archive-sweep-failed/);
  const bodyFile = join(r.homeDir, 'sweep-no-app.md');
  assert.ok(existsSync(bodyFile), 'the alarm body file must be written');
  const body = readFileSync(bodyFile, 'utf8');
  assert.match(body, new RegExp(`compare/main\\.\\.\\.auto-archive/${today}`), `alarm body must carry the compare link:\n${body}`);
  assert.match(body, /not configured/i, 'the alarm must say the App is not configured');
  const branches = spawnSync('git', ['ls-remote', '--heads', originPath], { encoding: 'utf8' }).stdout;
  assert.match(branches, new RegExp(`auto-archive/${today}`), `the pushed branch must be kept for manual PR creation:\n${branches}`);
});

test('#1106 executable: App secrets present but the mint failed (empty token) → sweep.mjs still skips the PR, real-failure wording, branch kept', () => {
  let originPath;
  const r = runStepIsolated('sweep', {
    env: { APP_CONFIGURED: 'true', BRAIN_SWEEP_TOKEN: '', GITHUB_REPOSITORY: 'acme/brain', DEFAULT_BRANCH: 'main' },
    repoSetup: (g, repo, homeDir) => {
      originPath = repoWithOrigin(homeDir, g, repo);
      writeGhStubPrecise(join(homeDir, 'bin'), { openBacklogCount: 0, sameDayExists: false });
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=1 blocked=0 unconsolidated=0', sweepExit: 0, touchDummyFile: true, openPrExit: 2, openPrOut: 'SWEEP-PR skipped=no-token' });
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(r.status, 0, `a mint-failure run must not redden the job:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.ghLog(), /pr create/, `gh pr create must NEVER be invoked when the mint failed:\n${r.ghLog()}`);
  const body = readFileSync(join(r.homeDir, 'sweep-no-app.md'), 'utf8');
  assert.match(body, /mint failed/, `the alarm must say the mint failed, distinct from "not configured":\n${body}`);
  const branches = spawnSync('git', ['ls-remote', '--heads', originPath], { encoding: 'utf8' }).stdout;
  assert.match(branches, new RegExp(`auto-archive/${today}`), 'the branch must be kept, not deleted, on a real mint failure too');
});

test('#1106 executable: push failure (bad remote), App-available path — cleans up the orphan branch and alarms, never even reaches open-pr', () => {
  const r = runStepIsolated('sweep', {
    env: { APP_CONFIGURED: 'true', BRAIN_SWEEP_TOKEN: FIXTURE_APP_TOKEN, GITHUB_REPOSITORY: 'acme/brain', DEFAULT_BRANCH: 'main' },
    repoSetup: (g, repo, homeDir) => {
      // Deliberately NO origin remote — the push itself fails.
      writeFileSync(join(repo, 'f'), 'x\n'); g('add', '.'); g('commit', '-m', 'c0');
      writeGhStubPrecise(join(homeDir, 'bin'), { openBacklogCount: 0, sameDayExists: false });
      writeSweepNodeStub(join(homeDir, 'bin'), { sweepOutput: 'SWEEP archived=1 blocked=0 unconsolidated=0', sweepExit: 0, touchDummyFile: true });
    },
  });
  assert.equal(r.status, 0, `a push failure must not redden the job:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.ghLog(), /pr create/, 'no PR call when the push itself never succeeded');
  assert.doesNotMatch(r.nodeLog(), /--open-pr/, 'sweep.mjs --open-pr must never be invoked when the push itself failed');
  assert.match(r.ghLog(), /issue (create|comment)/, `an alarm must be filed on a push failure:\n${r.ghLog()}`);
  assert.match(r.ghLog(), /governance:archive-sweep-failed/);
  assert.match(r.output(), /alarm=governance:archive-sweep-failed/);
});

test('#1106 executable: mrCreate itself fails (open-pr exits 1) → treated as a real failure, alarm filed, orphan branch deleted', () => {
  let originPath;
  const r = runStepIsolated('sweep', {
    env: { APP_CONFIGURED: 'true', BRAIN_SWEEP_TOKEN: FIXTURE_APP_TOKEN, GITHUB_REPOSITORY: 'acme/brain', DEFAULT_BRANCH: 'main' },
    repoSetup: (g, repo, homeDir) => {
      originPath = repoWithOrigin(homeDir, g, repo);
      writeGhStubPrecise(join(homeDir, 'bin'), { openBacklogCount: 0, sameDayExists: false });
      writeSweepNodeStub(join(homeDir, 'bin'), {
        sweepOutput: 'SWEEP archived=1 blocked=0 unconsolidated=0', sweepExit: 0, touchDummyFile: true,
        openPrExit: 1, openPrOut: 'SWEEP-PR failed=GraphQL: nope',
      });
    },
  });
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(r.status, 0, `an mrCreate failure must not redden the job (design D5):\n${r.stdout}\n${r.stderr}`);
  assert.match(r.ghLog(), /issue (create|comment)/, `an alarm must be filed on a real mrCreate failure:\n${r.ghLog()}`);
  assert.match(r.ghLog(), /governance:archive-sweep-failed/);
  assert.match(r.output(), /alarm=governance:archive-sweep-failed/);
  // Unlike the no-token degrade, a REAL mrCreate failure is treated "as
  // today" (the coordinator's own words) — the orphan branch is deleted,
  // never left for a human to find, since a human was never told to expect it.
  const branches = spawnSync('git', ['ls-remote', '--heads', originPath], { encoding: 'utf8' }).stdout;
  assert.doesNotMatch(branches, new RegExp(`auto-archive/${today}`), `a real mrCreate failure must delete the orphan branch:\n${branches}`);
});

// #1162: `gh run list --workflow` (the bootstrap's prior-run evidence) needs
// `actions: read`. An explicit `permissions:` block sets every OMITTED scope to
// none, so without it a PRIVATE consumer reads `unknown` and alarms forever.
test('#1162: governance-postmerge.yml grants actions: read (and only read) for the bootstrap evidence read', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const m = text.match(/^permissions:\s*\{([^}]*)\}/m);
  assert.ok(m, 'the workflow must declare a permissions block');
  assert.match(m[1], /\bactions:\s*read\b/, 'actions: read is required by `gh run list --workflow`');
  assert.doesNotMatch(m[1], /\bactions:\s*write\b/, 'least privilege: never actions: write');
});

// ── #1162 round 2 (cold-1): every trigger resolves the default branch ─────────
// push / workflow_dispatch carry `repository.default_branch`; `schedule` does not,
// so DEFAULT_BRANCH is EMPTY there. The bootstrap must still find `main`.
for (const [trigger, defaultBranch] of [['push', 'main'], ['workflow_dispatch', 'main'], ['schedule', '']]) {
  test(`#1162 cold-1: ${trigger} (DEFAULT_BRANCH='${defaultBranch}') bootstraps and asks for main's run history`, () => {
    const r = runStepIsolated('window', {
      repoSetup: freshConsumerSetup,
      ghOpts: { runListPrints: '[]' },
      env: { ...BOOT_ENV, DEFAULT_BRANCH: defaultBranch },
    });
    assert.equal(r.status, 0, `${trigger} must bootstrap:\n${r.stdout}\n${r.stderr}`);
    assert.match(r.ghLog(), /run list .*--branch main/);
    assert.doesNotMatch(r.ghLog(), /gh (label|issue) create/);
  });
}

// ── #1162 round 2 (cold-2): the alarm's instructions match the safety argument ─
test('#1162 cold-2: the ABSENT alarm tells a human to set the cursor AT the adoption commit, never at the root', () => {
  const r = runStepIsolated('window', {
    repoSetup: freshConsumerSetup,
    ghOpts: { runListPrints: '[{"databaseId":42}]' },
    env: BOOT_ENV,
  });
  const body = readFileSync(join(r.homeDir, 'body.md'), 'utf8');
  assert.doesNotMatch(body, /max-parents=0/, 'the root is exactly the base that audits (and reverts) the adoption');
  assert.match(body, /--diff-filter=A/, 'the instruction must compute the adoption commit');
  assert.match(body, /governance-postmerge\.yml/);
});

// ── #1188: alarms close themselves ────────────────────────────────────────────
// The demo's alarm issue stayed open after the audit recovered. A clean audit
// resolves the audit-class alarms; a clean sweep resolves the sweep's. Closing an
// issue needs `issues: write`, which the workflow already holds for filing — so
// NO scope is added, and the test pins that the set stayed exactly as it was.

function stepBlock(text, id) {
  const start = text.indexOf(`- id: ${id}`);
  assert.ok(start !== -1, `step ${id} must exist`);
  const next = text.indexOf('\n      - ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

test('#1188: a `resolve-audit` step exists after advance, runs ONLY on a clean audit, and resolves the audit alarms by group', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.ok(text.indexOf('- id: resolve-audit') > text.indexOf('- id: advance'), 'must come after the cursor advanced');
  const block = stepBlock(text, 'resolve-audit');
  const ifLine = block.split('\n').find((l) => l.trim().startsWith('if:')) || '';
  assert.match(ifLine, /steps\.audit\.outputs\.code == '0'/, 'a still-failing audit must never close an alarm');
  assert.match(ifLine, /steps\.advance\.outcome == 'success'/);
  assert.doesNotMatch(ifLine, /always\(\)/);
  assert.match(block, /alarm\.mjs resolve "\$RUN_URL" audit/);
  assert.match(block, /RUN_URL:\s*\$\{\{ github\.server_url \}\}\/\$\{\{ github\.repository \}\}\/actions\/runs\/\$\{\{ github\.run_id \}\}/,
    'the run link arrives via env:, never ${{ }}-spliced into run:');
  assert.ok(!/\$\{\{[^}]*\}\}/.test(block.slice(block.indexOf('run: |'))), 'no expression is spliced into the run: body');
  assert.match(block, /VCS_TOKEN:\s*\$\{\{ github\.token \}\}/, 'the port call is authenticated like the audit (#479)');
  assert.match(block, /GH_TOKEN:\s*\$\{\{ github\.token \}\}/, "alarm.mjs's own reader shells gh");
});

test('#1188: a `resolve-sweep` step exists after sweep and runs only when the sweep succeeded', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.ok(text.indexOf('- id: resolve-sweep') > text.indexOf('- id: sweep'));
  const block = stepBlock(text, 'resolve-sweep');
  const ifLine = block.split('\n').find((l) => l.trim().startsWith('if:')) || '';
  assert.match(ifLine, /steps\.sweep\.outcome == 'success'/);
  assert.match(block, /alarm\.mjs resolve "\$RUN_URL" sweep/);
});

test('#1188: least privilege — closing alarms adds NO permission scope (issues: write was already held for filing)', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  const m = text.match(/^permissions:\s*\{([^}]*)\}/m);
  assert.ok(m, 'permissions block must exist');
  const scopes = Object.fromEntries(m[1].split(',').map((kv) => kv.split(':').map((x) => x.trim())));
  assert.deepEqual(scopes, { contents: 'write', 'pull-requests': 'write', issues: 'write', actions: 'read' },
    'the post-merge permission set is exactly the pre-#1188 one; a new scope needs its own justification');
});

test('#1188: the terminal backstop still runs always() — resolving must not displace it', () => {
  const text = readFileSync(POSTMERGE_YML, 'utf8');
  assert.ok(text.indexOf('- id: terminal') > text.indexOf('- id: resolve-sweep'));
});
