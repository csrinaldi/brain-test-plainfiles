// brain-promote.amendment.test.mjs — the amendment path end to end (issue #509).
//
// Two things this file proves that the golden oracle does not:
//
//   1. The METHODOLOGY shape — the case #529 met, where the target is one of the
//      five SOURCE_DOCS and there is no brain/HOME.md act. The hand-rolled
//      promoter written from the doctrine text lost the AGENTS.md regeneration
//      there, and CI caught it on the human's signing commit.
//   2. ADR-0028's four locks hold on the NEW path, not only on slice 1's. A lock
//      proven on one branch of a dispatch is blind along the branch axis
//      (brain/core/anti-patterns/red-proof-blind-along-an-unvaried-axis.md).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, rmSync, symlinkSync, chmodSync, mkdtempSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIRMATION_WORD, runPromote } from './brain-promote.mjs';
import { SOURCE_DOCS, compileAgentsMd } from './axes/platform/adapters/antigravity.mjs';
import { makeFixtureRepo, statusOf, commitCount, stagedPaths, REPO_ROOT } from './__fixtures__/promote-repo.mjs';

const MODULE_PATH = join(REPO_ROOT, 'brain/scripts/brain-promote.mjs');
const WFG = 'brain/core/methodology/workflow-governance.md';
const HOME = 'brain/HOME.md';
const AGENTS = 'AGENTS.md';

/** An anchor that exists verbatim in the REAL workflow-governance.md today. */
const WFG_ANCHOR = '## Lockout Recovery';
const WFG_INSERT = '## Lockout Recovery (amended by the fixture, #509)';

/**
 * A methodology-shape amendment draft: one in-place edit, no amendment number,
 * no brain/HOME.md marker, no appended section.
 */
const DOC_DRAFT = [
  '# A ruling to promote',
  '',
  '```brain-amendment/1',
  `target: ${WFG}`,
  'issue: 529',
  '```',
  '',
  '```amend-find',
  WFG_ANCHOR,
  '```',
  '',
  '```amend-replace',
  WFG_INSERT,
  '```',
  '',
].join('\n');

const ADR_TARGET = 'brain/project/decisions/adr-9999-fixture.md';

/** An ADR-shape draft whose target the fixture seeds. */
const ADR_DRAFT = [
  '```brain-amendment/1',
  `target: ${ADR_TARGET}`,
  'amendment: 1',
  'issue: 509',
  'home-summary: a summary, #509',
  'body: ## Amendment 1 — t (issue #509)',
  '```',
  '',
  '```amend-find',
  'the old rule',
  '```',
  '',
  '```amend-replace',
  'the old rule **[Amended by Amendment 1 (#509)]**',
  '```',
  '',
  '## Amendment 1 — t (issue #509)',
  '',
  '**Signed**: DD/MM/YYYY — <Name>',
  '',
  'body',
  '',
].join('\n');

/** Writes the ADR target and its brain/HOME.md index line into a fixture. */
function seedAdrTarget(root) {
  writeFileSync(
    join(root, ADR_TARGET),
    '# ADR-9999 — Fixture\n\n**Status**: Accepted\n**Date**: 01/01/2026 — Someone\n\n## Decision\n\nthe old rule\n',
    'utf8',
  );
  const homeAbs = join(root, HOME);
  const home = readFileSync(homeAbs, 'utf8');
  writeFileSync(
    homeAbs,
    home.replace(
      '### Architecture decisions\n',
      '### Architecture decisions\n\n- [ADR-9999](project/decisions/adr-9999-fixture.md) — Fixture\n',
    ),
    'utf8',
  );
}

function cleanup(root) {
  removeTempTree(root);
}

function fixture(draftBody = DOC_DRAFT, draftName = 'ruling.draft.md') {
  return makeFixtureRepo({ draftName, draftBody });
}

async function promote(fx, extra = {}) {
  return runPromote({
    argv: [fx.draftRel],
    isTTY: true,
    root: fx.root,
    readLineFn: async () => CONFIRMATION_WORD,
    todayFn: () => '2026-08-11',
    write: () => {},
    ...extra,
  });
}

// ── harness proof: the fixture's anchor is real, and unique ──────────────────

