// scripts/i18n/sh.test.mjs — Unit tests for the shell catalog emitter.
// Run with: node --test scripts/i18n/sh.test.mjs
// No external dependencies — uses Node built-in node:test.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { keyToVar, templateToShell, renderCatalog } from './sh.mjs';

// ── keyToVar ──────────────────────────────────────────────────────────────────

test('keyToVar: dotted key becomes I18N_DOTTED_UPPER', () => {
  assert.equal(keyToVar('day.auth.ok'), 'I18N_DAY_AUTH_OK');
});

test('keyToVar: two-segment dotted key', () => {
  assert.equal(keyToVar('tracker.yourTickets'), 'I18N_TRACKER_YOURTICKETS');
});

test('keyToVar: single-segment key', () => {
  assert.equal(keyToVar('common'), 'I18N_COMMON');
});

// ── templateToShell ────────────────────────────────────────────────────────────

test('templateToShell: {placeholder} becomes %s', () => {
  assert.equal(templateToShell('Hello {name}'), 'Hello %s');
});

test('templateToShell: multiple placeholders each become %s', () => {
  assert.equal(
    templateToShell('Authenticated as @{user} ({provider}).'),
    'Authenticated as @%s (%s).',
  );
});

test('templateToShell: template with no placeholders is unchanged', () => {
  assert.equal(templateToShell('Your tickets'), 'Your tickets');
});

// ── renderCatalog ─────────────────────────────────────────────────────────────

test('renderCatalog: uses active catalog value when key exists in it', () => {
  const cat = { 'common.none': '(ninguno)' };
  const fallback = { 'common.none': '(none)', 'tracker.yourTickets': 'Your tickets' };
  const output = renderCatalog(cat, fallback);
  // Spanish value used for the key present in cat
  assert.ok(
    output.includes("I18N_COMMON_NONE='(ninguno)'"),
    `Expected Spanish value in output, got:\n${output}`,
  );
  // English fallback used for key absent from cat
  assert.ok(
    output.includes("I18N_TRACKER_YOURTICKETS='Your tickets'"),
    `Expected English fallback in output, got:\n${output}`,
  );
});

test('renderCatalog: falls back per-key to English when active catalog is empty', () => {
  const cat = {};
  const fallback = { 'common.none': '(none)' };
  const output = renderCatalog(cat, fallback);
  assert.equal(output.trim(), "I18N_COMMON_NONE='(none)'");
});

test('renderCatalog: {placeholder} slots become %s in the emitted assignments', () => {
  const cat = {};
  const fallback = { 'day.auth.ok': 'Authenticated as @{user} ({provider}).' };
  const output = renderCatalog(cat, fallback);
  assert.ok(
    output.includes("I18N_DAY_AUTH_OK='Authenticated as @%s (%s).'"),
    `Expected %s placeholders in output, got:\n${output}`,
  );
});
