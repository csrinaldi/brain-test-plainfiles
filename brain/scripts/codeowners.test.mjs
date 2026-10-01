// codeowners.test.mjs — REQ-L6-1 rung-1 enhancement (design §6.2): .github/CODEOWNERS
// must exist and require human review on Tier-2 managed paths (brain/core/**,
// brain/project/**). This is the optional prevention-at-merge layer on top of the
// evidence-based `brain-writes-reviewed` detection job (design §6.1) — it does not
// replace it (no CODEOWNERS or branch protection required for L6 to detect).
//
// The `@<human-reviewer-team>` placeholder is intentional (Gap G7, tasks.md
// micro-decisions): the operator fills in the real identity post-merge. GitHub may
// flag the placeholder as an "unknown owner" annotation until replaced — that is
// accepted, non-blocking behavior, not a bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const codeownersPath = join(root, '.github/CODEOWNERS');

test('.github/CODEOWNERS exists', () => {
  assert.doesNotThrow(
    () => readFileSync(codeownersPath, 'utf8'),
    '.github/CODEOWNERS must exist — REQ-L6-1 rung-1 enhancement (design §6.2)',
  );
});

test('.github/CODEOWNERS assigns a reviewer to /brain/core/**', () => {
  const contents = readFileSync(codeownersPath, 'utf8');
  assert.match(
    contents,
    /^\/brain\/core\/\*\*\s+@\S+/m,
    '.github/CODEOWNERS must contain a rule matching "/brain/core/**" assigned to a reviewer identity (@...)',
  );
});

test('.github/CODEOWNERS assigns a reviewer to /brain/project/**', () => {
  const contents = readFileSync(codeownersPath, 'utf8');
  assert.match(
    contents,
    /^\/brain\/project\/\*\*\s+@\S+/m,
    '.github/CODEOWNERS must contain a rule matching "/brain/project/**" assigned to a reviewer identity (@...)',
  );
});
