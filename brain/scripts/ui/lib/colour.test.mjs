// colour.test.mjs — R881-6, D9-note. `colourClass(node)` maps a graph
// node's computed state to a CSS class. The exhaustive-map test below
// imports the real constants `colour.mjs` cannot (D9) so a renamed
// constant fails HERE instead of quietly painting a node grey.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PLANNED, IN_FLIGHT, DONE, UNREADABLE } from '../../status/snapshot.mjs';
import { READY, BLOCKED, AWAITING_HUMAN, UNCLASSIFIED } from '../../status/epic-graph.mjs';
import { colourClass, NOT_COMPUTED_CLASS } from './colour.mjs';

function node({ status = READY, blockedBy = [], roadmap = { ok: true, value: { state: PLANNED } } } = {}) {
  return { number: 1, status, blockedBy, roadmap };
}

test('#881: no node is filtered away — every one of a 90-node fixture, including "?"-track and unreadable, receives a colour class', () => {
  const fixture = [];
  for (let i = 1; i <= 88; i++) fixture.push(node({ status: READY, roadmap: { ok: true, value: { state: i % 2 ? PLANNED : DONE } } }));
  fixture.push(node({ status: UNCLASSIFIED, roadmap: { ok: false, reason: 'no declaration' } })); // "?"-track
  fixture.push(node({ status: UNREADABLE, roadmap: { ok: false, reason: 'the issue body could not be read' } }));
  assert.equal(fixture.length, 90);
  for (const n of fixture) {
    const cls = colourClass(n);
    assert.equal(typeof cls, 'string');
    assert.ok(cls.length > 0);
  }
});

test('#881: roadmap not computed is never mistaken for planned', () => {
  const n = node({ status: READY, roadmap: { ok: false, reason: 'the PR list could not be read' } });
  assert.equal(colourClass(n), NOT_COMPUTED_CLASS);
  assert.notEqual(colourClass(n), colourClass(node({ status: READY, roadmap: { ok: true, value: { state: PLANNED } } })));
});

test('#881: blocked overrides state colour', () => {
  const blocked = node({ status: BLOCKED, blockedBy: [42], roadmap: { ok: true, value: { state: PLANNED } } });
  const plain = node({ status: READY, blockedBy: [], roadmap: { ok: true, value: { state: PLANNED } } });
  assert.notEqual(colourClass(blocked), colourClass(plain));
});

test('#881: unreadable is a distinct mark from every other status', () => {
  const unreadable = node({ status: UNREADABLE, roadmap: { ok: false, reason: 'unreadable' } });
  const notComputed = node({ status: READY, roadmap: { ok: false, reason: 'transient' } });
  assert.notEqual(colourClass(unreadable), colourClass(notComputed));
});

test('#881 R881-6: a node.status this map does not know THROWS, naming it — it never inherits the roadmap colour', () => {
  // `node.status` is only ever compared against three literals, so a status
  // nobody here knows fell through to `roadmap.value.state` and painted as if
  // the node had been classified. The same refusal an unknown state gets.
  assert.throws(
    () => colourClass(node({ status: 'weird', roadmap: { ok: true, value: { state: PLANNED } } })),
    /weird/,
    'the unknown status must be named in the reason a lane card marks the node with',
  );
});

test('#881: the exhaustive map — every one of the eight roadmap.value.state / node.status constants maps to a defined, non-empty class', () => {
  const roadmapStates = [PLANNED, IN_FLIGHT, DONE];
  for (const state of roadmapStates) {
    const cls = colourClass(node({ status: READY, roadmap: { ok: true, value: { state } } }));
    assert.equal(typeof cls, 'string', `roadmap state "${state}" did not map to a class`);
    assert.ok(cls.length > 0, `roadmap state "${state}" mapped to an empty class`);
  }
  const nodeStatuses = [READY, BLOCKED, AWAITING_HUMAN, UNCLASSIFIED, UNREADABLE];
  for (const status of nodeStatuses) {
    const n = node({ status, blockedBy: status === BLOCKED ? [42] : [], roadmap: status === UNREADABLE ? { ok: false, reason: 'unreadable' } : { ok: true, value: { state: PLANNED } } });
    const cls = colourClass(n);
    assert.equal(typeof cls, 'string', `node.status "${status}" did not map to a class`);
    assert.ok(cls.length > 0, `node.status "${status}" mapped to an empty class`);
  }
});
