// pull-fixture.mjs — issue #1118's real git fixture, shared by
// plainfiles.pull.integration.test.mjs and engram.pull.integration.test.mjs
// so the two backends' `pull()`/`pullMemory()` are proven against the exact
// same scenario rather than two hand-maintained copies of it.
//
// Builds the shape #1081 finding F10 describes:
//   - `originDir`: a bare origin.
//   - `capturingDir`: a clone with an UNTRACKED `.memory/records/<file>.jsonl`
//     on disk at RECORD_PATH — `save()` never `git add`s it (lane/collect.mjs
//     reads it via `git status`, never the index).
//   - a separate `shipper` clone commits `shipperContent` at that SAME path
//     to `main` and pushes — standing in for the lane commit a merged PR
//     produced (`lane/plan.mjs`'s own `already-on-main` skip already proves
//     this exact file reaches `origin/main`).

import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { testTmp } from '../lib/test-tmp.mjs';
import { removeTempTree } from './tmp-tree.mjs';
import { buildRecord, serializeRecord } from '../memory/lib/format.mjs';
import { recordFilename } from '../memory/lib/store.mjs';

// GIT_CONFIG_GLOBAL/GIT_CONFIG_NOSYSTEM: the same isolation idiom
// plainfiles.save-index-failure.test.mjs already uses — every fixture git
// command is hermetic against whatever `pull.rebase`/`pull.ff`/etc. the
// HOST's real `~/.gitconfig` happens to carry, never just a coincidence of
// this particular machine's config.
export const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'brain-test',
  GIT_AUTHOR_EMAIL: 'brain-test@example.invalid',
  GIT_COMMITTER_NAME: 'brain-test',
  GIT_COMMITTER_EMAIL: 'brain-test@example.invalid',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: GIT_ENV });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} (cwd=${cwd}) failed:\n${r.stdout}\n${r.stderr}`);
  return r.stdout;
}

// A REAL record, built through format.mjs like every in-tree producer — its
// id is content-addressed (computeRecordId), so rebuildIndex()'s own tamper
// check (stored id vs recomputed id) accepts it, exactly like a genuine
// `brain:memory:save` output would.
export const FIXTURE_RECORD = buildRecord({
  ts: '2026-09-29T00:00:00Z', actor: '@brain-test', actorKind: 'agent',
  type: 'discovery', project: 'brain', content: 'issue #1118 fixture record',
});
export const RECORD_PATH = `.memory/records/${recordFilename(FIXTURE_RECORD)}`;
export const RECORD_CONTENT = serializeRecord(FIXTURE_RECORD) + '\n';

/**
 * Builds `{ originDir, capturingDir }` — `capturingDir` is a clone with an
 * untracked record file on disk at RECORD_PATH; `origin/main` already
 * carries the SAME path (from a separate `shipper` clone), with
 * `shipperContent` at that path — identical to RECORD_CONTENT unless the
 * caller passes a divergent one.
 *
 * @param {import('node:test').TestContext} t
 * @param {{shipperContent?: string}} [opts]
 */
export function buildPullFixture(t, { shipperContent = RECORD_CONTENT } = {}) {
  const base = testTmp('brain-pull-1118-');
  t.after(() => removeTempTree(base));

  const originDir = join(base, 'origin.git');
  const seedDir = join(base, 'seed');
  const capturingDir = join(base, 'capturing');
  const shipperDir = join(base, 'shipper');

  git(base, 'init', '--bare', '-q', '-b', 'main', originDir);

  git(base, 'init', '-q', '-b', 'main', seedDir);
  git(seedDir, 'remote', 'add', 'origin', originDir);
  mkdirSync(join(seedDir, '.memory', 'records'), { recursive: true });
  writeFileSync(join(seedDir, '.memory', '.gitkeep'), '', 'utf8');
  git(seedDir, 'add', '.memory');
  git(seedDir, 'commit', '-q', '-m', 'root');
  git(seedDir, 'push', '-q', '-u', 'origin', 'main');

  // The capturing checkout, with the untracked record on disk.
  git(base, 'clone', '-q', originDir, capturingDir);
  mkdirSync(join(capturingDir, '.memory', 'records'), { recursive: true });
  writeFileSync(join(capturingDir, RECORD_PATH), RECORD_CONTENT, 'utf8');

  // A separate clone ships the SAME path to main (the merged lane PR).
  git(base, 'clone', '-q', originDir, shipperDir);
  mkdirSync(join(shipperDir, '.memory', 'records'), { recursive: true });
  writeFileSync(join(shipperDir, RECORD_PATH), shipperContent, 'utf8');
  git(shipperDir, 'add', RECORD_PATH);
  git(shipperDir, 'commit', '-q', '-m', 'lane: add the fixture record');
  git(shipperDir, 'push', '-q', 'origin', 'main');

  return { originDir, capturingDir };
}

/**
 * Builds `{ originDir, capturingDir }` where `capturingDir`'s LOCAL branch
 * has genuinely DIVERGED from its upstream: a local-only commit AND a
 * remote-only commit (the shipped record), neither an ancestor of the
 * other — the shape a `standard`/`regulated`-tier feature branch is
 * routinely in under ADR-0034 (records land on `main` via their own lane
 * PR while the feature branch keeps its own local work). Same
 * byte-identical untracked record as `buildPullFixture`, at RECORD_PATH.
 *
 * @param {import('node:test').TestContext} t
 */
export function buildDivergedPullFixture(t) {
  const base = testTmp('brain-pull-diverged-1118-');
  t.after(() => removeTempTree(base));

  const originDir = join(base, 'origin.git');
  const seedDir = join(base, 'seed');
  const capturingDir = join(base, 'capturing');
  const shipperDir = join(base, 'shipper');

  git(base, 'init', '--bare', '-q', '-b', 'main', originDir);

  git(base, 'init', '-q', '-b', 'main', seedDir);
  git(seedDir, 'remote', 'add', 'origin', originDir);
  mkdirSync(join(seedDir, '.memory', 'records'), { recursive: true });
  writeFileSync(join(seedDir, '.memory', '.gitkeep'), '', 'utf8');
  git(seedDir, 'add', '.memory');
  git(seedDir, 'commit', '-q', '-m', 'root');
  git(seedDir, 'push', '-q', '-u', 'origin', 'main');

  // The capturing checkout, with the untracked record on disk.
  git(base, 'clone', '-q', originDir, capturingDir);
  mkdirSync(join(capturingDir, '.memory', 'records'), { recursive: true });
  writeFileSync(join(capturingDir, RECORD_PATH), RECORD_CONTENT, 'utf8');

  // Diverge: a LOCAL-only commit, never pushed.
  writeFileSync(join(capturingDir, 'local-only.txt'), 'local work in progress\n', 'utf8');
  git(capturingDir, 'add', 'local-only.txt');
  git(capturingDir, 'commit', '-q', '-m', 'local: work in progress');

  // A separate clone ships the SAME record path to main — origin/main now
  // ALSO carries a commit the capturing checkout's local HEAD lacks: true
  // divergence, neither side a fast-forward of the other.
  git(base, 'clone', '-q', originDir, shipperDir);
  mkdirSync(join(shipperDir, '.memory', 'records'), { recursive: true });
  writeFileSync(join(shipperDir, RECORD_PATH), RECORD_CONTENT, 'utf8');
  git(shipperDir, 'add', RECORD_PATH);
  git(shipperDir, 'commit', '-q', '-m', 'lane: add the fixture record');
  git(shipperDir, 'push', '-q', 'origin', 'main');

  return { originDir, capturingDir };
}

/**
 * Runs `fn()` with `process.env.GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`
 * temporarily forced to the SAME isolation `GIT_ENV` uses — production code
 * under test (`pull()`, `defaultGitPull()`) spawns `git` with `{cwd}` only,
 * inheriting `process.env` as-is (never `GIT_ENV`, which is this file's own
 * fixture-building seam), so a scenario that depends on "no
 * `pull.rebase`/`pull.ff` configured anywhere" needs THIS process's own env
 * isolated too, not just the fixture-building git calls. Always restores
 * the previous values (present or absent) afterward, even on throw.
 *
 * @template T
 * @param {() => Promise<T> | T} fn
 * @returns {Promise<T>}
 */
export async function withIsolatedGitEnv(fn) {
  const hadGlobal = Object.prototype.hasOwnProperty.call(process.env, 'GIT_CONFIG_GLOBAL');
  const hadNoSystem = Object.prototype.hasOwnProperty.call(process.env, 'GIT_CONFIG_NOSYSTEM');
  const prevGlobal = process.env.GIT_CONFIG_GLOBAL;
  const prevNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  try {
    return await fn();
  } finally {
    if (hadGlobal) process.env.GIT_CONFIG_GLOBAL = prevGlobal; else delete process.env.GIT_CONFIG_GLOBAL;
    if (hadNoSystem) process.env.GIT_CONFIG_NOSYSTEM = prevNoSystem; else delete process.env.GIT_CONFIG_NOSYSTEM;
  }
}
