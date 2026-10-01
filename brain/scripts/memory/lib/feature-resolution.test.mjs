// feature-resolution.test.mjs — unit tests for resolveFeature().
//
// Acceptance criteria (task 2.2 / REQ-S2-1):
//   (a) Explicit arg with valid dir → returns arg.
//   (b) Explicit arg with missing dir → throws (dir not found).
//   (c) No arg, exactly one change dir → returns that dir.
//   (d) No arg, multiple change dirs → throws "ambiguous" with dir list.
//   (e) No arg, zero change dirs → returns null.
//   (f) 'archive' dir is excluded from candidates.
//   (g) 'archive' excluded, one real feature → returns real feature.
//
// Tests use temp dirs — no real openspec/ is touched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// RED: import will fail until feature-resolution.mjs is created (task 2.4).
import { resolveFeature } from './feature-resolution.mjs';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempRoot() {
  return mkdtempSync(join(tmpdir(), 'feat-res-'));
}

function makeChangesDir(root, names) {
  const changesDir = join(root, 'openspec', 'changes');
  mkdirSync(changesDir, { recursive: true });
  for (const name of names) {
    mkdirSync(join(changesDir, name), { recursive: true });
  }
  return changesDir;
}

// ---------------------------------------------------------------------------
// (a) Explicit arg, valid dir
// ---------------------------------------------------------------------------

test('resolveFeature: explicit arg with valid dir returns the arg', (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeChangesDir(root, ['my-feature', 'other-feature']);

  const result = resolveFeature(root, 'my-feature');
  assert.equal(result, 'my-feature');
});

// ---------------------------------------------------------------------------
// (b) Explicit arg, dir does NOT exist → throws
// ---------------------------------------------------------------------------

test('resolveFeature: explicit arg with missing dir throws with the arg name', (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeChangesDir(root, ['other-feature']);

  assert.throws(
    () => resolveFeature(root, 'nonexistent'),
    (err) => {
      assert.ok(
        err.message.includes('nonexistent'),
        `expected 'nonexistent' in: ${err.message}`,
      );
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (c) No arg, exactly one dir → returns it
// ---------------------------------------------------------------------------

test('resolveFeature: no arg and exactly one change dir returns that dir', (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeChangesDir(root, ['solo-feature']);

  const result = resolveFeature(root, undefined);
  assert.equal(result, 'solo-feature');
});

// ---------------------------------------------------------------------------
// (d) No arg, multiple dirs, ZERO with resume.md → throws "ambiguous" with list
//     (sub-case of the new >1-dir logic: no resume.md to disambiguate)
// ---------------------------------------------------------------------------

test('resolveFeature: no arg with multiple dirs and no resume.md throws ambiguous listing all dirs', (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeChangesDir(root, ['feature-a', 'feature-b', 'feature-c']);
  // no resume.md in any dir → all are listed as ambiguous candidates

  assert.throws(
    () => resolveFeature(root, undefined),
    (err) => {
      assert.ok(err.message.includes('ambiguous'), `expected 'ambiguous' in: ${err.message}`);
      assert.ok(err.message.includes('feature-a'), `expected 'feature-a' in: ${err.message}`);
      assert.ok(err.message.includes('feature-b'), `expected 'feature-b' in: ${err.message}`);
      assert.ok(err.message.includes('feature-c'), `expected 'feature-c' in: ${err.message}`);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// (e) No arg, zero dirs → returns null
// ---------------------------------------------------------------------------

test('resolveFeature: no arg and zero change dirs returns null', (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeChangesDir(root, []);

  const result = resolveFeature(root, undefined);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// (f) 'archive' dir is excluded from candidates
// ---------------------------------------------------------------------------

test('resolveFeature: archive-only dir returns null (archive is excluded)', (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeChangesDir(root, ['archive']);

  const result = resolveFeature(root, undefined);
  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// (g) archive excluded, one real feature → returns real feature
// ---------------------------------------------------------------------------

test('resolveFeature: archive excluded, single real feature returned', (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  makeChangesDir(root, ['archive', 'real-feature']);

  const result = resolveFeature(root, undefined);
  assert.equal(result, 'real-feature');
});

// ---------------------------------------------------------------------------
// (h) No arg, multiple dirs, EXACTLY ONE has resume.md → resolves to that dir
//     This is the new "active-feature" disambiguation path (A2 fix).
// ---------------------------------------------------------------------------

test('resolveFeature: no arg, multiple dirs, exactly one has resume.md — returns that dir', (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const changesDir = makeChangesDir(root, ['cli-i18n', 'feature-working-memory', 'vcs-adapter']);
  // only feature-working-memory has a resume.md
  writeFileSync(
    join(changesDir, 'feature-working-memory', 'resume.md'),
    '---\nfeature: feature-working-memory\ncurrent_slice: "test"\nnext_action: "test"\nblockers: []\n---\n',
  );

  const result = resolveFeature(root, undefined);
  assert.equal(result, 'feature-working-memory');
});

// ---------------------------------------------------------------------------
// (i) No arg, multiple dirs, MORE THAN ONE has resume.md → throws ambiguous,
//     listing only the dirs that have resume.md (not the ones without it).
// ---------------------------------------------------------------------------

test('resolveFeature: no arg, multiple dirs, more than one has resume.md — throws ambiguous listing those dirs', (t) => {
  const root = makeTempRoot();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const changesDir = makeChangesDir(root, ['feature-a', 'feature-b', 'feature-c']);
  // feature-a and feature-b have resume.md; feature-c does not
  writeFileSync(join(changesDir, 'feature-a', 'resume.md'), '---\nfeature: feature-a\ncurrent_slice: "s"\nnext_action: "n"\nblockers: []\n---\n');
  writeFileSync(join(changesDir, 'feature-b', 'resume.md'), '---\nfeature: feature-b\ncurrent_slice: "s"\nnext_action: "n"\nblockers: []\n---\n');

  assert.throws(
    () => resolveFeature(root, undefined),
    (err) => {
      assert.ok(err.message.includes('ambiguous'), `expected 'ambiguous' in: ${err.message}`);
      // The dirs with resume.md must appear in the error
      assert.ok(err.message.includes('feature-a'), `expected 'feature-a' in: ${err.message}`);
      assert.ok(err.message.includes('feature-b'), `expected 'feature-b' in: ${err.message}`);
      // The dir WITHOUT resume.md must NOT appear (message scoped to resume.md dirs only)
      assert.ok(
        !err.message.includes('feature-c'),
        `feature-c (no resume.md) should not appear in: ${err.message}`,
      );
      return true;
    },
  );
});
