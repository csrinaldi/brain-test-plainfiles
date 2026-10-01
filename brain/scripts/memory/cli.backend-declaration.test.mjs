// cli.backend-declaration.test.mjs — issue #1165, end to end.
//
// The defect: MEMORY_BACKEND lived only in the untracked `.env`. A second
// checkout (a teammate, CI, a FRESH CLONE) has no `.env`, so it silently ran the
// hard-coded default (engram) while the team used plainfiles, and died with
// "engram.search() failed — 'search' is not a cli verb for the 'engram' backend".
//
// So this does not lift a snippet: it builds a real origin, a real FRESH CLONE
// that carries a copy of the brain under test (memory/cli.mjs resolves its repo
// root from its own module location, so a symlink would read the developer's
// checkout), and drives the real cli.mjs in a child process.
//
// Hermetic: PATH is a dir holding only git and which — no engram, so a run that
// reaches the engram adapter fails loudly instead of depending on the host — and
// ENGRAM_DATA_DIR points at a temp dir should one ever be found.

import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildRecord, serializeRecord } from './lib/format.mjs';
import { testTmp } from '../lib/test-tmp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const which = (n) => execFileSync('sh', ['-c', `command -v ${n}`], { encoding: 'utf8' }).trim();
const MARKER = 'plainfiles-team-marker-1165';

