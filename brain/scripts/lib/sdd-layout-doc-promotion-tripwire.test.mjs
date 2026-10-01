// sdd-layout-doc-promotion-tripwire.test.mjs — merge-order tripwire (issue #253,
// slice B1, fresh-review ruling). local-checks scope (npm test).
//
// check-refs.mjs's never-cryptic S-1 violation message (#595 pin 1b) points a
// human at `brain/core/methodology/sdd-layout.md` as the canonical contract
// doc. That doc is currently still a DRAFT under
// `openspec/changes/issue-250-b0/brain-drafts/sdd-layout.md` — it is promoted
// to `brain/core/methodology/` by a SEPARATE co-promotion branch/MR (Phase 8,
// out of scope for the B1 wiring PR itself; see design.md §6).
//
// THIS TEST IS EXPECTED RED ON THIS BRANCH, BY DESIGN. It is a merge-order
// tripwire: local-checks enforces that the co-promotion MR merges the doc to
// brain/core/ BEFORE (or atomically with) this wiring lands on a branch that
// cites it, without relying on a human remembering the ordering. It goes
// GREEN only once `brain/core/methodology/sdd-layout.md` exists on disk —
// i.e. after the ADR-0019/sdd-layout co-promotion MR (Phase 8) merges.
//
// DO NOT "fix" this by pointing the never-cryptic message at a different
// (draft) path, and do NOT delete this test to unblock CI — the RED is the
// point. It documents and enforces the correct merge order.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const PROMOTED_DOC_PATH = join(REPO_ROOT, 'brain/core/methodology/sdd-layout.md');

test('merge-order tripwire — RED until the ADR-0019/sdd-layout co-promotion MR merges the doc to brain/core; local-checks enforces the order without human memory', () => {
  assert.ok(
    existsSync(PROMOTED_DOC_PATH),
    'brain/core/methodology/sdd-layout.md does not exist yet — expected RED on the B1 wiring branch. ' +
      'This test goes GREEN once the co-promotion MR (Phase 8: ' +
      'openspec/changes/issue-250-b0/brain-drafts/sdd-layout.md -> brain/core/methodology/sdd-layout.md, ' +
      'with HOME.md / HOME.template.md nav entries) merges. Do NOT repoint check-refs.mjs\'s never-cryptic ' +
      'message at the draft path to make this pass — fix the merge order instead.',
  );
});
