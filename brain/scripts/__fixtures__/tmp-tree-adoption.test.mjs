// tmp-tree-adoption.test.mjs — drift guard (issue #802): no NEW recursive
// `rmSync` teardown may land in a file that also spawns git.
//
// #801 built `removeTempTree` (./tmp-tree.mjs) because a bare
// `rmSync(dir, { recursive: true, force: true })` teardown, run against a
// directory a concurrent git process is also touching, can hit ENOTEMPTY/EBUSY
// — the exact race issue #800 diagnosed. #802 converted every call site that
// can actually race: the 31 files that spawn `git` INTO a directory they later
// remove with a recursive `rmSync` (143 occurrences, measured by that ticket's
// own survey). Nothing in the language stops a NEW one from landing in a file
// that also spawns git tomorrow — this test is that stop.
//
// Scope is deliberately narrow, mirroring #802's own scope note: a file that
// recursively `rmSync`'s a temp tree but never spawns git cannot race a git
// process touching the same tree (that is "group C" from the ticket's survey,
// 68 files, explicitly left alone). The AND of BOTH conditions — git spawned,
// AND a recursive rmSync in the same file — is the actual risk this guards.
//
// Run with: npm test (node --test, no dependencies).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..'); // brain/scripts
const REPO_ROOT = join(SCRIPTS_DIR, '..', '..');
const TEST_DIR = join(REPO_ROOT, 'test');

// This file's own source contains the literal strings the traps below scan
// FOR (`execFileSync('git'`, `rmSync(..., { recursive: true`) as fixture text
// — a real-fs scan that hit this file would flag itself. Excluded the same way
// sdd-layout.test.mjs excludes its own module from A1 (issue #250 B0).
const SELF_ABS = fileURLToPath(import.meta.url);
// lib/tmp-tree.mjs itself legitimately calls a recursive rmSync (that IS the
// removeTempTree implementation, moved here from __fixtures__/ by #887's
// correction C2) — it does not spawn git, so the AND condition already
// excludes it, but it is named here too so the exclusion is not an accident
// of tmp-tree.mjs happening to be git-silent today.
const TMP_TREE_ABS = join(SCRIPTS_DIR, 'lib', 'tmp-tree.mjs');
// __fixtures__/tmp-tree.mjs is now a thin re-export of the above — it
// carries neither a git spawn nor an rmSync literal, so it would not trip
// the scan even without this exclusion; named for the same "not an
// accident" reason.
const TMP_TREE_REEXPORT_ABS = join(SCRIPTS_DIR, '__fixtures__', 'tmp-tree.mjs');

/**
 * Files that spawn git AND recursively `rmSync` a directory they own, and are
 * exempt from this guard anyway — for the one-line reason given. An entry here
 * must be a deliberate, REVIEWED exception, not a silent workaround: that is
 * why the file and the reason are pinned together, and why the drift-guard
 * test below proves the mechanism actually exempts ("an allowlisted file does
 * NOT trip") rather than merely existing as an unused array.
 *
 * Paths are REPO-RELATIVE and resolved against `REPO_ROOT` at scan time. An
 * absolute path here would match only on the machine that wrote it and would
 * silently stop exempting in CI — an allowlist that quietly fails open is
 * worse than no allowlist.
 *
 * Both entries are PRODUCTION modules, and that is the whole reason they are
 * here. `removeTempTree` never throws on a removal failure, and the argument
 * for that guarantee is "teardown runs after the test's assertions already
 * passed, so a cleanup error may not fail it". **That premise does not exist
 * in production code**, where a caller may genuinely need to know the removal
 * failed. Whether these two should adopt it — and whether the helper should
 * then move out of `__fixtures__`, whose name reads test-only — is a design
 * question #802 does not own; it is deferred rather than decided in passing.
 */
