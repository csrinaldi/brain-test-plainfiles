// governance-ignorelist.test.mjs — brain.config.json's own governance.ignoreList
// must stay aligned with the migration default (config-migrations.mjs 0.4.0),
// which already ships the 3 lockfile globs to every consumer. This repo's own
// hand-maintained config had drifted downward from its own default (design.md
// "Open questions ... ruling 3(a)" — lockfile globs, no `decision` label).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('brain.config.json governance.ignoreList includes the 3 lockfile globs (aligned with config-migrations.mjs 0.4.0 default)', () => {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'brain.config.json'), 'utf8'));
  const ignoreList = config.governance?.ignoreList ?? [];
  for (const glob of ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock']) {
    assert.ok(ignoreList.includes(glob), `governance.ignoreList must include ${glob}`);
  }
});

// Issue #256, B2 Half 1, owner ruling #601 Pin 1: AGENTS.md is a GENERATED
// operational artifact whose derivation chain is guarded (reviewed generator
// antigravity.mjs#compileAgentsMd + reviewed/promoted sources + drift-guard
// byte-equality, antigravity.drift.test.mjs) — the review surface is the
// chain, not the emitted file. Classified as a LITERAL (root file, not a
// glob) — this-repo-local policy, same pattern as B1's `**/*.golden.json`,
// never promoted into config-migrations.mjs's shipped defaults.
test('brain.config.json governance.ignoreList includes the exact literal AGENTS.md (issue #256 B2, owner ruling #601)', () => {
  const config = JSON.parse(readFileSync(join(REPO_ROOT, 'brain.config.json'), 'utf8'));
  const ignoreList = config.governance?.ignoreList ?? [];
  assert.ok(
    ignoreList.includes('AGENTS.md'),
    'governance.ignoreList must include the exact literal "AGENTS.md" (not a glob)',
  );
});