test('harness: the real workflow-governance.md carries the fixture anchor exactly once', () => {
  const doc = readFileSync(join(REPO_ROOT, WFG), 'utf8');
  assert.equal(doc.split(WFG_ANCHOR).length - 1, 1, `${WFG} must contain "${WFG_ANCHOR}" exactly once`);
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-509-3 — the methodology shape: the target + AGENTS.md, and NOT HOME.md
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-509-3: a doctrine-document amendment writes the target and REGENERATES AGENTS.md', async () => {
  const fx = fixture();
  try {
    const res = await promote(fx);
    assert.equal(res.exitCode, 0, res.output);
    assert.deepEqual([...res.wrote].sort(), [AGENTS, WFG].sort());

    const doc = readFileSync(join(fx.root, WFG), 'utf8');
    assert.ok(doc.includes(WFG_INSERT), 'the in-place edit must have landed');

    // Independent of the compiler agreeing with itself: the NEW TEXT must be
    // inside the compiled file. This is the assertion promote-529.sh failed.
    const agents = readFileSync(join(fx.root, AGENTS), 'utf8');
    assert.ok(agents.includes(WFG_INSERT), 'AGENTS.md must carry the amended text (§1d act 3)');

    const docs = {};
    for (const rel of SOURCE_DOCS) docs[rel] = readFileSync(join(fx.root, rel), 'utf8');
    assert.equal(agents, compileAgentsMd(docs), 'AGENTS.md must be byte-equal to a fresh compile');
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-3: the doctrine shape does NOT touch brain/HOME.md — that act is the ADR shape\'s', async () => {
  const fx = fixture();
  const before = readFileSync(join(fx.root, HOME), 'utf8');
  try {
    const res = await promote(fx);
    assert.equal(res.wrote.includes(HOME), false);
    assert.equal(readFileSync(join(fx.root, HOME), 'utf8'), before);
    assert.deepEqual(stagedPaths(fx.root), [AGENTS, WFG].sort());
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-3: the amendment path creates ZERO commits and prints a commit command instead', async () => {
  const fx = fixture();
  const chunks = [];
  try {
    const before = commitCount(fx.root);
    await promote(fx, { write: (s) => chunks.push(s) });
    assert.equal(commitCount(fx.root), before, 'the verb must never commit');
    assert.match(chunks.join(''), /git commit -m 'docs\(brain\): amend brain\/core\/methodology\/workflow-governance\.md \(#529\)'/);
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-3: re-running an applied doctrine amendment is a no-op with an explicit reason', async () => {
  const fx = fixture();
  try {
    await promote(fx);
    const after = readFileSync(join(fx.root, WFG), 'utf8');
    const second = await promote(fx);
    // This anchor is a PREFIX of its own replacement, so it still occurs exactly
    // once after the first run — an anchor-count check alone would stack the
    // annotation. The no-op must come from recognising the applied replacement.
    assert.equal(second.exitCode, 0, second.output);
    assert.match(second.output, /already promoted/i);
    assert.equal(readFileSync(join(fx.root, WFG), 'utf8'), after, 'the target must be byte-identical after a re-run');
    assert.deepEqual(second.wrote, []);
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-3: a target OUTSIDE the five SOURCE_DOCS leaves AGENTS.md alone — and says so', async () => {
  const other = 'brain/core/methodology/consolidation-protocol.md';
  const fx = fixture(DOC_DRAFT.replace(WFG, other).replace(WFG_ANCHOR, '## 1c anchor').replace(WFG_INSERT, '## 1c anchor (amended)'));
  writeFileSync(join(fx.root, other), '# Protocol\n\n## 1c anchor\n\nbody\n', 'utf8');
  const agentsBefore = readFileSync(join(fx.root, AGENTS), 'utf8');
  const chunks = [];
  try {
    const res = await promote(fx, { write: (s) => chunks.push(s) });
    assert.equal(res.exitCode, 0, res.output);
    assert.deepEqual(res.wrote, [other], 'an unchanged AGENTS.md must not be reported as written');
    assert.equal(readFileSync(join(fx.root, AGENTS), 'utf8'), agentsBefore);
    assert.match(chunks.join(''), /recompiled, byte-identical/);
    assert.deepEqual(stagedPaths(fx.root), [other]);
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-509-4 — ADR-0028's locks hold on the amendment branch too
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-509-4 (lock 1): the REAL entry point refuses an amendment draft on a non-TTY, tree untouched', () => {
  const fx = fixture();
  try {
    const r = spawnSync(process.execPath, [MODULE_PATH, fx.draftRel], {
      cwd: fx.root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /interactive terminal|non-TTY/i);
    assert.equal(statusOf(fx.root), '', 'a non-TTY run must not write or stage anything');
  } finally {
    cleanup(fx.root);
  }
});

for (const flag of ['--yes', '--force', '--confirm=PROMOTE']) {
  test(`REQ-509-4 (lock 2): \`${flag}\` aborts the amendment path BEFORE the prompt`, async () => {
    const fx = fixture();
    let prompted = 0;
    try {
      const res = await promote(fx, {
        argv: [flag, fx.draftRel],
        readLineFn: async () => {
          prompted += 1;
          return CONFIRMATION_WORD;
        },
      });
      assert.notEqual(res.exitCode, 0);
      assert.equal(prompted, 0);
      assert.deepEqual(res.wrote, []);
      assert.equal(statusOf(fx.root), '');
    } finally {
      cleanup(fx.root);
    }
  });
}

for (const answer of ['y', 'yes', 'promote', 'PROMOTE!', '']) {
  test(`REQ-509-4 (lock 4): answer ${JSON.stringify(answer)} aborts the amendment with ZERO writes`, async () => {
    const fx = fixture();
    try {
      const res = await promote(fx, { readLineFn: async () => answer });
      assert.notEqual(res.exitCode, 0);
      assert.deepEqual(res.wrote, []);
      assert.equal(statusOf(fx.root), '');
    } finally {
      cleanup(fx.root);
    }
  });
}

test('REQ-509-4 (lock 4): the prompt is reached exactly ONCE — the plan is shown before it', async () => {
  const fx = fixture();
  const chunks = [];
  let prompted = 0;
  try {
    await promote(fx, {
      readLineFn: async () => {
        prompted += 1;
        assert.match(chunks.join(''), /─── PLAN ── in-place amendment/, 'the plan must be shown BEFORE the prompt');
        return CONFIRMATION_WORD;
      },
      write: (s) => chunks.push(s),
    });
    assert.equal(prompted, 1);
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-4: the rendered plan shows every act it is about to apply', async () => {
  const fx = fixture();
  const chunks = [];
  try {
    await promote(fx, { write: (s) => chunks.push(s) });
    const out = chunks.join('');
    assert.match(out, /act 2 — in-place edit/);
    assert.match(out, new RegExp(WFG_INSERT.replace(/[()#]/g, '\\$&')));
    assert.match(out, /does not commit and does not push/);
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-509-5 — the refusals: it stops rather than guessing
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-509-5: a *.draft.md with NO contract block is refused, and the message names the contract', async () => {
  const fx = fixture('# just prose, no contract\n');
  try {
    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /brain-amendment\/1/);
    assert.deepEqual(res.wrote, []);
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-5: a contract in a file NOT named *.draft.md is refused — the suffix is the marker', async () => {
  const fx = fixture(DOC_DRAFT, 'ruling.md');
  try {
    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /not a promotable draft name/);
    assert.match(res.output, /\.draft\.md/);
    assert.deepEqual(res.wrote, []);
    assert.equal(statusOf(fx.root), '');
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-5: a target that does not exist is refused — this verb amends, it does not create', async () => {
  const fx = fixture(DOC_DRAFT.replace(WFG, 'brain/core/methodology/does-not-exist.md'));
  try {
    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /target not found/);
    assert.deepEqual(res.wrote, []);
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-5: an anchor that occurs twice refuses, and NOTHING is written — not even the acts that resolved', async () => {
  const fx = fixture();
  const targetAbs = join(fx.root, WFG);
  writeFileSync(targetAbs, `${readFileSync(targetAbs, 'utf8')}\n${WFG_ANCHOR}\n`, 'utf8');
  const before = readFileSync(targetAbs, 'utf8');
  try {
    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /anchor occurs 2 time\(s\)/);
    assert.equal(readFileSync(targetAbs, 'utf8'), before, 'a refused run must leave the target byte-identical');
    assert.deepEqual(res.wrote, []);
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-5: an ADR-shaped draft whose ADR is not indexed in brain/HOME.md refuses with nothing written', async () => {
  const adrDraft = [
    '```brain-amendment/1',
    'target: brain/project/decisions/adr-9999-unindexed.md',
    'amendment: 1',
    'issue: 509',
    'home-summary: a summary, #509',
    'body: ## Amendment 1 — t (issue #509)',
    '```',
    '',
    '```amend-find',
    'old line',
    '```',
    '',
    '```amend-replace',
    'new line',
    '```',
    '',
    '## Amendment 1 — t (issue #509)',
    '',
    '**Signed**: DD/MM/YYYY — <Name>',
    '',
    'What changed.',
    '',
  ].join('\n');
  const fx = fixture(adrDraft);
  writeFileSync(
    join(fx.root, 'brain/project/decisions/adr-9999-unindexed.md'),
    '# ADR-9999 — X\n\n**Status**: Accepted\n\nold line\n',
    'utf8',
  );
  try {
    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /0 index lines/);
    assert.deepEqual(res.wrote, []);
    assert.equal(
      readFileSync(join(fx.root, 'brain/project/decisions/adr-9999-unindexed.md'), 'utf8').includes('new line'),
      false,
      'act 2 must not survive a failure in the fourth act',
    );
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-509-5: a git config user.name that is empty refuses before any amendment act', async () => {
  const fx = fixture();
  const before = readFileSync(join(fx.root, WFG), 'utf8');
  try {
    const res = await promote(fx, { gitUserNameFn: () => '  ' });
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /user\.name/);
    assert.equal(readFileSync(join(fx.root, WFG), 'utf8'), before);
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-509-7 — the stopgap scripts this verb replaces are gone
// ═══════════════════════════════════════════════════════════════════════════

for (const stopgap of [
  'openspec/changes/issue-529-memory-gate-ruling/brain-drafts/promote-529.sh',
  'openspec/changes/issue-516-doctrine-gate-claim/brain-drafts/promote-516.sh',
]) {
  test(`REQ-509-7: ${stopgap} no longer exists — one implementation of the cascade, not three`, () => {
    assert.equal(existsSync(join(REPO_ROOT, stopgap)), false);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// The cold review's blockers, each proven END-TO-END against a real throwaway
// repo. Every one of them was found that way and missed by unit assertions:
// they are properties of the verb plus git plus the filesystem, and a unit test
// cannot observe any of the three.
// ═══════════════════════════════════════════════════════════════════════════

/** Runs a real `git` in the fixture. */
function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8' });
}

// ── BLOCKER 1 — a partial cascade is never reported as success ───────────────

test('BLOCKER 1 e2e: the signed section pasted BY HAND, cascade undone → refusal, not "already promoted"', async () => {
  const fx = fixture(ADR_DRAFT, 'adr-amendment.draft.md');
  seedAdrTarget(fx.root);
  // The human pastes act 3 by hand — how all three cited precedents were done.
  const targetAbs = join(fx.root, ADR_TARGET);
  writeFileSync(targetAbs, `${readFileSync(targetAbs, 'utf8')}\n## Amendment 1 — t (issue #509)\n\nbody\n`, 'utf8');
  git(fx.root, ['add', '-A']);
  git(fx.root, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'chore: hand-pasted section (#509)']);
  try {
    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0, 'a three-quarters-undone cascade must not exit 0');
    assert.match(res.output, /PARTIALLY amended/);
    assert.match(res.output, /act 1 — Status line: PENDING/);
    assert.match(res.output, /act 4 — brain\/HOME\.md marker: PENDING/);
    assert.deepEqual(res.wrote, []);
    // And the act the old code reported success about is still missing. Keyed on
    // ADR-9999's OWN index line: the real brain/HOME.md carries other ADRs'
    // amendment markers, so a whole-file search would pass on someone else's.
    const adrLine = readFileSync(join(fx.root, HOME), 'utf8')
      .split('\n')
      .find((l) => l.includes('](project/decisions/adr-9999-fixture.md)'));
    assert.equal(adrLine.includes('**Amendment 1,'), false, `ADR-9999's index line gained a marker: ${adrLine}`);
  } finally {
    cleanup(fx.root);
  }
});

test('BLOCKER 1 e2e: a complete cascade with a STALE AGENTS.md is not "already promoted" — it regenerates', async () => {
  const fx = fixture();
  try {
    await promote(fx); // full, correct promotion
    // Simulate the AGENTS.md step having been lost — the #529 defect exactly.
    const agentsAbs = join(fx.root, AGENTS);
    const stale = readFileSync(agentsAbs, 'utf8').replace(WFG_INSERT, WFG_ANCHOR);
    writeFileSync(agentsAbs, stale, 'utf8');
    git(fx.root, ['add', '-A']);
    git(fx.root, ['-c', 'core.hooksPath=/dev/null', 'commit', '--quiet', '-m', 'chore: lose the cascade step (#509)']);

    const second = await promote(fx);
    assert.equal(second.exitCode, 0, second.output);
    assert.deepEqual(second.wrote, [AGENTS], 'the missing act, and only the missing act');
    const docs = {};
    for (const rel of SOURCE_DOCS) docs[rel] = readFileSync(join(fx.root, rel), 'utf8');
    assert.equal(readFileSync(join(fx.root, AGENTS), 'utf8'), compileAgentsMd(docs));
  } finally {
    cleanup(fx.root);
  }
});

// ── BLOCKER 3 — unmerged paths ──────────────────────────────────────────────

test('BLOCKER 3 e2e: with a real merge conflict in the tree, the verb REFUSES and stages no markers', async () => {
  const fx = fixture();
  const home = join(fx.root, HOME);
  try {
    git(fx.root, ['checkout', '--quiet', '-b', 'side']);
    writeFileSync(home, `${readFileSync(home, 'utf8')}\nside change\n`, 'utf8');
    git(fx.root, ['commit', '--quiet', '-am', 'chore: side (#509)']);
    git(fx.root, ['checkout', '--quiet', 'master']).status === 0 || git(fx.root, ['checkout', '--quiet', 'main']);
    writeFileSync(home, `${readFileSync(home, 'utf8')}\nmain change\n`, 'utf8');
    git(fx.root, ['commit', '--quiet', '-am', 'chore: main (#509)']);
    const merge = git(fx.root, ['merge', 'side']);
    assert.notEqual(merge.status, 0, 'the fixture must actually be in conflict');
    assert.match(git(fx.root, ['status', '--porcelain']).stdout, /^UU /m, 'HOME.md must be UU');

    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /unmerged path/);
    assert.deepEqual(res.wrote, []);
    // The conflict is still a conflict: `git add` never ran. Counted, because
    // the reviewer's measurement was a COUNT going 1 → 0, and a boolean
    // "is there still a conflict" would pass on any number above zero.
    const unmerged = git(fx.root, ['diff', '--name-only', '--diff-filter=U']).stdout.split('\n').filter(Boolean);
    assert.equal(unmerged.length, 1, 'the conflict must still be unresolved');
    assert.equal(readFileSync(join(fx.root, AGENTS), 'utf8').includes('<<<<<<<'), false);
    assert.equal(git(fx.root, ['show', `:2:${HOME}`]).status, 0, 'HOME.md must still have merge stages');
  } finally {
    cleanup(fx.root);
  }
});

test('BLOCKER 3 e2e: a STAGED-only edit to a write path is refused, not destroyed', async () => {
  const fx = fixture();
  const wfg = join(fx.root, WFG);
  try {
    writeFileSync(wfg, `${readFileSync(wfg, 'utf8')}\nprecious staged edit\n`, 'utf8');
    git(fx.root, ['add', '--', WFG]);
    const stagedBefore = git(fx.root, ['show', ':' + WFG]).stdout;
    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /STAGED changes/);
    assert.deepEqual(res.wrote, []);
    assert.equal(git(fx.root, ['show', ':' + WFG]).stdout, stagedBefore, 'the index entry must survive');
  } finally {
    cleanup(fx.root);
  }
});

test('BLOCKER 8 e2e: unstaged content already in a write path is DISCLOSED in the plan before the word', async () => {
  const fx = fixture();
  const wfg = join(fx.root, WFG);
  const chunks = [];
  try {
    writeFileSync(wfg, `${readFileSync(wfg, 'utf8')}\nunrelated in-flight edit\n`, 'utf8');
    const res = await promote(fx, { write: (s) => chunks.push(s) });
    assert.equal(res.exitCode, 0, res.output);
    const out = chunks.join('');
    assert.match(out, /ALREADY differ from HEAD/);
    assert.match(out, new RegExp(WFG.replace(/[/.]/g, '\\$&')));
    // The disclosure precedes the confirmation prompt.
    assert.ok(out.indexOf('ALREADY differ from HEAD') < out.indexOf(`Type ${CONFIRMATION_WORD}`));
  } finally {
    cleanup(fx.root);
  }
});

// ── BLOCKER 6 — symlinked target ────────────────────────────────────────────

test('BLOCKER 6 e2e: a symlinked target is REFUSED, and the out-of-repo file is untouched', async () => {
  const fx = fixture();
  const outside = mkdtempSync(join(tmpdir(), 'brain-outside-'));
  const outsideFile = join(outside, 'escaped.md');
  const original = '# Not part of any repository\n\n## Lockout Recovery\n';
  writeFileSync(outsideFile, original, 'utf8');
  const wfg = join(fx.root, WFG);
  try {
    rmSync(wfg);
    symlinkSync(outsideFile, wfg);
    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /SYMLINK/);
    assert.deepEqual(res.wrote, []);
    assert.equal(readFileSync(outsideFile, 'utf8'), original, 'the out-of-repo file must be byte-identical');
  } finally {
    cleanup(fx.root);
    removeTempTree(outside);
  }
});

// ── BLOCKER 5 — a failed write rolls back ───────────────────────────────────

test('BLOCKER 5 e2e: a mid-cascade write failure ROLLS BACK, stages nothing, and leaves no half-amended file', async () => {
  const fx = fixture();
  const wfg = join(fx.root, WFG);
  const agentsAbs = join(fx.root, AGENTS);
  const wfgBefore = readFileSync(wfg, 'utf8');
  const agentsBefore = readFileSync(agentsAbs, 'utf8');
  try {
    // Fail the LAST write of the cascade, after the target is already rewritten
    // on disk. Injected rather than forced with a mode bit, because a mode bit
    // does not bite as root and a test that quietly does nothing is the defect
    // this whole review round is about.
    let writes = 0;
    const res = await promote(fx, {
      writeFileFn: (abs, text) => {
        writes += 1;
        if (abs === agentsAbs && writes <= 2) throw Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
        writeFileSync(abs, text, 'utf8');
      },
    });
    assert.ok(writes >= 2, `the failure must happen mid-cascade, after a real write; writes=${writes}`);
    assert.notEqual(res.exitCode, 0, 'a failed cascade must not report success');
    assert.match(res.output, /Rolled back/);
    assert.deepEqual(res.wrote, []);
    assert.equal(readFileSync(wfg, 'utf8'), wfgBefore, 'the target must be restored to its pre-run bytes');
    assert.equal(readFileSync(agentsAbs, 'utf8'), agentsBefore);
    assert.equal(statusOf(fx.root), '', 'nothing written, nothing staged');
  } finally {
    cleanup(fx.root);
  }
});

test('BLOCKER 5 e2e: the same rollback against a REAL immutable file (EPERM from the kernel, not from a seam)', async () => {
  // The seam above proves the rollback logic; this proves the logic is what a
  // real write failure reaches. chattr needs privileges the runner may lack, so
  // the capability is PROBED and the probe's outcome is asserted — never a
  // silent early return.
  const probe = mkdtempSync(join(tmpdir(), 'brain-immutable-'));
  const probeFile = join(probe, 'f.md');
  writeFileSync(probeFile, 'x', 'utf8');
  const chattrWorks =
    spawnSync('chattr', ['+i', probeFile]).status === 0 &&
    spawnSync(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(probeFile)}, 'y')`]).status !== 0;
  spawnSync('chattr', ['-i', probeFile]);
  removeTempTree(probe);
  if (!chattrWorks) {
    // Not a pass dressed as a pass: the seam-driven test above still ran and is
    // the one that pins the behaviour everywhere.
    console.log('    (chattr unavailable here — the seam-driven rollback test above is the binding one)');
    return;
  }

  const fx = fixture();
  const wfg = join(fx.root, WFG);
  const agentsAbs = join(fx.root, AGENTS);
  const wfgBefore = readFileSync(wfg, 'utf8');
  try {
    assert.equal(spawnSync('chattr', ['+i', agentsAbs]).status, 0);
    const res = await promote(fx);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /Rolled back/);
    assert.equal(readFileSync(wfg, 'utf8'), wfgBefore, 'the target must be restored after a real EPERM');
    assert.equal(statusOf(fx.root), '');
  } finally {
    spawnSync('chattr', ['-i', agentsAbs]);
    cleanup(fx.root);
  }
});
