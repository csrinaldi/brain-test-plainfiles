// engram.setup.test.mjs — unit tests for the setup() / ensureMemorySymlink() function.
//
// Uses real temp directories — no git needed for the symlink scenarios.
// Import `ensureMemorySymlink` (a testable extraction of the symlink step from setup()).
//
// Acceptance criteria (task 0.2 / REQ-S0-1):
//   (a) Creates .engram → .memory symlink when .memory/ exists and .engram is absent.
//   (b) Is idempotent when the correct symlink already exists.
//   (c) Logs a warning and does NOT clobber when .engram is a real directory.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  lstatSync,
  readlinkSync,
  rmSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Named export added in task 0.5. Until then this import resolves to undefined,
// causing the assertions below to throw TypeError — the intentional RED state.
import { ensureMemorySymlink } from './engram.mjs';

// ── (a) Creates symlink when .memory/ present and .engram absent ──────────────

test('ensureMemorySymlink: creates .engram → .memory when .memory/ exists and .engram absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'engram-setup-a-'));
  try {
    // Set up: .memory/ exists, .engram is absent.
    mkdirSync(join(root, '.memory'));

    ensureMemorySymlink(root);

    // .engram must now be a symlink pointing to .memory.
    const stat = lstatSync(join(root, '.engram'));
    assert.ok(stat.isSymbolicLink(), '.engram should be a symlink');
    const target = readlinkSync(join(root, '.engram'));
    assert.equal(target, '.memory', 'symlink target must be .memory');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (b) Idempotent when symlink already exists ────────────────────────────────

test('ensureMemorySymlink: is idempotent when symlink already exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'engram-setup-b-'));
  try {
    mkdirSync(join(root, '.memory'));

    // First call — creates the symlink.
    ensureMemorySymlink(root);
    // Second call — must not throw and must leave symlink intact.
    ensureMemorySymlink(root);

    const stat = lstatSync(join(root, '.engram'));
    assert.ok(stat.isSymbolicLink(), '.engram must still be a symlink after second call');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── (c) Warns and does NOT clobber when .engram is a real directory ───────────

test('ensureMemorySymlink: warns and does not clobber when .engram is a real directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'engram-setup-c-'));
  try {
    mkdirSync(join(root, '.memory'));
    mkdirSync(join(root, '.engram'));
    // Place a sentinel file inside to prove it was not deleted.
    writeFileSync(join(root, '.engram', 'sentinel.txt'), 'do-not-delete');

    // Capture console.warn to assert the warning was emitted.
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...args) => warnings.push(args.join(' '));
    try {
      ensureMemorySymlink(root);
    } finally {
      console.warn = origWarn;
    }

    // .engram must still be a real directory, not converted to a symlink.
    const stat = lstatSync(join(root, '.engram'));
    assert.ok(stat.isDirectory(), '.engram must remain a real directory — must not be clobbered');

    // A warning must have been logged.
    assert.ok(
      warnings.some((w) => w.includes('.engram')),
      `expected a warning mentioning .engram; got: ${JSON.stringify(warnings)}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Edge: .memory/ absent — symlink must not be created ──────────────────────

test('ensureMemorySymlink: does not create symlink when .memory/ is absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'engram-setup-d-'));
  try {
    // .memory/ does not exist.
    ensureMemorySymlink(root);

    // .engram must NOT have been created.
    assert.throws(
      () => lstatSync(join(root, '.engram')),
      { code: 'ENOENT' },
      '.engram should not exist when .memory/ is absent',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
