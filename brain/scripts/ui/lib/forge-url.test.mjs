// forge-url.test.mjs — #882 cold review of PR 1 (blocker): the one builder
// an issue or PR number becomes a forge URL through, so `change-route.mjs`
// and `roadmap-model.mjs` (and every later governance view) share ONE
// definition rather than each growing its own copy.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { issueUrl, prUrl } from './forge-url.mjs';

test('#882: issueUrl builds an absolute github.com URL when a project is known', () => {
  assert.equal(issueUrl('o/r', 123), 'https://github.com/o/r/issues/123');
});

test('#882: issueUrl degrades to a relative reference when no project is known — never a crash, never a bare number', () => {
  assert.equal(issueUrl(null, 123), 'issues/123');
  assert.equal(issueUrl(undefined, 123), 'issues/123');
});

test('#882: prUrl builds an absolute github.com URL when a project is known (change-route.mjs\'s own pre-existing shape, unchanged)', () => {
  assert.equal(prUrl('o/r', 957), 'https://github.com/o/r/pull/957');
});

test('#882: prUrl degrades to a relative reference when no project is known', () => {
  assert.equal(prUrl(null, 957), 'pull/957');
});
