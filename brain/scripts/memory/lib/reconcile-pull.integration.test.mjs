// reconcile-pull.integration.test.mjs — issue #1118, real git, no mocks of git.
//
// The contract: a byte-identical untracked `.memory/records/*.jsonl` whose blob
// is reachable from `@{u}` is deleted before `git pull` (so git can write its
// tracked copy) and, if the pull does not verifiably recreate it, rewritten
// from git's own object store. Nothing is stored outside the working tree and
// the object store.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { testTmp } from '../../lib/test-tmp.mjs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import {
  buildDivergedPullFixture, buildPullFixture, git, withIsolatedGitEnv,
  FIXTURE_RECORD, RECORD_PATH, RECORD_CONTENT,
} from '../../__fixtures__/pull-fixture.mjs';
import { defaultGitPull, reconcileUntrackedRecords } from './reconcile-pull.mjs';

// The production `git pull` inherits this process's env. Run the whole file
// against no host/global git config, so a developer's ~/.gitconfig can never
// make a scenario pass or fail (CI has none). Each test that needs identity or
// a merge strategy sets it in the fixture repo's own config.
process.env.GIT_CONFIG_GLOBAL = '/dev/null';
process.env.GIT_CONFIG_NOSYSTEM = '1';

const quiet = () => {};
const tracked = (dir) => git(dir, 'ls-files', '--', RECORD_PATH).trim();
const onDisk = (dir) => readFileSync(join(dir, RECORD_PATH), 'utf8');

test('(a) the #1081 F10 scenario: pull reconciles the byte-identical record and it ends tracked', (t) => {
  const { capturingDir } = buildPullFixture(t);
  const logs = [];
  defaultGitPull(capturingDir, { _log: (l) => logs.push(l) });
  assert.equal(tracked(capturingDir), RECORD_PATH);
  assert.equal(onDisk(capturingDir), RECORD_CONTENT);
  assert.equal(logs.length, 1, 'one log line per reconciled path');
  assert.match(logs[0], new RegExp(RECORD_PATH.replace(/[.]/g, '\\.')));
  assert.match(logs[0], /verified/i);
});

test('(b) no upstream: nothing is deleted and git pull runs as before', (t) => {
  const { capturingDir } = buildPullFixture(t);
  git(capturingDir, 'branch', '--unset-upstream');
  assert.throws(() => defaultGitPull(capturingDir, { _log: quiet }), /git pull|Command failed/i);
  assert.equal(onDisk(capturingDir), RECORD_CONTENT, 'file untouched');
  assert.equal(tracked(capturingDir), '', 'still untracked');
});

test('(c) @{u} lacks the path: that file is never deleted', (t) => {
  const { capturingDir } = buildPullFixture(t);
  const other = '.memory/records/2026-09-rec-00000000000000aa.jsonl';
  writeFileSync(join(capturingDir, other), 'not upstream\n', 'utf8');
  defaultGitPull(capturingDir, { _log: quiet });
  assert.equal(readFileSync(join(capturingDir, other), 'utf8'), 'not upstream\n');
  assert.equal(tracked(capturingDir), RECORD_PATH);
});

test('(d) different bytes: refused before pulling, naming the file, nothing touched', (t) => {
  const tampered = JSON.stringify({ ...FIXTURE_RECORD, content: 'a DIFFERENT body' }) + '\n';
  const { capturingDir } = buildPullFixture(t, { shipperContent: tampered });
  const headBefore = git(capturingDir, 'rev-parse', 'HEAD');
  assert.throws(
    () => defaultGitPull(capturingDir, { _log: quiet }),
    (err) => { assert.ok(err.message.includes(RECORD_PATH), err.message); return true; },
  );
  assert.equal(onDisk(capturingDir), RECORD_CONTENT);
  assert.equal(git(capturingDir, 'rev-parse', 'HEAD'), headBefore, 'the pull never ran');
});

