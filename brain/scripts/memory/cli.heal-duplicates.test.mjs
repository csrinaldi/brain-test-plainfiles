// cli.heal-duplicates.test.mjs — `heal-duplicates` through the real CLI
// (#1061, #864 task 1.2a). Drives cli.mjs as a real child process against a
// FAKE `engram` binary on PATH, so the wiring (op validation, --apply
// parsing, exit codes, which pipe) is exercised end to end without ever
// touching a real engram store.
//
// Hermetic by construction, mirroring cli.backend-fallback.test.mjs: PATH is
// REPLACED, never inherited, and carries a symlink to the real `which` plus
// this test's own fake `engram`. ENGRAM_DATA_DIR/HOME point at the sandbox
// too — belt and suspenders, since the fake binary never reads a real store,
// but the pattern this suite must not deviate from is "isolated by
// construction", not "isolated because nothing here would misbehave".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { testTmp } from '../lib/test-tmp.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
const REAL_WHICH = execFileSync('sh', ['-c', 'command -v which'], { encoding: 'utf8' }).trim();

/**
 * A fake `engram` POSIX shell script — `#!/bin/sh`, an absolute-path
 * interpreter, never `#!/usr/bin/env node` (this sandbox's PATH is REPLACED
 * with only `bin/`, so `env` could never find `node` on it). Uses ONLY shell
 * builtins (`printf`, never `cat`): the sandbox PATH carries nothing but
 * `which` and this script, so any external command the script shells out to
 * (measured: `cat`) fails `not found` and silently writes an empty file.
 *
 * Answers three sub-commands:
 *   version — always "engram 1.20.0"
 *   export  — writes the fixture named by `HEAL_FIXTURE`, MINUS whatever
 *             `delete` has already marked gone (a `deleted-<id>` marker file
 *             under `$ENGRAM_DATA_DIR`, since this is the one directory
 *             `world()` hands the shim and cleans up with the sandbox)
 *   delete  — `delete <id> --hard`: marks `<id>` gone (unless
 *             `HEAL_DELETE_NOOP` is set — "succeeds" without mutating state,
 *             for the `unverified` scenario), UNLESS `<id>` equals
 *             `HEAL_FAIL_DELETE_ID`, in which case it exits 1 (for the
 *             `partial` scenario)
 *
 * Fixtures:
 *   dup        — one duplicate pair, rec-abc ids 3089 (keep) / 3092 (delete)
 *   divergent  — one pair sharing rec-abc, content differs
 *   two-groups — two independent duplicate pairs: rec-a ids 10/11, rec-b
 *                ids 20/21 (delete candidates ascending: 11, then 21)
 */
const ENGRAM_SHIM = `#!/bin/sh
if [ "$1" = "version" ]; then
  printf '%s\\n' "engram 1.20.0"
  exit 0
fi
if [ "$1" = "export" ]; then
  file="$2"
  rows=""
  count=0
  row() {
    if [ ! -f "$ENGRAM_DATA_DIR/deleted-$1" ]; then
      if [ -z "$rows" ]; then rows="$2"; else rows="$rows,$2"; fi
      count=$((count + 1))
    fi
  }
  case "$HEAL_FIXTURE" in
    divergent)
      row 1 '{"id":1,"topic_key":"rec-abc","content":"one","title":"t","type":"decision"}'
      row 2 '{"id":2,"topic_key":"rec-abc","content":"two","title":"t","type":"decision"}'
      ;;
    two-groups)
      row 10 '{"id":10,"topic_key":"rec-a","content":"c","title":"t","type":"decision"}'
      row 11 '{"id":11,"topic_key":"rec-a","content":"c","title":"t","type":"decision"}'
      row 20 '{"id":20,"topic_key":"rec-b","content":"c","title":"t","type":"decision"}'
      row 21 '{"id":21,"topic_key":"rec-b","content":"c","title":"t","type":"decision"}'
      ;;
    *)
      row 3089 '{"id":3089,"topic_key":"rec-abc","content":"c","title":"t","type":"decision"}'
      row 3092 '{"id":3092,"topic_key":"rec-abc","content":"c","title":"t","type":"decision"}'
      ;;
  esac
  printf '{"version":"0.1.0","observations":[%s]}' "$rows" > "$file"
  printf 'Exported to %s\\n  Observations: %s\\n' "$file" "$count"
  exit 0
fi
if [ "$1" = "delete" ]; then
  id="$2"
  if [ "$id" = "$HEAL_FAIL_DELETE_ID" ]; then
    printf 'engram test shim: forced delete failure for id %s\\n' "$id" >&2
    exit 1
  fi
  if [ -z "$HEAL_DELETE_NOOP" ]; then
    printf '' > "$ENGRAM_DATA_DIR/deleted-$id"
  fi
  printf 'Observation #%s hard-deleted\\n' "$id"
  exit 0
fi
printf 'engram test shim: unsupported command %s\\n' "$1" >&2
exit 1
`;

