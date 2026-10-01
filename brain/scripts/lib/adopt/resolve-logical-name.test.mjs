// resolve-logical-name.test.mjs — Unit tests for resolveLogicalName.
// Run with: npm test   (node --test, no dependencies)
//
// Covers all five mapping rules and both spec scenarios from tasks.md § Phase 2:
//   - flat brain/<seg>/ → brain/core/<seg>/ (Rule 5) + catastro fixture scenario
//   - root scripts/ → brain/scripts/ (Rule 2)
//   - brain/project/** stays project (Rule 4)
//   - brain/core/** stays as-is (Rule 3)
//   - brain/scripts/** stays as-is (Rule 1)
//   - no-manifest file → 'project' (Rule 6 / absent-from-manifest scenario)

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveLogicalName } from './resolve-logical-name.mjs';
import { managed, local } from '../../../core/managed-paths.mjs';

// ── Rule 5: flat brain/<seg>/ → brain/core/<seg>/ ───────────────────────────

test('flat brain/methodology/intro.md resolves to brain/core/methodology/intro.md (Rule 5 — catastro scenario)', () => {
  const result = resolveLogicalName('brain/methodology/intro.md', { managed, local });
  assert.equal(result.logicalName, 'brain/core/methodology/intro.md');
  assert.equal(result.classification, 'generic');
  assert.equal(result.matchedGlob, 'brain/core/**');
});

test('flat brain/governance/adr.md resolves to brain/core/governance/adr.md (Rule 5)', () => {
  const result = resolveLogicalName('brain/governance/adr.md', { managed, local });
  assert.equal(result.logicalName, 'brain/core/governance/adr.md');
  assert.equal(result.classification, 'generic');
  assert.equal(result.matchedGlob, 'brain/core/**');
});

// ── Rule 2: root scripts/ → brain/scripts/ ──────────────────────────────────

test('root scripts/setup.sh resolves to brain/scripts/setup.sh and is generic (Rule 2)', () => {
  const result = resolveLogicalName('scripts/setup.sh', { managed, local });
  assert.equal(result.logicalName, 'brain/scripts/setup.sh');
  assert.equal(result.classification, 'generic');
  assert.equal(result.matchedGlob, 'brain/scripts/**');
});

test('root scripts/nested/tool.mjs resolves to brain/scripts/nested/tool.mjs (Rule 2)', () => {
  const result = resolveLogicalName('scripts/nested/tool.mjs', { managed, local });
  assert.equal(result.logicalName, 'brain/scripts/nested/tool.mjs');
  assert.equal(result.classification, 'generic');
  assert.equal(result.matchedGlob, 'brain/scripts/**');
});

// ── Rule 1: brain/scripts/** stays as-is ────────────────────────────────────

test('brain/scripts/installer.mjs stays as-is and is generic (Rule 1)', () => {
  const result = resolveLogicalName('brain/scripts/installer.mjs', { managed, local });
  assert.equal(result.logicalName, 'brain/scripts/installer.mjs');
  assert.equal(result.classification, 'generic');
  assert.equal(result.matchedGlob, 'brain/scripts/**');
});

// ── Rule 3: brain/core/** stays as-is ───────────────────────────────────────

test('brain/core/methodology/intro.md stays as-is and is generic (Rule 3)', () => {
  const result = resolveLogicalName('brain/core/methodology/intro.md', { managed, local });
  assert.equal(result.logicalName, 'brain/core/methodology/intro.md');
  assert.equal(result.classification, 'generic');
  assert.equal(result.matchedGlob, 'brain/core/**');
});

// ── Rule 4: brain/project/** stays project ───────────────────────────────────

test('brain/project/decisions/adr-0001.md stays as-is and is project (Rule 4)', () => {
  const result = resolveLogicalName('brain/project/decisions/adr-0001.md', { managed, local });
  assert.equal(result.logicalName, 'brain/project/decisions/adr-0001.md');
  assert.equal(result.classification, 'project');
  assert.equal(result.matchedGlob, null);
});

// ── Rule 6: no-manifest file → project (absent-from-manifest scenario) ──────

test('docs/onboarding/guide.md has no manifest match and is project (Rule 6)', () => {
  const result = resolveLogicalName('docs/onboarding/guide.md', { managed, local });
  assert.equal(result.logicalName, 'docs/onboarding/guide.md');
  assert.equal(result.classification, 'project');
  assert.equal(result.matchedGlob, null);
});

test('root-level README.md has no manifest match and is project (Rule 6)', () => {
  const result = resolveLogicalName('README.md', { managed, local });
  assert.equal(result.logicalName, 'README.md');
  assert.equal(result.classification, 'project');
  assert.equal(result.matchedGlob, null);
});

// ── Rule 6: root-level managed file (.gitattributes) ────────────────────────

test('.gitattributes resolves as-is and is generic (Rule 6 + manifest match)', () => {
  const result = resolveLogicalName('.gitattributes', { managed, local });
  assert.equal(result.logicalName, '.gitattributes');
  assert.equal(result.classification, 'generic');
  assert.equal(result.matchedGlob, '.gitattributes');
});

// ── POSIX normalization (Windows-style separator) ────────────────────────────

test('Windows-style path brain\\methodology\\intro.md is normalized to POSIX (Rule 5)', () => {
  const result = resolveLogicalName('brain\\methodology\\intro.md', { managed, local });
  assert.equal(result.logicalName, 'brain/core/methodology/intro.md');
  assert.equal(result.classification, 'generic');
});

// ── local[] always wins over managed[] ──────────────────────────────────────

test('brain/project/** path matching both managed and local is classified project (local wins)', () => {
  // brain/project/** is local[], not managed[]; defensive test for overlap logic.
  const customManaged = [...managed, 'brain/project/**'];
  const result = resolveLogicalName('brain/project/test.md', { managed: customManaged, local });
  assert.equal(result.classification, 'project');
  assert.equal(result.matchedGlob, null);
});
