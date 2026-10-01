// resume-view.test.mjs — R881-8 Working memory tab, D12. Shapes an
// already-parsed `resume.md` frontmatter object into the three ruling-3
// fields (`resume-schema.mjs:19`). `validateResume` is NOT used as a gate
// (D12) — a missing field renders `{ok:false, reason}` beside the fields
// that ARE present, never an all-or-nothing failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { shapeResumeView } from './resume-view.mjs';

const BRANCH = 'feat/issue-881-slice-3-lib';

test('#881: a complete frontmatter object shapes all three fields, each sourced to <branch>:resume.md', () => {
  const frontmatter = { next_action: 'ship PR 3', current_slice: 3, blockers: [] };
  const result = shapeResumeView({ frontmatter, branch: BRANCH });
  assert.deepEqual(result.next_action, { ok: true, value: 'ship PR 3', source: { path: `${BRANCH}:resume.md` } });
  assert.deepEqual(result.current_slice, { ok: true, value: 3, source: { path: `${BRANCH}:resume.md` } });
  assert.deepEqual(result.blockers, { ok: true, value: [], source: { path: `${BRANCH}:resume.md` } });
});

test('#881: a missing field renders {ok:false, reason} beside the fields that ARE present', () => {
  const frontmatter = { current_slice: 3, blockers: [] }; // next_action missing
  const result = shapeResumeView({ frontmatter, branch: BRANCH });
  assert.equal(result.next_action.ok, false);
  assert.equal(result.next_action.reason, `resume.md on ${BRANCH} has no next_action`);
  assert.equal(result.current_slice.ok, true);
  assert.equal(result.blockers.ok, true);
});

test('#881: an empty blockers array is a value, not absence — zero blockers renders ok:true', () => {
  const frontmatter = { next_action: 'x', current_slice: 1, blockers: [] };
  const result = shapeResumeView({ frontmatter, branch: BRANCH });
  assert.equal(result.blockers.ok, true);
  assert.deepEqual(result.blockers.value, []);
});

test('#881: validateResume is not used as a gate — two missing fields still shape the one field that is present', () => {
  const frontmatter = { blockers: ['#882'] };
  const result = shapeResumeView({ frontmatter, branch: BRANCH });
  assert.equal(result.next_action.ok, false);
  assert.equal(result.current_slice.ok, false);
  assert.equal(result.blockers.ok, true);
  assert.deepEqual(result.blockers.value, ['#882']);
});

test('#881: no frontmatter object at all fails every field, each naming what is missing', () => {
  const result = shapeResumeView({ frontmatter: null, branch: BRANCH });
  for (const key of ['next_action', 'current_slice', 'blockers']) {
    assert.equal(result[key].ok, false);
    assert.ok(result[key].reason.includes(key));
  }
});