const ALLOWLIST = [
  {
    path: 'brain/scripts/review/cold-boot.mjs',
    // The removal exists so the `git worktree add` on the NEXT line cannot
    // fail. Swallowing a failure here would surface one tick later as a
    // confusing "worktree add failed" instead of the real cause — strictly
    // worse than the bare rmSync it would replace.
  },
  {
    path: 'brain/scripts/axes/memory/adapters/engram.mjs',
    // Scratch dirs for export/import payloads, removed in a `finally`. Here
    // never-throwing is arguably RIGHT (a throwing cleanup in `finally` masks
    // the original exception) — but adopting it would make a production module
    // import from `__fixtures__`, which is the layering question above.
  },
];

/** True when the file's source spawns a git child process, directly or via a
 * local `git(...)` helper (the helper's own body still contains the literal
 * spawn, so this single check catches both shapes without a second pass). */
function spawnsGit(content) {
  return /execFileSync\(\s*['"]git['"]/.test(content) || /spawnSync\(\s*['"]git['"]/.test(content);
}

/**
 * A bounded-window scan, not a parser: for every `rmSync(` call site, looks at
 * up to 200 characters after it for `recursive:\s*true`, stopping early at the
 * NEXT `rmSync(` call so a later, unrelated call's options can never be
 * misattributed to an earlier one.
 *
 * Deliberately NOT a `[^)]*` character-class match up to the first `)`: a
 * first argument built with a nested call — `rmSync(join(main, '.env'))`, the
 * real shape #802 left untouched in bootstrap.worktree.test.mjs — closes its
 * OWN paren before the options object even starts, which would truncate that
 * class right there and blind the scan to every real multi-arg call that
 * follows it in the same file.
 */
function callsRecursiveRmSync(content) {
  const CALL = 'rmSync(';
  const WINDOW = 200;
  let from = 0;
  for (;;) {
    const at = content.indexOf(CALL, from);
    if (at === -1) return false;
    const next = content.indexOf(CALL, at + CALL.length);
    const end = Math.min(at + WINDOW, next === -1 ? content.length : next);
    if (/recursive:\s*true/.test(content.slice(at, end))) return true;
    from = at + CALL.length;
  }
}

function scanForDrift(roots, { readdir = readdirSync, readFile = readFileSync, allowlist = ALLOWLIST } = {}) {
  // Repo-relative in the list, absolute at comparison time — see ALLOWLIST.
  const allowSet = new Set(allowlist.map((e) => join(REPO_ROOT, e.path)));
  const offenders = [];
  for (const root of roots) {
    const entries = readdir(root, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.mjs')) continue;
      const dir = entry.parentPath ?? entry.path;
      const full = join(dir, entry.name);
      if (full === TMP_TREE_ABS || full === TMP_TREE_REEXPORT_ABS || full === SELF_ABS) continue;
      if (allowSet.has(full)) continue;
      const content = readFile(full, 'utf8');
      if (spawnsGit(content) && callsRecursiveRmSync(content)) offenders.push(full);
    }
  }
  return offenders;
}

// ── precision traps, written first ──────────────────────────────────────────

test('drift guard: a file that spawns git AND recursively rmSync-s is caught, naming the file', () => {
  const files = {
    'fixture/offender.mjs': "execFileSync('git', ['init', dir]); rmSync(dir, { recursive: true, force: true });",
  };
  const offenders = scanForDrift(['fixture'], {
    readdir: () => [{ isFile: () => true, name: 'offender.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, ['fixture/offender.mjs']);
});

test('drift guard: a file that only spawns git (no recursive rmSync) does NOT trip', () => {
  const files = {
    'fixture/git-only.mjs': "execFileSync('git', ['status']);",
  };
  const offenders = scanForDrift(['fixture'], {
    readdir: () => [{ isFile: () => true, name: 'git-only.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, []);
});

test('drift guard: a file that only recursively rmSync-s (no git spawn) does NOT trip — this is "group C", out of #802 scope by design', () => {
  const files = {
    'fixture/rm-only.mjs': 'rmSync(dir, { recursive: true, force: true });',
  };
  const offenders = scanForDrift(['fixture'], {
    readdir: () => [{ isFile: () => true, name: 'rm-only.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, []);
});

test('drift guard: a non-recursive rmSync (single-file removal) in a git-spawning file does NOT trip — matches the amendment.test.mjs rmSync(wfg) / smoke.mjs rmSync(f, {force:true}) shape #802 left untouched on purpose', () => {
  const files = {
    'fixture/single-file.mjs': "execFileSync('git', ['init', dir]); rmSync(wfg); rmSync(other, { force: true });",
  };
  const offenders = scanForDrift(['fixture'], {
    readdir: () => [{ isFile: () => true, name: 'single-file.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, []);
});

test("drift guard: spawnSync('git', ...) is caught too, not just execFileSync", () => {
  const files = {
    'fixture/spawnsync-offender.mjs': "spawnSync('git', ['init']); rmSync(dir, { recursive: true, force: true });",
  };
  const offenders = scanForDrift(['fixture'], {
    readdir: () => [{ isFile: () => true, name: 'spawnsync-offender.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, ['fixture/spawnsync-offender.mjs']);
});

test('drift guard: a local git() helper wrapping execFileSync(\'git\', ...) is caught by the same literal check — the helper body still contains the spawn', () => {
  const files = {
    'fixture/local-helper.mjs': [
      "const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();",
      'rmSync(scratch, { recursive: true, force: true });',
    ].join('\n'),
  };
  const offenders = scanForDrift(['fixture'], {
    readdir: () => [{ isFile: () => true, name: 'local-helper.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, ['fixture/local-helper.mjs']);
});

test('drift guard: the bounded window does not misattribute a LATER unrelated recursive rmSync back onto an EARLIER non-recursive one — but still catches the later call on its own merits', () => {
  const files = {
    'fixture/two-calls.mjs': [
      "execFileSync('git', ['init']);",
      'rmSync(single);', // no recursive:true anywhere near this one
      'x'.repeat(300), // padding well past the 200-char window
      'rmSync(other, { recursive: true, force: true });', // the real, distant offender
    ].join('\n'),
  };
  const offenders = scanForDrift(['fixture'], {
    readdir: () => [{ isFile: () => true, name: 'two-calls.mjs', parentPath: 'fixture' }],
    readFile: (p) => files[p],
  });
  assert.deepEqual(offenders, ['fixture/two-calls.mjs']);
});

test('drift guard: an allowlisted file does NOT trip, only that exact path is exempted, and the entry is written REPO-RELATIVE', () => {
  // The fake tree is rooted at REPO_ROOT on purpose: the allowlist entry below
  // is repo-relative, the scan compares absolute paths, and this test is what
  // pins the resolution between them. An entry that only matched when written
  // absolute would exempt on the author's machine and fail open in CI.
  const dir = join(REPO_ROOT, 'fixture');
  const offender = "execFileSync('git', ['init']); rmSync(d, { recursive: true, force: true });";
  const files = {
    [join(dir, 'exempt.mjs')]: offender,
    [join(dir, 'not-exempt.mjs')]: offender,
  };
  const offenders = scanForDrift([dir], {
    readdir: () => [
      { isFile: () => true, name: 'exempt.mjs', parentPath: dir },
      { isFile: () => true, name: 'not-exempt.mjs', parentPath: dir },
    ],
    readFile: (p) => files[p],
    allowlist: [{ path: 'fixture/exempt.mjs', reason: 'test fixture only' }],
  });
  assert.deepEqual(offenders, [join(dir, 'not-exempt.mjs')]);
});

// ── the real scan ────────────────────────────────────────────────────────────

test('#802: brain/scripts/** and test/** carry ZERO files that spawn git AND recursively rmSync a directory outside removeTempTree', () => {
  const offenders = scanForDrift([SCRIPTS_DIR, TEST_DIR]);
  const message = offenders.length === 0
    ? undefined
    : `Found ${offenders.length} file(s) that spawn git AND recursively rmSync a directory: ` +
      `${offenders.join(', ')}. Use removeTempTree from brain/scripts/__fixtures__/tmp-tree.mjs instead of ` +
      `a bare rmSync(dir, { recursive: true, force: true }) in any file that also spawns git into that dir ` +
      `(issue #800/#802). If this specific call site genuinely cannot use it, add a reviewed entry to ` +
      `ALLOWLIST in this test with a one-line reason — do not widen the scan to stop seeing it.`;
  assert.deepEqual(offenders, [], message);
});
