// repo.test.mjs — Unit tests for parseRemote. Run with: npm test (node --test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRemote } from './repo.mjs';

test('parseRemote: HTTPS with .git', () => {
  assert.deepEqual(parseRemote('https://github.com/csrinaldi/brain.git'),
    { host: 'github.com', project: 'csrinaldi/brain' });
});

test('parseRemote: HTTPS without .git', () => {
  assert.deepEqual(parseRemote('https://github.com/csrinaldi/brain'),
    { host: 'github.com', project: 'csrinaldi/brain' });
});

test('parseRemote: SSH', () => {
  assert.deepEqual(parseRemote('git@github.com:csrinaldi/brain.git'),
    { host: 'github.com', project: 'csrinaldi/brain' });
});

test('parseRemote: GitLab subgroups', () => {
  // A reserved name (RFC 2606), like every sibling assertion here. The path keeps
  // four segments because that is what this test is FOR — nested groups, which
  // GitHub does not have and GitLab does.
  assert.deepEqual(parseRemote('https://git.example.com/org/group/sub/repo.git'),
    { host: 'git.example.com', project: 'org/group/sub/repo' });
});

test('parseRemote: custom HTTPS port is dropped from host, slug stays clean', () => {
  assert.deepEqual(parseRemote('https://gitlab.example.com:8080/group/repo.git'),
    { host: 'gitlab.example.com', project: 'group/repo' });
});

test('parseRemote: HTTPS with embedded credentials', () => {
  assert.deepEqual(parseRemote('https://oauth2:TOKEN@git.example.com/group/repo.git'),
    { host: 'git.example.com', project: 'group/repo' });
});

test('parseRemote: unrecognized input returns nulls', () => {
  assert.deepEqual(parseRemote('not a url'), { host: null, project: null });
  assert.deepEqual(parseRemote(''), { host: null, project: null });
});
