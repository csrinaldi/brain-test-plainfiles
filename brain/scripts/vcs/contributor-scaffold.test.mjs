// contributor-scaffold.test.mjs — the drift guards for the contributor-facing
// governance scaffold (issue #570).
//
// Every test here is written to go RED on a specific regression, not to
// describe the current text:
//   · the scaffold offering a `type:*` value that is not in the declared set
//     (this is how `type:breaking-change` survived — a drift between rare edits);
//   · the two providers' texts diverging (two hand-maintained copies is #340);
//   · the emitted files on disk drifting from the one source that renders them;
//   · a provider's consumer receiving no scaffold at all (proved by running the
//     REAL installer over the REAL manifest, never by reading managed-paths.mjs);
//   · the closing-reference form the scaffold prints failing the gate that parses
//     it — proved through `runCheck('issue-link', …)`, the entrypoint both
//     providers' pipelines invoke, once per provider;
//   · any brain-owned file claiming again that the `decision` label arms a gate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  SCAFFOLD_TEMPLATE,
  SCAFFOLD_PROVIDERS,
  TYPE_LABELS,
  CLOSING_KEYWORDS,
  CHAIN_KEYWORD,
  GATE_SUMMARY,
  scaffoldDelivery,
  renderScaffold,
  approvedLabelFor,
} from './contributor-scaffold.mjs';
import { GOVERNANCE_JOBS } from './governance-checks.mjs';
import { evaluateActor } from './actor-check.mjs';
import { evaluateBrainWritesReviewed } from './brain-writes-reviewed.mjs';
import { runPhaseOrderCheck, evaluatePhaseOrder } from './phase-order-check.mjs';
import { issueLink } from '../governance/checks/issue-link.mjs';
import { runCheck } from '../governance/run-check.mjs';
import { managed, local, managedStrategy, STRATEGY } from '../../core/managed-paths.mjs';
import { copyManaged, strategyFor } from '../lib/installer.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * These test files travel to every consumer under `brain/scripts/**` (COPY), and a
 * consumer's `npm test` may well glob them the way brain's own package.json does.
 * Three tests below read the TREE rather than pure functions, and their subject is
 * BRAIN'S OWN source tree — asserting brain's bytes are on a consumer's disk turns
 * red for the consumer doing exactly what `STRATEGY.REFUSE` grants them (rewriting
 * their own scaffold), and the tree sweep would police files brain does not own.
 *
 * `.brain-source` is the marker `.github/workflows/governance.yml` already uses for
 * precisely this distinction — present only in brain's source repo, never a managed
 * path, so never vendored. Same idiom, same reason.
 */
const IS_BRAIN_SOURCE = existsSync(join(REPO_ROOT, '.brain-source'));

// ── one source, per-provider emission ───────────────────────────────────────

test('renderScaffold is a pure substitution over the ONE neutral template — the provider texts cannot diverge (#340, #570)', () => {
  for (const provider of SCAFFOLD_PROVIDERS) {
    const d = scaffoldDelivery(provider);
    const rendered = renderScaffold(provider);
    // Reverse the substitution: the rendered text must fold back EXACTLY onto
    // the template. A hand-edit to one provider's emitted text (or a second
    // source of that text) cannot survive this.
    //
    // `abbr` folds on WORD BOUNDARIES. An unanchored split turned any uppercase
    // PR/MR substring — PROCESS, PROVIDER, IMPROVE — into `{{abbr}}OCESS` and
    // reported it as a divergence that did not exist: a guard that cries wolf on
    // ordinary prose gets edited away, and then it guards nothing.
    const folded = rendered
      .split(d.path).join('{{path}}')
      .split(approvedLabelFor(provider)).join('{{approvedLabel}}')
      .split(d.nounTitle).join('{{Noun}}')
      .split(d.noun).join('{{noun}}')
      .replace(new RegExp(`\\b${d.abbr}\\b`, 'g'), '{{abbr}}');
    assert.equal(folded, SCAFFOLD_TEMPLATE,
      `${provider}'s emitted text is not the neutral template with its vocabulary substituted`);
  }
});

test('the fold tolerates ordinary prose containing the abbreviation as a substring (#570)', () => {
  // Pins the fix, not the bug: a template word like PROCESS must not read as `{{abbr}}`.
  for (const provider of SCAFFOLD_PROVIDERS) {
    const d = scaffoldDelivery(provider);
    const sample = `PROCESS ${d.abbr} IMPROVE`;
    assert.equal(sample.replace(new RegExp(`\\b${d.abbr}\\b`, 'g'), '{{abbr}}'), 'PROCESS {{abbr}} IMPROVE');
  }
});

test('the neutral template carries no provider vocabulary of its own (#570)', () => {
  assert.doesNotMatch(SCAFFOLD_TEMPLATE, /pull request|merge request|\bPR\b|\bMR\b/i,
    'the source must be neutral — vocabulary belongs to the provider delivery record');
  assert.doesNotMatch(SCAFFOLD_TEMPLATE, /\.github\/|\.gitlab\//,
    'the source must name no provider path — delivery is the provider-specific half');
  assert.doesNotMatch(SCAFFOLD_TEMPLATE, /status::?approved/,
    'the approved label is per-provider (GitLab scopes it `::`) — it is read from approved-label.mjs, never spelled here');
});

test('each provider prints the approved label in the form ITS OWN gate compares against (#570)', () => {
  assert.equal(approvedLabelFor('github'), 'status:approved');
  assert.equal(approvedLabelFor('gitlab'), 'status::approved');
  assert.match(renderScaffold('github'), /`status:approved`/);
  assert.match(renderScaffold('gitlab'), /`status::approved`/);
  assert.doesNotMatch(renderScaffold('gitlab'), /`status:approved`/,
    'GitLab contributors must not be told to look for a label their gate does not compare against');
});

