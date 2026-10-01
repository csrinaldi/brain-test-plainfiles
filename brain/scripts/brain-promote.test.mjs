// brain-promote.test.mjs — the MECHANICS of `brain:promote` (REQ-378-5 .. -10).
//
// The structural locks live in brain-promote.locks.test.mjs. This file covers
// what the verb produces once the locks have let it run: the derived
// destination, the refusals that all happen BEFORE the first write, the header
// rewrite, the paste-safe commit command, and the three-file cascade.
//
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  CONFIRMATION_WORD,
  parseArgs,
  transformDraft,
  shellQuote,
  buildCommitCommand,
  destinationFor,
  renderPlan,
  runPromote,
} from './brain-promote.mjs';
import { GUARDS } from './lib/promote-guards.mjs';
import { compileAgentsMd, SOURCE_DOCS } from './axes/platform/adapters/antigravity.mjs';
import { makeFixtureRepo, statusOf, SAMPLE_DRAFT } from './__fixtures__/promote-repo.mjs';

// Independent transcription of governance/checks/adr-presence.mjs's ADR_RE.
// Transcribed rather than imported on purpose: this test exists to prove the
// destination satisfies that gate, and importing the gate's own regex would
// make the assertion vacuous if the gate ever loosened.
const ADR_PRESENCE_RE = /^brain\/project\/decisions\/adr-\d+-.+\.md$/;

const cleanup = (root) => rmSync(root, { recursive: true, force: true });

