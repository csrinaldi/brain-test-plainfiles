// bootstrap.required-steps.test.mjs — a bootstrap step whose failure leaves the
// environment unusable must join REQUIRED_FAILURES (#1127, class C; slice A).
//
// Before: SDD init, the git hooks path, the engram/plainfiles setup, `brain:memory:pull`,
// `brain:memory:index`, the VCS login and the provider-override write each warned (the
// override write did not even warn) and the run then read as `Environment ready`,
// exit 0. #1155's REQUIRED_FAILURES list turns a non-empty list into the summary line
// and exit 1; these steps append to THAT list, never a second one.
//
// Every snippet is LIFTED out of bootstrap.sh and executed (bootstrap.cross-tree-code
// discipline), so there is no second copy to drift from the first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LINES = readFileSync(join(HERE, 'bootstrap.sh'), 'utf8').split('\n');

/** Lines from the first one starting with `from` up to (not including) the next starting with `to`. */
function region(from, to) {
  const start = LINES.findIndex((l) => l.trimStart().startsWith(from));
  assert.ok(start !== -1, `bootstrap.sh must have a line starting with "${from}"`);
  const end = LINES.findIndex((l, i) => i > start && l.trimStart().startsWith(to));
  assert.ok(end !== -1, `bootstrap.sh must have a line starting with "${to}" after "${from}"`);
  return LINES.slice(start, end).join('\n');
}

const HELPERS = region('# --- BEGIN memory-step-helpers', '# --- END memory-step-helpers');

const PRELUDE = [
  'REQUIRED_FAILURES=()',
  'MISSING_OPTIONAL=()',
  'ok()   { printf "  ok %s\\n" "$1"; }',
  'warn() { printf "  warn %s\\n" "$1" >&2; }',
  `eval "$(node ${JSON.stringify(join(HERE, 'i18n', 'sh.mjs'))})"`,
  HELPERS,
].join('\n');

function inTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-1127-req-'));
  try { return fn(dir); } finally { removeTempTree(dir); }
}

function failing(dir) {
  const p = join(dir, 'fail.sh');
  writeFileSync(p, '#!/bin/sh\nexit 1\n');
  chmodSync(p, 0o755);
  return p;
}

function required(snippet, setup, dir) {
  const r = spawnSync('bash', ['-c', `${PRELUDE}\n${setup}\n${snippet}\nprintf 'REQ=%s\\n' "\${REQUIRED_FAILURES[*]}"`], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: dir, DBUS_SESSION_BUS_ADDRESS: '' },
  });
  return `${r.stdout}${r.stderr}`;
}

const scriptsWith = (dir, rel, body) => {
  const scripts = join(dir, 'scripts');
  mkdirSync(join(scripts, dirname(rel)), { recursive: true });
  writeFileSync(join(scripts, rel), body);
  return scripts;
};

test('#1127 bootstrap: a failing SDD init is a REQUIRED failure', () => inTmp((dir) => {
  const scripts = scriptsWith(dir, 'harness/cli.mjs', 'process.exit(1);\n');
  const out = required(region('node "$BRAIN_SCRIPTS/harness/cli.mjs" init', '# --- 7.'), `BRAIN_SCRIPTS=${JSON.stringify(scripts)}`, dir);
  assert.match(out, /REQ=.*SDD/, out);
}));

test('#1127 bootstrap: a failing core.hooksPath config is a REQUIRED failure', () => inTmp((dir) => {
  const out = required(region('git config core.hooksPath', 'case "$MEMORY_BACKEND"'), 'git() { return 1; }', dir);
  assert.match(out, /REQ=.*hooks/i, out);
}));

test('#1127 bootstrap: engram setup, pull and index failures are each a REQUIRED failure', () => inTmp((dir) => {
  const scripts = scriptsWith(dir, 'memory/cli.mjs', 'process.exit(1);\n');
  const engram = region('node "$BRAIN_SCRIPTS/memory/cli.mjs" setup', '# Hydration and indexing');
  const setup = required(`if true; then\n${engram}`, `BRAIN_SCRIPTS=${JSON.stringify(scripts)}`, dir);
  assert.match(setup, /REQ=.*engram memory setup/i, setup);

  // pull and index run through the helpers; the preflight is stubbed so the CAUSE under test is the PM's.
  const pm = failing(dir);
  const setupEnv = `WORKTREE_ROOT=${JSON.stringify(dir)}; PM=${JSON.stringify(pm)}; memory_pull_unavailable() { return 1; }`;
  const out = required('run_memory_pull\nrun_memory_index', setupEnv, dir);
  assert.match(out, /REQ=.*memory pull/i, out);
  assert.match(out, /REQ=.*memory index/i, out);
}));

