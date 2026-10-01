// bootstrap.default-platform.test.mjs — bootstrap.sh's platform default is
// `claude`, and it gives the SAME answer as `resolvePlatform` (issue #1125).
//
// ── Why this exists ─────────────────────────────────────────────────────────
//
// bootstrap.sh resolves AGENT_PLATFORM in shell, writes it to `.env` and
// exports it before `harness/cli.mjs init` runs. That makes it a SECOND
// resolver beside `harness/platform.mjs#resolvePlatform`, and until #1125 the
// two disagreed on three inputs while agreeing on the default by coincidence:
//
//   - a process-env `AGENT_PLATFORM` was ignored (only `.env` was read), so the
//     documented `AGENT_PLATFORM=antigravity npm run brain:env:init` produced
//     antigravity only because antigravity was also the default;
//   - a legacy `SDD_HARNESS=claude` in `.env` was ignored, and the default was
//     written over it;
//   - a process-env value was shadowed by `.env`, the reverse of the resolver.
//
// Flipping the default to `claude` turns each coincidence into a wrong answer,
// so the default and the precedence move together, and the parity test below
// holds the shell to the JS resolver until #1114 leaves exactly one resolver.
//
// ── Idiom ───────────────────────────────────────────────────────────────────
//
// Same as bootstrap.cross-tree-code.test.mjs (#1093) and
// bootstrap.worktree.test.mjs (#657): the block under test is LIFTED OUT OF
// bootstrap.sh and executed, so there is no second copy to drift from it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { resolvePlatform, AGENT_PLATFORMS } from './harness/platform.mjs';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const LINES = readFileSync(BOOTSTRAP, 'utf8').split('\n');

/** bootstrap.sh's own `env_get` / `env_set` helpers, verbatim. */
function envHelpers() {
  const get = LINES.find((l) => l.startsWith('env_get() {'));
  assert.ok(get, 'bootstrap.sh must define env_get');
  const setStart = LINES.findIndex((l) => l.startsWith('env_set() {'));
  assert.ok(setStart !== -1, 'bootstrap.sh must define env_set');
  const setEnd = LINES.findIndex((l, i) => i > setStart && l === '}');
  assert.ok(setEnd !== -1, 'env_set must close with a bare }');
  return [get, ...LINES.slice(setStart, setEnd + 1)].join('\n');
}

/**
 * The platform block of §6, verbatim: from the line after the SDD section
 * banner up to and including the line that sets the run's AGENT_PLATFORM.
 */
function platformBlock() {
  const banner = LINES.findIndex((l) => l.startsWith('say "$I18N_BOOTSTRAP_SDD_SECTION"'));
  assert.ok(banner !== -1, 'bootstrap.sh §6 must open with the SDD section banner');
  const persist = LINES.findIndex((l, i) => i > banner && l.includes('env_set AGENT_PLATFORM'));
  assert.ok(persist !== -1, '§6 must persist AGENT_PLATFORM with env_set');
  const end = LINES.findIndex((l, i) => i >= persist && l.startsWith('AGENT_PLATFORM="${AGENT_PLATFORM:-'));
  assert.ok(end !== -1, "§6 must set the run's AGENT_PLATFORM after persisting the repo's");
  return LINES.slice(banner + 1, end + 1).join('\n');
}

const BASE_ENV = { ...process.env };
for (const k of ['AGENT_PLATFORM', 'SDD_HARNESS', 'SDD_ENGINE']) delete BASE_ENV[k];

/**
 * Runs the lifted block in a scratch dir holding `envFile` (null = no .env),
 * with `procEnv` layered on a clean environment. Returns what the block
 * resolved and the `.env` it left behind.
 */
function runBlock({ procEnv = {}, envFile = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-1125-bootstrap-'));
  try {
    if (envFile !== null) writeFileSync(join(dir, '.env'), envFile);
    const script = [
      'set -euo pipefail',
      envHelpers(),
      platformBlock(),
      'printf \'%s\' "$AGENT_PLATFORM"',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...BASE_ENV, ...procEnv },
    });
    const envPath = join(dir, '.env');
    return { platform: out, dotenv: existsSync(envPath) ? readFileSync(envPath, 'utf8') : null };
  } finally {
    removeTempTree(dir);
  }
}

test('#1125 bootstrap.sh: with nothing stated anywhere, the platform is claude and .env records it', () => {
  const { platform, dotenv } = runBlock();
  assert.equal(platform, 'claude');
  assert.match(dotenv, /^AGENT_PLATFORM=claude$/m, 'the default is stated explicitly in .env');
});

test('#1125 bootstrap.sh: an .env without AGENT_PLATFORM still defaults to claude', () => {
  const { platform, dotenv } = runBlock({ envFile: 'VCS_TOKEN=tok\n' });
  assert.equal(platform, 'claude');
  assert.match(dotenv, /^AGENT_PLATFORM=claude$/m);
  assert.match(dotenv, /^VCS_TOKEN=tok$/m, 'other keys survive');
});

test('#1125 bootstrap.sh: a stated antigravity still resolves to antigravity on every shell path', () => {
  const cases = {
    '.env AGENT_PLATFORM': { envFile: 'AGENT_PLATFORM=antigravity\n' },
    'process env AGENT_PLATFORM': { procEnv: { AGENT_PLATFORM: 'antigravity' } },
    '.env SDD_HARNESS (legacy)': { envFile: 'SDD_HARNESS=antigravity\n' },
    'process env SDD_HARNESS (legacy)': { procEnv: { SDD_HARNESS: 'antigravity' } },
  };
  for (const [label, opts] of Object.entries(cases)) {
    assert.equal(runBlock(opts).platform, 'antigravity', `stated via ${label}`);
  }
});