test('(e1) diverged + pull.ff=only: the pull fails and the file is back byte-identical', (t) => {
  const { capturingDir } = buildDivergedPullFixture(t);
  git(capturingDir, 'config', 'pull.ff', 'only');
  const logs = [];
  assert.throws(() => defaultGitPull(capturingDir, { _log: (l) => logs.push(l) }), /git pull|Command failed/i);
  assert.equal(onDisk(capturingDir), RECORD_CONTENT);
  assert.ok(logs.some((l) => /restored/i.test(l)), `a restore must be reported, got ${JSON.stringify(logs)}`);
});

test('(e2) diverged + stock config: the pull fails and the file is back byte-identical', async (t) => {
  const { capturingDir } = buildDivergedPullFixture(t);
  await withIsolatedGitEnv(() => {
    assert.throws(() => defaultGitPull(capturingDir, { _log: quiet }), /git pull|Command failed/i);
  });
  assert.equal(onDisk(capturingDir), RECORD_CONTENT);
});

test('(f) race: path removed upstream between fetch and pull — restored from the blob and reported', (t) => {
  const { capturingDir, originDir, base } = buildRace(t);
  const logs = [];
  assert.throws(
    () => defaultGitPull(capturingDir, {
      _log: (l) => logs.push(l),
      _afterReconcile: () => {
        const shipper = join(base, 'shipper-b');
        git(base, 'clone', '-q', originDir, shipper);
        git(shipper, 'rm', '-q', RECORD_PATH);
        git(shipper, 'commit', '-q', '-m', 'lane: remove the fixture record');
        git(shipper, 'push', '-q', 'origin', 'main');
      },
    }),
    (err) => { assert.ok(err.message.includes(RECORD_PATH), err.message); return true; },
  );
  assert.equal(onDisk(capturingDir), RECORD_CONTENT, 'restored byte-identical from the blob');
  assert.equal(tracked(capturingDir), '', 'commit B removed it: untracked local state again');
  assert.ok(logs.some((l) => /restored/i.test(l) && l.includes(RECORD_PATH)));
});

test('(f2) restore never overwrites a file that exists with different content', (t) => {
  const { capturingDir, originDir, base } = buildRace(t);
  assert.throws(
    () => defaultGitPull(capturingDir, {
      _log: quiet,
      _afterReconcile: () => {
        const shipper = join(base, 'shipper-b');
        git(base, 'clone', '-q', originDir, shipper);
        git(shipper, 'rm', '-q', RECORD_PATH);
        git(shipper, 'commit', '-q', '-m', 'lane: remove the fixture record');
        git(shipper, 'push', '-q', 'origin', 'main');
        // A stranger writes different bytes at the path before the pull.
        mkdirSync(join(capturingDir, '.memory', 'records'), { recursive: true });
        writeFileSync(join(capturingDir, RECORD_PATH), 'someone else wrote this\n', 'utf8');
      },
    }),
    (err) => { assert.match(err.message, /different content|not overwrit/i); return true; },
  );
  assert.equal(onDisk(capturingDir), 'someone else wrote this\n');
});

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('(g) nothing is stored outside the working tree and the object store — git worktree remove is irrelevant', (t) => {
  const { capturingDir } = buildPullFixture(t);
  const linked = join(dirname(capturingDir), 'linked');
  git(capturingDir, 'fetch', '-q');
  git(capturingDir, 'branch', '-f', 'tmp-root', 'origin/main~1');
  git(capturingDir, 'worktree', 'add', '-q', '-b', 'linked-branch', linked, 'tmp-root');
  git(linked, 'branch', '--set-upstream-to=origin/main');
  mkdirSync(join(linked, '.memory', 'records'), { recursive: true });
  writeFileSync(join(linked, RECORD_PATH), RECORD_CONTENT, 'utf8');

  defaultGitPull(linked, { _log: quiet });
  assert.equal(tracked(linked), RECORD_PATH);

  const gitCommon = join(capturingDir, '.git');
  const gitFiles = walk(gitCommon).filter((p) => !p.includes(`${join(gitCommon, 'objects')}/`));
  assert.deepEqual(gitFiles.filter((p) => /reconcile|aside/i.test(p)), [], 'no aside directory under the git dir');
  for (const p of gitFiles) {
    assert.ok(!readFileSync(p).includes(FIXTURE_RECORD.content), `plaintext copy of the record found in ${p}`);
  }

  git(capturingDir, 'worktree', 'remove', '--force', linked);
  git(capturingDir, 'cat-file', '-e', `origin/main:${RECORD_PATH}`); // still durable
  assert.ok(!existsSync(linked));
});

