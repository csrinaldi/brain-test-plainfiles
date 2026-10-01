// archive-sweep.test.mjs — pure unit suite for classifySweepDiff, the
// content-earned archive-sweep issue-link exemption (#557 phase 9 gap-close).
//
// RED until brain/scripts/governance/checks/archive-sweep.mjs exists.
// Modeled on lane.test.mjs: every case here is evidence-shaped, never
// branch-name-shaped — the branch regex alone never earns the exemption.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { SWEEP_BRANCH_RE, classifySweepDiff } from './archive-sweep.mjs';

// ── SWEEP_BRANCH_RE ──────────────────────────────────────────────────────

test('SWEEP_BRANCH_RE matches auto-archive/<date>, rejects lookalikes', () => {
  assert.equal(SWEEP_BRANCH_RE.test('auto-archive/2026-09-23'), true);
  assert.equal(SWEEP_BRANCH_RE.test('auto-archive/2026-9-23'), false);
  assert.equal(SWEEP_BRANCH_RE.test('auto-archive-2026-09-23'), false);
  assert.equal(SWEEP_BRANCH_RE.test('auto-archive/2026-09-23-extra'), false);
  assert.equal(SWEEP_BRANCH_RE.test('feat/auto-archive/2026-09-23'), false);
});

// ── classifySweepDiff — the real shape ──────────────────────────────────

test('a real-shaped sweep diff (rename + new spec + appended spec, no deletions) ⇒ exempt:true', () => {
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'R100\topenspec/changes/issue-9-foo/tasks.md\topenspec/changes/archive/9/tasks.md',
      'M\topenspec/specs/existing-cap/spec.md',
      'A\topenspec/specs/new-cap/spec.md',
    ],
    numstatLines: [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/tasks.md',
      '4\t0\topenspec/specs/existing-cap/spec.md',
      '1\t0\topenspec/specs/new-cap/spec.md',
    ],
  });
  assert.equal(result.exempt, true);
  assert.deepEqual(result.offending, []);
});

test('multiple folders archived in one sweep (2 renames, different iids) ⇒ exempt:true', () => {
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'R100\topenspec/changes/issue-11-bar/proposal.md\topenspec/changes/archive/11/proposal.md',
    ],
    numstatLines: [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '0\t0\topenspec/changes/{issue-11-bar => archive/11}/proposal.md',
    ],
  });
  assert.equal(result.exempt, true);
});

// ── the hole this predicate exists to close ─────────────────────────────

test('a rename plus ONE extra code file ⇒ not exempt, offending names the code file', () => {
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'M\tbrain/scripts/governance/run-check.mjs',
    ],
    numstatLines: [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '10\t2\tbrain/scripts/governance/run-check.mjs',
    ],
  });
  assert.equal(result.exempt, false);
  assert.ok(result.offending.some((o) => o.includes('run-check.mjs')));
});

test('a spec-only edit with NO archive renames ⇒ not exempt (a spec-only change is never exempt alone)', () => {
  const result = classifySweepDiff({
    nameStatusLines: ['M\topenspec/specs/existing-cap/spec.md'],
    numstatLines: ['4\t0\topenspec/specs/existing-cap/spec.md'],
  });
  assert.equal(result.exempt, false);
  assert.match(result.reason, /no archive rename/);
});

test('a NEW spec file with no archive rename ⇒ not exempt (creation alone proves nothing)', () => {
  const result = classifySweepDiff({
    nameStatusLines: ['A\topenspec/specs/new-cap/spec.md'],
    numstatLines: ['1\t0\topenspec/specs/new-cap/spec.md'],
  });
  assert.equal(result.exempt, false);
  assert.match(result.reason, /no archive rename/);
});

test('a modified spec file WITH deletions ⇒ not exempt (append-only is the earned rule, not "modified")', () => {
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'M\topenspec/specs/existing-cap/spec.md',
    ],
    numstatLines: [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '4\t3\topenspec/specs/existing-cap/spec.md', // 3 deletions — not a pure append
    ],
  });
  assert.equal(result.exempt, false);
  assert.ok(result.offending.some((o) => o.includes('existing-cap/spec.md')));
});

test('a non-renamed deletion under openspec/changes/ ⇒ not exempt', () => {
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'D\topenspec/changes/issue-9-foo/design.md', // deleted outright, no matching rename
    ],
    numstatLines: [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '0\t5\topenspec/changes/issue-9-foo/design.md',
    ],
  });
  assert.equal(result.exempt, false);
  assert.ok(result.offending.some((o) => o.includes('design.md')));
});

