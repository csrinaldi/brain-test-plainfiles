// installer.retired.test.mjs — a file brain stops shipping leaves the consumer's
// tree on upgrade (issue #1141).
//
// Consumers receive `brain/scripts/**` by COPY. `copyManaged` walks the INCOMING
// package and writes what it finds, so a file the new release no longer ships is
// never visited: it stays in the consumer's tree, still importable, with nothing
// saying it is dead. #1141 moves every adapter to `brain/scripts/axes/`, so
// without this a consumer would keep two copies of every adapter.
//
// A consumer file in the SAME directory is not brain's and must survive. That is
// why the removal is an exact list the incoming package declares
// (`RETIRED_PATHS`) and never "whatever the package no longer has": under
// `--no-install` the outgoing package is already gone, so "brain shipped this
// last time" cannot be read off the tree, and a directory-level sweep would
// delete the consumer's own files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { copyManaged, strategyFor } from './installer.mjs';
import { RETIRED_PATHS } from './retired-paths.mjs';
import { managedStrategy } from '../../core/managed-paths.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const OLD = 'brain/scripts/harness/backends/claude.mjs';
const MINE = 'brain/scripts/harness/backends/my-own-backend.mjs';
const NEW = 'brain/scripts/axes/platform/adapters/claude.mjs';

/** An incoming package that ships NEW, and a consumer tree still holding OLD plus a file of its own. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'brain-1141-retired-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const src = join(root, 'pkg');
  const dest = join(root, 'consumer');
  const put = (base, rel, text) => {
    mkdirSync(dirname(join(base, rel)), { recursive: true });
    writeFileSync(join(base, rel), text);
  };
  put(src, NEW, 'export const where = "axes";\n');
  put(dest, OLD, 'export const where = "backends";\n');
  put(dest, MINE, 'export const mine = true;\n');
  return { src, dest };
}

test('#1141: a retired path the consumer still holds is removed, and reported', (t) => {
  const { src, dest } = fixture(t);
  const result = copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/scripts/**'], local: [], retired: [OLD] });

  assert.equal(existsSync(join(dest, OLD)), false, 'the file brain no longer ships must be gone');
  assert.deepEqual(result.removed, [OLD], 'and the run must say which file it removed');
  assert.equal(readFileSync(join(dest, NEW), 'utf8'), 'export const where = "axes";\n', 'the new path is still copied');
});

test('#1141: a retired path under a REFUSE or MERGE strategy is NOT removed, whatever the list says', (t) => {
  const { src, dest } = fixture(t);
  const refused = copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/scripts/**'], local: [], retired: [OLD], refusePaths: [OLD] });
  assert.equal(existsSync(join(dest, OLD)), true, 'a REFUSE path keeps the consumer\'s bytes; the list alone cannot delete it');
  assert.deepEqual(refused.removed, []);

  const merged = copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/scripts/**'], local: [], retired: [OLD], specialMerge: { [OLD]: () => {} } });
  assert.equal(existsSync(join(dest, OLD)), true, 'a MERGE path is the consumer\'s to keep too');
  assert.deepEqual(merged.removed, []);
});

test('#1141: a consumer-owned file in the same directory is NOT removed', (t) => {
  const { src, dest } = fixture(t);
  copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/scripts/**'], local: [], retired: [OLD] });

  assert.equal(readFileSync(join(dest, MINE), 'utf8'), 'export const mine = true;\n',
    'a file brain never declared retired is the consumer\'s, whatever directory it sits in');
});

test('#1141: a retired path the consumer declared local is left alone', (t) => {
  const { src, dest } = fixture(t);
  const result = copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/scripts/**'], local: [OLD], retired: [OLD] });

  assert.equal(existsSync(join(dest, OLD)), true, '`local` is the consumer\'s "never touch this" channel');
  assert.deepEqual(result.removed, []);
});

test('#1141: a retired path the incoming package still ships is copied, never removed', (t) => {
  const { src, dest } = fixture(t);
  mkdirSync(dirname(join(src, OLD)), { recursive: true });
  writeFileSync(join(src, OLD), 'export const where = "still shipped";\n');
  const result = copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/scripts/**'], local: [], retired: [OLD] });

  assert.equal(readFileSync(join(dest, OLD), 'utf8'), 'export const where = "still shipped";\n');
  assert.deepEqual(result.removed, []);
});

test('#1141: a dry run reports the removal and removes nothing', (t) => {
  const { src, dest } = fixture(t);
  const result = copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/scripts/**'], local: [], retired: [OLD], dryRun: true });

  assert.deepEqual(result.removed, [OLD], 'the plan names the file');
  assert.equal(existsSync(join(dest, OLD)), true, 'and a dry run writes nothing');
});

test('#1141: the retired directory is left empty-free once its last brain file goes', (t) => {
  const { src, dest } = fixture(t);
  rmSync(join(dest, MINE));
  copyManaged({ srcRoot: src, destRoot: dest, managed: ['brain/scripts/**'], local: [], retired: [OLD] });

  assert.equal(existsSync(join(dest, 'brain/scripts/harness/backends')), false,
    'an empty directory brain emptied is removed with its last file');
  assert.equal(existsSync(join(dest, 'brain/scripts')), true, 'but never a directory that still holds something');
});

test('#1141: RETIRED_PATHS names only paths brain no longer ships, each under a managed COPY glob', () => {
  assert.ok(RETIRED_PATHS.length > 0, 'the list is empty — the guard below would pass vacuously');
  for (const rel of RETIRED_PATHS) {
    assert.equal(existsSync(join(REPO_ROOT, rel)), false, `${rel} is declared retired but brain still has it`);
    assert.equal(strategyFor(rel, managedStrategy), 'copy', `${rel} must sit under a managed COPY glob — nothing else is brain's to remove`);
  }
  assert.ok(RETIRED_PATHS.includes(OLD), 'the #1141 move is in the list');
});