test('#1127 bootstrap: a failing plainfiles setup and pull are REQUIRED failures', () => inTmp((dir) => {
  const scripts = scriptsWith(dir, 'memory/cli.mjs', 'process.exit(1);\n');
  const pm = failing(dir);
  const out = required(region('plainfiles)', ';;').replace(/^\s*plainfiles\)/, ''),
    `BRAIN_SCRIPTS=${JSON.stringify(scripts)}; WORKTREE_ROOT=${JSON.stringify(dir)}; PM=${JSON.stringify(pm)}; memory_pull_unavailable() { return 1; }`, dir);
  assert.match(out, /REQ=.*plainfiles memory setup/i, out);
  assert.match(out, /REQ=.*memory pull/i, out);
}));

test('#1127 bootstrap: a failing VCS login (a token was provided) is a REQUIRED failure; no token is not', () => inTmp((dir) => {
  const scripts = scriptsWith(dir, 'vcs/cli.mjs', 'process.exit(1);\n');
  const snippet = `if false; then :\n${region('elif [ -n "$VCS_TOKEN" ]', 'else')}\nelse\n  warn "$I18N_BOOTSTRAP_AUTH_NOTOKEN"\nfi`;
  const failed = required(snippet, `BRAIN_SCRIPTS=${JSON.stringify(scripts)}; VCS_HOST=h; VCS_TOKEN=tok`, dir);
  assert.match(failed, /REQ=.*login/i, failed);
  const noToken = required(snippet, `BRAIN_SCRIPTS=${JSON.stringify(scripts)}; VCS_HOST=h; VCS_TOKEN=`, dir);
  assert.match(noToken, /REQ=\n?$/m, 'an operator who skipped the token is not a failed step');
}));

test('#1127 bootstrap: an unwritable VCS-provider override is a REQUIRED failure, not a swallowed catch', () => inTmp((dir) => {
  writeFileSync(join(dir, 'brain.config.json'), '{ this is not json');
  const out = required(region('VCS_PROVIDER_OVERRIDE="$_override" node', 'fi'), '_override=github', dir);
  assert.match(out, /REQ=.*provider override/i, out);
}));

test('#1127 bootstrap: the open-ticket board failing stays optional (read-only listing, loses no state)', () => inTmp((dir) => {
  const scripts = scriptsWith(dir, 'tracker-board.mjs', 'process.exit(1);\n');
  const out = required(region('node "$BRAIN_SCRIPTS/tracker-board.mjs"', '# --- 9.'), `BRAIN_SCRIPTS=${JSON.stringify(scripts)}; VCS_HOST=h; PROJECT_PATH=p`, dir);
  assert.match(out, /REQ=\n?$/m, out);
}));

// ── #1127 round 3: classify by CAUSE ─────────────────────────────────────────