test('the GitLab scaffold is delivered as Default.md — the only name GitLab auto-applies (#570)', () => {
  // The PR that added this called the name load-bearing; nothing pinned it, so a
  // rename to any other basename shipped "a scaffold that does not scaffold" green.
  assert.equal(scaffoldDelivery('gitlab').path, '.gitlab/merge_request_templates/Default.md');
  assert.equal(scaffoldDelivery('github').path, '.github/PULL_REQUEST_TEMPLATE.md');
});

test('each provider render speaks its OWN vocabulary and never the other\'s (#570)', () => {
  const gh = renderScaffold('github');
  const gl = renderScaffold('gitlab');
  assert.match(gh, /pull request/);
  assert.doesNotMatch(gh, /merge request/);
  assert.match(gl, /merge request/);
  assert.doesNotMatch(gl, /pull request/);
});

test('scaffoldDelivery refuses an unknown provider rather than emitting a GitHub-shaped default (#570)', () => {
  assert.throws(() => scaffoldDelivery('bitbucket'), /bitbucket/);
  assert.throws(() => renderScaffold(undefined), /provider/i);
});

// ── the `type:*` set the scaffold offers ────────────────────────────────────

/** Every `type:*` token the rendered scaffold offers a contributor. */
function offeredTypeLabels(rendered) {
  return [...new Set([...rendered.matchAll(/`(type:[a-z-]+)`/g)].map(m => m[1]))].sort();
}

test('every type:* value the scaffold offers is in the declared label set, and none is missing (#570)', () => {
  const declared = TYPE_LABELS.map(t => t.label).sort();
  assert.ok(declared.length > 0, 'sanity: the declared type:* set must be non-empty');
  for (const provider of SCAFFOLD_PROVIDERS) {
    assert.deepEqual(offeredTypeLabels(renderScaffold(provider)), declared,
      `${provider}'s scaffold must offer EXACTLY the declared type:* labels — no extra, none dropped`);
  }
});

test('the declared type:* set does not contain type:breaking-change (measured 404 on csrinaldi/brain, 2026-08-13, #570)', () => {
  const declared = TYPE_LABELS.map(t => t.label);
  assert.ok(!declared.includes('type:breaking-change'),
    'type:breaking-change is not a label in this repo — offering it makes "exactly one type:*" unsatisfiable');
  for (const provider of SCAFFOLD_PROVIDERS) {
    assert.doesNotMatch(renderScaffold(provider), /type:breaking-change/);
  }
});

test('every declared type:* label carries a description the scaffold can print (#570)', () => {
  for (const t of TYPE_LABELS) {
    assert.match(t.label, /^type:[a-z-]+$/);
    assert.ok(typeof t.description === 'string' && t.description.length > 0, `${t.label} needs a description`);
  }
});

// ── the gate table ──────────────────────────────────────────────────────────

test('the scaffold describes EXACTLY the governance jobs that exist (GOVERNANCE_JOBS, #570)', () => {
  assert.deepEqual(Object.keys(GATE_SUMMARY).sort(), [...GOVERNANCE_JOBS].sort(),
    'a gate the scaffold describes but that does not exist (or vice versa) is the same defect class as the label drift');
  for (const provider of SCAFFOLD_PROVIDERS) {
    const rendered = renderScaffold(provider);
    for (const job of GOVERNANCE_JOBS) {
      assert.match(rendered, new RegExp(`\`${job}\``), `${provider}'s scaffold never names the ${job} gate`);
    }
  }
});

// ── the closing reference, proved against the parser, per provider ──────────

