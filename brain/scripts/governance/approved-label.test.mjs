// approved-label.test.mjs — TDD tests for resolveApprovedLabel + CLI printer
// (design.md Decision 4, REQ-A2-3, issue #231 A2 phase 1, task 1.1/1.2).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { resolveApprovedLabel, main } from './approved-label.mjs';

// ── resolveApprovedLabel: default base form, per provider ──────────────────────

test('resolveApprovedLabel: github → plain default form status:approved', () => {
  assert.equal(resolveApprovedLabel({}, 'github'), 'status:approved');
});

test('resolveApprovedLabel: gitlab → scoped default form status::approved', () => {
  assert.equal(resolveApprovedLabel({}, 'gitlab'), 'status::approved');
});

test('resolveApprovedLabel: no config at all → default form still resolves per provider', () => {
  assert.equal(resolveApprovedLabel(undefined, 'github'), 'status:approved');
  assert.equal(resolveApprovedLabel(undefined, 'gitlab'), 'status::approved');
});

// ── consumer override wins ──────────────────────────────────────────────────────

test('resolveApprovedLabel: a consumer-set governance.approvedLabel overrides the default (github)', () => {
  const config = { governance: { approvedLabel: 'ready:approved' } };
  assert.equal(resolveApprovedLabel(config, 'github'), 'ready:approved');
});

test('resolveApprovedLabel: a consumer-set governance.approvedLabel overrides the default (gitlab, mapped mechanically)', () => {
  const config = { governance: { approvedLabel: 'ready:approved' } };
  assert.equal(resolveApprovedLabel(config, 'gitlab'), 'ready::approved');
});

test('resolveApprovedLabel: an already-scoped override passes through unchanged on gitlab', () => {
  const config = { governance: { approvedLabel: 'ready::approved' } };
  assert.equal(resolveApprovedLabel(config, 'gitlab'), 'ready::approved');
});

test('resolveApprovedLabel: unknown/missing provider falls back to the plain base form', () => {
  const config = { governance: { approvedLabel: 'ready:approved' } };
  assert.equal(resolveApprovedLabel(config, undefined), 'ready:approved');
  assert.equal(resolveApprovedLabel(config, 'unknown'), 'ready:approved');
});

// ── CLI printer (injectable, so tests never read the real brain.config.json) ───

test('main: prints the resolved label for the given provider using an injected config', () => {
  const result = main(['gitlab'], { loadConfig: () => ({ governance: { approvedLabel: 'status:approved' } }) });
  assert.equal(result, 'status::approved');
});

test('main: degrades to the default base form when loadConfig throws (missing/unreadable config)', () => {
  const result = main(['github'], { loadConfig: () => { throw new Error('ENOENT'); } });
  assert.equal(result, 'status:approved');
});
