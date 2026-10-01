// tasks-list.test.mjs — R881-8 Tasks tab. `tasks.md`'s `- [ ]`/`- [x]`/
// `- [X]` lines (case-insensitive, AGENTS.md:377-379), parsed into
// checklist items with line numbers. Per-line actor/timestamp is optional
// input (Q2): the SERVER attaches it from `git blame` via `blame.mjs`; this
// module renders "unknown" when no attribution row is given for a line.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseTasksList } from './tasks-list.mjs';

const PATH = 'openspec/changes/issue-881-ui-server-canvas/tasks.md';

test('#881: - [ ], - [x] and - [X] lines parse into checklist items with line numbers and the file path', () => {
  const text = ['## Phase 1', '- [ ] pending one', '- [x] done one', '- [X] done two (uppercase X)'].join('\n');
  const { ok, value: items } = parseTasksList({ text, path: PATH });
  assert.equal(ok, true);
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((i) => i.done), [false, true, true]);
  assert.equal(items[0].line, 2);
  assert.equal(items[0].text, 'pending one');
  assert.deepEqual(items[0].source, { path: PATH, line: 2 });
});

test('#881: an empty tasks.md parses to zero items — a fact, not a failure', () => {
  const { ok, value: items } = parseTasksList({ text: '', path: PATH });
  assert.equal(ok, true);
  assert.deepEqual(items, []);
});

test('#881: a checked task WITH attribution carries its actor and timestamp', () => {
  const text = '- [x] shipped it';
  const attribution = [{ line: 1, actor: 'csrinaldi', ts: '2026-09-14T12:00:00Z' }];
  const { value: items } = parseTasksList({ text, path: PATH, attribution });
  assert.equal(items[0].actor, 'csrinaldi');
  assert.equal(items[0].ts, '2026-09-14T12:00:00Z');
});

test('#881: a checked task WITHOUT attribution renders "unknown", never a blank', () => {
  const text = '- [x] shipped it';
  const { value: items } = parseTasksList({ text, path: PATH });
  assert.equal(items[0].actor, 'unknown');
  assert.equal(items[0].ts, null);
});

test('#881: a non-checklist line is not a checklist item', () => {
  const text = ['## Phase 1', 'some prose', '- a plain bullet, no brackets'].join('\n');
  const { value: items } = parseTasksList({ text, path: PATH });
  assert.deepEqual(items, []);
});

test('#881: CRLF line endings parse the same as LF, with the same line numbers', () => {
  const lf = ['- [ ] a', '- [x] b'].join('\n');
  const crlf = lf.replaceAll('\n', '\r\n');
  const { value: fromLf } = parseTasksList({ text: lf, path: PATH });
  const { value: fromCrlf } = parseTasksList({ text: crlf, path: PATH });
  assert.deepEqual(fromLf, fromCrlf);
});

test('#881: no text given is a said failure, never an empty array read as "no tasks"', () => {
  const result = parseTasksList({ text: null, path: PATH });
  assert.equal(result.ok, false);
  assert.ok(result.reason.length > 0);
});