function world(t) {
  const root = testTmp('cli-heal-');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  symlinkSync(REAL_WHICH, join(bin, 'which'));
  writeFileSync(join(bin, 'engram'), ENGRAM_SHIM, { mode: 0o755 });
  void t;
  return { root, bin };
}

function runCli({ bin, root }, args, extraEnv = {}) {
  const env = {
    // Deliberately NOT `...process.env` beyond HOME — PATH and MEMORY_BACKEND
    // are the two variables the dispatch decides on, so inheriting either
    // makes the result ambient (mirrors cli.backend-fallback.test.mjs).
    HOME: root,
    PATH: bin,
    ENGRAM_DATA_DIR: root,
    MEMORY_BACKEND: 'engram',
    ...extraEnv,
  };
  return spawnSync(process.execPath, [CLI, 'heal-duplicates', ...args], { encoding: 'utf8', env });
}

test('heal-duplicates: MEMORY_BACKEND=plainfiles refuses notEngram, exit 1, deletes nothing', (t) => {
  const w = world(t);
  const r = runCli(w, [], { MEMORY_BACKEND: 'plainfiles' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /memory\.heal\.notEngram|only applies to the 'engram' backend/);
});

test('heal-duplicates: an unknown flag refuses badFlag, exit 1, deletes nothing', (t) => {
  const w = world(t);
  const r = runCli(w, ['--bogus']);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /memory\.heal\.badFlag|unknown flag '--bogus'/);
});

test('heal-duplicates: dry-run against the shim\'s duplicate fixture exits 0 and prints the plan', (t) => {
  const w = world(t);
  const r = runCli(w, [], { HEAL_FIXTURE: 'dup' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /rec-abc.*keep #3089.*delete #3092/);
});

test('heal-duplicates: a divergent-copies fixture refuses, exit 1, deletes nothing', (t) => {
  const w = world(t);
  const r = runCli(w, [], { HEAL_FIXTURE: 'divergent' });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /rec-abc/);
  assert.match(r.stderr, /Nothing was deleted|nada/i);
});

// ── cold-review MAJOR #2: --apply through the real entrypoint — the exact
// branches the maintainer's real run depends on ───────────────────────────

test('heal-duplicates --apply: one duplicate → exit 0, deleted+done messages name the right id; a second --apply is a no-op', (t) => {
  const w = world(t);
  const env = { HEAL_FIXTURE: 'dup' };

  const first = runCli(w, ['--apply'], env);
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /deleted 1 row\(s\): 3092/);
  assert.match(first.stdout, /heal verified/);

  const second = runCli(w, ['--apply'], env);
  assert.equal(second.status, 0, second.stdout + second.stderr);
  assert.match(second.stdout, /memory\.heal\.none|nothing to heal/);
  assert.doesNotMatch(second.stdout, /deleted \d+ row/, 'a second apply must delete nothing');
});

test('heal-duplicates --apply: a delete that fails on the second id exits 1 with the partial message naming deleted and not-deleted ids', (t) => {
  const w = world(t);
  const r = runCli(w, ['--apply'], { HEAL_FIXTURE: 'two-groups', HEAL_FAIL_DELETE_ID: '21' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /memory\.heal\.partial|heal stopped after a failed delete/);
  assert.match(r.stderr, /11/, 'names the id that WAS deleted');
  assert.match(r.stderr, /21/, 'names the id that was NOT deleted');
});

test('heal-duplicates --apply: a post-apply export that still shows the duplicate exits 1 with the unverified message', (t) => {
  const w = world(t);
  const r = runCli(w, ['--apply'], { HEAL_FIXTURE: 'dup', HEAL_DELETE_NOOP: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /memory\.heal\.unverified|could not be verified/);
  assert.match(r.stderr, /3092/, 'names the id the (no-op) delete claimed to remove');
});

// ── cold-review MAJOR #1: an unexpected throw must exit 1 with the failed
// message, never an uncaught stack trace (mirrors split-records' try/catch,
// cli.mjs:250-305) ───────────────────────────────────────────────────────
//
// `BRAIN_MEMORY_HEAL_FORCE_THROW` is the injection point: `healDuplicates()`
// itself is already fully defensive (every exec/read it performs is wrapped
// internally), so no misbehaving `engram` binary can make the CALL throw —
// this seam exists precisely to exercise cli.mjs's OWN try/catch around that
// call and its outcome handling, independent of whether today's internals
// ever hit it.
test('heal-duplicates: an unexpected throw in the block exits 1 with the failed message and no stack trace', (t) => {
  const w = world(t);
  const r = runCli(w, [], { BRAIN_MEMORY_HEAL_FORCE_THROW: '1' });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(r.stderr, /memory\/cli:.*heal-duplicates failed|memory\.heal\.failed/);
  assert.match(r.stderr, /forced failure for test coverage/);
  assert.doesNotMatch(
    r.stderr,
    /at Object|at file:|at async|\.mjs:\d+:\d+\)/,
    'a graceful failure must not leak a raw stack trace on stderr',
  );
});
