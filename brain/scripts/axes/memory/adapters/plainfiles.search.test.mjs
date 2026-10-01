// plainfiles.search.test.mjs — unit tests for axes/memory/adapters/plainfiles.mjs#search
// (C3, issue #246, REQ-C3-3). Zero-binary Node scan; `rg` is an optional
// accelerant behind injectable `_which`/`_rg` seams — never required.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// RED: search is not exported from plainfiles.mjs yet.
import { search } from './plainfiles.mjs';
import { buildRecord } from '../../../memory/lib/format.mjs';
import { appendRecord } from '../../../memory/lib/store.mjs';

function seedRecords(root) {
  const recordsDir = join(root, '.memory', 'records');
  const recA = buildRecord({
    ts: '2026-07-01T00:00:00Z', actor: 'a', actorKind: 'agent', type: 'decision', project: 'brain',
    content: 'switched to plainfiles for durability', title: 'Backend decision',
  });
  const recB = buildRecord({
    ts: '2026-07-02T00:00:00Z', actor: 'a', actorKind: 'agent', type: 'bugfix', project: 'brain',
    content: 'fixed the FTS5 query sanitizer', title: 'FTS bug',
  });
  appendRecord(recA, { recordsDir });
  appendRecord(recB, { recordsDir });
  return { recA, recB, recordsDir };
}

// ── 2.5 — no rg on PATH → pure-Node fallback, no error, no throw ────────────

test('search: with no rg on PATH, falls back to the pure-Node scan and returns matches (no throw)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-search-a-'));
  try {
    const { recA } = seedRecords(root);
    let rgCalled = false;

    const result = await search('plainfiles', { root }, {
      _which: () => false,
      _rg: () => { rgCalled = true; },
    });

    assert.equal(rgCalled, false, '_rg must NOT be called when _which reports rg absent');
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].id, recA.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── 2.6 — rg present → identical results to the pure-Node path; pin the arg shape ──

test('search: with rg present, the accelerated path and the pure-Node path return identical results', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-search-b-'));
  try {
    seedRecords(root);
    let rgCalled = false;

    const withRg = await search('bug', { root, mode: 'substring' }, {
      _which: () => true,
      _rg: () => { rgCalled = true; },
    });
    const withoutRg = await search('bug', { root, mode: 'substring' }, {
      _which: () => false,
      _rg: () => { throw new Error('_rg must not be called when _which reports rg absent'); },
    });

    assert.equal(rgCalled, true, '_rg must be called (as an accelerant) when _which reports rg present');
    assert.deepEqual(
      withRg.matches.map((m) => m.id).sort(),
      withoutRg.matches.map((m) => m.id).sort(),
      'the rg-accelerated path and the pure-Node path must return IDENTICAL match sets',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── regex mode ────────────────────────────────────────────────────────────────

test('search: mode "regex" matches via RegExp, case-insensitive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-search-c-'));
  try {
    const { recB } = seedRecords(root);
    const result = await search('FTS\\d', { root, mode: 'regex' }, { _which: () => false });
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0].id, recB.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── no crash on empty/missing records/ ─────────────────────────────────────────

test('search: an absent records/ directory returns zero matches, never throws', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-search-d-'));
  try {
    const result = await search('anything', { root });
    assert.deepEqual(result.matches, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
