// brain-ship.fresh-consumer.e2e.test.mjs — the path phase 1 must prove, run for real (#1186, #1187).
//
// The 1.10.0 exit demonstration (#1185) found `brain:ship` unusable on a fresh consumer's first
// PR: issue-link asked the port about `repos/undefined/issues/1`, the local checks were UNVERIFIED
// until an undocumented `git remote set-head`, `npm test` failed on the `npm init` placeholder and
// `memoryPresence` demanded a session summary no first PR has — while the same PR, opened by hand,
// passed all 11 CI checks. Every unit test of those pieces was green.
//
// This runs the REAL `brain:ship` (and through it the real `brain:check`) in the hermetic box the
// bootstrap e2e uses (`lib/hermetic-box.mjs`), against a fresh-consumer fixture: a `lite` config
// with a slug, no memory records, `origin/HEAD` UNSET, a package.json carrying the `npm init`
// placeholder test script, and a branch named the way `ticket:start` names it. The only fake is
// `gh`, and it is the PORT's side: it answers like the remote and records every call, so the
// assertion is that `mrCreate` actually reached it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, chmodSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { testTmp } from './lib/test-tmp.mjs';
import { ensureHome } from './lib/home-scaffold.mjs';
import { git, installBrain, hermeticEnv } from './lib/hermetic-box.mjs';

const SLUG = 'acme/widgets';
const BRANCH = 'chore/issue-1-enable-the-memory-lane';

// A fake `gh` that answers as the remote would and records every argv. Anything it does not
// know exits 1 loudly, so a call the port should not make cannot pass silently.
const FAKE_GH = `#!/usr/bin/env node
const fs = require('node:fs');
const argv = process.argv.slice(2);
fs.appendFileSync(process.env.GH_LOG, JSON.stringify(argv) + '\\n');
const line = argv.join(' ');
const out = (v) => { process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v)); process.exit(0); };
const notFound = () => { process.stderr.write('gh: Not Found (HTTP 404)\\n'); process.exit(1); };
if (argv[0] === 'api' && argv[1] === 'repos/${SLUG}/issues/1') {
  out({ number: 1, title: 'enable the memory lane', body: '', user: { login: 'maintainer' }, state: 'open',
        labels: [{ name: 'status:approved' }, { name: 'type:chore' }] });
}
if (argv[0] === 'api' && argv[argv.length - 1].startsWith('repos/${SLUG}/labels')) {
  out([{ name: 'status:approved' }, { name: 'type:chore' }]);
}
if (argv[0] === 'api' && argv[argv.length - 1].startsWith('repos/')) notFound();
if (argv[0] === 'pr' && argv[1] === 'create') out('https://github.com/${SLUG}/pull/2\\n');
process.stderr.write('fake gh: unexpected call: ' + line + '\\n');
process.exit(1);
`;

function freshConsumer({ tier = 'lite', push = true } = {}) {
  const root = testTmp('ship-e2e-');
  const repo = join(root, 'repo');
  const origin = join(root, 'origin.git');
  const bin = join(root, 'fakebin');
  mkdirSync(repo);
  mkdirSync(bin);

  writeFileSync(join(bin, 'gh'), FAKE_GH);
  chmodSync(join(bin, 'gh'), 0o755);

  git(root, 'init', '-q', '--bare', '-b', 'main', origin);
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'config', 'user.email', 't@example.com');
  git(repo, 'config', 'user.name', 't');
  // A consumer's tree, not brain's own: the managed copy (tests included, which brain:nav's cited-path
  // check needs) without `brain/project/**`, and the HOME.md `brain init` scaffolds.
  installBrain(repo, { keepTests: true });
  rmSync(join(repo, 'brain', 'project'), { recursive: true, force: true });
  rmSync(join(repo, 'brain', 'HOME.md'));
  ensureHome(repo); // the real scaffold `env:init` writes, from the COPY's own template
  // What `npm init -y` leaves behind, plus the two verbs under test.
  writeFileSync(join(repo, 'package.json'), JSON.stringify({
    name: 'brain-test-fresh',
    version: '1.0.0',
    scripts: {
      test: 'echo "Error: no test specified" && exit 1',
      'brain:check': 'node ./brain/scripts/brain-check.mjs',
      'brain:ship': 'node ./brain/scripts/brain-ship.mjs',
    },
  }, null, 2));
  writeFileSync(join(repo, 'brain.config.json'), JSON.stringify({
    project: { slug: SLUG },
    vcs: { provider: 'github' },
    governance: { tier },
    memory: { backend: 'plainfiles' },
  }, null, 2));
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'chore: seed');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', '-u', 'origin', 'main');

  git(repo, 'checkout', '-q', '-b', BRANCH);
  writeFileSync(join(repo, 'notes.txt'), 'first change\n');
  git(repo, 'add', 'notes.txt');
  git(repo, 'commit', '-qm', 'chore(memory): enable the memory lane\n\nCloses #1');
  // brain:ship never pushes (#1207): the operator's push is what puts the head on the remote.
  if (push) git(repo, 'push', '-q', '-u', 'origin', BRANCH);
  return { root, repo, bin, log: join(root, 'gh.log') };
}

