// auto-merge-outcome.test.mjs — issue #886. Imports ONLY the module under
// test: no `gh`, no `setSpawn`, no fixtures (design.md's approach — the
// constructor is pure, mirroring uncomputable-cause.test.mjs's discipline).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { AUTO_MERGE_REASONS, armed, refused } from './auto-merge-outcome.mjs';

// ── 1. The frozen, closed vocabulary ────────────────────────────────────────

test('AUTO_MERGE_REASONS: frozen and exposes exactly REQUIRES_HUMAN_APPROVAL/UNSUPPORTED/TRANSPORT', () => {
  assert.ok(Object.isFrozen(AUTO_MERGE_REASONS), 'AUTO_MERGE_REASONS must be frozen — no runtime mutation of the vocabulary');
  assert.deepEqual(
    Object.keys(AUTO_MERGE_REASONS).sort(),
    ['REQUIRES_HUMAN_APPROVAL', 'TRANSPORT', 'UNSUPPORTED'],
    'the vocabulary must expose exactly these three keys — no more, no fewer',
  );
});

// ── 2. armed() ───────────────────────────────────────────────────────────────

test('armed({url}): returns keys [enabled,url] sorted, enabled:true', () => {
  const result = armed({ url: 'https://example.test/x/y/pull/1' });
  assert.deepEqual(Object.keys(result).sort(), ['enabled', 'url']);
  assert.equal(result.enabled, true);
  assert.equal(result.url, 'https://example.test/x/y/pull/1');
});

test('armed({url: null}): url passes through as null — never constructed, never coerced', () => {
  const result = armed({ url: null });
  assert.equal(result.url, null);
  assert.deepEqual(Object.keys(result).sort(), ['enabled', 'url']);
});

test('armed(): never carries merged/sha or any other provider field', () => {
  const result = armed({ url: null });
  assert.deepEqual(Object.keys(result).sort(), ['enabled', 'url'], 'armed must carry exactly enabled+url — no merged, no sha');
});

// ── 3. refused() — tier case (no error) ──────────────────────────────────────

test('refused({reason}) (tier case): returns keys [enabled,reason], no error key at all', () => {
  const result = refused({ reason: AUTO_MERGE_REASONS.REQUIRES_HUMAN_APPROVAL });
  assert.deepEqual(Object.keys(result).sort(), ['enabled', 'reason']);
  assert.equal(result.enabled, false);
  assert.equal(result.reason, AUTO_MERGE_REASONS.REQUIRES_HUMAN_APPROVAL);
  assert.equal('error' in result, false, 'the tier-refusal branch must never fabricate an error key');
});

// ── 4. refused() — unsupported / transport case (error present) ─────────────

test('refused({reason,error}) (unsupported/transport case): returns keys [enabled,error,reason]', () => {
  const result = refused({ reason: AUTO_MERGE_REASONS.UNSUPPORTED, error: 'auto-merge is not allowed for this repository' });
  assert.deepEqual(Object.keys(result).sort(), ['enabled', 'error', 'reason']);
  assert.equal(result.enabled, false);
  assert.equal(result.reason, AUTO_MERGE_REASONS.UNSUPPORTED);
  assert.equal(result.error, 'auto-merge is not allowed for this repository');
});

test('refused({reason,error}): error is present iff explicitly passed — never fabricated for the tier branch (design A1)', () => {
  const tier = refused({ reason: AUTO_MERGE_REASONS.REQUIRES_HUMAN_APPROVAL });
  assert.equal('error' in tier, false);
  const transport = refused({ reason: AUTO_MERGE_REASONS.TRANSPORT, error: 'fetch failed' });
  assert.equal('error' in transport, true);
  assert.equal(transport.error, 'fetch failed');
});

// ── 5. Source guard (mirrors uncomputable-cause.mjs's precedent) ───────────

test('source guard: neither provider source hand-constructs `enabled:` — both import armed/refused from this module', () => {
  for (const providerFile of ['github.mjs', 'gitlab.mjs']) {
    const src = readFileSync(fileURLToPath(new URL(`../../axes/vcs/adapters/${providerFile}`, import.meta.url)), 'utf8');
    // Editorial 7: `\s+` (at least one space) missed a hand-written COMPACT
    // literal like `enabled:true` (no space) — the exact style Prettier
    // would never emit but a hand-edit could. Widened to `\s*` so both
    // spaced and compact hand-constructions are caught. JSDoc `@returns`
    // type annotations (e.g. `{enabled:true,url:...}`) legitimately use the
    // compact form for documentation, so lines whose trimmed form starts
    // with `*` (JSDoc comment body lines) are excluded before matching —
    // real code in this repo is never indented with a leading `*`.
    const codeOnly = src
      .split('\n')
      .filter((line) => !line.trim().startsWith('*'))
      .join('\n');
    assert.doesNotMatch(
      codeOnly,
      /\benabled:\s*(true|false)\b/,
      `${providerFile} must never hand-construct the { enabled, ... } shape — call armed()/refused() from vcs/lib/auto-merge-outcome.mjs instead`,
    );
  }
});
