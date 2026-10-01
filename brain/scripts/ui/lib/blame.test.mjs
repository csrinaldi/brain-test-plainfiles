// blame.test.mjs — Q2/D13: `git blame --porcelain` parsed into per-line
// `{sha, author, authorTime}`. One subprocess per drawer open, run
// SERVER-side (`change-route.mjs`, injected `_run` — no shell inside
// `lib/`); this module only parses the porcelain TEXT. A malformed or
// absent blame input never resolves to a blank — it is a said failure.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBlame } from './blame.mjs';

const PORCELAIN = [
  'abc1234abc1234abc1234abc1234abc1234abc1 1 1 2',
  'author Alice',
  'author-mail <a@example.com>',
  'author-time 1694700000',
  'author-tz +0000',
  'committer Alice',
  'committer-mail <a@example.com>',
  'committer-time 1694700000',
  'committer-tz +0000',
  'summary first commit',
  'filename tasks.md',
  '\t- [ ] line one',
  'abc1234abc1234abc1234abc1234abc1234abc1 2 2',
  '\t- [x] line two',
  'def5678def5678def5678def5678def5678def5 3 3 1',
  'author Bob',
  'author-mail <b@example.com>',
  'author-time 1694800000',
  'author-tz +0000',
  'committer Bob',
  'committer-mail <b@example.com>',
  'committer-time 1694800000',
  'committer-tz +0000',
  'summary second commit',
  'filename tasks.md',
  '\t- [ ] line three',
].join('\n');

test('#881: a fixture porcelain blob parses one entry per content line, with the metadata line-1 carried and line-2 reused (no repeated metadata block)', () => {
  const { ok, value } = parseBlame({ text: PORCELAIN });
  assert.equal(ok, true);
  assert.equal(value[1].sha, 'abc1234abc1234abc1234abc1234abc1234abc1');
  assert.equal(value[1].author, 'Alice');
  assert.equal(value[1].authorTime, new Date(1694700000 * 1000).toISOString());
  // line 2: same commit, porcelain omits the metadata block — reused from the cache built at line 1
  assert.equal(value[2].sha, value[1].sha);
  assert.equal(value[2].author, 'Alice');
  assert.equal(value[2].authorTime, value[1].authorTime);
  assert.equal(value[3].author, 'Bob');
});

test('#881: no blame text at all is a said failure, never a blank map', () => {
  const result = parseBlame({ text: null });
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});

test('#881: an empty blame text is a said failure, distinct from "one line, no history"', () => {
  const result = parseBlame({ text: '' });
  assert.equal(result.ok, false);
});

test('#881: unparseable/garbage text yields {ok:false, reason}, never an empty object read as "zero lines"', () => {
  const result = parseBlame({ text: 'this is not porcelain output at all\njust prose' });
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});

test('#881: CRLF porcelain output parses the same as LF', () => {
  const crlf = PORCELAIN.replaceAll('\n', '\r\n');
  const { value: fromLf } = parseBlame({ text: PORCELAIN });
  const { value: fromCrlf } = parseBlame({ text: crlf });
  assert.deepEqual(fromLf, fromCrlf);
});
