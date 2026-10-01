// scripts/__fixtures__/tmp-tree.test.mjs — unit tests for removeTempTree (issue #800).
//
// Acceptance criteria:
//   (a) an existing temp tree, nested file included, is actually removed.
//   (b) a path that never existed does not throw — the ENOENT case `force: true`
//       already covered, proven here as a no-regression baseline.
//   (c) the real defect: the old call site passed rmSync only `{recursive, force}`,
//       with no `maxRetries`/`retryDelay` — so an ENOTEMPTY/EBUSY race was never
//       retried. This asserts the options actually forwarded to `_rm` carry all
//       four keys.
//   (d) an `_rm` that always throws ENOTEMPTY never propagates — `onLeak` is
//       called once with the path and the error instead.
//   (e) an `_rm` that throws some unrelated error still doesn't propagate and
//       still reports — cleanup is not an assertion, regardless of errno.
//   (f) `defaultOnLeak` — the only reporter that runs in real CI, since every
//       other test here injects its own — actually writes to stderr. Every
//       other leak-path test above only proves the injected seam is called;
//       none of them exercise the function CI actually invokes.
//   (g) an `onLeak` that itself throws must not escape `removeTempTree`
//       either — the reporter is a last-ditch effort, not a new place for a
//       cleanup failure to surface as a thrown error (the "never throws"
//       guarantee's own regression test).
//   (h)-(k) an invalid `dir` (not a string, empty, relative, or resolving
//       outside `os.tmpdir()` — including the temp root itself, a sibling of
//       the temp root, a two-segment path like `/usr/bin` that a depth
//       heuristic would have let through, and `/`) is a caller bug caught
//       before any filesystem call, so it is NOT covered by "never throws"
//       and must throw loudly instead of silently deleting from a
//       filesystem root.
//   (l) a valid, deep absolute path is unaffected by the new guard and still
//       gets removed.
//
// All tests use the injectable `_rm`/`onLeak` seams — no real timing race is
// simulated, only the shape of the contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, basename, join, resolve } from 'node:path';

import { removeTempTree } from './tmp-tree.mjs';

const tmpRoot = resolve(tmpdir());

test('removeTempTree deletes a real temp tree, including a nested file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmp-tree-real-'));
  mkdirSync(join(dir, 'nested'), { recursive: true });
  writeFileSync(join(dir, 'nested', 'file.txt'), 'content');

  removeTempTree(dir);

  assert.equal(existsSync(dir), false);
});

test('removeTempTree on a path that never existed does not throw (the ENOENT case force already handled)', () => {
  const dir = join(tmpdir(), 'tmp-tree-never-existed-', String(Date.now()));

  assert.doesNotThrow(() => removeTempTree(dir));
});

test('removeTempTree forwards recursive, force, maxRetries and retryDelay to _rm — the regression test for #800: the old call site passed only recursive/force, so the race was never retried', () => {
  let capturedOptions = null;
  const _rm = (dir, options) => {
    capturedOptions = options;
  };

  // Never touches the filesystem — `_rm` is injected — so a path under
  // `tmpdir()` that does not exist is fine here; it only needs to pass the
  // containment guard.
  removeTempTree(join(tmpdir(), 'tmp-tree-fake-forward-path'), { maxRetries: 7, retryDelay: 250, _rm });

  assert.deepEqual(capturedOptions, {
    recursive: true,
    force: true,
    maxRetries: 7,
    retryDelay: 250,
  });
});

test('removeTempTree never throws when _rm always fails with ENOTEMPTY — onLeak is called once with the path and the error instead', () => {
  const err = Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
  const _rm = () => { throw err; };
  const leaks = [];
  const onLeak = (dir, error) => leaks.push({ dir, error });
  const dir = join(tmpdir(), 'tmp-tree-fake-leaked-path');

  assert.doesNotThrow(() => removeTempTree(dir, { _rm, onLeak }));
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].dir, dir);
  assert.equal(leaks[0].error, err);
});

