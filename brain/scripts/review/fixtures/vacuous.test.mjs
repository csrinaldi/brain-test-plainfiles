// vacuous.test.mjs — fixture data for checkpoint.test.mjs (REQ-H1-10 §10.4,
// TDD-RED by reversion). This is a DELIBERATELY BAD test: it never calls into
// any implementation code, so it passes identically whether the
// implementation files are at HEAD or reverted to base — exactly the
// anti-pattern the reversion check exists to catch (issue #266 acceptance
// scenario "a vacuous test is caught by reversion"). It IS picked up by
// `npm test`'s own `**/*.test.mjs` glob and passes there too — that is
// expected and intentional: this file documents the anti-pattern as fixture
// data, it does not assert anything about brain:review's own behavior.
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('vacuous fixture: asserts a tautology, never exercises implementation code', () => {
  assert.equal(2 + 2, 4);
});
