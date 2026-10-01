// synthesizer.mjs — Intelligent Context Synthesizer Engine (REQ-CTX-1, REQ-CTX-2, REQ-CTX-3).

import fs from 'node:fs/promises';
import path from 'node:path';

export const FAILSAFE_MODES = Object.freeze({
  CORE_FLOOR: 'core_floor',
  FULL_FALLBACK: 'full_fallback',
});

const CORE_METHODOLOGY_FILES = [
  'brain/core/methodology/agent-authorities.md',
  'brain/core/methodology/sdd-layout.md',
  'brain/core/methodology/workflow-governance.md',
  'brain/core/methodology/reviewer-protocol.md',
];

/**
 * Synthesizes targeted context for active working session.
 * @param {{ touchedFiles?: string[], rootDir?: string }} options
 * @returns {Promise<{ coreFloor: string[], matchedDecisions: string[], matchedMemories: string[], failsafeActivated: boolean, failsafeMode: string, markdown: string }>}
 */
export async function synthesizeContext({ touchedFiles = [], rootDir = process.cwd() } = {}) {
  const coreFloor = [];
  for (const relPath of CORE_METHODOLOGY_FILES) {
    try {
      const fullPath = path.join(rootDir, relPath);
      await fs.access(fullPath);
      coreFloor.push(relPath);
    } catch {
      // ignore if unreadable in test fixtures
    }
  }

  const matchedDecisions = [];
  const matchedMemories = [];

  // Match ADRs in brain/project/decisions/
  try {
    const decisionsDir = path.join(rootDir, 'brain/project/decisions');
    const entries = await fs.readdir(decisionsDir);

    for (const file of entries) {
      if (!file.endsWith('.md')) continue;
      const fileLower = file.toLowerCase();

      for (const touched of touchedFiles) {
        const parts = touched.toLowerCase().split(/[/\\]/);
        let matched = false;
        for (const part of parts) {
          const clean = part.replace(/\.[a-z0-9]+$/i, '');
          if (clean.length >= 4 && (fileLower.includes(clean) || clean.includes('review') && fileLower.includes('reviewer'))) {
            matchedDecisions.push(`brain/project/decisions/${file}`);
            matched = true;
            break;
          }
        }
        if (matched) break;
      }
    }
  } catch {
    // ignore
  }

  const totalMatches = matchedDecisions.length + matchedMemories.length;
  const failsafeActivated = touchedFiles.length > 0 && totalMatches === 0;
  const failsafeMode = FAILSAFE_MODES.CORE_FLOOR;

  const lines = [
    '# Synthesized Agent Context (.brain-context.md)',
    '',
    '## Core Methodology Baseline Floor (Mandatory)',
  ];

  for (const doc of coreFloor) {
    lines.push(`- [${path.basename(doc)}](${doc})`);
  }

  if (failsafeActivated) {
    lines.push('');
    lines.push('> [!NOTE]');
    lines.push('> Core Baseline Floor Activated: Zero targeted decision matches found for active diff files. Falling back to core governance rules.');
  }

  if (matchedDecisions.length > 0) {
    lines.push('');
    lines.push('## Targeted Architecture Decisions (ADRs)');
    for (const dec of matchedDecisions) {
      lines.push(`- [${path.basename(dec)}](${dec})`);
    }
  }

  return {
    coreFloor,
    matchedDecisions,
    matchedMemories,
    failsafeActivated,
    failsafeMode,
    markdown: lines.join('\n'),
  };
}
