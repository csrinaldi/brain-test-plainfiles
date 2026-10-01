// Regression coverage for issue #890's atomic retirement surfaces.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname, '..');

test('issue-890: repository enables the memory lane without changing migration defaults', () => {
  const config = JSON.parse(readFileSync(resolve(root, 'brain.config.json'), 'utf8'));
  assert.equal(config.memory?.lane?.enabled, true);
});

test('issue-890: brain:save command and implementation are absent', () => {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  assert.equal(Object.hasOwn(pkg.scripts, 'brain:save'), false);
  assert.equal(existsSync(resolve(root, 'brain/scripts/brain-save.mjs')), false);
  assert.equal(existsSync(resolve(root, 'brain/scripts/brain-save.test.mjs')), false);
});
