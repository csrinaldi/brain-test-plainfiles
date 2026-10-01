// synthesizer.test.mjs — Unit tests for Intelligent Context Synthesizer (REQ-CTX-1, REQ-CTX-2, REQ-CTX-3).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { synthesizeContext, FAILSAFE_MODES } from './synthesizer.mjs';

test('synthesizeContext: always includes core methodology baseline floor', async () => {
  const result = await synthesizeContext({ touchedFiles: [] });
  assert.ok(result.coreFloor.length > 0, 'Core floor must contain methodology docs');
  assert.ok(result.markdown.includes('agent-authorities') || result.markdown.includes('Core Methodology'), 'Markdown output must contain core baseline');
});

test('synthesizeContext: matches ADRs and memory records based on touched files', async () => {
  const result = await synthesizeContext({
    touchedFiles: ['brain/scripts/governance/workflow.mjs', 'brain/scripts/vcs/provider.mjs'],
  });

  assert.ok(result.matchedDecisions.some(d => d.includes('governance') || d.includes('vcs')), 'Matches governance and VCS ADRs');
});

test('synthesizeContext: empty file matches trigger CORE_FLOOR failsafe mode', async () => {
  const result = await synthesizeContext({ touchedFiles: ['some/unknown/untracked-file.xyz'] });
  assert.equal(result.failsafeActivated, true);
  assert.equal(result.failsafeMode, FAILSAFE_MODES.CORE_FLOOR);
  assert.ok(result.markdown.includes('Core Baseline Floor'), 'Output mentions failsafe baseline floor activation');
});
