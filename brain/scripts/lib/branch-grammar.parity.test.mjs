// Parity matrix (#697): every reader of "which issue is this branch" against the
// same inputs. Differences are DECLARED per row, never accidental.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseIssueBranch, findIssueInBranch, nonEmptySlug } from './branch-grammar.mjs';
import { deriveIssue } from '../memory/lib/capture-provenance.mjs';
import { issueOfBranch } from '../status/snapshot.mjs';
import { issueFromBranch } from '../brain-next.mjs';
import { resolveIssueNumber } from '../brain-ship.mjs';
import { deriveChangeFromBranch } from '../session-start.mjs';

const N = null;
// [branch, parse, provenance, snapshot, next, ship, sessionToken]
// provenance/snapshot: canonical shape only (durable writes never guess; the legacy
//   brain:start shape is not in the documented contract).
// next: lenient on purpose (fail closed: never read a numbered branch as "ready").
// session-start: deliberately searches `issue-N` anywhere, case-insensitively, to match change-dir names.
const MATRIX = [
  ['fix/issue-639-x',        639, 639, 639, 639, 639, 'issue-639'],
  ['feat/issue-3-x',         3,   3,   3,   3,   3,   'issue-3'],
  ['chore/issue-1157-cut',   1157, 1157, 1157, 1157, 1157, 'issue-1157'],
  ['feature/42-x',           42,  N,   N,   42,  42,  N],
  ['feature/42',             N,   N,   N,   42,  N,   N],
  ['claude/some-slug',       N,   N,   N,   N,   N,   N],
  ['memory/host-date',       N,   N,   N,   N,   N,   N],
  ['fix/issue-7',            7,   7,   7,   7,   7,   'issue-7'],
  ['Fix/issue-5-x',          N,   N,   N,   5,   N,   'issue-5'],
  ['feat/scope/issue-5-x',   N,   N,   N,   5,   N,   'issue-5'],
  ['fix/issue-5-',           5,   5,   5,   5,   5,   'issue-5'],
  ['feature/42-',            42,  N,   N,   42,  42,  N],
  ['memory/2026-09-23',      N,   N,   N,   N,   N,   N],
  ['release/2024-01-x',      N,   N,   N,   N,   N,   N],
  ['12-fix-x',               N,   N,   N,   12,  N,   N],
  ['issue-12-x',             N,   N,   N,   12,  N,   'issue-12'],
  ['fix/2026-cleanup',       2026, N,  N,   2026, 2026, N],
];

for (const [b, parse, prov, snap, next, ship, sess] of MATRIX) {
  test(`parity: ${b}`, () => {
    assert.equal(parseIssueBranch(b)?.issueNumber ?? null, parse === null ? null : String(parse), 'parseIssueBranch');
    assert.equal(deriveIssue({ declared: undefined, branch: b }).issue ?? null, prov, 'provenance');
    assert.equal(issueOfBranch(b), snap, 'snapshot');
    assert.equal(issueFromBranch(b) ?? null, next, 'brain-next');
    assert.equal(resolveIssueNumber(b).issueNumber ?? null, ship === null ? null : String(ship), 'brain-ship');
    assert.equal(deriveChangeFromBranch(b, '/x', { _readdir: () => [] }).token, sess, 'session-start');
    assert.equal(findIssueInBranch(b) ?? null, next === null ? null : String(next), 'findIssueInBranch');
  });
}

test('nonEmptySlug never returns an empty slug', () => {
  assert.equal(nonEmptySlug(''), 'task');
  assert.equal(nonEmptySlug('abc'), 'abc');
});
