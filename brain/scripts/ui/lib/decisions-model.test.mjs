// decisions-model.test.mjs — R882-3: the ADR table and its drift warnings.
// An unreadable ADR is kept in place (adr-index.mjs's own rule), sorted
// last; `issues` is labelled "referenced," never "driving" (the parser does
// not distinguish the two); `driftWarnings` is a passthrough of
// `adrDrift`'s own result, never a second drift computation.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDecisionsModel } from './decisions-model.mjs';
import { sourceLabel, sourceStamp } from './provenance.mjs';

const readableAdr = (over = {}) => ({
  ok: true,
  path: 'brain/project/decisions/adr-0001-example.md',
  number: 1,
  title: 'Example decision',
  status: 'Accepted',
  statusLine: 'Accepted, amended 01/02/2026',
  date: '2026-01-01',
  amendments: [{ n: 1, date: '2026-02-01', issue: 42, summary: 'a fix' }],
  supersedes: [],
  supersededBy: null,
  issues: [42, 7, 3],
  ...over,
});

const drift = (over = {}) => ({ ok: true, value: { homeOnly: [], filesOnly: [], unreadable: [], ...over } });

test('#882 R882-3: no ADR section given is a stated reason, never an empty table', () => {
  const model = buildDecisionsModel(undefined, drift());
  assert.equal(model.ok, false);
  assert.match(model.reason, /no ADR section/);
});

test('#882 R882-3: an unreadable ADR index is the whole view\'s own reason, regardless of driftSection', () => {
  const failed = buildDecisionsModel({ ok: false, reason: 'brain/project/decisions could not be listed: EACCES' }, drift());
  assert.deepEqual(failed, { ok: false, reason: 'brain/project/decisions could not be listed: EACCES' });
  const failedNoDrift = buildDecisionsModel({ ok: false, reason: 'boom' }, { ok: false, reason: 'unrelated drift failure' });
  assert.deepEqual(failedNoDrift, { ok: false, reason: 'boom' });
});

test('#882 R882-3: a readable ADR\'s full row carries number, title, status, amendments, issues (referenced, not driving), and its own sourceStamp', () => {
  const adr = readableAdr();
  const model = buildDecisionsModel({ ok: true, value: [adr] }, drift());
  assert.equal(model.ok, true);
  const row = model.value.rows[0];
  assert.equal(row.number, 1);
  assert.equal(row.title, 'Example decision');
  assert.equal(row.status, 'Accepted');
  assert.deepEqual(row.amendments, adr.amendments);
  assert.deepEqual(row.issues, [42, 7, 3], 'issues pass through exactly as parseAdr extracted them');
  assert.equal(row.issuesLabel, 'issues referenced in this ADR', 'the model states its own label text — the parser does not distinguish a driving ticket from an incidentally cited one');
  assert.deepEqual(row.supersedes, []);
  assert.equal(row.supersededBy, null);
  assert.equal(row.source, sourceLabel({ path: adr.path }));
  assert.deepEqual(row.sourceStamp, sourceStamp({ path: adr.path }));
});

test('#882 R882-3: an unreadable ADR is kept as its own row, sorted last — no number to sort by', () => {
  const readable = readableAdr({ number: 5 });
  const unreadable = { ok: false, path: 'brain/project/decisions/adr-broken.md', reason: 'no `# ADR-NNNN — Title` line' };
  const model = buildDecisionsModel({ ok: true, value: [unreadable, readable] }, drift());
  assert.equal(model.ok, true);
  assert.deepEqual(model.value.rows.map((r) => r.number), [5, null]);
  const badRow = model.value.rows[1];
  assert.equal(badRow.ok, false);
  assert.equal(badRow.path, unreadable.path);
  assert.equal(badRow.reason, unreadable.reason);
});

test('#882 R882-3: rows sort by ADR number', () => {
  const a3 = readableAdr({ number: 3, path: 'p3' });
  const a1 = readableAdr({ number: 1, path: 'p1' });
  const a2 = readableAdr({ number: 2, path: 'p2' });
  const model = buildDecisionsModel({ ok: true, value: [a3, a1, a2] }, drift());
  assert.deepEqual(model.value.rows.map((r) => r.number), [1, 2, 3]);
});

test('#882 R882-3: driftWarnings carries homeOnly/filesOnly/unreadable verbatim — never a second drift computation', () => {
  const driftValue = { homeOnly: [{ number: 9, path: null }], filesOnly: [{ number: 2, path: 'x' }], unreadable: [{ path: 'y', reason: 'bad' }] };
  const model = buildDecisionsModel({ ok: true, value: [] }, { ok: true, value: driftValue });
  assert.equal(model.ok, true);
  assert.deepEqual(model.value.driftWarnings, { ok: true, value: driftValue });
});

test('#882 R882-3: drift warnings ride beside the table, not instead of it — a failed drift section degrades only the warnings, not the rows', () => {
  const adr = readableAdr();
  const model = buildDecisionsModel({ ok: true, value: [adr] }, { ok: false, reason: 'brain/HOME.md could not be read' });
  assert.equal(model.ok, true);
  assert.equal(model.value.rows.length, 1);
  assert.deepEqual(model.value.driftWarnings, { ok: false, reason: 'brain/HOME.md could not be read' });
});
