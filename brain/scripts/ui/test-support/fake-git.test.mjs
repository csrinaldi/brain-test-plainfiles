// fake-git.test.mjs — the in-memory `git` the document reader is tested
// against (#1198). It answers only the commands the reader is allowed to
// issue and THROWS on anything else, so a test cannot pass on a call nobody
// modelled.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fakeGit } from './fake-git.mjs';

const HEAD = 'a'.repeat(40);
const base = () => fakeGit({
  files: { 'd/spec.md': 'hello', 'd/empty.md': '' },
  head: HEAD,
  branches: { 'feat/x': { commit: 'b'.repeat(40), files: { 'resume.md': 'on branch' } } },
  blame: 'BLAME',
});

const lsTree = (run, ...paths) => run('git', ['--literal-pathspecs', 'ls-tree', '-l', '-z', HEAD, '--', ...paths]);

test('#1198 fake-git: rev-parse resolves HEAD and a branch, and refuses an unknown ref', () => {
  const run = base();
  assert.equal(run('git', ['rev-parse', '--verify', 'HEAD^{commit}']).trim(), HEAD);
  assert.equal(run('git', ['rev-parse', '--verify', 'feat/x^{commit}']).trim(), 'b'.repeat(40));
  assert.throws(() => run('git', ['rev-parse', '--verify', 'nope^{commit}']), /nope/);
});

test('#1198 fake-git: ls-tree -l -z reports mode, type, size and path; an absent path yields no line', () => {
  const run = base();
  const out = lsTree(run, 'd/spec.md', 'd/missing.md');
  const entries = out.split('\0').filter(Boolean);
  assert.equal(entries.length, 1);
  const [meta, path] = entries[0].split('\t');
  assert.equal(path, 'd/spec.md');
  const [mode, type, sha, size] = meta.trim().split(/\s+/);
  assert.deepEqual([mode, type, Number(size)], ['100644', 'blob', 5]);
  assert.match(sha, /^[0-9a-f]{40}$/);
  assert.equal(lsTree(run, 'd/missing.md'), '');
});

test('#1198 fake-git: cat-file blob returns the text and honours maxBuffer with ENOBUFS', () => {
  const run = base();
  const sha = lsTree(run, 'd/spec.md').split('\0')[0].split('\t')[0].trim().split(/\s+/)[2];
  assert.equal(run('git', ['cat-file', 'blob', sha]), 'hello');
  assert.equal(run('git', ['cat-file', 'blob', sha], { maxBuffer: 5 }), 'hello');
  assert.throws(() => run('git', ['cat-file', 'blob', sha], { maxBuffer: 4 }), (e) => e.code === 'ENOBUFS');
});

test('#1198 fake-git: show <ref>:<path>, blame and branch --list are answered from the model', () => {
  const run = base();
  assert.equal(run('git', ['show', 'feat/x:resume.md']), 'on branch');
  assert.throws(() => run('git', ['show', 'feat/x:other.md']), /does not exist/);
  assert.equal(run('git', ['blame', '--porcelain', 'HEAD', '--', 'd/tasks.md']), 'BLAME');
  assert.equal(run('git', ['branch', '--list', 'feat/*']).trim(), 'feat/x');
});

test('#1198 fake-git: failure injection, the call log, and refusal of unmodelled commands', () => {
  const run = fakeGit({ files: { a: 'x' }, head: HEAD, fail: { 'ls-tree': 'boom' } });
  assert.throws(() => lsTree(run, 'a'), /boom/);
  assert.deepEqual(run.calls.at(-1).slice(0, 2), ['--literal-pathspecs', 'ls-tree']);
  assert.throws(() => run('git', ['push']), /unmodelled/);
  assert.throws(() => run('git', ['blame', 'HEAD']), /no blame/, 'blame is unmodelled unless the test supplies it');
  assert.equal(run.calls.length, 3);
});

test('#1198 fake-git: modes and trees model the entries the reader must refuse', () => {
  const run = fakeGit({ files: { link: 'target' }, modes: { link: '120000' }, trees: ['dir'], head: HEAD });
  assert.match(lsTree(run, 'link'), /^120000 blob /);
  assert.match(lsTree(run, 'dir'), /^040000 tree /);
});
