// capture-reachable.test.mjs — #530: there must be a route from "an agent knows
// something" to a durable record, IN THE ENVIRONMENT WHERE THE AGENT WORKS.
//
// Measured before the fix, and this file is the shape of that measurement:
//
//   MEMORY_BACKEND defaults to ....................... engram
//   engram.save() ................................... refuses by design
//   the refusal pointed at .......................... `engram save`, a binary
//                                                     `command -v` cannot find here
//   plainfiles.save() ............................... works, fully tested
//   reachable as an npm verb ........................ no
//
// So a working records-only writer existed and nothing could reach it. The gap was
// never the writer — it was every signpost pointing somewhere else.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, symlinkSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { removeTempTree } from '../lib/tmp-tree.mjs';

const REPO = fileURLToPath(new URL('../../..', import.meta.url));
const pkg = JSON.parse(readFileSync(`${REPO}/package.json`, 'utf8'));

test('#530: capture is exposed as a managed verb', () => {
  assert.ok(pkg.scripts['memory:save'],
    'the capture half had no npm verb at all — index/share/pull/reindex existed, save did not');
});

test('#874 (D8, strengthens #530): the verb does NOT pin a backend — the record-first producer path (#874) makes engram reachable too', () => {
  // Before #874 the default backend (engram) REFUSED `save` outright, so
  // pinning `MEMORY_BACKEND=plainfiles` here was the only way to make this
  // verb usable at all. Since split A, `engram.save()` is a record-first
  // producer in its own right — it writes the durable record and DEFERS
  // (never refuses) the hydration step when the binary is absent (R5, R8).
  // A pin here would now be a LIE about which backend the verb needs.
  assert.doesNotMatch(pkg.scripts['memory:save'], /MEMORY_BACKEND=/,
    'the verb must not pin a backend — save is reachable under every backend now (#874, R8)');
  assert.match(pkg.scripts['memory:save'], /cli\.mjs save/);
});

test('#874 (D8): capture stays reachable with NO engram installed — save defers rather than refuses, end to end', (t) => {
  // #530's guarantee, PROVED END-TO-END instead of by a pin: even with the
  // default backend (engram) selected and the binary measurably absent from
  // PATH, `brain:memory:save` still writes a durable record and exits 0 — it never
  // refuses, and it never needs the plainfiles pin to do so.
  const REAL_WHICH = execFileSync('sh', ['-c', 'command -v which'], { encoding: 'utf8' }).trim();
  const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();

  const root = mkdtempSync(join(tmpdir(), 'capture-reachable-engram-'));
  // fresh-review F5 (#924): this fixture `git init`s `root` (below) and had NO
  // teardown at all — every run leaked a fresh temp tree (measured: 14 stray
  // `capture-reachable-engram-*` dirs under /tmp before this fix). `t.after`
  // + `removeTempTree`, consistent with this file's OTHER git-spawning
  // fixture (~line 101) and the #802 guard's answer to this exact class.
  t.after(() => removeTempTree(root));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  symlinkSync(REAL_WHICH, join(bin, 'which'));
  symlinkSync(REAL_GIT, join(bin, 'git'));
  mkdirSync(join(root, '.memory', 'records'), { recursive: true });

  const isolatedGitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv, PATH: bin } });
  spawnSync('git', ['config', '--local', 'brain.actor', '@test'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv, PATH: bin } });

  const r = spawnSync(process.execPath, [`${REPO}/brain/scripts/memory/cli.mjs`, 'save', 'title', 'content', '--type', 'discovery'], {
    encoding: 'utf8',
    env: { HOME: process.env.HOME, PATH: bin, MEMORY_BACKEND: 'engram', BRAIN_MEMORY_TEST_ROOT: root, ...isolatedGitEnv },
  });

  assert.equal(r.status, 0, `save must be reachable with no engram installed:\n${r.stdout}\n${r.stderr}`);
  assert.match(r.stderr, /deferred/i, 'the hydration must be reported as deferred, never as a refusal');
  const dir = join(root, '.memory', 'records');
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, `exactly one record file should exist: ${files.join(', ')}`);
});

test('#874 (D7/D8): engram\'s search refusal still names the native tool — save no longer routes through this key', async () => {
  // `memory.save.engramUnsupported` retired with its only call site (D7):
  // `save` is no longer deferred/refused at all. `memory.search.engramUnsupported`
  // stays (R14 scope — `search` is still unsupported under engram).
  const { t } = await import('../i18n/t.mjs');
  const say = (locale) => t('memory.search.engramUnsupported', { op: 'search', backend: 'engram' }, { locale });

  const en = await say('en');
  const es = await say('es');

  assert.notEqual(en, es, 'both locales resolved to the same string — the locale option is not being honoured');

  for (const [locale, msg] of [['en', en], ['es', es]]) {
    assert.match(msg, /mem_search/, `[${locale}] the refusal must name the native engram tool`);
  }
});

test('#530: the CLI actually forwards --issue — the parser is a layer of its own', async (t) => {
  // Every other #530 guard drives `save()` directly, so the PARSER had no coverage:
  // deleting `--issue` from it left the whole suite green. Proving a behaviour at one
  // layer says nothing about the layer above it, which is the same shape that let a
  // `readMergeParent` guard sit unexercised on #518.
  const { mkdtempSync, mkdirSync, readFileSync: read, readdirSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const { removeTempTree } = await import('../lib/tmp-tree.mjs');

  const root = mkdtempSync(join(tmpdir(), 'capture-cli-'));
  // #802: this test now `git init`s root (#738's isolation fixture) — a bare
  // recursive rmSync here would trip the drift guard; removeTempTree instead.
  t.after(() => removeTempTree(root));
  mkdirSync(join(root, '.memory', 'records'), { recursive: true });

  // #738 (design A6, #897 precedent): `save` reads `brain.actor` from the
  // real `git config --get` (cwd = root) — isolated from ambient
  // global/system config so this test's verdict does not depend on the
  // machine it runs on.
  const isolatedGitEnv = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };
  spawnSync('git', ['init', '-q'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } });
  spawnSync('git', ['config', '--local', 'brain.actor', '@test'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...isolatedGitEnv } });

  const r = spawnSync('node', [`${REPO}/brain/scripts/memory/cli.mjs`, 'save', 'title', 'content',
    '--type', 'discovery', '--issue', '530'], {
    encoding: 'utf8',
    env: { ...process.env, MEMORY_BACKEND: 'plainfiles', BRAIN_MEMORY_TEST_ROOT: root, ...isolatedGitEnv },
  });
  assert.equal(r.status, 0, `the CLI must save:\n${r.stdout}\n${r.stderr}`);

  // The filename is `<yyyy-mm>.jsonl` derived from the record's own timestamp, so
  // hardcoding this month would pass today and fail on the 1st. Read whatever landed.
  const dir = join(root, '.memory', 'records');
  const files = readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
  assert.equal(files.length, 1, `exactly one records file should exist: ${files.join(', ')}`);
  const line = read(join(dir, files[0]), 'utf8').trim().split('\n').pop();
  assert.equal(JSON.parse(line).issue, 530,
    'the flag reached the parser and not the record — an untagged record is what #368 measured 2157 times');
});
