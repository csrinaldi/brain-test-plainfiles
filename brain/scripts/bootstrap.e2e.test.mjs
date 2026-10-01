// bootstrap.e2e.test.mjs — the REAL bootstrap.sh, run non-interactively, in a hermetic box (#1127).
//
// The coverage gap this closes: slice A made `memory pull` and `memory index` REQUIRED failures
// and every test around it lifted a snippet, so nothing ran the whole script in a HEALTHY
// environment. It would have exited 1 for a fresh install with the default engram backend and
// no engram binary, for plainfiles with no origin or no upstream, for a repo with no commits and
// for a new worktree branch. Those are usable environments; the failure must be by CAUSE.
//
// Hermetic: `stdin </dev/null`, a HOME and XDG_RUNTIME_DIR under the run's temp root,
// DBUS_SESSION_BUS_ADDRESS empty, and a PATH made ONLY of a curated shim dir — every host
// binary EXCEPT gh, glab, engram, gentle-ai, codex, gga, claude and grep (grep is a python3
// shim, so nothing depends on the host having one). The brain tree under test is COPIED into
// the fixture: `memory/cli.mjs` resolves its repo root from its own module location, so a
// symlink would make it pull in the developer's real checkout.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { testTmp } from './lib/test-tmp.mjs';
import { shimBin, git, installBrain, hermeticEnv } from './lib/hermetic-box.mjs';