let BIN;
let ORIGIN;
let SCRATCH;

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], {
    cwd, encoding: 'utf8', env: { PATH: BIN, HOME: SCRATCH, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

/** Origin whose tracked tree is a plainfiles consumer: the brain, a config, one record. */
before(() => {
  SCRATCH = testTmp('backend-declaration-');
  BIN = join(SCRATCH, 'bin');
  mkdirSync(BIN);
  symlinkSync(which('git'), join(BIN, 'git'));
  symlinkSync(which('which'), join(BIN, 'which'));

  ORIGIN = join(SCRATCH, 'origin.git');
  git(SCRATCH, 'init', '-q', '--bare', '-b', 'main', ORIGIN);
  const seed = join(SCRATCH, 'seed');
  git(SCRATCH, 'clone', '-q', ORIGIN, seed);
  cpSync(join(REPO, 'brain'), join(seed, 'brain'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && !/\.test\.mjs$/.test(src),
  });
  cpSync(join(REPO, 'package.json'), join(seed, 'package.json'));
  mkdirSync(join(seed, '.memory', 'records'), { recursive: true });
  const rec = buildRecord({
    ts: '2026-09-30T12:00:00Z', actor: '@test', actorKind: 'human', type: 'decision', project: 'brain',
    content: `a record only the plainfiles backend can search: ${MARKER}`,
  });
  writeFileSync(join(seed, '.memory', 'records', '2026-09-30.jsonl'), serializeRecord(rec) + '\n');
  writeFileSync(join(seed, '.gitignore'), '.env\n.engram\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-qm', 'seed');
  git(seed, 'push', '-q', 'origin', 'HEAD:main');
});

/** A FRESH CLONE of the origin: tracked files only, so no `.env`. `config` is the tracked brain.config.json. */
let n = 0;
function freshClone(config) {
  const dir = join(SCRATCH, `clone-${n++}`);
  git(SCRATCH, 'clone', '-q', ORIGIN, dir);
  if (config !== undefined) writeFileSync(join(dir, 'brain.config.json'), JSON.stringify(config));
  return dir;
}

function run(dir, args, env = {}) {
  return spawnSync(process.execPath, [join(dir, 'brain/scripts/memory/cli.mjs'), ...args], {
    cwd: dir, encoding: 'utf8',
    env: { PATH: BIN, HOME: SCRATCH, ENGRAM_DATA_DIR: join(SCRATCH, 'engram-data'), ...env },
  });
}

test('#1165 (a) a fresh clone with NO .env resolves plainfiles from tracked config: pull and search work', () => {
  const dir = freshClone({ memory: { backend: 'plainfiles' } });
  const pull = run(dir, ['pull']);
  assert.equal(pull.status, 0, pull.stderr);
  assert.doesNotMatch(pull.stderr, /engram/i);
  const search = run(dir, ['search', MARKER]);
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(MARKER));
  assert.doesNotMatch(search.stderr, /not a cli verb/);
});

test('#1165 (b) the process env beats config, and .env beats config', () => {
  const dir = freshClone({ memory: { backend: 'plainfiles' } });
  const viaEnv = run(dir, ['search', MARKER], { MEMORY_BACKEND: 'engram' });
  assert.equal(viaEnv.status, 1, 'env engram overrides the team plainfiles');
  assert.match(viaEnv.stderr, /engram\.search\(\) failed/);

  writeFileSync(join(dir, '.env'), 'MEMORY_BACKEND=engram\n');
  const viaDotenv = run(dir, ['search', MARKER]);
  assert.equal(viaDotenv.status, 1, '.env engram overrides the team plainfiles');
  assert.match(viaDotenv.stderr, /engram\.search\(\) failed/);

  const envOverDotenv = run(dir, ['search', MARKER], { MEMORY_BACKEND: 'plainfiles' });
  assert.equal(envOverDotenv.status, 0, 'process env beats .env');
  assert.match(envOverDotenv.stdout, new RegExp(MARKER));
});

test('#1165 (c) nothing declared anywhere is a REFUSAL that names the fix, not engram', () => {
  for (const config of [{ memory: { backend: '' } }, { memory: {} }, {}]) {
    const dir = freshClone(config);
    for (const args of [['pull'], ['search', MARKER], ['import'], ['heal-duplicates']]) {
      const r = run(dir, args);
      assert.equal(r.status, 3, `${args[0]} must refuse with the undeclared exit code: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /memory\.backend/, 'names the config key');
      assert.match(r.stderr, /brain:config -- set memory\.backend/, 'names the command that fixes it');
      assert.doesNotMatch(r.stderr, /engram binary not found|not a cli verb|substituted|records-only `plainfiles` backend instead/,
        'must not have guessed engram');
    }
  }
});

test('#1165 (c) an undeclared consumer can still do backend-free work (reindex needs no backend)', () => {
  const dir = freshClone({});
  const r = run(dir, ['reindex']);
  assert.equal(r.status, 0, r.stderr);
});

test('#1165 (c) an INVALID declaration is refused as a typo, never coerced', () => {
  const dir = freshClone({ memory: { backend: 'plainfile' } });
  const r = run(dir, ['pull']);
  assert.equal(r.status, 4, 'invalid has its own exit code, so callers can tell it from undeclared');
  assert.match(r.stderr, /'plainfile'/);
  assert.match(r.stderr, /engram \| plainfiles/);
});

test('#1165 (d) an existing consumer with only .env (config has no memory.backend key) is unchanged', () => {
  const dir = freshClone({ project: { name: 'x' } });
  writeFileSync(join(dir, '.env'), 'MEMORY_BACKEND=plainfiles\n');
  const pull = run(dir, ['pull']);
  assert.equal(pull.status, 0, pull.stderr);
  const search = run(dir, ['search', MARKER]);
  assert.equal(search.status, 0, search.stderr);
  assert.match(search.stdout, new RegExp(MARKER));
});

test('#1165 the tracked config the fixture carries is not mutated by a read', () => {
  const dir = freshClone({ memory: { backend: 'plainfiles' } });
  const before = readFileSync(join(dir, 'brain.config.json'), 'utf8');
  run(dir, ['search', MARKER]);
  assert.equal(readFileSync(join(dir, 'brain.config.json'), 'utf8'), before);
});

// ── per-op behaviour when NOTHING is declared (cold review of #1165, B1) ──────────────────────

const REFUSAL = /no memory backend is declared/;

test('#1165 B1 `save` on an UNDECLARED checkout is record-first: exit 0, the record is on disk, hydration is said to be deferred', () => {
  const dir = freshClone({});
  git(dir, 'config', '--local', 'brain.actor', '@test');
  const recordsDir = join(dir, '.memory', 'records');
  const before = readdirSync(recordsDir).length;
  const r = run(dir, ['save', 'a title', 'undeclared-save-body-1165', '--type', 'decision', '--issue', '1165']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.doesNotMatch(r.stderr, REFUSAL, 'save needs no backend (memory-backend-contract rule 2)');
  assert.match(r.stderr, /deferred until one is declared/, 'and it says why nothing was hydrated');
  const files = readdirSync(recordsDir);
  assert.ok(files.length > before || files.some((f) => readFileSync(join(recordsDir, f), 'utf8').includes('undeclared-save-body-1165')));
  assert.ok(files.some((f) => readFileSync(join(recordsDir, f), 'utf8').includes('undeclared-save-body-1165')), 'record content is durable');
});

// The complete table, one assertion per op. WORK: never consults a backend. REFUSE: does.
const WORK = [['reindex'], ['audit'], ['resolve-index'], ['split-records'], ['collect'], ['ship', '--dry-run'], ['migrate-v1']];
const REFUSE = [['share'], ['pull'], ['import'], ['index'], ['setup'], ['search', MARKER], ['feature-checkpoint'], ['feature-resume'], ['heal-duplicates']];

for (const args of WORK) {
  test(`#1165 undeclared: \`${args.join(' ')}\` never consults a backend, so it is NOT refused`, () => {
    const r = run(freshClone({}), args);
    assert.doesNotMatch(`${r.stdout}${r.stderr}`, REFUSAL);
  });
}
for (const args of REFUSE) {
  test(`#1165 undeclared: \`${args.join(' ')}\` consults a backend, so it REFUSES naming the fix`, () => {
    const r = run(freshClone({}), args);
    assert.equal(r.status, 3, `${r.stdout}${r.stderr}`);
    assert.match(r.stderr, REFUSAL);
    assert.match(r.stderr, /brain:config -- set memory\.backend/);
  });
}

// ── S3: a losing declaration is reported, never dropped ───────────────────────────────────────

test('#1165 S3 every backend-consulting op says when one declaration overrides another', () => {
  const dir = freshClone({ memory: { backend: 'plainfiles' } });
  writeFileSync(join(dir, '.env'), 'MEMORY_BACKEND=plainfiles\n');
  const envOverConfig = run(dir, ['search', MARKER], { MEMORY_BACKEND: 'plainfiles' });
  assert.equal(envOverConfig.status, 0, envOverConfig.stderr);
  // shell (plainfiles) equals .env and config: nothing shadowed, nothing said.
  assert.doesNotMatch(envOverConfig.stderr, /overrides/);

  writeFileSync(join(dir, '.env'), 'MEMORY_BACKEND=engram\n');
  const shellOverDotenv = run(dir, ['search', MARKER], { MEMORY_BACKEND: 'plainfiles' });
  assert.equal(shellOverDotenv.status, 0, shellOverDotenv.stderr);
  assert.match(shellOverDotenv.stderr, /process env \(plainfiles\) overrides \.env \(engram\)/, 'the shell-vs-.env shadow resolveEnv computes');

  const dotenvOverConfig = run(dir, ['search', MARKER]);
  assert.match(dotenvOverConfig.stderr, /\.env \(engram\) overrides brain\.config\.json \(plainfiles\)/);
});

test('#1165 S3 (cold-1) an INVALID winning declaration still prints what it overrode, before refusing', () => {
  const dir = freshClone({ memory: { backend: 'engram' } });
  const r = run(dir, ['pull'], { MEMORY_BACKEND: 'bogus' });
  assert.equal(r.status, 4);
  assert.match(r.stderr, /process env \(bogus\) overrides brain\.config\.json \(engram\)/);
});

// ── round-2 review (cold-1 … cold-4) ─────────────────────────────────────────────────────────

test('#1165 cold-1 a config-declared engram with NO engram binary: `pull` is record-first — it pulls the records, defers hydration, says so, exits 0', () => {
  const dir = freshClone({ memory: { backend: 'engram' } });
  const r = run(dir, ['pull']);
  assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
  assert.match(r.stderr, /ran on the records-only `plainfiles` backend instead/);
  assert.match(r.stderr, /brain\.config\.json/, 'names where engram was declared');
  assert.match(r.stderr, /hydration into `engram` is deferred/);
});

test('#1165 cold-1 an EXPLICIT env/.env engram with no binary is still never overridden, and the notice names its real source', () => {
  const dir = freshClone({ memory: { backend: 'plainfiles' } });
  const viaEnv = run(dir, ['pull'], { MEMORY_BACKEND: 'engram' });
  assert.match(viaEnv.stderr, /the process env sets the memory backend to engram explicitly/);
  assert.doesNotMatch(viaEnv.stderr, /records-only `plainfiles` backend instead/);
  writeFileSync(join(dir, '.env'), 'MEMORY_BACKEND=engram\n');
  const viaFile = run(dir, ['pull']);
  assert.match(viaFile.stderr, /\.env sets the memory backend to engram explicitly/);
});

test('#1165 cold-3 the saveDeferred reason is catalog text, not an English literal spliced into es', async () => {
  const { default: en } = await import('../i18n/en.mjs');
  const { default: es } = await import('../i18n/es.mjs');
  for (const key of ['memory.backend.saveDeferred.undeclared', 'memory.backend.saveDeferred.invalid']) {
    assert.ok(en[key] && es[key], `${key} exists in both locales`);
    assert.notEqual(es[key], en[key]);
    assert.doesNotMatch(en[key], /\{reason\}/);
  }
  assert.equal(en['memory.backend.saveDeferred'], undefined, 'the {reason}-splicing key is gone');
  assert.doesNotMatch(es['memory.backend.saveDeferred.undeclared'], /no backend is declared/);
});

test('#1165 cold-4 the invalid refusal names the source as an operator reads it, not the resolver token', () => {
  const dir = freshClone({ memory: { backend: 'zzz' } });
  assert.match(run(dir, ['pull']).stderr, /\(from brain\.config\.json\)/);
  writeFileSync(join(dir, '.env'), 'MEMORY_BACKEND=zzz\n');
  assert.match(run(dir, ['pull']).stderr, /\(from \.env\)/);
  assert.match(run(dir, ['pull'], { MEMORY_BACKEND: 'zzz' }).stderr, /\(from the process env\)/);
});
