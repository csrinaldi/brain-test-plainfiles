// report.test.mjs — issue #280, slice 1. The degradation contract is the thing
// under test: a field renders its value or says why it could not.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { field, uncomputable, renderReport, isUncomputable } from './report.mjs';

test('field: carries a value', () => {
  const f = field('abc123');
  assert.equal(f.value, 'abc123');
  assert.equal(isUncomputable(f), false);
});

test('uncomputable: carries a REASON, and refuses an empty one', () => {
  // "uncomputable" with no reason is the silence this command exists to remove:
  // the operator learns that something failed and not what.
  assert.equal(uncomputable('no network').reason, 'no network');
  for (const bad of [undefined, null, '', '   ']) {
    assert.throws(() => uncomputable(bad), /reason/);
  }
});

test('field: a null or undefined value is NOT a value', () => {
  // A field that renders `null` teaches nothing. Callers that cannot compute
  // must say so; this makes the accident impossible rather than unlikely.
  for (const bad of [null, undefined]) {
    assert.throws(() => field(bad), /uncomputable/);
  }
});

test('field: an empty string and 0 and false ARE values', () => {
  // "no dirty files" is a fact. Collapsing it into absence is how a clean tree
  // and an unreadable one come to look the same.
  assert.equal(field('').value, '');
  assert.equal(field(0).value, 0);
  assert.equal(field(false).value, false);
});

// ── renderReport ──────────────────────────────────────────────────────────

const SECTIONS = [
  { title: 'Chain position', fields: [
    ['branch', field('feat/issue-280')],
    ['ahead of tracker', field(3)],
    ['dirty files', field(0)],
  ]},
  { title: 'Review state', fields: [
    ['open PR', uncomputable('no network: gh api /repos failed')],
  ]},
];

test('renderReport: every field renders its value or its reason', () => {
  const out = renderReport(SECTIONS);
  assert.match(out, /Chain position/);
  assert.match(out, /branch\s+feat\/issue-280/);
  assert.match(out, /ahead of tracker\s+3/);
  assert.match(out, /dirty files\s+0/);
  assert.match(out, /open PR\s+uncomputable \(no network: gh api \/repos failed\)/);
});

test('renderReport: an uncomputable section does not suppress the computable ones', () => {
  // THE POINT OF FIELD-LEVEL DEGRADATION. A dead network must leave the disk
  // sections intact — the operator recovering from a crash needs what IS
  // knowable, and an all-or-nothing report gives them nothing exactly when they
  // have least.
  const out = renderReport(SECTIONS);
  assert.match(out, /feat\/issue-280/, 'the disk section survives a dead server section');
});

test('renderReport: a section with no fields says so rather than rendering blank', () => {
  const out = renderReport([{ title: 'Standing items', fields: [] }]);
  assert.match(out, /Standing items/);
  assert.match(out, /nothing to report/);
});

test('renderReport: it is PURE — no dates, no cwd, no environment', () => {
  // Two calls with the same input must be byte-identical. A report that varies
  // cannot be diffed between two runs, which is the first thing an operator
  // does after a crash.
  assert.equal(renderReport(SECTIONS), renderReport(SECTIONS));
});

test('renderReport: refuses a malformed field rather than printing [object Object]', () => {
  assert.throws(
    () => renderReport([{ title: 'X', fields: [['k', 'a bare string']] }]),
    /field\(\)|uncomputable\(\)/,
  );
});
