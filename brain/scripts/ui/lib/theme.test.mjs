// theme.test.mjs — the viewer's own theme choice (#1059 phase 8).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { THEMES, normalizeTheme, attributeFor } from './theme.mjs';

test('#1059: the three choices are system, light and dark, in that order', () => {
  assert.deepEqual(THEMES.map((t) => t.id), ['system', 'light', 'dark']);
  for (const theme of THEMES) {
    assert.equal(typeof theme.label, 'string');
    assert.ok(theme.label.length > 0, 'every choice has a word — the control is read, not guessed');
  }
});

test('#1059: anything that is not one of the three reads as system', () => {
  assert.equal(normalizeTheme('dark'), 'dark');
  assert.equal(normalizeTheme('light'), 'light');
  assert.equal(normalizeTheme('system'), 'system');

  for (const stored of [null, undefined, '', 'DARK', 'solarized', 42, {}]) {
    assert.equal(normalizeTheme(stored), 'system',
      `a stored value the page does not know must fall back to the viewer's own system setting, never to a guess (${JSON.stringify(stored)})`);
  }
});

test('#1059: only an explicit choice stamps the document — system leaves it unstamped', () => {
  assert.equal(attributeFor('light'), 'light');
  assert.equal(attributeFor('dark'), 'dark');
  assert.equal(attributeFor('system'), null,
    'with no stamp the page follows prefers-color-scheme, which is what "system" means');
  assert.equal(attributeFor('nonsense'), null, 'an unknown choice is system, so it stamps nothing');
});
