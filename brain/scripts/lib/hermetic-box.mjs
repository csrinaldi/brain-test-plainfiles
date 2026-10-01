// hermetic-box.mjs — the hermetic box the end-to-end tests run brain in (#1127, #1187).
//
// Extracted from bootstrap.e2e.test.mjs so a second e2e (brain:ship on a fresh consumer)
// runs in the SAME box instead of a copy that drifts: a PATH made ONLY of a curated shim
// dir — every host binary EXCEPT gh, glab, engram, gentle-ai, codex, gga, claude and grep
// (grep is a python3 shim, so nothing depends on the host having one) — an isolated HOME and
// XDG_RUNTIME_DIR, empty DBUS_SESSION_BUS_ADDRESS, stdin closed. The brain tree under test
// is COPIED into the fixture: `memory/cli.mjs` resolves its repo root from its own module
// location, so a symlink would make it pull in the developer's real checkout.

import { spawnSync } from 'node:child_process';
import { cpSync, writeFileSync, readdirSync, symlinkSync, chmodSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { testTmp } from './test-tmp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO = join(HERE, '..', '..', '..');
const ABSENT = new Set(['gh', 'glab', 'engram', 'gentle-ai', 'codex', 'gga', 'claude', 'grep', 'egrep', 'fgrep']);

const GREP_SHIM = `#!/usr/bin/env python3
import re, sys
args = sys.argv[1:]
flags, pats, files = set(), [], []
i = 0
while i < len(args):
    a = args[i]
    if a == '-e': pats.append(args[i + 1]); i += 2; continue
    if a.startswith('-') and len(a) > 1: flags |= set(a[1:]); i += 1; continue
    (pats if not pats else files).append(a); i += 1
pat = pats[0]
if 'F' in flags: pat = re.escape(pat)
rx = re.compile(pat, re.I if 'i' in flags else 0)
data = [sys.stdin.read()] if not files else []
lines = []
for f in files:
    try: lines += open(f, errors='replace').read().splitlines()
    except OSError: sys.exit(2)
if not files: lines = data[0].splitlines()
hit = [l for l in lines if bool(rx.search(l)) != ('v' in flags)]
if 'q' not in flags:
    for l in hit: print(l)
sys.exit(0 if hit else 1)
`;

let sharedBin = null;
export function shimBin() {
  if (sharedBin) return sharedBin;
  const bin = testTmp('bootstrap-e2e-bin-');
  for (const dir of ['/usr/bin', '/bin']) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (ABSENT.has(name) || existsSync(join(bin, name))) continue;
      try { symlinkSync(join(dir, name), join(bin, name)); } catch { /* swallow-ok: a duplicate or unlinkable name only means one fewer host tool in the shim dir; the run then fails loudly if it was needed */ }
    }
  }
  for (const name of ['node', 'npm']) {
    const found = spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(found, join(bin, name));
  }
  writeFileSync(join(bin, 'grep'), GREP_SHIM);
  chmodSync(join(bin, 'grep'), 0o755);
  sharedBin = bin;
  return bin;
}

export function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: { PATH: shimBin(), HOME: cwd, GIT_CONFIG_NOSYSTEM: '1' } });
  assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}


/**
 * Copies the brain under test into `dir`. Tests are left out unless `keepTests`: a consumer
 * gets them with the managed copy, and `brain:nav` checks that core docs' cited test files exist.
 */
export function installBrain(dir, { keepTests = false } = {}) {
  cpSync(join(REPO, 'brain'), join(dir, 'brain'), {
    recursive: true,
    filter: (src) => !src.includes('node_modules') && (keepTests || !/\.test\.mjs$/.test(src)),
  });
  cpSync(join(REPO, 'package.json'), join(dir, 'package.json'));
}

/** The environment every hermetic run gets; `bin` (a dir of fakes) goes FIRST on PATH. */
export function hermeticEnv(root, { bin, env = {} } = {}) {
  return {
    PATH: bin ? `${bin}:${shimBin()}` : shimBin(),
    ...env,
    HOME: join(root, 'home'),
    XDG_RUNTIME_DIR: join(root, 'xdg'),
    DBUS_SESSION_BUS_ADDRESS: '',
    ENGRAM_DATA_DIR: join(root, 'engram-data'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
}
