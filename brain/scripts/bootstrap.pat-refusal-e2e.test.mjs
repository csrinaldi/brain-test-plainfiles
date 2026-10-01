// bootstrap.pat-refusal-e2e.test.mjs — issue #1112, cold-review round 3,
// should-fix 2: a refused PAT write must not be a clean exit, proven by
// running the REAL bootstrap.sh, not an extracted fragment.
//
// `bootstrap.pat-secret-guard.test.mjs` and `bootstrap.required-failure.test.mjs`
// already prove the write-gate and the REQUIRED_FAILURES/exit-code mechanism
// each in isolation, against lifted fragments (#340). What neither proves is
// that the WHOLE SCRIPT, run for real, actually reaches the write gate with a
// real operator-typed token and actually exits non-zero at the end — that
// needs a genuine interactive run: §3's PAT prompt only fires when `[ -t 0 ]`
// is true, and piped (non-tty) stdin takes the "no TTY" branch instead,
// never reaching the write gate at all. So this test drives bootstrap.sh
// under a REAL pseudo-tty (`__fixtures__/pty-drive.py` — python3 is already a
// required base dependency; Node has no built-in pty) and answers its two
// prompts (open-browser: no; paste-PAT: a fake token) exactly as a human
// would.
//
// SAFETY / HERMETICITY: everything lives under the OS temp dir (mkdtemp),
// never under this worktree, and the run must never reach a real `gh`, a
// real `gentle-ai`, the network or the operator's keyring.
//   - A temp dir is placed FIRST on PATH holding fake `gh` and `gentle-ai`
//     executables. They append their argv to a log file and exit
//     deterministically (gh: 1, gentle-ai: 0). The logs are the only record of
//     what bootstrap asked those tools to do.
//   - DBUS_SESSION_BUS_ADDRESS is emptied and XDG_RUNTIME_DIR points at a temp
//     dir, so nothing can reach the desktop secret service (keyring).
//   - HOME and ENGRAM_DATA_DIR are redirected into the fixture's temp tree,
//     GH_CONFIG_DIR points at a nonexistent path, GH_TOKEN/GITHUB_TOKEN are
//     cleared. The fixture has no `origin` remote at all.
//   - python3 stays real: it is only the pty driver.
//
// WHY THIS IS NECESSARY (corrected diagnosis): an earlier version of this
// header blamed the pty for `gh auth status` "seeing the ambient login". That
// was wrong. gh 2.46 exits 0 on an INVALID `GH_TOKEN` (it prints "The token in
// GH_TOKEN is invalid"), so `authCheck` reported true whatever the session.
// The real leaks were different: bootstrap's harness step runs
// `gentle-ai install`, and `gentle-ai doctor` calls `gh auth token`, which
// reached the operator's REAL token through the desktop keyring (dbus secret
// service at /run/user/UID/bus) despite the HOME/GH_CONFIG_DIR overrides. The
// shims plus the dbus/XDG overrides close both.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { removeTempTree } from './lib/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE_ROOT = join(HERE, '..', '..');
const PTY_DRIVE = join(HERE, '__fixtures__', 'pty-drive.py');

const PASTED_PAT_VALUE = 'ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE';

/** Copies what a consumer carries after `brain init`: brain/scripts + brain/core, no tests. */
function copyBrain(dest) {
  const keep = (src) => !src.endsWith('.test.mjs') && basename(src) !== '__fixtures__' && basename(src) !== 'node_modules';
  cpSync(join(SOURCE_ROOT, 'brain', 'scripts'), join(dest, 'brain', 'scripts'), { recursive: true, filter: keep });
  cpSync(join(SOURCE_ROOT, 'brain', 'core'), join(dest, 'brain', 'core'), { recursive: true, filter: keep });
}

/**
 * A real consumer fixture with `.env` already TRACKED — the write-gate's
 * refusal scenario blocker 2 covers — and everything else pre-seeded so the
 * ONLY interactive prompts bootstrap.sh reaches are the two the PAT section
 * asks (open-browser, paste-PAT): `brain.config.json` exists (skips the
 * VCS-provider-override prompt, which only fires on a freshly-created
 * config) and `.env` already states `MEMORY_BACKEND` (skips that prompt).
 */
function withTrackedEnvConsumer(fn) {
  const base = mkdtempSync(join(tmpdir(), 'brain-1112-pat-e2e-'));
  const repo = join(base, 'repo');
  try {
    execFileSync('git', ['init', '-q', '-b', 'main', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.com']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'test']);
    copyBrain(repo);
    writeFileSync(
      join(repo, 'package.json'),
      JSON.stringify(
        {
          name: 'pat-e2e-consumer',
          version: '1.0.0',
          private: true,
          scripts: {
            'brain:memory:pull': 'node ./brain/scripts/memory/cli.mjs pull',
            'brain:memory:index': 'node ./brain/scripts/memory/cli.mjs index',
          },
        },
        null,
        2,
      ),
    );
    writeFileSync(
      join(repo, 'brain.config.json'),
      JSON.stringify(
        {
          schemaVersion: '0.9.0',
          vcs: { provider: 'github' },
          project: { name: '', slug: 'testowner/pat-e2e-consumer', gitHost: 'github.com', gitProjectId: '', owner: '' },
          governance: {},
        },
        null,
        2,
      ),
    );
    writeFileSync(join(repo, '.env'), 'MEMORY_BACKEND=plainfiles\nAGENT_PLATFORM=claude\nSDD_ENGINE=gentle-ai\n');
    execFileSync('git', ['-C', repo, 'add', 'package.json', 'brain.config.json', '.env', 'brain']);
    execFileSync('git', ['-C', repo, 'commit', '-q', '-m', 'chore: seed fixture (tracked .env, on purpose)']);
    return fn(repo, base);
  } finally {
    removeTempTree(base);
  }
}

/** Every file under `root`, recursively — for the "the token is nowhere" scan. */
function allFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue; // git objects are content-addressed blobs, not plaintext greppable the same way; the working tree is what matters
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else out.push(p);
    }
  };
  walk(root);
  return out;
}

