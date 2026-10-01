// plainfiles.setup.test.mjs — unit tests for axes/memory/adapters/plainfiles.mjs#setup
// (C3, issue #246, design Decision 1). Deliberately minimal: mkdir
// .memory/records/ + rebuildIndex() self-check ONLY — NO .engram symlink
// (ADR-0002 is engram-only) and NO merge-driver registration (the
// .gitattributes union-merge rule is backend-agnostic, registered by the
// record format C0/C1, not by any backend's setup).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// RED: setup is not exported from plainfiles.mjs yet.
import { setup } from './plainfiles.mjs';

test('setup: on a repo with no .memory/records/, creates it and runs rebuildIndex() as a self-check', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-setup-a-'));
  try {
    await setup({ root });
    assert.ok(existsSync(join(root, '.memory', 'records')), '.memory/records/ must be created');
    assert.ok(existsSync(join(root, '.memory', 'index.jsonl')), 'rebuildIndex() must run as a self-check');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup: is idempotent when .memory/records/ already exists — no error, re-runs rebuildIndex()', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-setup-b-'));
  try {
    await setup({ root });
    await assert.doesNotReject(() => setup({ root }));
    assert.ok(existsSync(join(root, '.memory', 'index.jsonl')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('setup: does NOT create a .engram symlink (ADR-0002 is engram-only)', async () => {
  const root = mkdtempSync(join(tmpdir(), 'plainfiles-setup-c-'));
  try {
    await setup({ root });
    assert.equal(existsSync(join(root, '.engram')), false, 'plainfiles setup must never create .engram');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
