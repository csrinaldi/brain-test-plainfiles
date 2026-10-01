// install-tools.test.mjs — install-tools.sh must not guess or over-claim (#1127, class C).
//
// Two defects, both found by the cold review of the swallow sweep:
//  1. An unreadable brain.config.json defaulted vcs.provider to gitlab, so a GitHub
//     repo was handed `glab`. A corrupt config is now refused; only an ABSENT one
//     keeps the documented default.
//  2. `gentle-ai install && ok || warn` printed the next-steps summary as if setup
//     had finished. A failed configuration now ends the run as incomplete, exit 1.
//
// Snippets are LIFTED out of the script (as bootstrap.cross-tree-code.test.mjs does),
// so there is no second copy to drift from the first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, symlinkSync, mkdirSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINES = readFileSync(join(HERE, 'install-tools.sh'), 'utf8').split('\n');

function region(from, to) {
  const start = LINES.findIndex((l) => l.startsWith(from));
  assert.ok(start !== -1, `install-tools.sh must have a line starting with "${from}"`);
  const end = LINES.findIndex((l, i) => i > start && l.startsWith(to));
  assert.ok(end !== -1, `install-tools.sh must have a line starting with "${to}" after "${from}"`);
  return LINES.slice(start, end).join('\n');
}

function run(script, dir, extraPath = '') {
  const r = spawnSync('bash', ['-c', script], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: `${extraPath}${extraPath ? ':' : ''}${process.env.PATH}`, HOME: dir, DBUS_SESSION_BUS_ADDRESS: '' },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, stdout: r.stdout };
}

const PRELUDE = 'set -euo pipefail\ndie() { printf "\\n  x %s\\n" "$1" >&2; exit 1; }\n';
const resolveVcs = () => region('# ── Resolve VCS provider', '# ── i18n');

function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-1127-tools-'));
  try { return fn(dir); } finally { removeTempTree(dir); }
}

test('#1127 install-tools: a corrupt brain.config.json is refused, never defaulted to gitlab', () => inTmp((dir) => {
  writeFileSync(join(dir, 'brain.config.json'), '{ not json');
  const r = run(`${PRELUDE}${resolveVcs()}\necho "CLI=$VCS_CLI"`, dir);
  assert.notEqual(r.code, 0, r.out);
  assert.match(r.out, /brain\.config\.json/);
  assert.doesNotMatch(r.out, /CLI=glab/);
}));

test('#1127 install-tools: a GitHub config resolves to gh, an absent config keeps the documented gitlab default', () => inTmp((dir) => {
  writeFileSync(join(dir, 'brain.config.json'), JSON.stringify({ vcs: { provider: 'github' } }));
  assert.match(run(`${PRELUDE}${resolveVcs()}\necho "CLI=$VCS_CLI"`, dir).stdout, /CLI=gh/);
}));

test('#1127 install-tools: no brain.config.json at all keeps the documented gitlab default', () => inTmp((dir) => {
  assert.match(run(`${PRELUDE}${resolveVcs()}\necho "CLI=$VCS_CLI"`, dir).stdout, /CLI=glab/);
}));

test('#1127 install-tools: a failing `gentle-ai install` ends the run incomplete with exit 1, not a clean summary', () => inTmp((dir) => {
  const shim = join(dir, 'bin');
  spawnSync('mkdir', ['-p', shim]);
  writeFileSync(join(shim, 'gentle-ai'), '#!/bin/sh\n[ "$1" = install ] && exit 1\nexit 0\n');
  chmodSync(join(shim, 'gentle-ai'), 0o755);
  const tail = LINES.slice(LINES.findIndex((l) => l.startsWith('# ── 5. Summary'))).join('\n');
  const script = [
    'set -euo pipefail',
    'ok() { echo "ok $1"; }; warn() { echo "warn $1" >&2; }; skip() { echo "skip $1"; }; say() { echo "== $1"; }',
    `eval "$(node ${JSON.stringify(join(HERE, 'i18n', 'sh.mjs'))})"`,
    'FAILED_STEPS=()',
    'VCS_CLI=gh',
    region('# gentle-ai install configures', '# ── 5. Summary'),
    tail,
  ].join('\n');
  const r = run(script, dir, shim);
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /gentle-ai configuration/);
}));

// Without node the provider is read by a text match: scoped to the `vcs` object, and an empty
// or missing provider takes the same gitlab default the node path uses.
function noNodeRun(dir, config) {
  const bin = join(dir, 'nonode');
  mkdirSync(bin);
  for (const tool of ['tr', 'sed', 'head']) {
    const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    symlinkSync(found, join(bin, tool));
  }
  writeFileSync(join(dir, 'brain.config.json'), config);
  const bash = spawnSync('sh', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  const r = spawnSync(bash, ['-c', `${PRELUDE}${resolveVcs()}\necho "CLI=$VCS_CLI PROVIDER=$VCS_PROVIDER"`], {
    cwd: dir, encoding: 'utf8', env: { PATH: bin, HOME: dir, DBUS_SESSION_BUS_ADDRESS: '' },
  });
  return `${r.stdout}${r.stderr}`;
}

test('#1127 install-tools (no node): reads vcs.provider scoped to the vcs object, and says it is a text match', () => inTmp((dir) => {
  const out = noNodeRun(dir, '{"other": {"provider": "gitlab"}, "vcs": {"gitHost": "x", "provider": "github"}}');
  assert.match(out, /CLI=gh/);
  assert.match(out, /text match/);
}));

test('#1127 install-tools (no node): the vcs object wins whichever order the file lists it in', () => inTmp((dir) => {
  assert.match(noNodeRun(dir, '{"vcs": {"provider": "github"}, "other": {"provider": "gitlab"}}'), /CLI=gh/);
}));

test('#1127 install-tools (no node): an empty or missing provider takes the same gitlab default as the node path', () => inTmp((dir) => {
  assert.match(noNodeRun(dir, '{"vcs": {"provider": ""}}'), /PROVIDER=gitlab/, 'the same default value the node path uses, not an empty string');
}));
