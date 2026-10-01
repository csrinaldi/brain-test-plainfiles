// brain-promote.golden.test.mjs — the acceptance test for issue #509, driven
// against a REAL human promotion instead of a fixture written to match the code.
//
// THE ORACLE is commit `be2d143`: ADR-0026 Amendment 2, promoted BY HAND by the
// human who signed consolidation-protocol.md §1c. Given
//
//   input   = the tree at `be2d143^` + the #473 amendment draft
//   oracle  = the three files `be2d143` produced
//
// `brain:promote` must stage a BYTE-IDENTICAL tree, with zero new commits, and
// print a commit command `commit-msg` accepts. A tool that diverges from the
// human's own execution of the rule has not automated the rule.
//
// ── How the input is constructed, and why it is not the answer in disguise ───
//
// Every byte of the draft comes from one of two places that are NOT the oracle:
//
//   * the prose, the signed section and the act-2 annotation text — read out of
//     the pre-existing #473 draft, written before the promotion happened;
//   * the act-2 anchor — read out of the PRE-promotion target file.
//
// Only the contract scalars (`target`, `amendment`, `issue`, `home-summary`,
// `body`) are authored here, and the verb — not the draft — decides what those
// become on disk: the Status-line format, the `**Signed**:` stamp, the
// brain/HOME.md marker format and the AGENTS.md regeneration are all generated.
//
// One honest observation the construction forces into the open: the #473 draft's
// act-2 paste block is LINE-WRAPPED prose, while the file carries the annotation
// on a single line inside a table row. The human unwrapped it by hand. The
// contract format exists so that step is declared rather than performed from
// memory — here the test unwraps the draft's own block and declares the result.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIRMATION_WORD, runPromote } from './brain-promote.mjs';
import { SOURCE_DOCS, compileAgentsMd } from './axes/platform/adapters/antigravity.mjs';
import { makeRepoFromFiles, statusOf, commitCount, stagedPaths, REPO_ROOT } from './__fixtures__/promote-repo.mjs';

/**
 * The human's promotion of ADR-0026 Amendment 2 (#473, PR #508).
 *
 * FULL sha, not the abbreviation: a shallow CI checkout has to fetch this
 * commit, and `git fetch origin be2d143` fails with "couldn't find remote ref"
 * — an abbreviated sha is read as a ref name. Measured in a real `--depth 1`
 * clone; with the 40 characters the fetch takes about a second.
 */
const ORACLE = 'be2d143e6cb62748369ba2f1a11425845eeeebaf';
const PRE = `${ORACLE}^`;

const TARGET = 'brain/project/decisions/adr-0026-governance-doctrine-tiers.md';
const HOME = 'brain/HOME.md';
const AGENTS = 'AGENTS.md';
const DRAFT_473 = 'openspec/changes/issue-473-approval-signature-on-diff/brain-drafts/adr-0026-amendment-2.draft.md';

/** The date and name `be2d143` stamped — supplied to the verb through its seams. */
const PROMOTION_DATE = '2026-08-08';
const PROMOTER = 'Cristian Rinaldi';

const DRAFT_REL = 'openspec/changes/issue-473-approval-signature-on-diff/brain-drafts/adr-0026-amendment-2.contract.draft.md';