function run(cmd, args, { root, repo, bin, log }) {
  const r = spawnSync(cmd, args, {
    cwd: repo,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120000,
    env: hermeticEnv(root, { bin, env: { GH_LOG: log } }),
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const calls = (log) => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

test('#1186 #1187 e2e (f): a fresh consumer at lite ships its first PR — the local gates pass and mrCreate reaches the port', () => {
  const box = freshConsumer();
  assert.equal(git(box.repo, 'for-each-ref', 'refs/remotes/origin/HEAD'), '',
    'precondition: origin/HEAD is unset — the state that made brain:check UNVERIFIED');

  const r = run('npm', ['run', 'brain:ship'], box);
  assert.equal(r.code, 0, `brain:ship must open the first PR:\n${r.out.slice(-2500)}`);
  assert.match(r.out, /brain:ship: PR opened → https:\/\/github\.com\/acme\/widgets\/pull\/2/);

  // #1187 — stated, not failed, and not silent.
  assert.match(r.out, /\[N\/A\] npmTest/, r.out);
  assert.match(r.out, /\[PASS\] memoryPresence — ::warning::memory-gate.*\(tier: lite\)/, r.out);
  // #1186 — resolved, not UNVERIFIED, and not `repos/undefined`.
  assert.match(r.out, /\[PASS\] issueLink/, r.out);
  assert.doesNotMatch(r.out, /UNVERIFIED/, r.out);

  const made = calls(box.log);
  assert.ok(!made.some((a) => a.join(' ').includes('undefined')), `the port was asked about an unset field: ${JSON.stringify(made)}`);
  const create = made.find((a) => a[0] === 'pr' && a[1] === 'create');
  assert.ok(create, `mrCreate never reached the port: ${JSON.stringify(made)}`);
  assert.deepEqual([create[create.indexOf('--head') + 1], create[create.indexOf('--base') + 1], create[create.indexOf('--label') + 1]],
    [BRANCH, 'main', 'type:chore']);

  // The verbs report; they do not repair the operator's repo behind their back.
  assert.equal(git(box.repo, 'for-each-ref', 'refs/remotes/origin/HEAD'), '', 'origin/HEAD must stay unset: no set-head was run');
});

test('#1187 e2e: the same fresh consumer at `standard` is still refused by memory-gate — the tier decides, not the verb', () => {
  const box = freshConsumer({ tier: 'standard' });
  const r = run('npm', ['run', 'brain:ship'], box);
  assert.equal(r.code, 1, r.out.slice(-2000));
  assert.match(r.out, /\[FAIL\] memoryPresence/, r.out);
  assert.ok(!calls(box.log).some((a) => a[0] === 'pr'), 'a red tree makes zero mrCreate calls');
});

test('#1207 e2e: an unpushed branch is refused with the push to run, and mrCreate is never reached', () => {
  const box = freshConsumer({ push: false });
  const r = run('npm', ['run', 'brain:ship'], box);
  assert.equal(r.code, 1, r.out.slice(-2000));
  assert.match(r.out, new RegExp(`git push -u origin ${BRANCH}`), r.out);
  assert.doesNotMatch(r.out, /GraphQL|createPullRequest/, r.out);
  assert.ok(!calls(box.log).some((a) => a[0] === 'pr'), 'zero PR-creation calls');
  assert.equal(git(box.repo, 'ls-remote', 'origin', `refs/heads/${BRANCH}`), '', 'ship must not push');
});
