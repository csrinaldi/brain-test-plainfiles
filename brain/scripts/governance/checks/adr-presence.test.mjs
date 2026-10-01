// adr-presence.test.mjs — Unit tests for adrPresence check (REQ-S4-1)
// Run with: npm test

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { adrPresence } from './adr-presence.mjs';

test('adrPresence: changedFiles includes ADR file and HOME.md → pass', () => {
  const files = [
    'brain/project/decisions/adr-0042-foo.md',
    'brain/HOME.md',
    'src/something.mjs',
  ];
  assert.deepEqual(adrPresence(files), { pass: true });
});

test('adrPresence: HOME.md changed but no ADR file → fail (missing ADR)', () => {
  const r = adrPresence(['brain/HOME.md', 'src/other.mjs']);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
});

test('adrPresence: ADR file present but HOME.md missing → fail', () => {
  const r = adrPresence(['brain/project/decisions/adr-0042-foo.md', 'src/something.mjs']);
  assert.equal(r.pass, false);
  assert.ok(typeof r.reason === 'string' && r.reason.length > 0, 'reason must be present');
});
