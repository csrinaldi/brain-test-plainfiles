// derive.test.mjs — issue #280, slice 1. Pure derivations: facts in, sections
// out. The divergence derivation is the one that matters.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { deriveTicket, deriveChain, deriveTasks, deriveDivergence } from './derive.mjs';
import { isUncomputable } from './report.mjs';

const ISSUE = {
  number: 682, state: 'closed', stateReason: 'completed',
  labels: ['status:approved', 'type:feature'], title: 'the inferential producer',
};

// ── deriveTicket — the spine ──────────────────────────────────────────────

test('deriveTicket: the issue heads the report', () => {
  const s = deriveTicket({ issue: ISSUE });
  assert.equal(s.title, 'Ticket #682');
  const byLabel = Object.fromEntries(s.fields);
  assert.equal(byLabel.state.value, 'closed (completed)');
  assert.match(String(byLabel.labels.value), /status:approved/);
});

test('deriveTicket: an unreachable forge is uncomputable, not a crash', () => {
  const s = deriveTicket({ issue: null, reason: 'gh api /user failed (HTTP 401)' });
  const byLabel = Object.fromEntries(s.fields);
  assert.equal(isUncomputable(byLabel.state), true);
  assert.match(byLabel.state.reason, /401/);
});

test('deriveTicket: refuses to invent a reason when given neither', () => {
  // A section that says "uncomputable ()" is worse than one that throws here,
  // because it reaches the operator looking like an answer.
  assert.throws(() => deriveTicket({}), /reason/);
});

// ── deriveChain / deriveTasks — local evidence ────────────────────────────

test('deriveChain: ahead/behind/dirty, and zero is a value', () => {
  const s = deriveChain({ branch: 'feat/x', ahead: 3, behind: 0, dirtyFiles: 0, pushed: true });
  const f = Object.fromEntries(s.fields);
  assert.equal(f['ahead of tracker'].value, 3);
  assert.equal(f['dirty files'].value, 0, 'a clean tree is a FACT, not an absence');
  assert.equal(f.pushed.value, 'yes');
});

test('deriveChain: an unreadable git fact degrades that field alone', () => {
  const s = deriveChain({ branch: 'feat/x', ahead: null, behind: null, dirtyFiles: 2, pushed: null });
  const f = Object.fromEntries(s.fields);
  assert.equal(isUncomputable(f['ahead of tracker']), true);
  assert.equal(f['dirty files'].value, 2, 'the readable fields survive the unreadable ones');
});

test('deriveTasks: counts checked and unchecked, and names the next open one', () => {
  const s = deriveTasks({ tasksText: [
    '- [x] A.1 done', '- [x] A.2 also done', '- [ ] B.1 the next thing', '- [ ] B.2 later',
  ].join('\n') });
  const f = Object.fromEntries(s.fields);
  assert.equal(f.checked.value, 2);
  assert.equal(f.open.value, 2);
  assert.match(String(f.next.value), /B\.1 the next thing/);
});

test('deriveTasks: no tasks.md is uncomputable with the path in the reason', () => {
  const s = deriveTasks({ tasksText: null, reason: 'no tasks.md at openspec/changes/issue-280-x/' });
  assert.match(Object.fromEntries(s.fields).checked.reason, /openspec\/changes/);
});

test('deriveTasks: all boxes checked reports zero open, not "nothing"', () => {
  const s = deriveTasks({ tasksText: '- [x] A.1\n- [x] A.2\n' });
  const f = Object.fromEntries(s.fields);
  assert.equal(f.open.value, 0);
  assert.equal(f.next.value, '—');
});

// ── deriveDivergence — the finding this redesign exists for ───────────────

test('divergence: a CLOSED ticket with open tasks is named, and the ticket wins', () => {
  // The measured case: `openspec/changes/issue-682-.../tasks.md` left C.6
  // unchecked while #682 was `closed/completed`, and nothing anywhere said the
  // two disagreed. It was found by reading both by hand.
  const s = deriveDivergence({ issue: ISSUE, openTasks: 1, headPushed: true });
  const f = Object.fromEntries(s.fields);
  assert.match(String(f['tasks vs ticket'].value), /closed/i);
  assert.match(String(f['tasks vs ticket'].value), /1 open/);
  assert.match(String(f['tasks vs ticket'].value), /ticket wins/i);
});

test('divergence: an OPEN ticket with open tasks is agreement, not a finding', () => {
  const s = deriveDivergence({
    issue: { ...ISSUE, state: 'open', stateReason: null }, openTasks: 3, headPushed: true,
  });
  assert.match(String(Object.fromEntries(s.fields)['tasks vs ticket'].value), /agree/i);
});

test('divergence: a closed ticket with zero open tasks is agreement', () => {
  const s = deriveDivergence({ issue: ISSUE, openTasks: 0, headPushed: true });
  assert.match(String(Object.fromEntries(s.fields)['tasks vs ticket'].value), /agree/i);
});

test('divergence: unpushed local commits are named — the server cannot see them', () => {
  const s = deriveDivergence({ issue: ISSUE, openTasks: 0, headPushed: false });
  assert.match(String(Object.fromEntries(s.fields)['local vs server'].value), /not pushed/i);
});

test('divergence: with no ticket it is uncomputable — it cannot be derived from one side', () => {
  // Divergence is a RELATION. Reporting "no divergence" when the authority was
  // unreachable would state agreement nobody measured — the exact defect class
  // `evaluateForgeReach` refuses one layer down.
  const s = deriveDivergence({ issue: null, openTasks: 1, headPushed: true, reason: 'offline' });
  const f = Object.fromEntries(s.fields);
  assert.equal(isUncomputable(f['tasks vs ticket']), true);
  assert.match(f['tasks vs ticket'].reason, /offline/);
});
