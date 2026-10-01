// cli.backend-fallback.test.mjs — issue #641, end to end.
//
// The ticket is not "a fallback was missing": `MEMORY_BACKEND=plainfiles npm run
// brain:memory:share` exited clean the whole time. The ticket is that the documented
// verb died and no message ever pointed at the working route, so four PRs'
// worth of capture was skipped on the belief that capture was impossible here.
// A unit test over `selectBackend` cannot fail for that. So this drives the REAL
// cli.mjs in a child process and asserts on what it EMITS, and on which pipe.
//
// ── Hermetic by construction, in both directions ────────────────────────────
//
// PATH is REPLACED, never inherited: `engram` present vs absent is the variable
// under test, so leaving it to whatever the runner happens to have installed
// makes every assertion below conditional on the machine. The replacement PATH
// carries a symlink to the real `which` and nothing else — so "absent" is a
// measured absence rather than a broken probe, which is a distinction #641
// specifically added and which the third test pins.
//
// `.env` is replaced too, via BRAIN_MEMORY_ENV_FILE. `.env` is gitignored, so
// whether the maintainer's checkout carries `MEMORY_BACKEND=engram` would
// otherwise decide the STATED-vs-DEFAULTED branch that is the point of the
// feature. That is the same ambient-state trap #657's suite hit with $VCS_TOKEN.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRecord, serializeRecord } from './lib/format.mjs';
import { removeTempTree } from '../lib/tmp-tree.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), 'cli.mjs');
// This file lives at brain/scripts/memory/ — three levels up is the repo root
// (#1010: the real root a spawned `setup` must never touch, even though
// BRAIN_MEMORY_TEST_ROOT points it at a sandboxed one).
const REAL_REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const REAL_ENGRAM_PATH = join(REAL_REPO_ROOT, '.engram');

/**
 * The substitution notice, matched on a phrase UNIQUE to it.
 *
 * The obvious matcher — `/not installed here/` — was wrong and passed anyway:
 * #530's `memory.save.engramUnsupported` contains the words "If engram is not
 * installed here (the agent environment)", so every `doesNotMatch` guarding a
 * NON-substituted op was liable to trip on an unrelated message, and every
 * `match` could in principle have been satisfied by one. Anchoring on the
 * records-only clause makes the assertion name the notice rather than a phrase
 * two catalogue entries happen to share.
 */
const SUBSTITUTED = /ran on the records-only `plainfiles` backend instead/;

/** The real `which`, resolved once — the sandbox PATH still needs it to work. */
const REAL_WHICH = execFileSync('sh', ['-c', 'command -v which'], { encoding: 'utf8' }).trim();
/** The real `git`, resolved once — needed by any test that drives `save` far
 *  enough to reach the #738 actor gate (D8: `save` no longer refuses outright). */
const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
const ISOLATED_GIT_ENV = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/** `git init`s `root` and configures a LOCAL `brain.actor`, isolated from ambient
 *  global/system config (mirrors cli.save-search.test.mjs's `initIdentity`). */
function initIdentity(root, actor = '@test') {
  const env = { ...process.env, ...ISOLATED_GIT_ENV };
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', env });
  spawnSync('git', ['config', '--local', 'brain.actor', actor], { cwd: root, encoding: 'utf8', env });
}

/**
 * A temp world: a records fixture, an isolated PATH, and an isolated `.env`.
 *
 * @param {object} t              node:test context, for cleanup
 * @param {{engram?: boolean, envFile?: string}} opts
 *   engram  — plant an executable `engram` on the sandbox PATH
 *   envFile — contents of the `.env` the CLI will read. Defaults to a DECLARED engram (#1165: an
 *             undeclared selector is refused, so a test about the engram-absent paths must declare
 *             it; '' = no keys at all, which is the refusal, pinned in cli.backend-declaration.test.mjs)
 */