test('a rename whose destination basename does not match the source (same-basename rule) ⇒ not exempt', () => {
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/renamed-to-something-else.md',
    ],
    numstatLines: [
      '0\t0\topenspec/changes/{issue-9-foo/proposal.md => archive/9/renamed-to-something-else.md}',
    ],
  });
  assert.equal(result.exempt, false);
});

test('a rename whose source is NOT under openspec/changes/ ⇒ not exempt', () => {
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\tbrain/scripts/foo.mjs\topenspec/changes/archive/9/foo.mjs',
    ],
    numstatLines: ['0\t0\tbrain/scripts/{foo.mjs => ../openspec/changes/archive/9/foo.mjs}'],
  });
  assert.equal(result.exempt, false);
});

test('a rename whose destination is NOT under openspec/changes/archive/ ⇒ not exempt', () => {
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-foo/proposal.md\tbrain/scripts/sneaky.md',
    ],
    numstatLines: ['0\t0\t{openspec/changes/issue-9-foo => brain/scripts}/proposal.md'],
  });
  assert.equal(result.exempt, false);
});

// ── residual risk 2 (ADR-0035): an added file under archive/<dest>/ must
// under archive/** at all — no real archiveChange run ever ADDS a file
// there (see the module header comment), so there is no legitimate case
// to protect and the rule costs nothing tightened all the way to zero.

test('a real rename plus an unrelated added file under a DIFFERENT archive/<dest>/ ⇒ not exempt, offending names it (ADR-0035 residual risk 2)', () => {
  // The exact proof from the gap report: a genuine issue-9 rename earns
  // nothing for a hand-added payload dropped under archive/anything/.
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-x/spec.md\topenspec/changes/archive/9/spec.md',
      'A\topenspec/changes/archive/anything/payload.sh',
    ],
    numstatLines: [
      '0\t0\topenspec/changes/{issue-9-x => archive/9}/spec.md',
      '40\t0\topenspec/changes/archive/anything/payload.sh',
    ],
  });
  assert.equal(result.exempt, false);
  assert.ok(result.offending.some((o) => o.includes('payload.sh')));
});

test('an added file under archive/<dest>/ where <dest> IS a real rename destination in the same diff ⇒ STILL not exempt (zero added files under archive/** are ever exempt)', () => {
  // Same-folder pairing used to let this through — closed. No real
  // archiveChange run ever adds a file under archive/<iid>/ (it only
  // renames), so there is nothing legitimate this would have protected.
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'A\topenspec/changes/archive/9/extra-file.md',
    ],
    numstatLines: [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '3\t0\topenspec/changes/archive/9/extra-file.md',
    ],
  });
  assert.equal(result.exempt, false);
  assert.ok(result.offending.some((o) => o.includes('extra-file.md')));
});

test('an added file under archive/<dest>/ with NO rename anywhere in the diff ⇒ not exempt (no rename at all, refused before pairing is even considered)', () => {
  const result = classifySweepDiff({
    nameStatusLines: ['A\topenspec/changes/archive/9/payload.sh'],
    numstatLines: ['40\t0\topenspec/changes/archive/9/payload.sh'],
  });
  assert.equal(result.exempt, false);
});

// ── fail-closed evidence handling ───────────────────────────────────────

test('nameStatusLines/numstatLines absent (uncomputable diff) ⇒ not exempt, never throws', () => {
  const result = classifySweepDiff({});
  assert.equal(result.exempt, false);
  assert.match(result.reason, /uncomputable|unverifiable/);
});

test('empty diff (no changed files at all) ⇒ not exempt', () => {
  const result = classifySweepDiff({ nameStatusLines: [], numstatLines: [] });
  assert.equal(result.exempt, false);
});

test('a modified spec file with unreadable numstat (binary marker "-") ⇒ not exempt, fails closed', () => {
  const result = classifySweepDiff({
    nameStatusLines: [
      'R100\topenspec/changes/issue-9-foo/proposal.md\topenspec/changes/archive/9/proposal.md',
      'M\topenspec/specs/existing-cap/spec.md',
    ],
    numstatLines: [
      '0\t0\topenspec/changes/{issue-9-foo => archive/9}/proposal.md',
      '-\t-\topenspec/specs/existing-cap/spec.md',
    ],
  });
  assert.equal(result.exempt, false);
});
