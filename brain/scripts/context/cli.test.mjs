// cli.test.mjs — Unit tests for brain:context:compile CLI (REQ-CTX-4).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

test('cli: brain:context:compile outputs markdown context containing Core Baseline Floor', () => {
  const cliPath = path.resolve('brain/scripts/context/cli.mjs');
  const output = execFileSync(process.execPath, [cliPath], { encoding: 'utf8' });
  assert.ok(output.includes('Synthesized Agent Context'), 'CLI prints synthesized header');
  assert.ok(output.includes('Core Methodology Baseline Floor'), 'CLI output contains core methodology floor');
});