// A capturing clone whose origin/main already carries the record (commit A),
// plus the base dir so a test can land a second upstream change (commit B).
//   files: {path: Buffer|string} shipped upstream AND written locally;
//   local: overrides the local bytes per path; ship(dir): overrides how commit
//   A writes upstream; seed: extra tracked files in the root commit.
function buildRace(t, { files = { [RECORD_PATH]: RECORD_CONTENT }, local = {}, ship, seed = {} } = {}) {
  const base = testTmp('brain-pull-race-1118-');
  t.after(() => removeTempTree(base));
  const originDir = join(base, 'origin.git');
  const seedDir = join(base, 'seed');
  const capturingDir = join(base, 'capturing');
  const put = (dir, map) => {
    for (const [p, c] of Object.entries(map)) {
      mkdirSync(dirname(join(dir, p)), { recursive: true });
      writeFileSync(join(dir, p), c);
    }
  };
  git(base, 'init', '--bare', '-q', '-b', 'main', originDir);
  git(base, 'init', '-q', '-b', 'main', seedDir);
  git(seedDir, 'remote', 'add', 'origin', originDir);
  put(seedDir, { '.memory/.gitkeep': '', ...seed });
  git(seedDir, 'add', '-A', '.');
  git(seedDir, 'commit', '-q', '-m', 'root');
  git(seedDir, 'push', '-q', '-u', 'origin', 'main');
  git(base, 'clone', '-q', originDir, capturingDir);
  put(capturingDir, { ...files, ...local });
  const a = join(base, 'shipper-a');
  git(base, 'clone', '-q', originDir, a);
  if (ship) ship(a); else put(a, files);
  git(a, 'add', '-A', '.');
  git(a, 'commit', '-q', '-m', 'lane: add the fixture record');
  git(a, 'push', '-q', 'origin', 'main');
  return { base, originDir, capturingDir };
}

// Makes the pull fail after reconciliation: pull.ff=only plus a diverging
// local commit and a diverging upstream commit.
function divergeAfterReconcile(capturingDir, base, originDir) {
  git(capturingDir, 'config', 'pull.ff', 'only');
  return () => {
    writeFileSync(join(capturingDir, 'local-only.txt'), 'local\n');
    git(capturingDir, 'add', 'local-only.txt');
    git(capturingDir, 'commit', '-q', '-m', 'local work');
    const b = join(base, 'shipper-b');
    git(base, 'clone', '-q', originDir, b);
    writeFileSync(join(b, 'upstream-only.txt'), 'up\n');
    git(b, 'add', 'upstream-only.txt');
    git(b, 'commit', '-q', '-m', 'upstream work');
    git(b, 'push', '-q', 'origin', 'main');
  };
}

test('(h) core.autocrlf=true + CRLF local copy of an LF blob: refused as divergent, bytes unchanged', (t) => {
  const crlf = RECORD_CONTENT.replace(/\n/g, '\r\n');
  const { capturingDir } = buildRace(t, { local: { [RECORD_PATH]: crlf } });
  git(capturingDir, 'config', 'core.autocrlf', 'true');
  assert.throws(() => defaultGitPull(capturingDir, { _log: quiet }), (err) => { assert.ok(err.message.includes(RECORD_PATH)); return true; });
  assert.equal(readFileSync(join(capturingDir, RECORD_PATH), 'utf8'), crlf, 'CRLF bytes untouched');
});

