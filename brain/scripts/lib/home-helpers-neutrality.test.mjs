// home-helpers-neutrality.test.mjs — REQ-7 neutrality source-scan.
//
// The HOME.md scaffold + index helpers are agent-agnostic infrastructure: any
// AI agent adapter (not a specific tool) invokes them. Mirroring the governance
// neutrality source-scans (run-check.test.mjs / substrate), this asserts their
// source names no specific AI agent/tool — so the agnostic contract (REQ-7) is
// ENFORCED, not merely documented in a comment.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HELPERS = ['./home-index.mjs', './home-scaffold.mjs'];

// Specific AI agent / tool names + agent-specific paths. NOT generic words such
// as "agent" or "adapter" — those legitimately describe the agnostic design.
const FORBIDDEN = [
  'Claude',
  'Codex',
  'Anthropic',
  'Copilot',
  'Cursor',
  'OpenAI',
  'Gemini',
  '.claude',
  'SKILL.md',
];

for (const rel of HELPERS) {
  test(`neutrality source-scan (REQ-7): ${rel} names no specific AI agent/tool`, () => {
    const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
    for (const token of FORBIDDEN) {
      assert.equal(
        src.includes(token),
        false,
        `${rel} source must not reference "${token}" — it must stay agent-agnostic (REQ-7)`,
      );
    }
  });
}
