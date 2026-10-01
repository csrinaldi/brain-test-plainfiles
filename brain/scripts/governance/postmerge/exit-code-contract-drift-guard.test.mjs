// exit-code-contract-drift-guard.test.mjs — PR5 (#310) Phase 5.3, REQ-D2-7.
//
// A STANDING guard that every governance check honors the full 0/1/2 exit
// contract: each drives to BOTH a VIOLATION (resultToExit === 1) and an
// UNCOMPUTABLE (=== 2). A check that can only reach 0/1 (no fail-closed path)
// is a silent-fail-open waiting to happen; this guard names it before it ships.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runCheck } from '../run-check.mjs';
import { resultToExit } from './exit-codes.mjs';
import { crossCheckExit } from '../../brain-audit.mjs';

// The registry: for each check, a way to force a genuine VIOLATION and a way to
// force an infra UNCOMPUTABLE, each yielding the corresponding exit code.
const CHECKS = {
  // #510: decision-gate now performs TWO git reads — the touched list and the added
  // list — so a violation cell has to inject both. It is worth stating why the second
  // uncomputable driver is here rather than only in run-check.test.mjs: this guard is
  // the standing one, and it is what turned red when `diffNameOnlyAdded` arrived
  // uninjected and the whole gate degraded from VIOLATION to UNCOMPUTABLE. A gate that
  // silently stops being able to reach 1 is the fail-open this file exists to name.
  'decision-gate': {
    violation: () => runCheck('decision-gate', {
      diffNameOnly: () => ['brain/HOME.md'],          // HOME without ADR
      diffNameOnlyAdded: () => [],
    }),
    uncomputable: () => runCheck('decision-gate', {
      diffNameOnly: () => { throw new Error('git'); },
      diffNameOnlyAdded: () => [],
    }),
  },
  // The same gate through its OTHER read. Registered as its own cell rather than
  // folded into the one above, because a fail-closed path that exists for the touched
  // list says nothing about the added list — and defaulting that one to [] instead of
  // failing is precisely how #510 could return from the opposite side, with every
  // added ADR reading as modified.
  'decision-gate (added-list read)': {
    violation: () => runCheck('decision-gate', {
      diffNameOnly: () => ['brain/project/decisions/adr-0099-new.md'],
      diffNameOnlyAdded: () => ['brain/project/decisions/adr-0099-new.md'],
    }),
    uncomputable: () => runCheck('decision-gate', {
      diffNameOnly: () => ['brain/project/decisions/adr-0099-new.md'],
      diffNameOnlyAdded: () => { throw new Error('git'); },
    }),
  },
  'diff-size': {
    violation: () => runCheck('diff-size', {
      ctx: { labels: [] },
      diffNumstat: () => Array.from({ length: 500 }, () => '5\t5\tf.mjs').join('\n') + '\n',
      readConfig: () => ({}),
    }),
    uncomputable: () => runCheck('diff-size', { ctx: { labels: [] }, diffNumstat: () => { throw new Error('git'); } }),
  },
  'issue-link': {
    violation: () => runCheck('issue-link', { ctx: { body: 'no reference here', targetBranch: 'x', defaultBranch: 'main' } }),
    uncomputable: () => runCheck('issue-link', { ctx: { body: null } }),
  },
  'memory-gate': {
    violation: () => runCheck('memory-gate', { readRecords: () => [] }),
    uncomputable: () => runCheck('memory-gate', { readRecords: () => { throw new Error('EACCES'); } }),
  },
  // brain-audit maps its own aggregate to 0/1/2 via crossCheckExit(failCount,
  // nominableTreeKeyed, failSha). A real violation (failCount>0, coherent) → 1;
  // an incoherent tree-keyed⟺[FAIL-SHA] mismatch (mid-emission crash) → 2.
  'brain-audit': {
    violation: () => ({ exit: crossCheckExit(1, 1, 1) }),      // 1 nominable, 1 emitted, 1 fail → 1
    uncomputable: () => ({ exit: crossCheckExit(0, 1, 0) }),   // nominable but 0 emitted → incoherent → 2
  },
};

for (const [name, cell] of Object.entries(CHECKS)) {
  test(`exit-contract drift-guard: ${name} reaches a VIOLATION (→1)`, async () => {
    const r = await cell.violation();
    const code = r.exit !== undefined ? r.exit : resultToExit(r);
    assert.equal(code, 1, `${name} must be able to produce a genuine violation (exit 1)`);
  });
  test(`exit-contract drift-guard: ${name} reaches an UNCOMPUTABLE (→2)`, async () => {
    const r = await cell.uncomputable();
    const code = r.exit !== undefined ? r.exit : resultToExit(r);
    assert.equal(code, 2, `${name} must have a fail-closed uncomputable path (exit 2) — else a silent fail-open`);
  });
}

// TEETH (5.3.3): a hypothetical evaluator with NO →2 path fails the guard,
// naming the missing evaluator — proven before trusting the guard on the real 5.
test('exit-contract drift-guard: TEETH — an evaluator with no uncomputable path is flagged', () => {
  const brokenCell = {
    uncomputable: async () => ({ pass: false }), // returns a VIOLATION, never uncomputable
  };
  // The guard's assertion, applied to the broken cell, must fail.
  assert.throws(() => {
    const r = { pass: false };
    const code = resultToExit(r);
    assert.equal(code, 2, 'broken-evaluator must reach 2');
  }, /broken-evaluator must reach 2|Expected values to be strictly equal/);
});