/** A fixture repo carrying a COPY of the brain under test. */
function fixture(name, { commit = true } = {}) {
  const root = testTmp(`bootstrap-e2e-${name}-`);
  const repo = join(root, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  installBrain(repo);
  if (commit) {
    writeFileSync(join(repo, 'notes.txt'), 'a\n');
    git(repo, 'add', 'notes.txt');
    git(repo, 'commit', '-qm', 'seed');
  }
  return { root, repo };
}

/** Runs the real bootstrap.sh from `cwd`. */
function bootstrap(cwd, root, { bin, env = {} } = {}) {
  const r = spawnSync('bash', ['brain/scripts/bootstrap.sh'], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    env: hermeticEnv(root, { bin, env }),
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const useBackend = (repo, backend) => writeFileSync(join(repo, '.env'), `MEMORY_BACKEND=${backend}\n`);

function assertHealthy(r, nextStep) {
  assert.equal(r.code, 0, `a usable environment must exit 0:\n${r.out.slice(-1500)}`);
  assert.match(r.out, nextStep, `the optional next step must be printed:\n${r.out.slice(-1500)}`);
  assert.doesNotMatch(r.out, /did NOT complete successfully/, r.out.slice(-800));
}

test('#1127 e2e (a): fresh repo, no commits, no origin, engram declared, no engram binary -> exit 0 with the next step', () => {
  const { root, repo } = fixture('a', { commit: false });
  useBackend(repo, 'engram'); // #1165: engram is no longer a silent default — it must be declared
  const r = bootstrap(repo, root);
  assertHealthy(r, /brain:memory:pull/);
  assert.match(r.out, /brain:memory:index/);
});

test('#1127 e2e (b): plainfiles with no origin -> exit 0 with the next step', () => {
  const { root, repo } = fixture('b');
  useBackend(repo, 'plainfiles');
  assertHealthy(bootstrap(repo, root), /npm run brain:memory:pull/);
});

test('#1127 e2e (c): plainfiles with an origin but no upstream branch -> exit 0 with the next step', () => {
  const { root, repo } = fixture('c');
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  useBackend(repo, 'plainfiles');
  assertHealthy(bootstrap(repo, root), /npm run brain:memory:pull/);
});

test('#1127 e2e (d): a new worktree branch with no upstream -> exit 0 with the next step', () => {
  const { root, repo } = fixture('d');
  useBackend(repo, 'plainfiles');
  const wt = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'feature/x');
  installBrain(wt);
  assertHealthy(bootstrap(wt, root), /npm run brain:memory:pull/);
});

test('#1127 e2e (e): plainfiles with a REAL merge refusal is a required failure -> exit 1, said as such', () => {
  const { root, repo } = fixture('e');
  const origin = join(root, 'origin.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  // Someone else changes notes.txt upstream; the local checkout has an uncommitted edit to it.
  const other = join(root, 'other');
  git(root, 'clone', '-q', origin, other);
  git(other, 'config', 'user.email', 'o@example.com');
  git(other, 'config', 'user.name', 'o');
  writeFileSync(join(other, 'notes.txt'), 'b\n');
  git(other, 'commit', '-qam', 'upstream change');
  git(other, 'push', '-q', 'origin', 'main');
  writeFileSync(join(repo, 'notes.txt'), 'c\n');
  useBackend(repo, 'plainfiles');
  const r = bootstrap(repo, root);
  assert.equal(r.code, 1, r.out.slice(-1500));
  assert.match(r.out, /memory pull failed/);
  assert.match(r.out, /did NOT complete successfully/);
  assert.doesNotMatch(r.out, /pull failed[^\n]*non-blocking/i, 'a required failure must not call itself non-blocking');
});

// ── #1165: the team's backend is tracked config; nothing is guessed ─────────────────────────────

const declare = (repo, backend) => writeFileSync(join(repo, 'brain.config.json'), JSON.stringify({ memory: { backend } }));
const envText = (repo) => (existsSync(join(repo, '.env')) ? readFileSync(join(repo, '.env'), 'utf8') : '');

test('#1165 e2e: a FRESH checkout with no .env runs the backend the tracked config declares, and writes no .env line', () => {
  const { root, repo } = fixture('decl-config');
  declare(repo, 'plainfiles');
  const r = bootstrap(repo, root);
  assertHealthy(r, /npm run brain:memory:pull/);
  assert.match(r.out, /memory backend: plainfiles \(brain\.config\.json\)/, r.out.slice(-1500));
  assert.doesNotMatch(envText(repo), /MEMORY_BACKEND/, 'env:init must not re-create the per-machine drift');
  assert.equal(existsSync(join(repo, '.engram')), false, 'the engram setup must not have run');
});

test('#1165 e2e: nothing declared and no TTY -> nothing is guessed: no engram setup, no .env line, the fix is named', () => {
  const { root, repo } = fixture('decl-none');
  const r = bootstrap(repo, root);
  assert.equal(r.code, 0, r.out.slice(-1500));
  assert.match(r.out, /no memory backend is declared/, r.out.slice(-1500));
  assert.match(r.out, /brain:config -- set memory\.backend/);
  assert.doesNotMatch(envText(repo), /MEMORY_BACKEND/);
  assert.equal(existsSync(join(repo, '.engram')), false, 'engram must not have been guessed');
  assert.doesNotMatch(r.out, /memory backend: engram/);
});

test('#1165 e2e: an existing consumer with only .env keeps working unchanged, and is told the value is invisible to teammates', () => {
  const { root, repo } = fixture('decl-envonly');
  useBackend(repo, 'plainfiles');
  const r = bootstrap(repo, root);
  assertHealthy(r, /npm run brain:memory:pull/);
  assert.match(r.out, /memory backend: plainfiles \(\.env\)/);
  assert.match(r.out, /brain:config -- set memory\.backend plainfiles/, 'the move-to-team-config one-liner is printed');
  const cfg = JSON.parse(readFileSync(join(repo, 'brain.config.json'), 'utf8'));
  assert.ok(!cfg.memory?.backend, 'never migrated silently: a tracked-file edit is the operator\'s to make');
});

test('#1165 e2e: .env overriding a different team value is reported', () => {
  const { root, repo } = fixture('decl-shadow');
  declare(repo, 'engram');
  useBackend(repo, 'plainfiles');
  const r = bootstrap(repo, root);
  assert.equal(r.code, 0, r.out.slice(-1500));
  assert.match(r.out, /overrides brain\.config\.json memory\.backend \(engram\)/, r.out.slice(-1500));
});

test('#1165 e2e: the write env:init performs on a TTY (`config set memory.backend`) lands in tracked config and the resolver reads it', () => {
  const { root, repo } = fixture('decl-write');
  const env = { PATH: shimBin(), HOME: join(root, 'home') };
  writeFileSync(join(repo, 'brain.config.json'), JSON.stringify({ schemaVersion: '1.9.0' }));
  const set = spawnSync('node', ['brain/scripts/config/cli.mjs', 'set', 'memory.backend', 'plainfiles'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(set.status, 0, set.stderr);
  const res = spawnSync('node', ['brain/scripts/memory/lib/backend-resolve.mjs', '--root', '.'], { cwd: repo, encoding: 'utf8', env });
  assert.equal(res.stdout, 'plainfiles config\n');
  assert.doesNotMatch(envText(repo), /MEMORY_BACKEND/);
});

test('#1165 cold-5 e2e: an unreadable brain.config.json is reported as unreadable, never as "no memory backend is declared"', () => {
  const { root, repo } = fixture('decl-badconfig');
  writeFileSync(join(repo, 'brain.config.json'), '{ not json');
  const r = bootstrap(repo, root);
  assert.match(r.out, /could not read brain\.config\.json/, r.out.slice(-1500));
  assert.doesNotMatch(r.out, /no memory backend is declared/);
});

// ── #1163 / #1164 / #1166: labels, actor and the lane notice, through the real script ──
// A fake `gh` (a node script, ahead of the curated PATH) answers ONLY what the port asks and
// records every call, so no test can reach the real GitHub API.

const FAKE_GH = `#!/usr/bin/env node
const fs = require('fs');
const a = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, a.join(' ') + '\\n');
const st = JSON.parse(fs.readFileSync(process.env.GH_STATE, 'utf8'));
if (a[0] === 'auth') process.exit(0);
if (a.includes('/user')) { console.log(JSON.stringify({ login: 'octo' })); process.exit(0); }
if (a.some((x) => x.includes('/labels?'))) { console.log(JSON.stringify(st.labels.map((name) => ({ name })))); process.exit(0); }
if (a.includes('POST') && a.some((x) => x.endsWith('/labels'))) {
  const b = JSON.parse(fs.readFileSync(0, 'utf8'));
  st.labels.push(b.name);
  fs.writeFileSync(process.env.GH_STATE, JSON.stringify(st));
  console.log('{}');
  process.exit(0);
}
process.exit(1);
`;

function withFakeGh(root, repo) {
  const bin = join(root, 'ghbin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);
  const state = join(root, 'gh-state.json');
  const log = join(root, 'gh.log');
  writeFileSync(state, JSON.stringify({ labels: [] }));
  writeFileSync(log, '');
  writeFileSync(join(repo, 'brain.config.json'), JSON.stringify({ vcs: { provider: 'github' }, project: { gitHost: 'github.com', slug: 'acme/widget' } }));
  return { bin, env: { GH_LOG: log, GH_STATE: state }, posts: () => readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('POST')).length };
}

test('#1163 #1164 #1166 e2e: an authenticated VCS gets the labels created, brain.actor set locally, and the lane stated; a re-run changes nothing', () => {
  const { root, repo } = fixture('labels');
  useBackend(repo, 'plainfiles');
  const gh = withFakeGh(root, repo);
  const first = bootstrap(repo, root, gh);
  assert.equal(first.code, 0, first.out.slice(-1500));
  assert.match(first.out, /governance labels created:.*status:approved/);
  assert.match(first.out, /brain\.actor: @octo/);
  assert.equal(git(repo, 'config', '--local', '--get', 'brain.actor'), '@octo', 'written to the LOCAL git config');
  assert.match(first.out, /memory lane: off/);
  assert.match(first.out, /npm run brain:config -- set memory\.lane\.enabled true/);
  const posts = gh.posts();
  assert.ok(posts >= 8, `labels were created through the port (${posts} POSTs)`);
  const second = bootstrap(repo, root, gh);
  assert.equal(second.code, 0, second.out.slice(-1500));
  assert.equal(gh.posts(), posts, 'idempotent: the second run makes no create call');
  assert.match(second.out, /governance labels: all \d+ already exist/);
  assert.match(second.out, /brain\.actor: @octo \(already configured/);
});

test('#1163 #1164 e2e: an unreachable VCS is two pending steps with their exact commands, exit 0 — never a crash, never a guess from user.name', () => {
  const { root, repo } = fixture('labels-pending');
  useBackend(repo, 'plainfiles');
  writeFileSync(join(repo, 'brain.config.json'), JSON.stringify({ vcs: { provider: 'github' }, project: { gitHost: 'github.com', slug: 'acme/widget' } }));
  const r = bootstrap(repo, root);
  assert.equal(r.code, 0, `optional steps must not fail env:init:\n${r.out.slice(-1500)}`);
  assert.match(r.out, /governance labels \(next: npm run brain:env:init[^)]*gh label create "status:approved"/);
  assert.match(r.out, /brain\.actor \(next: git config --local brain\.actor @<handle>\)/);
  assert.notEqual(spawnSync('git', ['config', '--local', '--get', 'brain.actor'], { cwd: repo, env: { PATH: shimBin(), HOME: root } }).status, 0, 'nothing was written');
});

test('#1163 e2e: a CRASH of the setup step is a REQUIRED failure naming the step (exit 1), never a pending entry', () => {
  const { root, repo } = fixture('labels-crash');
  useBackend(repo, 'plainfiles');
  writeFileSync(join(repo, 'brain', 'scripts', 'lib', 'env-init-setup.mjs'), "throw new Error('boom');\n");
  const r = bootstrap(repo, root);
  assert.equal(r.code, 1, r.out.slice(-1500));
  assert.match(r.out, /env-init-setup labels failed \(exit 1\)/);
  assert.match(r.out, /did NOT complete successfully/);
});

test('#1163 e2e: exit 3 WITHOUT a NEXT: line is a required failure, not an empty pending entry', () => {
  const { root, repo } = fixture('labels-nonext');
  useBackend(repo, 'plainfiles');
  writeFileSync(join(repo, 'brain', 'scripts', 'lib', 'env-init-setup.mjs'), 'process.exitCode = 3;\n');
  const r = bootstrap(repo, root);
  assert.equal(r.code, 1, r.out.slice(-1500));
  assert.match(r.out, /pending without a next step/);
});

test('#1163 e2e: from a linked worktree the label step reads the DATA root (main tree) config, not the worktree copy', () => {
  const { root, repo } = fixture('labels-worktree');
  useBackend(repo, 'plainfiles');
  const gh = withFakeGh(root, repo); // main tree config: acme/widget
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'config');
  const wt = join(root, 'wt');
  git(repo, 'worktree', 'add', '-q', wt, '-b', 'feature/x');
  installBrain(wt);
  writeFileSync(join(wt, 'brain.config.json'), JSON.stringify({ vcs: { provider: 'github' }, project: { gitHost: 'github.com', slug: 'other/wrong' } }));
  const r = bootstrap(wt, root, gh);
  assert.equal(r.code, 0, r.out.slice(-1500));
  const log = readFileSync(gh.env.GH_LOG, 'utf8');
  assert.match(log, /repos\/acme\/widget\/labels/, 'the main tree owns brain.config.json');
  assert.doesNotMatch(log, /other\/wrong/, 'the worktree copy must not pick the project');
});

test('#1163 cold-4: an unparseable brain.config.json is reported ONCE, as itself — not again as a defect of the setup steps', () => {
  const { root, repo } = fixture('labels-badconfig');
  useBackend(repo, 'plainfiles');
  writeFileSync(join(repo, 'brain.config.json'), '{ not json');
  const r = bootstrap(repo, root);
  assert.equal(r.code, 1, r.out.slice(-1500));
  assert.match(r.out, /brain\.config\.json cannot be parsed/);
  assert.doesNotMatch(r.out, /env-init-setup (labels|actor) failed/);
});