/** Fake `gh` / `gentle-ai`: record argv, exit deterministically. Returns { shimDir, ghLog, gentleLog }. */
function makeShims(base) {
  const shimDir = join(base, 'shims');
  mkdirSync(shimDir, { recursive: true });
  const ghLog = join(base, 'gh.log');
  const gentleLog = join(base, 'gentle-ai.log');
  const shim = (name, log, code) => {
    const path = join(shimDir, name);
    writeFileSync(path, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\nexit ${code}\n`);
    chmodSync(path, 0o755);
  };
  shim('gh', ghLog, 1);
  shim('gentle-ai', gentleLog, 0);
  return { shimDir, ghLog, gentleLog };
}

function runBootstrapE2e(repo, base, shims) {
  const homeDir = join(base, 'home');
  const engramDataDir = join(base, 'engram-data');
  const ghConfigDir = join(base, 'gh-config-nonexistent');
  const xdgRuntimeDir = join(base, 'xdg-runtime');
  mkdirSync(xdgRuntimeDir, { recursive: true });
  const steps = JSON.stringify([
    ['Open the browser', Buffer.from('n\n').toString('base64')],
    ['Paste your PAT', Buffer.from(`${PASTED_PAT_VALUE}\n`).toString('base64')],
  ]);
  return spawnSync('python3', [PTY_DRIVE, 'bash', 'brain/scripts/bootstrap.sh'], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 100_000,
    env: {
      PATH: `${shims.shimDir}:${process.env.PATH}`,
      HOME: homeDir,
      ENGRAM_DATA_DIR: engramDataDir,
      GH_CONFIG_DIR: ghConfigDir,
      GH_TOKEN: '',
      GITHUB_TOKEN: '',
      DBUS_SESSION_BUS_ADDRESS: '',
      XDG_RUNTIME_DIR: xdgRuntimeDir,
      PTY_STEPS: steps,
      PTY_TIMEOUT: '90',
    },
  });
}

test('#1112 e2e: env:init refuses a tracked .env, never writes the token, names the refusal, and exits non-zero', () => {
  withTrackedEnvConsumer((repo, base) => {
    const shims = makeShims(base);
    const result = runBootstrapE2e(repo, base, shims);

    // Hermeticity: the shims are what the run resolved, and they are the only
    // record of what bootstrap asked gh / gentle-ai for. Nothing real ran.
    for (const name of ['gh', 'gentle-ai']) {
      const resolved = execFileSync('sh', ['-c', `command -v ${name}`], {
        encoding: 'utf8',
        env: { PATH: `${shims.shimDir}:${process.env.PATH}` },
      }).trim();
      assert.equal(resolved, join(shims.shimDir, name), `${name} must resolve to the shim`);
    }
    const ghCalls = existsSync(shims.ghLog) ? readFileSync(shims.ghLog, 'utf8') : '';
    const gentleCalls = existsSync(shims.gentleLog) ? readFileSync(shims.gentleLog, 'utf8') : '';
    assert.doesNotMatch(ghCalls, /auth token/, `no gh shim call may be \`auth token\`; gh calls:\n${ghCalls}`);
    assert.doesNotMatch(gentleCalls, /auth token/, 'gentle-ai shim must never see `auth token`');
    assert.equal(
      ghCalls.includes(PASTED_PAT_VALUE) || gentleCalls.includes(PASTED_PAT_VALUE),
      false,
      'the pasted token must never reach a shim argv',
    );
    if (process.env.BRAIN_E2E_SHOW_SHIM_LOG) {
      process.stderr.write(`--- gh shim log ---\n${ghCalls}--- gentle-ai shim log ---\n${gentleCalls}`);
    }

    assert.notEqual(
      result.status,
      0,
      `env:init must exit non-zero when the PAT write was refused; combined output:\n${result.stdout}\n--- stderr ---\n${result.stderr}`,
    );

    // The refusal itself, and the final summary naming it as a required failure.
    assert.match(result.stdout, /NOT written/, `expected the write-gate's refusal; got:\n${result.stdout}`);
    assert.match(result.stdout, /git rm --cached/, 'the tracked-.env remedy must be named');
    assert.match(result.stdout, /Required step\(s\) failed/, 'the final summary must name the required failure');
    assert.match(result.stdout, /VCS_TOKEN not saved/, 'the summary must name which token was not saved');

    // The fake token must never land anywhere on disk in the fixture — not
    // just in .env (the direct write-gate target), but nowhere at all.
    for (const file of allFiles(repo)) {
      // 'latin1' — byte-preserving, so this never throws on a binary file;
      // the fake token is plain ASCII, so a latin1 decode still finds it
      // byte-for-byte if it is there.
      const content = readFileSync(file, 'latin1');
      assert.doesNotMatch(
        content,
        new RegExp(PASTED_PAT_VALUE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
        `the fake token must never be written to ${file}`,
      );
    }

    // .env itself is exactly what was seeded — MEMORY_BACKEND/AGENT_PLATFORM/
    // SDD_ENGINE are non-secret and env:init may rewrite those; VCS_TOKEN
    // must never appear.
    const envContent = readFileSync(join(repo, '.env'), 'utf8');
    assert.doesNotMatch(envContent, /VCS_TOKEN=/, '.env must never gain a VCS_TOKEN line');
  });
});
