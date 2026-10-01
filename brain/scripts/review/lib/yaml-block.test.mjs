// yaml-block.test.mjs — the value-side boundary table for `scalar()` (#612).
//
// `scalar(block, key)` is the shared `key: value` reader behind every
// fenced-YAML consumer in this repo. This file pins its three-state
// contract directly against the primitive, boundary by boundary
// (design.md §D-A): a real value, a whitespace-only tail (the ABSENT
// state, answers `null`), and the trailing-trim behavior that survives
// on top of the `\S`-anchored capture.
//
// Not this file's job: cross-parser equivalence (that's
// `yaml-block.drift.test.mjs`), consumer-specific behavior (that's each
// consumer's own test file), or governance admission (that's
// `actor-check.test.mjs`, colocated with the gate it protects — see
// design.md §D-C).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { scalar } from './yaml-block.mjs';

const NBSP = ' ';

test('scalar: a key line with a real value returns the value', () => {
  assert.equal(scalar('key: v', 'key'), 'v');
});

test('scalar: no space between the colon and the value still returns the value', () => {
  assert.equal(scalar('key:v', 'key'), 'v');
});

test('scalar: a bare key with nothing after the colon returns null', () => {
  assert.equal(scalar('key:', 'key'), null);
});

test('scalar: a single trailing space and nothing else returns null (ABSENT, not empty-string)', () => {
  assert.equal(scalar('key: ', 'key'), null);
});

test('scalar: a trailing tab and nothing else returns null', () => {
  assert.equal(scalar('key:\t', 'key'), null);
});

test('scalar: mixed trailing spaces and tabs and nothing else returns null', () => {
  assert.equal(scalar('key:   \t  ', 'key'), null);
});

test('scalar: a leading NBSP before a value returns null — exotic whitespace does not count as a value start', () => {
  // The ONLY row that kills the `(\S.*)` -> `(.*)` mutant: JS `.trim()`
  // strips U+00A0, so a naive `(.*)` + trim would have re-admitted this as
  // `'v'`. `\S` excludes U+00A0, so no start position exists for the
  // capture and the whole match fails.
  assert.equal(scalar(`key: ${NBSP}v`, 'key'), null);
});

test('scalar: a real value with trailing spaces after it is still trimmed', () => {
  // The ONLY row that kills the "remove .trim()" mutant: the capture
  // `(\S.*)` happily includes the trailing spaces (`.` is greedy), so
  // `.trim()` is the thing doing the stripping here, not the regex.
  assert.equal(scalar('key: v  ', 'key'), 'v');
});

test('scalar: CRLF line ending — the value stops before the carriage return', () => {
  assert.equal(scalar('key:\r', 'key'), null);
});

test('scalar: a whitespace-only key line does not leak into the next line under /m', () => {
  // Guards the `[ \t]*` -> `\s*` regression directly at the primitive:
  // `\s*` would consume the newline and let the capture start on the next
  // line's content. `[ \t]*` is horizontal-only, so it cannot.
  assert.equal(scalar('findings: \n  - id: F-1', 'findings'), null);
});

test('scalar: a real trailing-sha value survives .trim() (governance-adjacent shape, without the consumer)', () => {
  const sha = 'a'.repeat(40);
  assert.equal(scalar(`head_sha: ${sha}  `, 'head_sha'), sha);
});