/** The fill-in closing-reference line the scaffold gives the contributor. */
function fillInLine(rendered) {
  const line = rendered.split('\n').find(l => /^[A-Za-z]+ #$/.test(l.trim()));
  assert.ok(line, 'the scaffold must give the contributor a fill-in closing-reference line');
  return line.trim();
}

test('the fill-in closing reference the scaffold prints is accepted by the parser (#570)', () => {
  for (const provider of SCAFFOLD_PROVIDERS) {
    const filled = `${fillInLine(renderScaffold(provider))}570`;
    assert.equal(issueLink(filled).pass, true,
      `${provider}: "${filled}" must satisfy checks/issue-link.mjs`);
  }
});

test('every closing keyword the scaffold names is accepted by the parser; a non-keyword is not (#570)', () => {
  for (const keyword of CLOSING_KEYWORDS) {
    assert.equal(issueLink(`${keyword} #570`).pass, true, `${keyword} is printed as accepted but the parser rejects it`);
  }
  assert.equal(issueLink('Addresses #570').pass, false, 'sanity: the parser is not accepting everything');
  assert.equal(issueLink(`${CHAIN_KEYWORD} #570`).pass, true);
});

test('the keyword list the scaffold PRINTS is the list the tests just proved (#570)', () => {
  for (const provider of SCAFFOLD_PROVIDERS) {
    const rendered = renderScaffold(provider);
    const line = rendered.split('\n').find(l => l.includes('Accepted closing keywords'));
    assert.ok(line, `${provider}: the scaffold must print the accepted closing keywords`);
    const printed = [...new Set([...line.matchAll(/`([A-Za-z]+)`/g)].map(m => m[1]))].sort();
    assert.deepEqual(printed, [...CLOSING_KEYWORDS].sort());
  }
});

test('a body made from the scaffold passes the REAL issue-link gate, once per provider (#570)', async () => {
  const approvedLabel = { github: 'status:approved', gitlab: 'status::approved' };
  for (const provider of SCAFFOLD_PROVIDERS) {
    const body = renderScaffold(provider).replace(/^([A-Za-z]+) #$/m, '$1 #570');
    const result = await runCheck('issue-link', {
      ctx: { body, provider, targetBranch: 'main', defaultBranch: 'main' },
      fetchIssue: async (n) => {
        assert.equal(n, 570, `${provider}: the gate must extract the issue number from the filled scaffold`);
        return { labels: [approvedLabel[provider]] };
      },
      readConfig: () => ({}),
    });
    assert.deepEqual(result, { pass: true }, `${provider}: the emitted scaffold does not satisfy its own gate`);
  }
});

test('the scaffold\'s stated slice rule matches the gate: "Part of #N" passes off the default branch and fails on it (#570)', async () => {
  for (const provider of SCAFFOLD_PROVIDERS) {
    const body = renderScaffold(provider).replace(/^[A-Za-z]+ #$/m, `${CHAIN_KEYWORD} #570`);
    const deps = {
      fetchIssue: async () => ({ labels: [provider === 'gitlab' ? 'status::approved' : 'status:approved'] }),
      readConfig: () => ({}),
    };
    const slice = await runCheck('issue-link', {
      ...deps, ctx: { body, provider, targetBranch: 'feature/tracker', defaultBranch: 'main' },
    });
    assert.equal(slice.pass, true, `${provider}: a slice targeting a tracker branch may use the chain form`);
    const integration = await runCheck('issue-link', {
      ...deps, ctx: { body, provider, targetBranch: 'main', defaultBranch: 'main' },
    });
    assert.equal(integration.pass, false, `${provider}: the chain form must NOT satisfy a default-branch target`);
  }
});

// ── the gate rows, against the code they describe ───────────────────────────
//
// The first version of this table stated three rows the code does not implement,
// and the only assertion over it was "every job name appears". A row is a CLAIM;
// where the claim is mechanically checkable, it is checked here. The rows that
// remain prose-only (`actor-check`, `phase-order`, `brain-writes-reviewed`,
// `diff-size`) are named as such rather than implied to be covered.

test('the memory-gate row describes BOTH pipeline wirings, because the gate has both (#570)', async () => {
  // runCheck dispatches memory-gate to the ISSUE-SCOPED evaluator whenever the
  // pipeline handed it a description carrying an extractable reference, and to the
  // repo-scoped one when it did not. GitHub's job passes no body; GitLab's context
  // loader always fetches the MR description. A row asserting one of those two is
  // false on the other provider — which is what shipped, on the GitLab file this
  // very change invented.
  const records = [{ type: 'session_summary', issue: 12 }];
  // #1024 incident (batch 2): `records` scores a MISS against issue #570
  // (D3's lazy union), so `withBody` below reaches the default-branch
  // reader — injected as a hermetic fake here, never left to the production
  // default (which would otherwise touch the REAL repo's git state from
  // this test's real cwd).
  const deps = { readRecords: () => records, readConfig: () => ({}), readDefaultBranchRecords: () => ({ records: [], error: null }) };
  const filled = renderScaffold('gitlab').replace(/^([A-Za-z]+) #$/m, '$1 #570');

  const withBody = await runCheck('memory-gate', {
    ...deps,
    ctx: { body: filled, provider: 'gitlab', targetBranch: 'main', defaultBranch: 'main' },
  });
  assert.equal(withBody.pass, false,
    'a body-carrying pipeline scopes memory-gate to the linked issue — an unrelated session_summary does not satisfy it');

  const withoutBody = await runCheck('memory-gate', {
    ...deps,
    ctx: { body: null, provider: 'github', targetBranch: 'main', defaultBranch: 'main' },
  });
  assert.equal(withoutBody.pass, true,
    'a pipeline that passes no body degrades to the repo-scoped question');

  for (const provider of SCAFFOLD_PROVIDERS) {
    const row = GATE_SUMMARY['memory-gate'];
    assert.match(row, /scoped to the linked issue/i, 'the row must state the issue-scoped form');
    assert.match(row, /otherwise|degrades/i, 'the row must state the fallback, not just one wiring');
    assert.doesNotMatch(renderScaffold(provider), /memory-gate` does not check this/i,
      `${provider}: the scaffold must not claim the gate ignores this change`);
  }
});

test('the local-checks row is read against BOTH pipelines, not the one the author happened to open (#570)', () => {
  // The first version of this guard read `.github/workflows/governance.yml` alone and
  // stated its finding as universal: "npm test does NOT run in a consumer's governance
  // pipeline." True on GitHub, where the step is gated on the `.brain-source` marker
  // (never a managed path, so never vendored). FALSE on GitLab, where local-checks runs
  // `npm test` unconditionally in a REQUIRED job — measured at 152 failures in a real
  // consumer tree (#603). Reading one pipeline and generalising is the very error #570
  // is about, committed inside #570's own guard.
  if (!IS_BRAIN_SOURCE) return;
  const github = readFileSync(join(REPO_ROOT, '.github', 'workflows', 'governance.yml'), 'utf8');
  const gitlab = readFileSync(join(REPO_ROOT, 'brain', 'scripts', 'ci', 'gitlab-governance.yml'), 'utf8');

  const ghTestStep = github.slice(github.indexOf('run: npm test') - 400, github.indexOf('run: npm test'));
  assert.match(ghTestStep, /hashFiles\('\.brain-source'\)/,
    'GitHub gates the unit suite on .brain-source — a consumer skips it');
  assert.match(gitlab, /npm test/,
    'GitLab runs the unit suite in local-checks, unconditionally (#603) — if that changes, widen the row');

  // The pipelines DISAGREE, so the row may claim only what is true on both.
  assert.doesNotMatch(GATE_SUMMARY['local-checks'], /npm test/,
    'the row must claim only the part both pipelines actually run');
  assert.match(GATE_SUMMARY['local-checks'], /reference check|navigation check/i);
});

test('the brain-writes-reviewed row is TIER-CONDITIONAL because the gate is — driven, not asserted by substring (#570)', () => {
  // The first version asserted the row contained "lightest tier" and "review". An
  // INVERTED row — "an approving review is recommended but never required" — contains
  // both and stayed green. A guard that accepts its own inversion is not a guard (#499).
  // So drive the evaluator: ONE input, TWO tiers, verdicts differing in the direction
  // the row claims.
  const input = {
    changedFiles: ['brain/core/methodology/workflow-governance.md'],
    author: 'alice',
    reviews: [{ state: 'APPROVED', author: 'alice' }],   // self-approved, no distinct human
    botAllowlist: [],
  };
  assert.notEqual(evaluateBrainWritesReviewed({ ...input, tier: 'lite' }).level, 'fail',
    'lite: agent-authorship exclusion is the whole evidence form — a self-approved human write passes');
  assert.equal(evaluateBrainWritesReviewed({ ...input, tier: 'standard' }).level, 'fail',
    'standard: a review by someone OTHER than the author is required');
  // Binding PROSE to a measured verdict is the hard half, and the first two attempts
  // failed it. `/required/i` passes on "never required" — the inversion contains the
  // word. So: the row must assert the requirement AND must not weaken it.
  //
  // Named limit, not a claim of airtightness: this is a negation blacklist, and a
  // wording nobody has thought of ("dispensable", "at your discretion") slips past it.
  // The durable fix is to make the tier claim DATA that both the sentence and the
  // assertion are derived from — the same one-source shape as the rest of this module.
  // Until then the blacklist is what stands between the row and its own inversion.
  const bwr = GATE_SUMMARY['brain-writes-reviewed'];
  assert.match(bwr, /\brequired\b/i, 'the row must state the requirement the verdicts above establish');
  assert.doesNotMatch(bwr, /\b(?:never|not|no longer)\s+required\b/i,
    'standard FAILS without a distinct reviewer — a row saying it is never required is the inversion');
  assert.doesNotMatch(bwr, /\b(?:recommended|optional|advisory|encouraged|unnecessary|discretionary)\b/i,
    'the gate fails; a row hedging it into advice contradicts the measured verdict');

  // The row also claims the gate WARNS rather than fails on absent evidence.
  assert.notEqual(evaluateBrainWritesReviewed({ ...input, reviews: [], tier: 'standard' }).level, 'fail',
    'zero reviews is missing evidence, not disproof — the row says so and the gate must agree');
});

test('the actor-check row is TIER-CONDITIONAL because the gate is — driven at three tiers (#570)', () => {
  // The row stated `lite`'s evidence form as if it were the gate. `evaluateDistinctAct`
  // is reached ONLY inside `if (tier === 'lite')`; above it the gate compares the ACTOR
  // against the PR author and the issue author, and at the strictest tier additionally
  // requires the approver to have authored no commit on the branch. `resolveTier({})`
  // is `standard`, so the row was wrong for the default consumer in BOTH directions.
  const selfApproval = {
    author: 'alice',
    issueAuthor: 'alice',
    labeledEvents: [{ actor: { login: 'alice' }, at: '2026-08-13T12:00:00Z' }],
    commits: [{ sha: 'abc', login: 'alice', at: '2026-08-13T10:00:00Z' }],
    decisions: null,
    headSha: 'abc',
  };
  assert.notEqual(evaluateActor({ ...selfApproval, tier: 'lite' }).level, 'fail',
    'lite: approving after your own last commit is a DISTINCT ACT and passes');
  assert.equal(evaluateActor({ ...selfApproval, tier: 'standard' }).level, 'fail',
    'standard: the same act is self-approval — a distinct ACTOR is required');

  const distinctApprover = {
    ...selfApproval,
    labeledEvents: [{ actor: { login: 'bob' }, at: '2026-08-13T12:00:00Z' }],
    commits: [{ sha: 'abc', login: 'bob', at: '2026-08-13T10:00:00Z' }],
  };
  assert.notEqual(evaluateActor({ ...distinctApprover, tier: 'standard' }).level, 'fail',
    'standard: a distinct actor is enough, even one who committed');
  assert.equal(evaluateActor({ ...distinctApprover, tier: 'regulated' }).level, 'fail',
    'regulated: the approver must additionally have authored no commit on the branch');

  const row = GATE_SUMMARY['actor-check'];
  assert.match(row, /distinct ACT/i, 'the row must name the lightest tier\'s act-based form');
  assert.match(row, /distinct ACTOR/i, 'and the actor-based form the DEFAULT tier applies');
  assert.match(row, /no commit on the branch/i, 'and the strictest tier\'s extra requirement');
});

test('the phase-order row distinguishes a real violation from an uncomputable diff — the checker does (#570)', () => {
  // "Detection-only at the lightest tier" is not what the checker does: `main()`
  // returns 1 on any `level: 'fail'` with no tier term. The ONLY tier downgrade lives
  // in `uncomputableVerdict()` — it applies to a diff that could not be computed, not
  // to a violation that was found.
  assert.equal(runPhaseOrderCheck({ baseSha: null, headSha: null, tier: 'lite', readConfig: () => ({}) }).level, 'warn',
    'lite + uncomputable diff is the downgraded path the row describes');
  assert.equal(evaluatePhaseOrder({
    changedFiles: ['src/index.js', 'openspec/changes/issue-1-x/tasks.md'],
    changeDirs: [{ name: 'issue-1-x', checkedTasks: 0 }],
  }).level, 'fail', 'a REAL violation is a fail — no tier term reaches this verdict');

  assert.match(GATE_SUMMARY['phase-order'], /UNCOMPUTABLE/i, 'the row must name what is actually downgraded');
  assert.doesNotMatch(GATE_SUMMARY['phase-order'], /detection-only at the lightest tier/i,
    'the old wording claimed the violation itself was downgraded');
});

// ── the emitted files on disk ───────────────────────────────────────────────

test('each provider\'s emitted file on disk is byte-identical to what the one source renders (#570)', () => {
  // BRAIN SOURCE ONLY. In a consumer these bytes are theirs to rewrite —
  // `STRATEGY.REFUSE` exists to say so — and a brain-shipped test forbidding the
  // edit brain's own manifest grants is a defect, not a guard.
  if (!IS_BRAIN_SOURCE) return;
  for (const provider of SCAFFOLD_PROVIDERS) {
    const { path } = scaffoldDelivery(provider);
    const onDisk = join(REPO_ROOT, path);
    assert.ok(existsSync(onDisk), `${path} must exist — a consumer on ${provider} receives nothing without it`);
    assert.equal(readFileSync(onDisk, 'utf8'), renderScaffold(provider),
      `${path} has been hand-edited — regenerate it from contributor-scaffold.mjs instead`);
  }
});

// ── delivery: a consumer on EITHER provider receives a scaffold ─────────────

/**
 * These two tests carried a second branch while the manifest hunk was pending a human
 * act: a path was accepted as either DELIVERED or formally declared in
 * `brain-drafts/managed-paths-gitlab-scaffold.md`. That hunk was signed and applied
 * (commit `813f522`), so the branch is gone — deliberately, and not merely as tidying.
 *
 * A dead branch here would be a BYPASS: with the draft still on disk, deleting the
 * manifest row would fall through to "well, it is declared in the draft" and stay
 * green while every GitLab consumer received nothing. The draft is kept as the record
 * of what was signed, the way `brain-drafts/adr-0026-amendment-6.draft.md` is; what is
 * removed is its power to satisfy a test.
 */

test('the REAL installer, over the REAL manifest, delivers a scaffold for EVERY provider (#570)', () => {
  // BRAIN SOURCE ONLY, same reason as the on-disk test above: this copies THIS tree
  // as if it were the package being installed, so in a consumer it would assert that
  // the consumer's own (legitimately rewritten) scaffold equals brain's bytes.
  if (!IS_BRAIN_SOURCE) return;
  const dest = mkdtempSync(join(tmpdir(), 'brain-570-delivery-'));
  const { copied } = copyManaged({ srcRoot: REPO_ROOT, destRoot: dest, managed, local });

  for (const provider of SCAFFOLD_PROVIDERS) {
    const { path } = scaffoldDelivery(provider);
    assert.ok(copied.includes(path),
      `brain:upgrade does not ship ${path} — a ${provider} consumer gets no scaffold`);
    assert.equal(readFileSync(join(dest, path), 'utf8'), renderScaffold(provider),
      `the ${provider} consumer received something other than the emitted scaffold`);
  }
});

test('every provider\'s scaffold is a managed literal, REFUSE-classified (design question (c), #570)', () => {
  for (const provider of SCAFFOLD_PROVIDERS) {
    const { path } = scaffoldDelivery(provider);
    assert.ok(managed.includes(path), `${path} must be a managed literal`);
    assert.equal(strategyFor(path, managedStrategy), STRATEGY.REFUSE,
      `${path} is prose a team rewrites wholesale — it must refuse, never clobber`);
  }
});

test('#601: REFUSE protects a path on the release that FIRST ships it', () => {
  // The classification above is a table lookup. What the upgrade DOES with it is
  // this, and until #601 the two disagreed on a first ship: `copyManaged` only
  // classified a path as consumer-modified when the PREVIOUSLY INSTALLED package
  // shipped it (`outgoing.has(rel)`), and a brand-new path is in no prior
  // release. The guarantee started one release late — on the release where the
  // risk is highest — and a GitLab team that already owns `Default.md`, the one
  // file GitLab auto-applies, was overwritten rather than named.
  //
  // This replaces the characterization test that pinned the defect (#570).
  const tmp = mkdtempSync(join(tmpdir(), 'brain-601-firstship-'));
  const src = join(tmp, 'src');
  const dest = join(tmp, 'dest');
  const rel = scaffoldDelivery('gitlab').path;
  mkdirSync(dirname(join(src, rel)), { recursive: true });
  mkdirSync(dirname(join(dest, rel)), { recursive: true });
  writeFileSync(join(src, rel), 'BRAIN VERSION\n');
  writeFileSync(join(dest, rel), 'THE CONSUMER OWN TEMPLATE\n');

  const result = copyManaged({
    srcRoot: src,
    destRoot: dest,
    managed: [rel],
    local: [],
    refusePaths: [rel],
    outgoing: new Map(),   // exactly what readOutgoing returns for a first ship
  });

  assert.ok(result.refused.includes(rel),
    'brain never shipped this path, so the bytes there are the consumer\'s — it must be NAMED');
  assert.equal(readFileSync(join(dest, rel), 'utf8'), 'THE CONSUMER OWN TEMPLATE\n',
    'and their file must survive');
  assert.ok(!result.copied.includes(rel), 'nothing was written over it');
});

test('#601: --force-managed still overrides a first-ship refusal, per path', () => {
  // Fail-closed must not mean fail-stuck. The escape hatch is the same one the
  // modified-path case uses, and it names exactly one path (signed decision 3).
  const tmp = mkdtempSync(join(tmpdir(), 'brain-601-forced-'));
  const src = join(tmp, 'src');
  const dest = join(tmp, 'dest');
  const rel = scaffoldDelivery('gitlab').path;
  mkdirSync(dirname(join(src, rel)), { recursive: true });
  mkdirSync(dirname(join(dest, rel)), { recursive: true });
  writeFileSync(join(src, rel), 'BRAIN VERSION\n');
  writeFileSync(join(dest, rel), 'THE CONSUMER OWN TEMPLATE\n');

  const result = copyManaged({
    srcRoot: src,
    destRoot: dest,
    managed: [rel],
    local: [],
    refusePaths: [rel],
    outgoing: new Map(),
    forceManaged: [rel],
  });

  assert.ok(result.forced.includes(rel));
  assert.deepEqual(result.refused, []);
  assert.equal(readFileSync(join(dest, rel), 'utf8'), 'BRAIN VERSION\n');
});

test('#601: a first-ship REFUSE path the consumer does NOT have copies silently', () => {
  // The gate must not become "ask on every new path". With no file there, there
  // is nothing of theirs to protect.
  const tmp = mkdtempSync(join(tmpdir(), 'brain-601-absent-'));
  const src = join(tmp, 'src');
  const dest = join(tmp, 'dest');
  const rel = scaffoldDelivery('gitlab').path;
  mkdirSync(dirname(join(src, rel)), { recursive: true });
  mkdirSync(dest, { recursive: true });
  writeFileSync(join(src, rel), 'BRAIN VERSION\n');

  const result = copyManaged({
    srcRoot: src, destRoot: dest, managed: [rel], local: [], refusePaths: [rel],
    outgoing: new Map(),
  });

  assert.deepEqual(result.refused, []);
  assert.ok(result.copied.includes(rel));
});

test('#601: a DEGRADED run (--no-install) does not refuse everything', () => {
  // `outgoing: null` means the outgoing tree was unavailable, not that brain
  // never shipped the path. Unknown-because-degraded and unknown-because-new are
  // different facts, and only the second is evidence about the consumer's file.
  const tmp = mkdtempSync(join(tmpdir(), 'brain-601-degraded-'));
  const src = join(tmp, 'src');
  const dest = join(tmp, 'dest');
  const rel = scaffoldDelivery('gitlab').path;
  mkdirSync(dirname(join(src, rel)), { recursive: true });
  mkdirSync(dirname(join(dest, rel)), { recursive: true });
  writeFileSync(join(src, rel), 'BRAIN VERSION\n');
  writeFileSync(join(dest, rel), 'THE CONSUMER OWN TEMPLATE\n');

  const result = copyManaged({
    srcRoot: src, destRoot: dest, managed: [rel], local: [], refusePaths: [rel],
    outgoing: null,
  });

  assert.deepEqual(result.refused, [], 'a degraded run must not manufacture refusals');
  assert.equal(result.modificationDetection, 'degraded');
});

// ── the sweep: no brain-owned file re-states the false claim ────────────────

/**
 * Claims that the `decision` LABEL changes what a gate does. `decision-gate`
 * dispatches to `adrPresence`, whose entire input is the changed- and added-file
 * lists — the label changes no verdict, in either direction.
 *
 * The first version of this pattern keyed on the word "enforce" and on four fixed
 * verbs, which is a wording, not a meaning: rewriting the same falsehood as "with
 * it present, decision-gate becomes hard" sailed through. It now keys on the LINK
 * between the label and any statement of gate behaviour, in either order.
 */
const DECISION_LABEL_ENFORCEMENT_CLAIM = new RegExp(
  [
    // "…decision label … <gate behaviour>"
    '`?decision`?\\s+label[^.\\n]{0,90}\\b(?:enforc\\w*|arms?|trigger\\w*|hard|mandator\\w*|required|requires|blocks?|two-step|step 2|heuristic|stricter|MUST)\\b',
    // "<gate behaviour> … decision label"
    '\\b(?:enforc\\w*|hard|mandator\\w*|two-step|step 2|heuristic|stricter)\\b[^.\\n]{0,90}`?decision`?\\s+label',
    // "a PR labeled decision MUST …" — the ADR-0014 phrasing
    'label(?:ed|led)\\s+`?decision`?[^.\\n]{0,90}\\b(?:MUST|hard|required|enforc\\w*)\\b',
    // The label need not be NAMED for the claim to be made: "decision-gate becomes
    // hard", "decision-gate is two-step". This alternative is what catches the
    // anaphoric form, which defeated every label-keyed pattern above.
    // Hyphenation tolerated on both sides (`step-2`, `label-conditional`) — a detector
    // a hyphen defeats is a detector for one author's typing habits.
    '`?decision-gate`?[^.\\n]{0,90}\\b(?:hard|two[- ]step|step[- ]2|heuristic|stricter|label[- ]conditional|conditional on)\\b',
    // The same claim with the behaviour word FIRST. Proximity to `decision` is
    // load-bearing: "step 2" unanchored matches every numbered instruction in the repo,
    // and a detector that fires on docs/adoption.md teaches people to add exemptions
    // instead of fixing claims.
    '\\b(?:two[- ]step|step[- ]2|label[- ]conditional)\\b[^.\\n]{0,90}`?decision',
    // The evidence token in the ratified gate matrix — specific enough to stand alone.
    'decision[- ]label[- ]hard',
    // "Without the label the gate does not …" / "adding it turns X on" — the
    // conditional framing, which names no behaviour word at all.
    '\\b(?:without|with|adding|applying)\\b[^.\\n]{0,40}`?decision`?(?:\\s+label)?[^.\\n]{0,60}\\b(?:does not|turns|switches|selects|escalat\\w*|binding|advisory)\\b',
    // "labels that make a gate stricter (`decision`, …)" — the label as a member of
    // a list, with the behaviour claim ahead of it and no "label" word adjacent.
    '\\b(?:stricter|tighten\\w*)\\b[^.\\n]{0,80}`decision`',
  ].join('|'),
  'i',
);

/**
 * Files that carry the claim TODAY, each with the ticket that owns removing it.
 * Frozen and asserted BOTH ways: a new occurrence anywhere else is red, and an
 * entry that no longer matches is also red, so this list cannot quietly become a
 * museum. Three of them are Tier-2 doctrine (`brain/core/**`, an ADR) that an
 * agent may not hand-edit, which is exactly why they are named here instead of
 * being silently excluded — the alternative is a green suite over a tree that
 * still lies. See #570's PR for the measurement.
 */
const KNOWN_CLAIM_SURVIVORS = Object.freeze({
  'brain/core/methodology/workflow-governance.md': 'Tier-2 doctrine: the brain:metrics caveat still justifies label-conditional counting by a "Step 1 hard / Step 2 heuristic" model the same file deletes 190 lines earlier',
  'AGENTS.md': 'generated from the file above — regenerates clean once the doctrine is amended',
  'brain/core/methodology/reviewer-protocol.md': 'Tier-2 doctrine: lists `decision` among labels that "make a gate stricter"',
  'brain/project/decisions/adr-0014-workflow-governance.md': 'Tier-2 decision record: "A PR labeled `decision` MUST … (hard)" — needs a signed amendment, not an edit',
  'brain/project/decisions/adr-0015-governance-v3-substrate-ladder.md': 'Tier-2 decision record: decision-gate described as "ADR ships for a labeled decision"',
  'docs/methodology-map/index.html': 'the two-step/heuristic model, three times — plain docs, no signature needed',
  'openspec/specs/governance/spec.md': 'living spec: still specifies the label-conditional model (and a GitHub-only scaffold requirement)',
  'openspec/specs/governance-v3/spec.md': 'living spec: same model',
  'openspec/specs/governance-metrics/spec.md': 'living spec: same model, in the metrics requirements',
  'brain/scripts/review/deny-set.mjs': 'the CODE side of reviewer-protocol §9 — classifies `decision` as a "tightening" label; the wording follows the doctrine above, so it moves when that amendment does',
  // Found by a second cold review; invisible to the first detector. The first two
  // matter most — they are CODE and ratified DATA, not prose.
  'brain/scripts/vcs/governance-tiers.mjs': 'the repealed model encoded as ratified doctrine: GATE_MATRIX carries `evidence: adr-home-cooccurrence+decision-label-hard`, which resolveGateEvidence and brain:governance-status read',
  'brain/scripts/review/evaluators/checkpoint.mjs': 'live code: short-circuits on hasDecisionLabel and emits a severity:blocker finding citing "Invariant 4 step 2 (decision-gate)" — a step 2 the doctrine deleted',
  // Live, UNARCHIVED change dirs whose spec deltas carry the claim — the pipeline that
  // fed reviewer-protocol §9, not a record of history. Trailing slash = directory prefix.
  'openspec/changes/issue-266-h0a-reviewer-protocol-doctrine/': 'the unpromoted spec delta behind §9\'s "tightening (`decision`)" list',
  'openspec/changes/issue-266-h1-brain-review/': 'same delta set, brain:review half',
});

/**
 * Matches the detector fires on that are NOT the falsehood. Kept separate from the
 * survivors above on purpose: those are things to fix, these are limits of a regex
 * reading prose, and collapsing the two would let a real claim hide behind the word
 * "exempt".
 *
 *   · `brain:metrics` REALLY IS label-conditional — `metrics-aggregate.mjs:175`
 *     skips unlabeled merges when counting. A sentence about COUNTS is true.
 *   · An amendment that QUOTES the wording it repeals has to reproduce it.
 */
const DETECTOR_EXEMPT = Object.freeze({
  'brain/scripts/lib/metrics-aggregate.mjs': 'describes brain:metrics COUNTING, which is genuinely label-conditional',
  'brain/project/decisions/adr-0026-governance-doctrine-tiers.md': 'Amendment 4 quotes the pre-#516 wording in the act of repealing it',
  // Trailing slash = directory prefix.
  'openspec/changes/issue-516-doctrine-gate-claim/': 'the change that REPEALED the claim — its proposal, spec, design and drafts have to quote what they remove',
});

/**
 * Files a HUMAN read and found carrying the claim, that the detector does NOT see.
 * Their own list on purpose: putting them among the survivors would break that map's
 * staleness test (which requires an entry to still MATCH), and widening the regex
 * until it caught them is how an earlier pass came to fire on docs/adoption.md and
 * every numbered instruction in the tree.
 *
 * This is the detector's confession. The invariant below is two-way: an entry must
 * still exist AND still be invisible — the day the pattern learns to see one, the
 * test says so and it moves to KNOWN_CLAIM_SURVIVORS.
 */
const UNDETECTED_SURVIVORS = Object.freeze({
  'brain/core/anti-patterns/evidence-reader-empty-on-failure.md': 'presents decision-gate as label-triggered ("A failed label fetch made `decision-gate` see \'no `decision` label\'") — the claim spans two lines and every pattern here is line-bounded',
  'brain/project/decisions/adr-0021-reviewer-port-head-and-rollup.md': '"a decision that needs this ADR + a `decision` label + L6 human review" — the label listed as a requirement, with no behaviour word to key on',
});

/** Exact path, or a listed key ending in `/` treated as a directory prefix. */
function listed(map, file) {
  return Object.keys(map).some(key => (key.endsWith('/') ? file.startsWith(key) : file === key));
}

/**
 * SDD change artifacts: proposals, designs and drafts record what a change PROPOSED,
 * including the text it was repealing — #516's own proposal has to quote the claim it
 * removes. They are also `local` (consumer-owned) in the manifest, i.e. never brain's
 * description of the system. `openspec/specs/**` is NOT here: those are living specs
 * and are held to the same standard as doctrine.
 */
const HISTORICAL_PATHS = /^openspec\/changes\/archive\//;

/** Tracked files that carry the claim, minus fixtures, history and detector exemptions. */
function sweepTree() {
  const tracked = execFileSync('git', ['ls-files'], { cwd: REPO_ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    // Test files quote the claim as a fixture — including this one.
    .filter(f => !/\.test\.mjs$/.test(f))
    .filter(f => !f.startsWith('.memory/'))
    .filter(f => !HISTORICAL_PATHS.test(f))
    .filter(f => !listed(DETECTOR_EXEMPT, f));

  assert.ok(tracked.length > 300, 'sanity: the sweep must actually be reading the whole tree');
  return tracked.filter(f => {
    let src;
    try { src = readFileSync(join(REPO_ROOT, f), 'utf8'); } catch { return false; }
    return DECISION_LABEL_ENFORCEMENT_CLAIM.test(src);
  });
}

test('no file outside the KNOWN survivors claims the `decision` label changes a gate (#516, #570)', () => {
  // BRAIN SOURCE ONLY: the survivor list and the ownership filter are statements
  // about brain's tree. A consumer's `.github/**` is theirs (ADR-0014's own
  // "never manage .github/**"), and policing it from a vendored test is wrong.
  if (!IS_BRAIN_SOURCE) return;
  const offenders = sweepTree();
  assert.deepEqual(
    offenders.filter(f => !listed(KNOWN_CLAIM_SURVIVORS, f)),
    [],
    'the `decision` label is a human signal — decision-gate reads no labels (ADR-0026 Amendment 4)',
  );
});

test('the KNOWN survivors list is current — an entry that no longer matches must be deleted (#570)', () => {
  if (!IS_BRAIN_SOURCE) return;
  const offenders = sweepTree();
  const stale = Object.keys(KNOWN_CLAIM_SURVIVORS).filter(key => {
    // A directory prefix is current while ANY file under it still carries the claim.
    if (key.endsWith('/')) return !offenders.some(f => f.startsWith(key));
    let src;
    try { src = readFileSync(join(REPO_ROOT, key), 'utf8'); } catch { return true; }
    return !DECISION_LABEL_ENFORCEMENT_CLAIM.test(src);
  });
  assert.deepEqual(stale, [],
    'these files were fixed (or moved) — drop them from KNOWN_CLAIM_SURVIVORS so the sweep tightens');
});

test('the UNDETECTED survivors are still present, and still undetected (#570)', () => {
  // Two-way, so neither half can rot: a file that vanished (renamed, fixed) must leave
  // the list, and a file the pattern LEARNED to see must move to the survivors map,
  // where staleness is tracked.
  if (!IS_BRAIN_SOURCE) return;
  for (const [file, why] of Object.entries(UNDETECTED_SURVIVORS)) {
    let src;
    try { src = readFileSync(join(REPO_ROOT, file), 'utf8'); } catch { src = null; }
    assert.ok(src !== null, `${file} is gone — drop it from UNDETECTED_SURVIVORS (${why})`);
    assert.doesNotMatch(src, DECISION_LABEL_ENFORCEMENT_CLAIM,
      `the detector now SEES ${file} — move it to KNOWN_CLAIM_SURVIVORS`);
  }
});

test('the sweep detects the MEANING, not one wording (#570)', () => {
  // Every string here is a real sentence that was live in this repo, or the exact
  // rewrite that defeated the first version of this pattern.
  for (const claim of [
    'CI will enforce this when the `decision` label is present.',
    'with it present, decision-gate becomes hard and both the ADR and the entry are mandatory',
    'decision-gate is two-step: hard when the decision label is present',
    'A PR labeled `decision` MUST add an `adr-NNNN-*.md`',
    'The reviewer may apply labels that make a gate stricter (`decision`, `seq:*`)',
  ]) {
    assert.match(claim, DECISION_LABEL_ENFORCEMENT_CLAIM, `not detected: ${claim}`);
  }
  for (const honest of [
    'Add the `decision` label to this pull request — no gate reads it.',
    'Step 3 is a human signal that a decision was made.',
    'decision-gate reads no labels and runs on every change.',
  ]) {
    assert.doesNotMatch(honest, DECISION_LABEL_ENFORCEMENT_CLAIM, `false positive: ${honest}`);
  }
});

test('the scaffold states what the `decision` label actually is, and never that a gate reads it (#570)', () => {
  for (const provider of SCAFFOLD_PROVIDERS) {
    const rendered = renderScaffold(provider);
    assert.doesNotMatch(rendered, DECISION_LABEL_ENFORCEMENT_CLAIM);
    assert.match(rendered, /reads no labels/i, `${provider}: the scaffold must say the gate reads no labels`);
  }
});

// #1024 changed the underlying reality: skip:memory-gate now IS honored at
// the "standard" tier (refused at "regulated", not consulted at "lite") —
// the OLD guard (asserting the scaffold must claim the label is inert)
// would now demand a FALSE claim. The scaffold must instead state the
// tier-scoped truth, never a blanket "exempts nothing" now that it does.
test('the scaffold states skip:memory-gate\'s tier-scoped reality, never a blanket "exempts nothing" claim (#1024, #529, #570)', () => {
  for (const provider of SCAFFOLD_PROVIDERS) {
    const rendered = renderScaffold(provider);
    if (rendered.includes('skip:memory-gate')) {
      assert.match(rendered, /skip:memory-gate[^.]{0,160}(honored|refus|not consulted)/i,
        `${provider}: the scaffold must name the tier-scoped rule (honored at standard, refused at regulated, not consulted at lite), not a blanket inert claim`);
      assert.doesNotMatch(rendered, /skip:memory-gate[^.]{0,160}exempts nothing/i,
        `${provider}: skip:memory-gate now DOES exempt something at the "standard" tier — this claim is stale`);
    }
  }
});

// ── the template sentence describes the lane (#905, spec.md "the template
// sentence describes the lane", design.md D5/L6, ADR-0034:158-160) ─────────
//
// The emitted checklist item's FIRST line now describes memory as reaching
// `main` on the lane (`brain:memory:save --issue N`), not the pre-lane
// `memory:share` wording — the last three lines (memory-gate/skip:memory-gate
// discipline) stay verbatim.

test('the memory checklist item describes the lane, verbatim, on every provider (#905)', () => {
  for (const provider of SCAFFOLD_PROVIDERS) {
    const rendered = renderScaffold(provider);
    assert.match(
      rendered,
      /- \[ \] Session memory captured as a record \(`brain:memory:save --issue N`\); it reaches `main`\n\s+on the lane\./,
      `${provider}: the checklist item must describe the lane, not the pre-lane brain:memory:share wording`
    );
    assert.doesNotMatch(
      rendered,
      /Session memory captured with `npm run memory:share`/,
      `${provider}: the pre-lane wording must be fully replaced, not left alongside the new sentence`
    );
    // memory-gate/skip:memory-gate discipline sentence — updated for #1024:
    // skip:memory-gate now genuinely honors at the "standard" tier.
    const { abbr } = scaffoldDelivery(provider);
    assert.match(
      rendered,
      new RegExp(
        `on the lane\\. Where the pipeline hands \`memory-gate\` this description, an unscoped\\n\\s+`
        + `record does NOT satisfy it — though a record already on \`main\` from its own lane ${abbr}\\n\\s+`
        + `does, with no rebase needed\\. \`skip:memory-gate\` is honored at the "standard" tier\\n\\s+`
        + `when applied by someone other than the ${abbr} author; "regulated" refuses it; "lite"\\n\\s+`
        + `does not consult it\\.`,
      ),
    );
  }
});

test('the emitted PULL_REQUEST_TEMPLATE.md matches the COMMITTED file byte-for-byte, including the lane sentence (#905)', () => {
  if (!IS_BRAIN_SOURCE) return;
  const { path } = scaffoldDelivery('github');
  const onDisk = join(REPO_ROOT, path);
  const emitted = renderScaffold('github');
  assert.equal(readFileSync(onDisk, 'utf8'), emitted,
    `${path} has been hand-edited — regenerate it from contributor-scaffold.mjs instead`);
  assert.match(emitted, /Session memory captured as a record \(`brain:memory:save --issue N`\); it reaches `main`/);
});
