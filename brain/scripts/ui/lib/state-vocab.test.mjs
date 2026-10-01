// state-vocab.test.mjs — R998-1: every node maps to ONE state with a code, a
// word, a mark and a class; the priority is colour.mjs's; an unmapped status
// throws (the renderer's guard renders it `unknown`); not-computed ≠ unknown.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { PLANNED, IN_FLIGHT, DONE, UNREADABLE } from '../../status/snapshot.mjs';
import { READY, BLOCKED, AWAITING_HUMAN, UNCLASSIFIED } from '../../status/epic-graph.mjs';
import { colourClass, NOT_COMPUTED_CLASS } from './colour.mjs';
import { stateOf, STATES, STATE_CODES, UNKNOWN_CODE } from './state-vocab.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const node = ({ status = READY, blockedBy = [], roadmap = { ok: true, value: { state: PLANNED } } } = {}) => ({ number: 1, status, blockedBy, roadmap });

const MATRIX = [
  ['unreadable', node({ status: UNREADABLE, roadmap: { ok: false, reason: 'x' } })],
  ['not-computed', node({ roadmap: { ok: false, reason: 'the PR list could not be read' } })],
  ['blocked', node({ blockedBy: [2] })],
  ['awaiting-review', node({ status: AWAITING_HUMAN })],
  ['unclassified', node({ status: UNCLASSIFIED })],
  ['planned', node({ roadmap: { ok: true, value: { state: PLANNED } } })],
  ['in-flight', node({ roadmap: { ok: true, value: { state: IN_FLIGHT } } })],
  ['done', node({ roadmap: { ok: true, value: { state: DONE } } })],
];

test('#998: every state has a distinct code, a word, a mark and the class colour.mjs returns', () => {
  const seen = new Set();
  for (const [code, n] of MATRIX) {
    const s = stateOf(n);
    assert.equal(s.code, code);
    assert.ok(s.label.length > 0 && s.mark.length > 0, code);
    assert.equal(s.className, colourClass(n), `${code}: state-vocab and colour.mjs are one table`);
    assert.ok(!seen.has(s.className), `${code}: class reused`); seen.add(s.className);
  }
  assert.deepEqual(STATE_CODES.slice().sort(), [...MATRIX.map(([c]) => c), UNKNOWN_CODE].sort(), 'nine codes, no more, no less');
});

test('#998: the priority is colour.mjs\'s — unreadable beats not-computed beats blocked beats awaiting beats undeclared beats the roadmap state', () => {
  assert.equal(stateOf(node({ status: UNREADABLE, blockedBy: [2], roadmap: { ok: false } })).code, 'unreadable');
  assert.equal(stateOf(node({ status: AWAITING_HUMAN, blockedBy: [2], roadmap: { ok: false } })).code, 'not-computed');
  assert.equal(stateOf(node({ status: AWAITING_HUMAN, blockedBy: [2] })).code, 'blocked');
  assert.equal(stateOf(node({ status: UNCLASSIFIED, blockedBy: [] })).code, 'unclassified');
  assert.equal(stateOf(node({ status: BLOCKED, blockedBy: [], roadmap: { ok: true, value: { state: DONE } } })).code, 'done', 'a known status with no open blocker takes the roadmap state, as colour.mjs does');
});

test('#998: the code value is the data\'s word, the label is the screen\'s — unclassified is shown as Undeclared (ruling 5)', () => {
  const s = stateOf(node({ status: UNCLASSIFIED }));
  assert.equal(s.code, 'unclassified');
  assert.equal(s.label, 'Undeclared');
});

test('#998: not-computed is not unknown — an unmapped status throws, and the two classes differ', () => {
  assert.throws(() => stateOf(node({ status: 'weird' })), /unknown node status "weird"/);
  assert.equal(STATES['not-computed'].className, NOT_COMPUTED_CLASS);
  assert.notEqual(STATES['not-computed'].className, STATES[UNKNOWN_CODE].className);
  assert.equal(STATES[UNKNOWN_CODE].className, 'node-unknown', 'the class the renderer already paints for the guard');
});

test('#998: every className has a rule in app.css', () => {
  const css = readFileSync(join(HERE, '..', 'static', 'app.css'), 'utf8');
  for (const code of STATE_CODES) assert.ok(css.includes(`.${STATES[code].className}`), `${code} → .${STATES[code].className} has no rule in app.css`);
});