test('(i) invalid UTF-8 bytes survive a failed pull byte-identical', (t) => {
  const bytes = Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0xc3, 0x28, 0x22, 0x7d, 0x0a]);
  const { base, originDir, capturingDir } = buildRace(t, { files: { [RECORD_PATH]: bytes } });
  assert.throws(() => defaultGitPull(capturingDir, {
    _log: quiet, _afterReconcile: divergeAfterReconcile(capturingDir, base, originDir),
  }), /git pull|Command failed/i);
  assert.ok(readFileSync(join(capturingDir, RECORD_PATH)).equals(bytes), 'bytes identical');
});

test('(j) a merge that conflicts elsewhere: the record staged in the index is fine, not "could not be put back"', (t) => {
  const { capturingDir } = buildRace(t, {
    seed: { 'conflict.txt': 'base\n' },
    ship: (dir) => {
      mkdirSync(join(dir, '.memory', 'records'), { recursive: true });
      writeFileSync(join(dir, RECORD_PATH), RECORD_CONTENT);
      writeFileSync(join(dir, 'conflict.txt'), 'upstream side\n');
    },
  });
  // A real merge needs a committer identity and an explicit strategy; CI has neither globally.
  git(capturingDir, 'config', 'pull.rebase', 'false');
  git(capturingDir, 'config', 'user.name', 'brain-test');
  git(capturingDir, 'config', 'user.email', 'brain-test@example.invalid');
  writeFileSync(join(capturingDir, 'conflict.txt'), 'local side\n');
  git(capturingDir, 'add', 'conflict.txt');
  git(capturingDir, 'commit', '-q', '-m', 'local edit');
  const logs = [];
  assert.throws(() => defaultGitPull(capturingDir, { _log: (l) => logs.push(l) }), (err) => { console.error('ERR', err.message, JSON.stringify(logs));
    assert.doesNotMatch(err.message, /could not be put back/);
    return true;
  });
  assert.equal(onDisk(capturingDir), RECORD_CONTENT);
  assert.match(git(capturingDir, 'ls-files', '-s', '--', RECORD_PATH), /^\d+ [0-9a-f]+ 0\t/);
  assert.ok(logs.some((l) => l.includes(RECORD_PATH) && /index/i.test(l)), JSON.stringify(logs));
});

test('(k) a symlink entry in @{u} is never a candidate, even when its target equals the local bytes', (t) => {
  const target = 'some-target';
  const { capturingDir } = buildRace(t, {
    files: { [RECORD_PATH]: target },
    ship: (dir) => {
      mkdirSync(join(dir, '.memory', 'records'), { recursive: true });
      symlinkSync(target, join(dir, RECORD_PATH));
    },
  });
  assert.throws(() => defaultGitPull(capturingDir, { _log: quiet }));
  assert.equal(readFileSync(join(capturingDir, RECORD_PATH), 'utf8'), target);
  assert.ok(lstatSync(join(capturingDir, RECORD_PATH)).isFile(), 'still the local regular file');
});

test('(l) an unlink failing mid-loop names the already-deleted paths and their oids', (t) => {
  const p2 = '.memory/records/2026-09-rec-00000000000000bb.jsonl';
  const { capturingDir } = buildRace(t, { files: { [RECORD_PATH]: RECORD_CONTENT, [p2]: 'second\n' } });
  git(capturingDir, 'fetch', '-q');
  const deleted = [];
  let calls = 0;
  const _unlink = (p) => {
    calls += 1;
    if (calls === 2) throw new Error('EPERM simulated');
    deleted.push(p); unlinkSync(p);
  };
  assert.throws(() => reconcileUntrackedRecords({ root: capturingDir, _unlink }), (err) => {
    assert.match(err.message, /EPERM simulated/);
    assert.ok(deleted.length === 1 && err.message.includes(deleted[0].replace(capturingDir + '/', '')), err.message);
    assert.match(err.message, /[0-9a-f]{40}/);
    assert.match(err.message, /@\{u\}|origin\/main/);
    return true;
  });
});