async function decline(root, argv, extra = {}) {
  return runPromote({
    argv,
    isTTY: true,
    root,
    readLineFn: async () => CONFIRMATION_WORD,
    todayFn: () => '2026-08-07',
    write: () => {},
    ...extra,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-5 — the destination is DERIVED, and it satisfies adrPresence
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-378-5: the destination is derived from the draft basename and matches adrPresence', () => {
  const dest = destinationFor('openspec/changes/issue-378-x/brain-drafts/adr-0028-a-slug.md');
  assert.equal(dest, 'brain/project/decisions/adr-0028-a-slug.md');
  assert.match(dest, ADR_PRESENCE_RE);
});

for (const bad of ['adr-28-short-number.md', 'notes.md', 'adr-0028.md', 'ADR-0028-upper.md', 'adr-0028-x.txt']) {
  test(`REQ-378-5: a draft named '${bad}' is REFUSED, not promoted to a path the ADR gate will not count`, async () => {
    const fx = makeFixtureRepo({ draftName: bad });
    try {
      const res = await decline(fx.root, [fx.draftRel]);
      assert.notEqual(res.exitCode, 0);
      assert.deepEqual(res.wrote, []);
      assert.equal(statusOf(fx.root), '');
    } finally {
      cleanup(fx.root);
    }
  });
}

test('REQ-378-5: a number in the filename that disagrees with the H1 is REFUSED', async () => {
  const fx = makeFixtureRepo({ draftName: 'adr-0031-sample-decision.md' }); // body H1 says ADR-0028
  try {
    const res = await decline(fx.root, [fx.draftRel]);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /0031[\s\S]*0028|0028[\s\S]*0031/);
    assert.deepEqual(res.wrote, []);
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-378-5: a draft that does not exist is REFUSED with no writes', async () => {
  const fx = makeFixtureRepo();
  try {
    const res = await decline(fx.root, ['openspec/changes/issue-378-brain-promote/brain-drafts/adr-0099-missing.md']);
    assert.notEqual(res.exitCode, 0);
    assert.deepEqual(res.wrote, []);
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-6 — never overwrite a signed artefact
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-378-6: an existing destination is REFUSED (the issue\'s own fixture number is already taken on main)', async () => {
  const fx = makeFixtureRepo();
  const destAbs = join(fx.root, fx.destRel);
  writeFileSync(destAbs, '# ADR-0028 — a DIFFERENT, already-signed decision\n', 'utf8');
  const before = readFileSync(destAbs, 'utf8');
  try {
    const res = await decline(fx.root, [fx.draftRel]);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /already exists/i);
    assert.equal(readFileSync(destAbs, 'utf8'), before, 'a signed artefact must never be overwritten');
    assert.deepEqual(res.wrote, []);
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-7 — the header rewrite, bounded to the preamble
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-378-7: the house header replaces the draft blockquotes, and the Tier 2 banner is gone', () => {
  const r = transformDraft(SAMPLE_DRAFT, { gitUserName: 'Ada Lovelace', today: '2026-08-07' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.number, '0028');
  assert.equal(r.title, 'A sample decision for the promote fixture');
  const lines = r.text.split('\n');
  assert.equal(lines[0], '# ADR-0028 — A sample decision for the promote fixture');
  assert.ok(r.text.includes('**Status**: Accepted'));
  assert.ok(r.text.includes('**Date**: 2026-08-07 — Ada Lovelace'));
  assert.equal(r.text.includes('Tier 2 draft'), false, 'the Tier 2 banner has no place in the promoted artifact');
  assert.equal(r.text.includes('pending human promotion'), false);
  assert.equal(r.text.includes('> **status:**'), false);
});

test('REQ-378-7: a blockquote INSIDE the body survives — the strip is bounded to the preamble', () => {
  const r = transformDraft(SAMPLE_DRAFT, { gitUserName: 'Ada Lovelace', today: '2026-08-07' });
  assert.ok(
    r.text.includes('> A blockquote INSIDE the body.'),
    'a whole-file blockquote strip would eat content',
  );
});

test('REQ-378-7: body content and headings are preserved verbatim', () => {
  const r = transformDraft(SAMPLE_DRAFT, { gitUserName: 'Ada Lovelace', today: '2026-08-07' });
  assert.ok(r.text.includes('## Context'));
  assert.ok(r.text.includes('## Decision'));
  assert.ok(r.text.includes('Something happened.'));
  assert.ok(r.text.endsWith('\n'));
});

test('REQ-378-7: a draft whose first content line is not an ADR H1 is refused', () => {
  const r = transformDraft('Some prose\n\n# ADR-0028 — late\n', { gitUserName: 'X', today: '2026-08-07' });
  assert.equal(r.ok, false);
});

test('REQ-378-7: an empty git config user.name is a REFUSAL, not a blank stamp', async () => {
  const fx = makeFixtureRepo();
  try {
    const res = await decline(fx.root, [fx.draftRel], { gitUserNameFn: () => '   ' });
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /user\.name/);
    assert.deepEqual(res.wrote, []);
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-8 — the printed commit command is paste-safe and hook-conforming
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-378-8: shellQuote single-quotes and escapes an embedded apostrophe', () => {
  assert.equal(shellQuote('plain'), "'plain'");
  assert.equal(shellQuote("it's"), "'it'\\''s'");
});

test('REQ-378-8: a title containing BACKTICKS is not command-substituted on paste (ADR-0027 has them)', () => {
  const cmd = buildCommitCommand({ number: '0027', title: '`brain:upgrade` rollback', issue: '396' });
  assert.ok(cmd.startsWith("git commit -m '"), cmd);
  assert.equal(cmd.includes('"'), false, 'a double-quoted message executes backticks on paste');
  assert.ok(cmd.includes('`brain:upgrade`'));
});

test('REQ-378-8: the message passes commit-msg — Conventional Commits AND a #N reference', () => {
  const cmd = buildCommitCommand({ number: '0028', title: 'A decision', issue: '378' });
  const msg = cmd.slice(cmd.indexOf("'") + 1, cmd.lastIndexOf("'"));
  assert.match(msg, /^(feat|fix|docs|style|refactor|perf|test|chore|build|ci|revert)(\([^)]+\))?(!)?: .+/);
  assert.match(msg, /#[0-9]+/);
  assert.equal(msg.includes('\n'), false);
});

test('REQ-378-8: an underivable issue number yields an OBVIOUS placeholder, not a silently-rejected command', () => {
  const cmd = buildCommitCommand({ number: '0028', title: 'A decision', issue: null });
  assert.match(cmd, /#<issue-number>/);
});

test('REQ-378-8: the issue number is read from the draft path', async () => {
  const fx = makeFixtureRepo();
  const chunks = [];
  try {
    await runPromote({
      argv: [fx.draftRel], isTTY: true, root: fx.root,
      readLineFn: async () => CONFIRMATION_WORD, todayFn: () => '2026-08-07',
      write: (s) => chunks.push(s),
    });
    assert.match(chunks.join(''), /\(#378\)/);
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-9 — the cascade is complete, or nothing happened
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-378-9: one accepted run writes the ADR, the HOME.md entry and a REGENERATED AGENTS.md', async () => {
  const fx = makeFixtureRepo();
  try {
    const res = await runPromote({
      argv: [fx.draftRel], isTTY: true, root: fx.root,
      readLineFn: async () => CONFIRMATION_WORD, todayFn: () => '2026-08-07',
      write: () => {},
    });
    assert.equal(res.exitCode, 0, JSON.stringify(res));
    assert.deepEqual([...res.wrote].sort(), ['AGENTS.md', 'brain/HOME.md', fx.destRel].sort());

    const adr = readFileSync(join(fx.root, fx.destRel), 'utf8');
    assert.ok(adr.includes('**Status**: Accepted'));
    assert.equal(adr.includes('Tier 2 draft'), false);

    const home = readFileSync(join(fx.root, 'brain/HOME.md'), 'utf8');
    assert.ok(home.includes('](project/decisions/adr-0028-sample-decision.md)'));

    // AGENTS.md must be what the REAL compiler produces from the NEW HOME.md —
    // the same byte-equality the existing antigravity drift guard asserts.
    const docs = {};
    for (const rel of SOURCE_DOCS) docs[rel] = readFileSync(join(fx.root, rel), 'utf8');
    assert.equal(readFileSync(join(fx.root, 'AGENTS.md'), 'utf8'), compileAgentsMd(docs));
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-378-9: the HOME.md entry is inserted after the LAST existing ADR link', async () => {
  const fx = makeFixtureRepo();
  try {
    await runPromote({
      argv: [fx.draftRel], isTTY: true, root: fx.root,
      readLineFn: async () => CONFIRMATION_WORD, todayFn: () => '2026-08-07', write: () => {},
    });
    const lines = readFileSync(join(fx.root, 'brain/HOME.md'), 'utf8').split('\n');
    const idx = lines.findIndex((l) => l.includes('](project/decisions/adr-0028-sample-decision.md)'));
    assert.ok(idx > 0);
    assert.match(lines[idx - 1], /^- \[ADR-\d{4}\]\(project\/decisions\//);
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-378-9: an ADR already indexed in HOME.md is a REFUSAL, not a silent no-op', async () => {
  const fx = makeFixtureRepo();
  const homeAbs = join(fx.root, 'brain/HOME.md');
  const home = readFileSync(homeAbs, 'utf8').replace(
    '### Architecture decisions\n',
    '### Architecture decisions\n- [ADR-0028](project/decisions/adr-0028-sample-decision.md) — pre-existing\n',
  );
  writeFileSync(homeAbs, home, 'utf8');
  try {
    const res = await decline(fx.root, [fx.draftRel]);
    assert.notEqual(res.exitCode, 0);
    assert.deepEqual(res.wrote, []);
    assert.equal(existsSync(join(fx.root, fx.destRel)), false);
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-10 — the human reads what they sign
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-378-10: the draft body and the full plan are rendered BEFORE the prompt', async () => {
  const fx = makeFixtureRepo();
  const chunks = [];
  let outAtPrompt = null;
  try {
    await runPromote({
      argv: [fx.draftRel], isTTY: true, root: fx.root,
      readLineFn: async () => { outAtPrompt = chunks.join(''); return 'n'; },
      todayFn: () => '2026-08-07',
      write: (s) => chunks.push(s),
    });
    assert.ok(outAtPrompt, 'the prompt must be reached');
    assert.ok(outAtPrompt.includes('Something happened.'), 'the draft body must be shown in full');
    assert.ok(outAtPrompt.includes(fx.destRel), 'the destination must be shown');
    assert.ok(outAtPrompt.includes('**Status**: Accepted'), 'the header rewrite must be shown');
    assert.ok(outAtPrompt.includes('](project/decisions/adr-0028-sample-decision.md)'), 'the HOME.md line must be shown');
    assert.match(outAtPrompt, /AGENTS\.md/, 'the AGENTS.md regeneration must be shown');
    assert.ok(outAtPrompt.includes(CONFIRMATION_WORD), 'the required word must be stated');
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-378-10: the HOME.md line SHOWN is byte-identical to the line WRITTEN', async () => {
  const fx = makeFixtureRepo();
  const chunks = [];
  try {
    await runPromote({
      argv: [fx.draftRel], isTTY: true, root: fx.root,
      readLineFn: async () => CONFIRMATION_WORD, todayFn: () => '2026-08-07',
      write: (s) => chunks.push(s),
    });
    const shown = chunks.join('').split('\n').find((l) => l.includes('](project/decisions/adr-0028-sample-decision.md)'));
    const written = readFileSync(join(fx.root, 'brain/HOME.md'), 'utf8')
      .split('\n').find((l) => l.includes('](project/decisions/adr-0028-sample-decision.md)'));
    assert.ok(shown && written);
    assert.equal(shown.trim(), written.trim(), 'the plan shown must be the plan applied');
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-378-10: renderPlan is pure — same input, same output, no I/O', () => {
  const plan = {
    draftPath: 'd/adr-0028-x.md',
    destination: 'brain/project/decisions/adr-0028-x.md',
    headerBefore: '> **status:** proposed',
    headerAfter: '**Status**: Accepted\n**Date**: 2026-08-07 — Ada',
    homeLine: '- [ADR-0028](project/decisions/adr-0028-x.md) — X',
    homeAfterLine: '- [ADR-0027](project/decisions/adr-0027-y.md) — Y',
    agentsPath: 'AGENTS.md',
  };
  assert.equal(renderPlan(plan), renderPlan(plan));
  assert.ok(renderPlan(plan).includes('brain/project/decisions/adr-0028-x.md'));
});

// ═══════════════════════════════════════════════════════════════════════════
// argument parsing
// ═══════════════════════════════════════════════════════════════════════════

test('parseArgs accepts exactly one positional', () => {
  assert.deepEqual(parseArgs(['a/b/adr-0028-x.md']), { ok: true, draftPath: 'a/b/adr-0028-x.md' });
});

for (const argv of [[], ['a.md', 'b.md'], ['a.md', 'b.md', 'c.md']]) {
  test(`parseArgs rejects ${JSON.stringify(argv)}`, () => {
    assert.equal(parseArgs(argv).ok, false);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// #675 / #674 — the content guards, end to end through the real verb
//
// Both reproductions run against a REAL fixture repo and assert three things
// the exit code alone is blind to: nothing written, nothing staged, and the
// confirmation NEVER ASKED. The third is the requirement — a refusal that
// arrives after the human has typed PROMOTE has already cost them the signature
// both tickets are about.
// ═══════════════════════════════════════════════════════════════════════════

/** A draft in the shape that produced the corrupt ADR-0031: bare, not blockquoted. */
const BARE_STATUS_DRAFT = `# ADR-0028 — A sample decision for the promote fixture

**Status**: Proposed — pending human signature
**Date**: 2026-08-15 — drafted by agent

## Context

Something happened.
`;

/** Assembled, never a literal URL — this file is under brain/** and is scanned. */
const FOREIGN = ['session', 'somewhere', 'gov', 'ar'].join('.');

const FOREIGN_HOST_DRAFT = `# ADR-0028 — A sample decision for the promote fixture

> **status:** proposed — pending human promotion | **date:** 2026-08-15 | **owner:** @crinaldi

## Context

Evidence: ${'https://'}${FOREIGN}/session/abc
`;

async function refuseBeforePrompt(root, draftRel) {
  return runPromote({
    argv: [draftRel],
    isTTY: true,
    root,
    // The assertion, not a stub: if the verb reaches the confirmation the run
    // rejects. A guard that fires after this point is the defect, not the fix.
    readLineFn: async () => { throw new Error('the confirmation was reached — the guard ran too late'); },
    todayFn: () => '2026-08-07',
    write: () => {},
  });
}

test('#675: a draft with a bare **Status** line is REFUSED — nothing written, nothing staged, never asked', async () => {
  const fx = makeFixtureRepo({ draftBody: BARE_STATUS_DRAFT });
  try {
    const res = await refuseBeforePrompt(fx.root, fx.draftRel);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /single-status-line/);
    assert.match(res.output, /2 `\*\*Status\*\*:` line\(s\), expected exactly 1/);
    assert.match(res.output, /> \*\*status:\*\*/, 'the refusal must show the shape the draft should have used');
    assert.deepEqual(res.wrote, []);
    assert.deepEqual(res.staged, []);
    assert.equal(statusOf(fx.root), '', 'nothing may be written or staged');
    assert.equal(existsSync(join(fx.root, fx.destRel)), false, 'the corrupt ADR must not exist');
  } finally {
    cleanup(fx.root);
  }
});

test('#675: the corrupt artefact is what the verb WOULD have produced — the fixture is not a straw man', () => {
  // Without this, the test above could pass because the draft is malformed in
  // some other way. transformDraft is run directly: two Status lines, exactly
  // as the ADR-0031 promotion produced them.
  const r = transformDraft(BARE_STATUS_DRAFT, { gitUserName: 'Fixture Human', today: '2026-08-07' });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.text.split('**Status**:').length - 1, 2, 'the header rewrite keeps the draft\'s own Status line');
});

test('#674: a foreign host reaching a SHIPPED destination is REFUSED before the signature', async () => {
  const fx = makeFixtureRepo({ draftBody: FOREIGN_HOST_DRAFT });
  try {
    const res = await refuseBeforePrompt(fx.root, fx.draftRel);
    assert.notEqual(res.exitCode, 0);
    assert.match(res.output, /shipped-hostnames/);
    assert.match(res.output, new RegExp(FOREIGN.replace(/\./g, '\\.')));
    assert.match(res.output, /brain\/project\/decisions\/adr-0028-sample-decision\.md/);
    assert.deepEqual(res.wrote, []);
    assert.equal(statusOf(fx.root), '');
  } finally {
    cleanup(fx.root);
  }
});

test('#674: the same bytes at the DRAFT path are green — which is why nothing caught it before', () => {
  // The defect stated as a property rather than as prose: the guard's verdict
  // depends only on where the file is going. This is what made ADR-0031 pass
  // `npm test`, `brain:repo:check` and CI, and go red on the signing commit.
  const g = GUARDS.find((x) => x.name === 'shipped-hostnames');
  assert.equal(g.applies('openspec/changes/issue-671-x/brain-drafts/adr-0031-x.md'), false);
  assert.equal(g.applies('brain/project/decisions/adr-0031-x.md'), true);
});

test('#675/#674: a clean promotion still happens, and REPORTS which guards ran', async () => {
  const fx = makeFixtureRepo();
  const chunks = [];
  try {
    const res = await runPromote({
      argv: [fx.draftRel], isTTY: true, root: fx.root,
      readLineFn: async () => CONFIRMATION_WORD, todayFn: () => '2026-08-07',
      write: (s) => chunks.push(s),
    });
    assert.equal(res.exitCode, 0, res.output);
    const out = chunks.join('');
    assert.match(out, /guards — ran against the DESTINATION content/);
    assert.match(out, /single-status-line/);
    assert.match(out, /shipped-hostnames/);
    assert.equal(res.wrote.length, 3, 'the three-file cascade is unchanged');
  } finally {
    cleanup(fx.root);
  }
});
