// pull-reconcile.integration.test.mjs — issue #1118. Both adapters default
// their `_gitPull` seam to the shared `defaultGitPull`; this proves each one
// end to end against a real bare origin and a real clone (the #1081 F10 shape).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildPullFixture, git, RECORD_PATH, RECORD_CONTENT } from '../../../__fixtures__/pull-fixture.mjs';
import { pull } from './plainfiles.mjs';
import { pullMemory } from './engram.mjs';

function assertReconciled(dir) {
  assert.equal(git(dir, 'ls-files', '--', RECORD_PATH).trim(), RECORD_PATH, 'the record is tracked after the pull');
  assert.equal(readFileSync(join(dir, RECORD_PATH), 'utf8'), RECORD_CONTENT, 'bytes unchanged');
}

test('plainfiles pull() fast-forwards over the byte-identical untracked record', async (t) => {
  const { capturingDir } = buildPullFixture(t);
  await pull({ root: capturingDir });
  assertReconciled(capturingDir);
});

test('engram pullMemory() fast-forwards over the byte-identical untracked record', async (t) => {
  const { capturingDir } = buildPullFixture(t);
  await pullMemory({ root: capturingDir, _import: async () => ({ written: 0, skipped: 0 }) });
  assertReconciled(capturingDir);
});