function world(t, { engram = false, envFile = 'MEMORY_BACKEND=engram\n' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-641-'));
  // removeTempTree, not a bare rmSync: `initIdentity()` below (used by the
  // #874 save test) makes this a fixture that spawns git — issue #802's guard
  // (`brain-repo-hygiene.test.mjs`) refuses a bare recursive rmSync teardown
  // anywhere `git` was spawned, because `.git/objects` can race a concurrent
  // writer mid-delete (ENOTEMPTY), and a bare rmSync has no retry for that.
  t.after(() => removeTempTree(root));

  const recordsDir = join(root, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  const record = buildRecord({
    ts: '2026-08-14T12:00:00Z',
    actor: '@test',
    actorKind: 'human',
    type: 'decision',
    project: 'brain',
    content: 'a single clean record, so a successful share has something to index',
  });
  writeFileSync(join(recordsDir, '2026-08.jsonl'), serializeRecord(record) + '\n', 'utf8');

  const bin = join(root, 'bin');
  mkdirSync(bin);
  symlinkSync(REAL_WHICH, join(bin, 'which'));
  if (engram) {
    // Never invoked in these tests — only `which` looks for it — but it is a
    // real executable so the probe answers the way it would on a real machine.
    writeFileSync(join(bin, 'engram'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  }

  const envPath = join(root, 'dotenv');
  writeFileSync(envPath, envFile, 'utf8');

  return { root, bin, envPath };
}

function runCli({ root, bin, envPath }, args, extraEnv = {}) {
  const env = {
    // Deliberately NOT `...process.env`: PATH and MEMORY_BACKEND are the two
    // variables under test and inheriting either makes the result ambient.
    HOME: process.env.HOME,
    PATH: bin,
    BRAIN_MEMORY_TEST_ROOT: root,
    BRAIN_MEMORY_ENV_FILE: envPath,
    // The repo's own config now declares a backend (#1165 S1): point at an absent file so
    // the .env fixture above is the ONLY declaration, as these tests assume.
    BRAIN_MEMORY_CONFIG_FILE: join(root, 'no-brain-config.json'),
    ...extraEnv,
  };
  return spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env });
}

// ── the defect, in the environment where it happened ────────────────────────

test('#874 (R11, B4a): brain:memory:share with NO engram installed and engram declared now succeeds DIRECTLY on engram — no failure left for the fallback to replace', (t) => {
  // MEASURED, post-#874 split B: this test used to be the #641 flagship
  // (share substitutes and says so). R11 changed the underlying defect:
  // engram.share() dropped requireEngram() entirely (B1), so share() no
  // longer fails on a missing binary at all — leaving it in FALLBACK_OPS
  // would itself have been a regression (a live substitution would silently
  // switch which reindex implementation runs). See backend-selection.mjs's
  // FALLBACK_OPS doc.
  const w = world(t);
  const r = runCli(w, ['share']);

  assert.equal(r.status, 0, `share must succeed with no backend installed; stderr:\n${r.stderr}`);
  assert.doesNotMatch(
    r.stderr,
    SUBSTITUTED,
    'engram.share() no longer fails on the missing binary (R11) — FALLBACK_OPS no longer covers it, so there is nothing to substitute',
  );
  assert.doesNotMatch(
    r.stderr,
    /engram binary not found/,
    'the old error must not survive either — that is the message that read as "capture is impossible here"',
  );
});

test('#1165 the unstated-default substitution of #641 is RETIRED: with nothing declared, `pull` refuses (names the fix) instead of substituting', (t) => {
  // #641 let an UNSTATED backend fall back to plainfiles when engram was absent. #1165 removes
  // the unstated case altogether: nothing declared is a refusal, so a second checkout can no
  // longer be handed a backend it did not choose — in either direction.
  const w = world(t, { envFile: '' });
  const r = runCli(w, ['pull']);
  assert.equal(r.status, 3);
  assert.doesNotMatch(r.stderr, SUBSTITUTED);
  assert.match(r.stderr, /brain:config -- set memory\.backend/);
});

test('#641 the stated-but-absent signpost (engram DECLARED, binary missing, `pull`) names the fix and goes to STDERR, not stdout', (t) => {
  // The notice is printed by cli.mjs's dispatch BEFORE the backend op runs, so it is on stderr
  // regardless of what pull does afterward. pre-push and post-merge run these verbs with stdout
  // redirected to /dev/null: a notice on stdout would be discarded exactly where it is needed.
  const w = world(t);
  const r = runCli(w, ['pull']);
  assert.doesNotMatch(r.stderr, SUBSTITUTED, 'an explicit .env selector is never swapped');
  assert.match(r.stderr, /\.env sets the memory backend to engram explicitly/);
  assert.match(r.stderr, /MEMORY_BACKEND=plainfiles npm run brain:memory:pull/, 'the records-only route is named');
  assert.doesNotMatch(r.stdout, /is set explicitly/);
});

test('#874 (D8): `save` is NOT substituted — engram no longer fails on the missing binary at all, it defers', (t) => {
  // MEASURED, post-#874: before split A, `save` failed on a DESIGNED refusal
  // (`unsupportedOp`, D7's now-retired `memory.save.engramUnsupported` key),
  // never on the missing binary — so it was never a candidate for the
  // fallback either way. Since split A, `engram.save()` is a record-first
  // producer: it writes the record, then `hydrate()` DEFERS (never throws)
  // when the binary is absent (R5). There is still no FAILURE on this op for
  // `FALLBACK_OPS` to replace — for a new reason.
  const w = world(t);
  symlinkSync(REAL_GIT, join(w.bin, 'git'));
  initIdentity(w.root);

  const r = runCli(w, ['save', 'a title', 'some content', '--type', 'decision', '--issue', '641']);

  assert.equal(r.status, 0, `save must exit 0 — the record is durable even with no engram installed:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, SUBSTITUTED, 'nothing failed on the binary, so nothing may be substituted');
  assert.match(r.stderr, /deferred/i, 'the hydration must be reported as deferred, never as a refusal');
});

test('#641 `setup` is NOT substituted — engram.setup() needs no binary, and owns the .engram symlink', (t) => {
  // THE REGRESSION THIS PINS. `engram.setup()` exits 0 with no engram
  // installed: it creates the `.engram → .memory` symlink (R7, #955 —
  // the ONLY place that symlink is created or repaired). `plainfiles.setup()`
  // does NOT. Substituting silently dropped the one binding `share`/`pull`
  // depend on for the backend to be reachable at all.
  const w = world(t);
  const r = runCli(w, ['setup']);

  assert.doesNotMatch(
    r.stderr,
    SUBSTITUTED,
    'setup never failed on the binary, so there was no failure to replace',
  );
});

test('#1010 `setup` run through runCli() writes .engram ONLY into the sandboxed BRAIN_MEMORY_TEST_ROOT, never into the real repo root', (t) => {
  // MEASURED (#1010, issue comment 2): `npm test` spawns this exact test —
  // among others — as a REAL subprocess of `node brain/scripts/memory/cli.mjs
  // setup`. `runCli()` already forwards BRAIN_MEMORY_TEST_ROOT (the seam
  // cli.mjs's ROOTED_OPS reads for "setup"), but `engram.setup()` used to take
  // no parameters at all, so the forwarded `{root}` was silently discarded and
  // `ensureMemorySymlink()` fell through to its default (the REAL repo root).
  // On a fresh worktree candidate that turns an idempotent no-op into a
  // symlink written where nothing asked for one — the exact contamination the
  // cold-review candidate-integrity check (#1010) exists to catch.
  //
  // Snapshot the real root's `.engram` state BEFORE running — an absence
  // claim would be false on any checkout that already carries the symlink
  // (the common case), so this is a before/after comparison, never a claim
  // that the path does not exist.
  const existedBefore = existsSync(REAL_ENGRAM_PATH);
  const wasLinkBefore = existedBefore && lstatSync(REAL_ENGRAM_PATH).isSymbolicLink();

  const w = world(t);
  const r = runCli(w, ['setup']);

  assert.equal(r.status, 0, `setup must exit 0:\n${r.stdout}\n${r.stderr}`);
  assert.equal(
    existsSync(join(w.root, '.engram')),
    true,
    'setup must create the symlink in the SANDBOXED root that BRAIN_MEMORY_TEST_ROOT names',
  );
  assert.ok(
    lstatSync(join(w.root, '.engram')).isSymbolicLink(),
    'the sandboxed .engram must be a real symlink, not a directory setup() gave up on',
  );

  const existedAfter = existsSync(REAL_ENGRAM_PATH);
  assert.equal(
    existedAfter,
    existedBefore,
    'this run must never create (or remove) .engram at the REAL repo root',
  );
  if (existedBefore) {
    assert.equal(
      lstatSync(REAL_ENGRAM_PATH).isSymbolicLink(),
      wasLinkBefore,
      'this run must never change what the real repo root .engram already was',
    );
  }
});

// ── each precondition, measured through the real CLI ────────────────────────

test('#641 engram PRESENT: no substitution — the run goes to ENGRAM, and #874 split B means it succeeds without ever touching the stub', (t) => {
  // R11 (#874 split B): engram.share() no longer calls the binary at all, so
  // an inert stub (exits 0, exports nothing) can no longer make it fail —
  // there is nothing left downstream of ensureSymlink+rebuildIndex to fail on.
  const w = world(t, { engram: true });
  const r = runCli(w, ['share']);

  assert.equal(r.status, 0, `share must succeed — engram.share() no longer calls the binary:\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, SUBSTITUTED, 'nothing was substituted, so nothing may claim it was');
});

test('#874 (R11, B4a): MEMORY_BACKEND=engram STATED via the environment: not overridden, and the run succeeds silently — nothing failed, so there is no signpost to print', (t) => {
  // MEASURED, post-B4a: `share` left FALLBACK_OPS, so selectBackend now
  // returns OP_NOT_COVERED for it — even when stated — before the `stated`
  // branch is ever reached (backend-selection.mjs's precondition order).
  // OP_NOT_COVERED prints nothing (cli.mjs:698-724): correctly so, since
  // engram.share() does not fail here at all.
  const w = world(t);
  const r = runCli(w, ['share'], { MEMORY_BACKEND: 'engram' });

  assert.equal(r.status, 0, `a stated selector runs the real engram.share(), which no longer fails on the missing binary (R11):\n${r.stdout}\n${r.stderr}`);
  assert.doesNotMatch(r.stderr, SUBSTITUTED, 'a stated selector is never silently swapped');
  assert.doesNotMatch(
    r.stderr,
    /MEMORY_BACKEND=plainfiles/,
    'no signpost is owed here — nothing about this run failed for the fallback to have replaced',
  );
});

test('#874 (R11, B4a): MEMORY_BACKEND=engram STATED via .env: same ruling — the file is a statement too', (t) => {
  const w = world(t, { envFile: 'MEMORY_BACKEND=engram\n' });
  const r = runCli(w, ['share']);

  assert.equal(r.status, 0);
  assert.doesNotMatch(r.stderr, SUBSTITUTED);
  assert.doesNotMatch(r.stderr, /MEMORY_BACKEND=plainfiles/);
});

test('#641 `import` — an op the fallback does not serve — keeps engram\'s error, which names the real fix', (t) => {
  // `import` hydrates engram FROM records/; plainfiles has no such op at all.
  // Substituting would turn "engram binary not found. Install via: gentle-ai
  // install" — which names the actual fix — into "backend 'plainfiles' does not
  // implement op 'import'", naming a backend the caller never asked for.
  const w = world(t);
  const r = runCli(w, ['import']);

  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stderr, SUBSTITUTED, 'no substitution may be claimed');
  assert.doesNotMatch(r.stderr, /'plainfiles'/, 'and the fallback must not be named as the thing that failed');
  assert.match(r.stderr, /gentle-ai install/);
});

test('#641 `index` is not substituted either — it projects into engram\'s OWN store', (t) => {
  // MEASURED, not assumed: `engram.index()` shells brain-to-engram.mjs, which
  // reports each document's failure and still exits 0 with "0 documentos
  // indexados". That zero-on-total-failure is its own instance of
  // `evidence-reader-empty-on-failure` and is NOT in this ticket's scope — so
  // this asserts only what #641 owns: that nothing was swapped underneath it.
  const w = world(t);
  const r = runCli(w, ['index']);

  assert.doesNotMatch(r.stderr, SUBSTITUTED, 'plainfiles is not a substitute for an engram-store projection');
  assert.doesNotMatch(r.stderr, /not supported by the 'plainfiles'/);
});

test('#641 a BROKEN probe is reported as itself and substitutes nothing', (t) => {
  // PATH with no `which` at all: the probe cannot run. Before #641 this was
  // indistinguishable from "engram is not installed" and would now silently
  // switch the backend on a machine that may well have engram.
  const w = world(t);
  const emptyBin = join(w.root, 'empty-bin');
  mkdirSync(emptyBin);
  const r = runCli({ ...w, bin: emptyBin }, ['share']);

  assert.match(r.stderr, /could not determine/, 'the probe outage must be reported as an outage');
  assert.doesNotMatch(r.stderr, SUBSTITUTED, 'an unmeasured absence must not substitute a backend');
  // #874 split B (R11): the unsubstituted run reaches the real engram.share(),
  // which no longer probes or requires the binary itself — so it succeeds.
  assert.equal(r.status, 0, `share must succeed even on a probe outage — it no longer calls requireEngram():\n${r.stdout}\n${r.stderr}`);
});

// ── the message is a catalog key, not a literal (so `es` is not handed English) ──

test('#641 the notices resolve from the catalogs in es, not English (#638 is about this exact leak)', (t) => {
  // `pull` (FALLBACK_OPS' one remaining covered op) drives the stated-but-absent
  // notice (the SUBSTITUTED one is unreachable from cli.mjs since #1165); `share` left FALLBACK_OPS in #874 split B (R11, B4a).
  const w = world(t);
  const rEn = runCli(w, ['pull']);
  assert.match(rEn.stderr, /sets the memory backend to engram explicitly/);

  // brain.config.json's docs.language drives the locale; assert the catalog has
  // the keys rather than shelling a second config, and that they differ.
  return import('./../i18n/en.mjs').then(async ({ default: en }) => {
    const { default: es } = await import('./../i18n/es.mjs');
    for (const key of [
      'memory.backend.substituted',
      'memory.backend.statedButAbsent',
      'memory.backend.probeFailed',
    ]) {
      assert.ok(en[key], `${key} must exist in en`);
      assert.ok(es[key], `${key} must exist in es`);
      assert.notEqual(es[key], en[key], `${key} must actually be translated, not copied`);
    }
  });
});