test('removeTempTree never throws on an UNRELATED error either — cleanup is not an assertion, regardless of errno', () => {
  const err = Object.assign(new Error('permission denied'), { code: 'EACCES' });
  const _rm = () => { throw err; };
  const leaks = [];
  const onLeak = (dir, error) => leaks.push({ dir, error });

  assert.doesNotThrow(() => removeTempTree(join(tmpdir(), 'tmp-tree-fake-other-path'), { _rm, onLeak }));
  assert.equal(leaks.length, 1);
  assert.equal(leaks[0].error.code, 'EACCES');
});

test('defaultOnLeak — the reporter actually wired up in CI, since every test above injects its own — writes the path and errno to stderr', () => {
  const originalWrite = process.stderr.write;
  const written = [];
  process.stderr.write = (chunk) => { written.push(chunk); return true; };

  try {
    const err = Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
    const _rm = () => { throw err; };
    const dir = join(tmpdir(), 'tmp-tree-real-onleak-', String(Date.now()));

    assert.doesNotThrow(() => removeTempTree(dir, { _rm }));

    assert.equal(written.length, 1);
    assert.match(written[0], /tmp-tree-real-onleak-/);
    assert.match(written[0], /ENOTEMPTY/);
  } finally {
    process.stderr.write = originalWrite;
  }
});

test('removeTempTree never throws even when onLeak itself throws — a failure inside the reporter must not escape as a new thrown error', () => {
  const err = Object.assign(new Error('ENOTEMPTY: directory not empty'), { code: 'ENOTEMPTY' });
  const _rm = () => { throw err; };
  const onLeak = () => { throw new Error('boom: reporter itself is broken'); };

  assert.doesNotThrow(() => removeTempTree(join(tmpdir(), 'tmp-tree-fake-throws-in-onleak'), { _rm, onLeak }));
});

test('removeTempTree throws a TypeError when dir is not a non-empty string — a caller bug caught before any I/O, not a cleanup failure', () => {
  assert.throws(() => removeTempTree(undefined), TypeError);
  assert.throws(() => removeTempTree(''), TypeError);
  assert.throws(() => removeTempTree(42), TypeError);
});

test('removeTempTree throws a TypeError when dir is a relative path', () => {
  assert.throws(() => removeTempTree('relative/path'), TypeError);
});

test('removeTempTree accepts a path under the temp root — the containment guard does not reject its own contract', () => {
  let capturedOptions = null;
  const _rm = (dir, options) => { capturedOptions = options; };

  removeTempTree(join(tmpRoot, 'tmp-tree-contained-path'), { _rm });

  assert.notEqual(capturedOptions, null);
});

test('removeTempTree throws a TypeError when dir IS the temp root itself, not just its parents', () => {
  assert.throws(() => removeTempTree(tmpRoot), TypeError);
});

test('removeTempTree throws a TypeError for a sibling of the temp root — containment must not do a bare startsWith without a separator', () => {
  const sibling = join(dirname(tmpRoot), `${basename(tmpRoot)}-sibling-attack`);

  assert.throws(() => removeTempTree(sibling), TypeError);
});

test('removeTempTree throws a TypeError for a two-segment path outside the temp root — the regression test for the depth-heuristic finding: "/usr/bin" has the same segment count as a valid tmpdir path but is not one', () => {
  assert.throws(() => removeTempTree('/usr/bin'), TypeError);
});

test('removeTempTree throws a TypeError when dir is the filesystem root', () => {
  assert.throws(() => removeTempTree('/'), TypeError);
});

test('removeTempTree still accepts a valid, deep absolute path and removes it — the new guard does not affect the happy path', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tmp-tree-valid-deep-'));
  mkdirSync(join(dir, 'a', 'b'), { recursive: true });

  removeTempTree(dir);

  assert.equal(existsSync(dir), false);
});
