import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, chmodSync, renameSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { compareCandidateSnapshots, snapshotCandidate } from './candidate-snapshot.mjs';

test('candidate snapshots refuse an absent root and measure paths, bytes, and modes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-snapshot-'));
  t.after(() => removeTempTree(root));
  assert.throws(() => snapshotCandidate(join(root, 'missing')), /directory/);

  mkdirSync(join(root, 'nested'));
  writeFileSync(join(root, 'nested', 'file.txt'), 'before\n');
  const before = snapshotCandidate(root);
  writeFileSync(join(root, 'nested', 'file.txt'), 'after\n');
  assert.equal(compareCandidateSnapshots(before, snapshotCandidate(root)).equal, false, 'byte changes must invalidate a candidate');

  writeFileSync(join(root, 'added.txt'), 'new\n');
  const added = snapshotCandidate(root);
  chmodSync(join(root, 'added.txt'), 0o755);
  assert.equal(compareCandidateSnapshots(added, snapshotCandidate(root)).equal, false, 'mode changes must invalidate a candidate');
});

test('candidate snapshots classify additions, removals, renames, type changes, and hashes', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-snapshot-diff-'));
  t.after(() => removeTempTree(root));
  writeFileSync(join(root, 'original.txt'), 'same\n');
  const before = snapshotCandidate(root);

  renameSync(join(root, 'original.txt'), join(root, 'renamed.txt'));
  writeFileSync(join(root, 'added.txt'), 'new\n');
  mkdirSync(join(root, 'directory-now'));
  const after = snapshotCandidate(root);
  const comparison = compareCandidateSnapshots(before, after);

  assert.equal(comparison.equal, false);
  assert.deepEqual(comparison.changes.added, ['added.txt', 'directory-now', 'renamed.txt']);
  assert.deepEqual(comparison.changes.removed, ['original.txt']);
  assert.deepEqual(comparison.changes.changed, []);

  rmSync(join(root, 'added.txt'));
  writeFileSync(join(root, 'renamed.txt'), 'changed\n');
  const changed = compareCandidateSnapshots(after, snapshotCandidate(root));
  assert.deepEqual(changed.changes.changed, ['renamed.txt']);
});

// #1010 — the producer's SessionStart hook (or `npm test` reaching
// ensureMemorySymlink through a real entrypoint) writes `.engram -> .memory`
// into a cold-review candidate. `entry()` used to hash a symlink with
// `readFileSync(path)`, which FOLLOWS the link: a link to a directory throws
// EISDIR (the crash the issue measured) and a link to a file is hashed by the
// TARGET's bytes, not by the link's own identity. A symlink's identity is its
// target string — `readlinkSync` — so that is what must be hashed.
test('candidate snapshots hash a symlink by its target string (readlinkSync), never through it', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'candidate-snapshot-symlink-'));
  t.after(() => removeTempTree(root));

  mkdirSync(join(root, 'real-dir'));
  mkdirSync(join(root, 'other-dir'));
  writeFileSync(join(root, 'real-file.txt'), 'target\n');

  symlinkSync('real-dir', join(root, 'link-to-dir'));
  symlinkSync('real-file.txt', join(root, 'link-to-file'));

  // Must not throw EISDIR on a symlink to a directory — the crash #1010
  // measured (`readFileSync` following the link into `real-dir`).
  const before = snapshotCandidate(root);
  const dirLink = before.find((e) => e.path === 'link-to-dir');
  const fileLink = before.find((e) => e.path === 'link-to-file');
  assert.equal(dirLink.type, 'symlink', 'a symlink to a directory snapshots as type "symlink", never recursed into');
  assert.equal(fileLink.type, 'symlink');
  assert.equal(
    compareCandidateSnapshots(before, snapshotCandidate(root)).equal,
    true,
    'an unchanged symlink must snapshot identically across two runs',
  );

  // Retarget link-to-dir to an already-present sibling (`other-dir`, part of
  // `before`) — no byte under either target changes, so the ONLY possible
  // signal is the link's own target string.
  rmSync(join(root, 'link-to-dir'));
  symlinkSync('other-dir', join(root, 'link-to-dir'));
  const retargeted = compareCandidateSnapshots(before, snapshotCandidate(root));
  assert.equal(retargeted.equal, false, 'retargeting a symlink must invalidate the candidate even though no target byte changed');
  assert.deepEqual(retargeted.changes.changed, ['link-to-dir']);
  assert.deepEqual(retargeted.changes.added, []);
  assert.deepEqual(retargeted.changes.removed, []);
});