test('#1125 bootstrap.sh: a process-env platform wins for the run and does NOT rewrite a platform .env already states', () => {
  // The antigravity backend's REGENERATE_HINT is
  // `AGENT_PLATFORM=antigravity npm run brain:env:init`. It must run antigravity
  // for that invocation, and must not silently switch a claude repo's .env.
  const { platform, dotenv } = runBlock({
    procEnv: { AGENT_PLATFORM: 'antigravity' },
    envFile: 'AGENT_PLATFORM=claude\n',
  });
  assert.equal(platform, 'antigravity');
  assert.equal(dotenv, 'AGENT_PLATFORM=claude\n', '.env is left exactly as stated');
});

test('#1125 bootstrap.sh: a process-env platform on a fresh .env is NOT persisted — .env records the repo\'s own answer', () => {
  // `brain:upgrade` prints `AGENT_PLATFORM=antigravity npm run brain:env:init`
  // to a FRESH consumer (to regenerate AGENTS.md). Persisting the process value
  // would silently move that consumer off the claude default for good. The
  // process env is per-invocation, exactly as resolvePlatform treats it; .env is
  // what the repo states, and a repo that stated nothing gets the default.
  const { platform, dotenv } = runBlock({ procEnv: { AGENT_PLATFORM: 'antigravity' } });
  assert.equal(platform, 'antigravity', 'the invocation runs what it was asked to');
  assert.match(dotenv, /^AGENT_PLATFORM=claude$/m, '.env records the default, not the one-off');
});

test('#1125 bootstrap.sh: a legacy SDD_HARNESS naming an ENGINE is not a platform — the default applies', () => {
  assert.equal(runBlock({ envFile: 'SDD_HARNESS=gentle-ai\n' }).platform, 'claude');
});

test('#1125 bootstrap.sh and resolvePlatform give ONE answer over every env/.env combination (parity until #1114)', () => {
  // Every combination of the four inputs both resolvers read. The legacy
  // `.env` SDD_HARNESS — the input the shell used to ignore — takes every value
  // (unset, each supported platform, an engine name); the other three take
  // unset plus values that differ from the default and from each other, so
  // each precedence edge flips the answer somewhere in the table. One bash
  // process runs every case in its own subshell and scratch dir: each case
  // forks grep/cut/mktemp, and a full 5^4 table measured 25 s.
  const unsetOr = (...v) => [undefined, ...v];
  const cases = [];
  for (const envAP of unsetOr('antigravity'))
    for (const envSH of unsetOr('antigravity', 'gentle-ai'))
      for (const fileAP of unsetOr('antigravity', 'claude'))
        for (const fileSH of unsetOr(...AGENT_PLATFORMS, 'gentle-ai')) cases.push({ envAP, envSH, fileAP, fileSH });

  const base = mkdtempSync(join(tmpdir(), 'brain-1125-parity-'));
  try {
    const q = (v) => `'${v}'`;
    const script = ['set -euo pipefail', envHelpers()];
    cases.forEach((c, i) => {
      const dir = join(base, String(i));
      const lines = [`mkdir -p ${q(dir)}`, `cd ${q(dir)}`];
      if (c.fileAP) lines.push(`printf 'AGENT_PLATFORM=%s\\n' ${q(c.fileAP)} >> .env`);
      if (c.fileSH) lines.push(`printf 'SDD_HARNESS=%s\\n' ${q(c.fileSH)} >> .env`);
      lines.push(c.envAP ? `export AGENT_PLATFORM=${q(c.envAP)}` : 'unset AGENT_PLATFORM');
      lines.push(c.envSH ? `export SDD_HARNESS=${q(c.envSH)}` : 'unset SDD_HARNESS');
      lines.push(platformBlock(), `printf '%s\\n' "$AGENT_PLATFORM"`);
      script.push(`(\n${lines.join('\n')}\n)`);
    });
    // From a script FILE, not argv (625 copies of the block exceed ARG_MAX, E2BIG) and not the
    // `input` option (a piped stdin never sees EOF in the cold reviewer's sandbox, #1221).
    const scriptFile = join(base, 'parity.sh');
    writeFileSync(scriptFile, script.join('\n'));
    const out = execFileSync('bash', [scriptFile], {
      encoding: 'utf8',
      env: BASE_ENV,
      maxBuffer: 16 * 1024 * 1024,
    }).split('\n');

    const mismatches = [];
    cases.forEach((c, i) => {
      const env = {};
      if (c.envAP) env.AGENT_PLATFORM = c.envAP;
      if (c.envSH) env.SDD_HARNESS = c.envSH;
      const envVars = {};
      if (c.fileAP) envVars.AGENT_PLATFORM = c.fileAP;
      if (c.fileSH) envVars.SDD_HARNESS = c.fileSH;
      const js = resolvePlatform({ env, envVars, config: {} });
      if (out[i] !== js) mismatches.push({ ...c, shell: out[i], js });
    });
    assert.equal(cases.length, 90, 'the table is exhaustive over the chosen values');
    assert.deepEqual(mismatches, [], 'bootstrap.sh must resolve what resolvePlatform resolves');
  } finally {
    removeTempTree(base);
  }
});