function repoWith(dir, { commit = true, upstream = false } = {}) {
  const env = { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' };
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8', env });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  if (commit) { writeFileSync(join(dir, 'f'), 'x'); g('add', 'f'); g('commit', '-qm', 'c'); }
  if (upstream) {
    const bare = join(dir, '..', `${dir.split('/').pop()}-origin.git`);
    g('init', '-q', '--bare', '-b', 'main', bare);
    g('remote', 'add', 'origin', bare);
    g('push', '-q', '-u', 'origin', 'main');
  }
}

const verdict = (dir) => required(
  'if r="$(memory_pull_unavailable "$WORKTREE_ROOT")"; then echo "UNAVAILABLE: $r"; else echo "ATTEMPT"; fi',
  `WORKTREE_ROOT=${JSON.stringify(dir)}`, dir);

test('#1127 preflight: no commits, no upstream -> unavailable (a healthy state); a real upstream -> attempt', () => {
  const noCommits = mkdtempSync(join(tmpdir(), 'brain-1127-pre-a-'));
  const noUpstream = mkdtempSync(join(tmpdir(), 'brain-1127-pre-b-'));
  const ready = mkdtempSync(join(tmpdir(), 'brain-1127-pre-c-'));
  try {
    repoWith(noCommits, { commit: false });
    repoWith(noUpstream);
    repoWith(ready, { upstream: true });
    assert.match(verdict(noCommits), /UNAVAILABLE: .*no commits/);
    assert.match(verdict(noUpstream), /UNAVAILABLE: .*no upstream/);
    assert.match(verdict(ready), /ATTEMPT/);
  } finally { [noCommits, noUpstream, ready].forEach(removeTempTree); }
});

test('#1127 pull classifier: connectivity words are offline, a real refusal is not (the one place that reads git\'s words)', () => inTmp((dir) => {
  const offline = [
    "fatal: unable to access 'https://x/y.git/': Could not resolve host: x",
    'ssh: Could not resolve hostname github.com: Temporary failure in name resolution',
    'fatal: unable to access: Failed to connect to x port 443: Connection refused',
    'ssh: connect to host x port 22: Network is unreachable',
  ];
  const refusals = [
    'error: Your local changes to the following files would be overwritten by merge:\n\tnotes.txt',
    'fatal: Not possible to fast-forward, aborting.',
    'brain:memory:pull: reconciled record(s) that could not be put back: .memory/records/2026-09-x.jsonl — tracked as a different blob',
    'CONFLICT (content): Merge conflict in notes.txt',
  ];
  const probe = (text) => required(`if memory_pull_offline ${JSON.stringify(text)}; then echo OFFLINE; else echo REFUSAL; fi`, '', dir);
  for (const t of offline) assert.match(probe(t), /OFFLINE/, t);
  for (const t of refusals) assert.match(probe(t), /REFUSAL/, t);
}));

test('#1127 pull: an offline failure is OPTIONAL with the next step; a real failure is REQUIRED', () => inTmp((dir) => {
  const shim = (body) => { const p = join(dir, 'pm.sh'); writeFileSync(p, `#!/bin/sh\n${body}\n`); chmodSync(p, 0o755); return p; };
  const base = (pm) => `WORKTREE_ROOT=${JSON.stringify(dir)}; PM=${JSON.stringify(pm)}; memory_pull_unavailable() { return 1; }`;
  const offline = required('run_memory_pull\nprintf "OPT=%s\\n" "${MISSING_OPTIONAL[*]}"', base(shim("echo 'fatal: unable to access x: Could not resolve host: x' >&2; exit 1")), dir);
  assert.match(offline, /REQ=\n/, offline);
  assert.match(offline, /OPT=.*npm run brain:memory:pull/, offline);
  const real = required('run_memory_pull', base(shim("echo 'CONFLICT (content): Merge conflict in a' >&2; exit 1")), dir);
  assert.match(real, /REQ=.*memory pull failed/, real);
}));

test('#1127 pull: a skipped pull (nothing to pull from) is OPTIONAL and prints its next step', () => inTmp((dir) => {
  const out = required('run_memory_pull\nprintf "OPT=%s\\n" "${MISSING_OPTIONAL[*]}"', `WORKTREE_ROOT=${JSON.stringify(dir)}; PM=false; memory_pull_unavailable() { printf "no upstream"; return 0; }`, dir);
  assert.match(out, /REQ=\n/, out);
  assert.match(out, /npm run brain:memory:pull/, out);
}));

test('#1127 bootstrap: an unparseable brain.config.json is a REQUIRED failure; another ensure failure stays optional', () => inTmp((dir) => {
  const scripts = scriptsWith(dir, 'lib/brain-config.mjs', 'process.exit(1);\n');
  const snippet = region('node "$BRAIN_SCRIPTS/lib/brain-config.mjs" ensure', '# Scaffold brain/HOME.md');
  writeFileSync(join(dir, 'brain.config.json'), '{ not json');
  const corrupt = required(`${snippet}\nprintf "OPT=%s\\n" "\${MISSING_OPTIONAL[*]}"`, `BRAIN_SCRIPTS=${JSON.stringify(scripts)}`, dir);
  assert.match(corrupt, /REQ=.*brain\.config\.json cannot be parsed/, corrupt);
  writeFileSync(join(dir, 'brain.config.json'), '{}');
  const other = required(`${snippet}\nprintf "OPT=%s\\n" "\${MISSING_OPTIONAL[*]}"`, `BRAIN_SCRIPTS=${JSON.stringify(scripts)}`, dir);
  assert.match(other, /REQ=\n/, other);
  assert.match(other, /OPT=.*brain\.config\.json ensure/, other);
}));

test('#1127 bootstrap: no message printed for a REQUIRED failure calls itself non-blocking', async () => {
  const { default: en } = await import('./i18n/en.mjs');
  const { keyToVar } = await import('./i18n/sh.mjs');
  const byVar = new Map(Object.entries(en).map(([k, v]) => [keyToVar(k), v]));
  const vars = new Set();
  LINES.forEach((l, i) => {
    if (!l.includes('REQUIRED_FAILURES+=')) return;
    for (const m of `${LINES[i - 1] ?? ''}\n${l}`.matchAll(/\$I18N_([A-Z0-9_]+)/g)) vars.add(`I18N_${m[1]}`);
  });
  assert.ok(vars.size >= 8, `expected the required steps' message keys, found ${[...vars]}`);
  for (const v of vars) {
    assert.ok(byVar.has(v), `no en catalog entry for ${v}`);
    assert.doesNotMatch(byVar.get(v), /non-blocking/i, `${v} prints for a REQUIRED failure but says non-blocking: ${byVar.get(v)}`);
  }
});