function git(args) {
  return spawnSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

/**
 * Makes the oracle commit available. A shallow CI checkout (`fetch-depth: 1`)
 * does not carry it, so one bounded fetch is attempted before giving up.
 * @returns {{available:boolean, how:string, fetchStderr:string}}
 */
function oracleAvailable() {
  if (git(['cat-file', '-e', `${PRE}^{commit}`]).status === 0) return { available: true, how: 'in the checkout', fetchStderr: '' };
  const fetched = git(['fetch', '--no-tags', '--quiet', '--depth=2', 'origin', ORACLE]);
  const present = git(['cat-file', '-e', `${PRE}^{commit}`]).status === 0;
  return {
    available: present,
    how: present ? 'fetched' : 'unavailable',
    fetchStderr: `${fetched.stderr ?? ''}`.trim(),
  };
}

/** Reads one blob out of history. Throws rather than returning '' — an empty
 *  read would make every byte-comparison below vacuously true. */
function blob(rev, relPath) {
  const r = git(['show', `${rev}:${relPath}`]);
  if (r.status !== 0) throw new Error(`git show ${rev}:${relPath} failed: ${r.stderr}`);
  if (typeof r.stdout !== 'string' || r.stdout.length === 0) {
    throw new Error(`git show ${rev}:${relPath} returned nothing`);
  }
  return r.stdout;
}

const ORACLE_STATE = oracleAvailable();
const AVAILABLE = ORACLE_STATE.available;
const SKIP = AVAILABLE
  ? false
  : `${ORACLE} is not reachable — run \`git fetch --depth=2 origin ${ORACLE}\``;

// ═══════════════════════════════════════════════════════════════════════════
// The acceptance suite must not be able to report success having asserted
// nothing. `node --test` exits 0 on skips, so 13 skipped tests are the same
// colour as 13 passing ones — and that is exactly what happened on this PR's
// first CI run (`# skipped 13`, all checks green). The full-sha fetch fixed one
// CAUSE; this test closes the CLASS. It carries NO skip: when the oracle cannot
// be reached, the suite is red and says why, instead of quietly asserting
// nothing about a byte-identity claim the ticket rests on.
// ═══════════════════════════════════════════════════════════════════════════

test('golden: the oracle IS reachable — this test never skips, so the suite cannot be green having run nothing', () => {
  assert.equal(
    AVAILABLE,
    true,
    `the acceptance oracle ${ORACLE} could not be resolved (${ORACLE_STATE.how}).\n` +
      `  git fetch said: ${ORACLE_STATE.fetchStderr || '(nothing)'}\n` +
      `  Fix: git fetch --no-tags --depth=2 origin ${ORACLE}\n` +
      '  The 13 byte-identity assertions below skip without it, and a skipped acceptance\n' +
      '  test is indistinguishable from a passing one on the PR page.',
  );
});

/**
 * Builds the amendment draft: the real #473 draft, plus the machine-readable
 * contract this slice defines. Nothing here is read from the oracle commit.
 *
 * @param {string} preTarget The target file as it stands at `be2d143^`.
 * @returns {string}
 */
function buildContractDraft(preTarget) {
  // From HISTORY, not from the working tree: the input to an acceptance test
  // must be as pinned as the oracle, or an edit to the checked-out draft
  // silently changes what the test proves.
  const prose = blob(PRE, DRAFT_473);

  // Act 2's replacement text, unwrapped from the draft's own paste block.
  const pasted = prose.match(/```\n(\*\*\[Amended by Amendment 2[\s\S]*?)\n```/);
  assert.ok(pasted, "the #473 draft must still carry act 2's paste block");
  const annotation = pasted[1].split('\n').join(' ');

  // Act 2's anchor, read from the PRE-promotion target.
  const anchor = 'any approval event satisfies the evidence. |';
  assert.equal(preTarget.split(anchor).length - 1, 1, 'the act-2 anchor must be unique in the pre-promotion target');
  const replacement = `${anchor.slice(0, -2)} ${annotation} |`;

  const homeSummary =
    'a signed `brain-decision/1` block is additional sufficient `lite` evidence for `actor-check`, #473';
  const bodyHeading =
    '## Amendment 2 — a signed decision block is admissible `lite` evidence for `actor-check` (issue #473)';

  const contract = [
    '```brain-amendment/1',
    `target: ${TARGET}`,
    'amendment: 2',
    'issue: 473',
    `home-summary: ${homeSummary}`,
    `body: ${bodyHeading}`,
    'body-end: ### Promotion is manual',
    '```',
    '',
    '```amend-find',
    anchor,
    '```',
    '',
    '```amend-replace',
    replacement,
    '```',
    '',
  ].join('\n');

  return prose.replace(bodyHeading, `${contract}\n${bodyHeading}`);
}

/** Runs the verb over a fixture repo built from the pre-promotion tree. */
async function promoteFromPreTree({ mutateTarget = (t) => t } = {}) {
  const files = {};
  for (const rel of SOURCE_DOCS) files[rel] = blob(PRE, rel);
  // The draft is always built from the UNMUTATED tree: a drift case must be the
  // TARGET moving under a fixed draft, which is what actually happens in life.
  files[DRAFT_REL] = buildContractDraft(blob(PRE, TARGET));
  files[TARGET] = mutateTarget(blob(PRE, TARGET));
  files[AGENTS] = blob(PRE, AGENTS);

  const { root } = makeRepoFromFiles(files, { userName: PROMOTER });
  const res = await runPromote({
    argv: [DRAFT_REL],
    isTTY: true,
    root,
    readLineFn: async () => CONFIRMATION_WORD,
    gitUserNameFn: () => PROMOTER,
    todayFn: () => PROMOTION_DATE,
    write: () => {},
  });
  return { root, res, read: (rel) => readFileSync(join(root, rel), 'utf8') };
}

// ═══════════════════════════════════════════════════════════════════════════
// Harness proofs — run BEFORE anything is compared, because a reader that
// comes back empty would make every byte-equality below trivially true
// (brain/core/anti-patterns/evidence-reader-empty-on-failure.md).
// ═══════════════════════════════════════════════════════════════════════════

test('golden harness: the oracle commit and its parent both carry the three files, non-empty', { skip: SKIP }, () => {
  for (const rel of [TARGET, HOME, AGENTS]) {
    assert.ok(blob(PRE, rel).length > 0, `${PRE}:${rel} must be readable`);
    assert.ok(blob(ORACLE, rel).length > 0, `${ORACLE}:${rel} must be readable`);
  }
});

test('golden harness: the oracle CHANGED all three files — the comparison has something to catch', { skip: SKIP }, () => {
  for (const rel of [TARGET, HOME, AGENTS]) {
    assert.notEqual(blob(PRE, rel), blob(ORACLE, rel), `${rel} must differ across ${ORACLE}`);
  }
  // And it changed them by a real amount, not a whitespace nudge.
  assert.ok(blob(ORACLE, TARGET).length - blob(PRE, TARGET).length > 5000);
});

test('golden harness: the pre-promotion tree is self-consistent (AGENTS.md compiles to the committed bytes)', { skip: SKIP }, () => {
  const docs = {};
  for (const rel of SOURCE_DOCS) docs[rel] = blob(PRE, rel);
  assert.equal(compileAgentsMd(docs), blob(PRE, AGENTS), 'the fixture must not start drifted');
});

test('golden harness: the constructed draft borrows no bytes from the oracle commit', { skip: SKIP }, () => {
  const draft = buildContractDraft(blob(PRE, TARGET));
  // The three things the VERB generates must be absent from the input.
  assert.equal(draft.includes('**Status**: Accepted · **amended 08/08/2026**'), false);
  assert.equal(draft.includes(`**Signed**: 08/08/2026 — ${PROMOTER}`), false);
  assert.equal(draft.includes('**Amendment 2, 08/08/2026**'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-509-1 — the staged tree is BYTE-IDENTICAL to the human's commit
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-509-1: the ADR file is byte-identical to be2d143 (all three §1c acts)', { skip: SKIP }, async () => {
  const fx = await promoteFromPreTree();
  try {
    assert.equal(fx.res.exitCode, 0, fx.res.output);
    assert.equal(fx.read(TARGET), blob(ORACLE, TARGET));
  } finally {
    removeTempTree(fx.root);
  }
});

test('REQ-509-1: brain/HOME.md is byte-identical to be2d143 (the amendment marker, §1b)', { skip: SKIP }, async () => {
  const fx = await promoteFromPreTree();
  try {
    assert.equal(fx.read(HOME), blob(ORACLE, HOME));
  } finally {
    removeTempTree(fx.root);
  }
});

test('REQ-509-1: AGENTS.md is byte-identical to be2d143 (§1d act 3 — the step #529 lost)', { skip: SKIP }, async () => {
  const fx = await promoteFromPreTree();
  try {
    assert.equal(fx.read(AGENTS), blob(ORACLE, AGENTS));
  } finally {
    removeTempTree(fx.root);
  }
});

test('REQ-509-1: exactly the three files are staged, and ZERO commits are created', { skip: SKIP }, async () => {
  const fx = await promoteFromPreTree();
  try {
    assert.equal(commitCount(fx.root), '1', 'the verb must never commit');
    assert.deepEqual(stagedPaths(fx.root), [AGENTS, HOME, TARGET].sort());
  } finally {
    removeTempTree(fx.root);
  }
});

test('REQ-509-1: the printed commit command passes the commit-msg hook', { skip: SKIP }, async () => {
  const chunks = [];
  const files = {};
  for (const rel of SOURCE_DOCS) files[rel] = blob(PRE, rel);
  files[TARGET] = blob(PRE, TARGET);
  files[AGENTS] = blob(PRE, AGENTS);
  files[DRAFT_REL] = buildContractDraft(files[TARGET]);
  const { root } = makeRepoFromFiles(files, { userName: PROMOTER });
  const scratch = mkdtempSync(join(tmpdir(), 'brain-msg-'));
  try {
    await runPromote({
      argv: [DRAFT_REL],
      isTTY: true,
      root,
      readLineFn: async () => CONFIRMATION_WORD,
      gitUserNameFn: () => PROMOTER,
      todayFn: () => PROMOTION_DATE,
      write: (s) => chunks.push(s),
    });
    const printed = chunks.join('').match(/git commit -m '((?:[^']|'\\'')*)'/);
    assert.ok(printed, 'a commit command must be printed');
    const message = printed[1].replace(/'\\''/g, "'");
    assert.match(message, /#473/, 'the ticket reference is what commit-msg checks for');

    const msgFile = join(scratch, 'COMMIT_EDITMSG');
    writeFileSync(msgFile, `${message}\n`, 'utf8');
    const hook = spawnSync('sh', [join(REPO_ROOT, 'brain/scripts/hooks/commit-msg'), msgFile], { encoding: 'utf8' });
    assert.equal(hook.status, 0, `commit-msg rejected the printed message:\n${message}\n${hook.stdout}`);
  } finally {
    removeTempTree(root);
    removeTempTree(scratch);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-509-2 — the properties both stopgap scripts had, kept
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-509-2: a second run over the already-promoted tree is a no-op, not a second amendment', { skip: SKIP }, async () => {
  const fx = await promoteFromPreTree();
  try {
    const after = fx.read(TARGET);
    const second = await runPromote({
      argv: [DRAFT_REL],
      isTTY: true,
      root: fx.root,
      readLineFn: async () => CONFIRMATION_WORD,
      gitUserNameFn: () => PROMOTER,
      todayFn: () => PROMOTION_DATE,
      write: () => {},
    });
    assert.equal(second.exitCode, 0, second.output);
    assert.deepEqual(second.wrote, [], 'an applied amendment must not be applied twice');
    assert.match(second.output, /already promoted/i);
    assert.equal(fx.read(TARGET), after, 'the target must be untouched by the second run');
  } finally {
    removeTempTree(fx.root);
  }
});

test('REQ-509-2: an act-2 anchor that occurs twice REFUSES — it does not edit the first one', { skip: SKIP }, async () => {
  // The duplicate is appended as a plain line, so the anchor count is 2 while
  // every other act still resolves — the run can only fail for the anchor.
  const fx = await promoteFromPreTree({
    mutateTarget: (t) => `${t}\nany approval event satisfies the evidence. |\n`,
  });
  try {
    assert.notEqual(fx.res.exitCode, 0);
    assert.match(fx.res.output, /anchor occurs 2 time\(s\)/);
    assert.match(fx.res.output, /act 2 — in-place edit 1: BLOCKED/);
    assert.deepEqual(fx.res.wrote, []);
    assert.equal(statusOf(fx.root), '', 'a refused run leaves the tree untouched');
  } finally {
    removeTempTree(fx.root);
  }
});

test('REQ-509-2: an act-2 anchor that has drifted away REFUSES with nothing written', { skip: SKIP }, async () => {
  const fx = await promoteFromPreTree({
    mutateTarget: (t) => t.replace('any approval event satisfies the evidence. |', 'any approval event suffices. |'),
  });
  try {
    assert.notEqual(fx.res.exitCode, 0);
    assert.match(fx.res.output, /anchor occurs 0 time\(s\)/);
    assert.deepEqual(fx.res.wrote, []);
    assert.equal(statusOf(fx.root), '');
  } finally {
    removeTempTree(fx.root);
  }
});

test('REQ-509-2: a draft whose amendment number does not follow the target REFUSES', { skip: SKIP }, async () => {
  const files = {};
  for (const rel of SOURCE_DOCS) files[rel] = blob(PRE, rel);
  files[TARGET] = blob(PRE, TARGET);
  files[AGENTS] = blob(PRE, AGENTS);
  files[DRAFT_REL] = buildContractDraft(files[TARGET]).replace('amendment: 2', 'amendment: 4');
  const { root } = makeRepoFromFiles(files, { userName: PROMOTER });
  try {
    const res = await runPromote({
      argv: [DRAFT_REL],
      isTTY: true,
      root,
      readLineFn: async () => CONFIRMATION_WORD,
      gitUserNameFn: () => PROMOTER,
      todayFn: () => PROMOTION_DATE,
      write: () => {},
    });
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /Amendment 4.*stands at Amendment 1|stands at Amendment 1.*expected 2/s);
    assert.equal(statusOf(root), '');
  } finally {
    removeTempTree(root);
  }
});
