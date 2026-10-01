// engram-export.test.mjs — unit tests for the engram observation → brain
// record export transform (REQ-MF-6, issue #217 C2).
//
// RED: these imports fail until engram-export.mjs is created.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { exportObservation, LEGACY_ACTOR, LEGACY_ACTOR_KIND } from './engram-export.mjs';
import { validateRecord } from './format.mjs';

const baseObs = {
  id: 323,
  sync_id: 'obs-1034b42dcca30459',
  session_id: '7ece5be8-29b3-4858-ae20-57b99d148b07',
  type: 'architecture',
  title: 'A real observation title',
  content: 'Some observation body, no §4 prose.',
  project: 'brain',
  scope: 'project',
  topic_key: 'sdd/x/apply-progress',
  revision_count: 3,
  duplicate_count: 0,
  last_seen_at: '2026-07-02 11:45:38',
  created_at: '2026-07-01 01:19:12',
  updated_at: '2026-07-02 11:45:38',
};

// ── Fallback path (the 278/278 real case: no §4 prose) ───────────────────────

test('exportObservation: no §4 prose → falls back to @legacy/human, records provenance-unknown source', () => {
  const { record, recovered } = exportObservation(baseObs);
  assert.equal(recovered, false);
  assert.equal(record.actor, LEGACY_ACTOR);
  assert.equal(record.actorKind, LEGACY_ACTOR_KIND);
  assert.match(record.source, /provenance unknown/);
  assert.match(record.source, /obs-1034b42dcca30459/);
});

test('exportObservation: fallback record passes validateRecord', () => {
  const { record } = exportObservation(baseObs);
  const { valid, errors } = validateRecord(record);
  assert.equal(valid, true, errors.join('; '));
});

test('exportObservation: R2 title fold — a non-empty title is folded into content', () => {
  const { record } = exportObservation(baseObs);
  assert.equal(record.content, `**${baseObs.title}**\n\n${baseObs.content}`);
});

test('exportObservation: naive engram ts becomes UTC seconds with the Z suffix', () => {
  const { record } = exportObservation(baseObs);
  assert.equal(record.ts, '2026-07-01T01:19:12Z');
});

test('exportObservation: id is the shared content-hash computeRecordId shape', () => {
  const { record } = exportObservation(baseObs);
  assert.match(record.id, /^rec-[0-9a-f]{16}$/);
});

// ── §4 recovery path ──────────────────────────────────────────────────────

test('exportObservation: §4 prose present → recovers structured actor/issue/supersedes', () => {
  const obs = {
    ...baseObs,
    content:
      '**Actor:** @crinaldi (humano)\n**Fuente:** issue #201\n\nA decision with recovered provenance.',
  };
  const { record, recovered } = exportObservation(obs);
  assert.equal(recovered, true);
  assert.equal(record.actor, '@crinaldi');
  assert.equal(record.actorKind, 'human');
  assert.equal(record.issue, 201);
  assert.equal(record.source, 'issue #201');
  assert.equal(record.content, `**${obs.title}**\n\nA decision with recovered provenance.`);
});

// ── #738 — a recovered branch-shaped actor is soft-rejected, never thrown ───
// A5 (design.md): W3 (format.mjs) refuses a branch-shaped `actor` at the
// write gate. A §4 block CAN recover a branch-shaped value (`ACTOR_LINE_RE`
// accepts any `\S+`), and letting it reach `buildRecord`/`appendRecord`
// unchecked would turn a genuine recovery into a THROW inside `share` — the
// #529 trap #542 already declined. So export soft-rejects it BEFORE
// `buildRecord`, the same shape as the non-enum-type rejection above.

test('exportObservation: a recovered branch-shaped actor is soft-rejected, never thrown', () => {
  const obs = {
    ...baseObs,
    content: '**Actor:** feat/issue-738-x (agente)\n\nA decision recovered with a branch-shaped actor.',
  };
  assert.doesNotThrow(() => exportObservation(obs));
  const result = exportObservation(obs);
  assert.equal(result.record, undefined);
  assert.ok(result.rejected, 'a recovered branch-shaped actor must be rejected, not silently exported');
  assert.equal(result.rejected.id, 'obs-1034b42dcca30459');
  assert.equal(result.rejected.title, baseObs.title);
  assert.equal(result.rejected.type, baseObs.type);
  assert.match(result.rejected.reason, /branch-shaped/);
});

test('exportObservation: a recovered HANDLE-shaped actor is unaffected by the branch-shape guard', () => {
  const obs = {
    ...baseObs,
    content: '**Actor:** @crinaldi (humano)\n\nA decision recovered with a handle actor.',
  };
  const { record, recovered, rejected } = exportObservation(obs);
  assert.equal(rejected, undefined);
  assert.equal(recovered, true);
  assert.equal(record.actor, '@crinaldi');
});

test('exportObservation: the no-recovery @legacy/human fallback path is UNCHANGED by the branch-shape guard', () => {
  const { record, recovered, rejected } = exportObservation(baseObs);
  assert.equal(rejected, undefined);
  assert.equal(recovered, false);
  assert.equal(record.actor, LEGACY_ACTOR);
});

// ── Ruling 3b: malformed / partial §4 prose → fallback preserves it verbatim ──
// A leading Actor line missing its (kind) is NOT a recoverable block (all-or-
// nothing anchor). The export must NOT recover it, must fall back to @legacy,
// AND must keep the malformed prose in the record content — never silently
// dropped. This is the export-level guard for the provenance policy pinned in
// design.md §"Malformed §4 prose".

test('exportObservation: malformed leading §4 prose (Actor without kind) → @legacy fallback, malformed prose preserved verbatim in content', () => {
  const obs = { ...baseObs, content: '**Actor:** @crinaldi\nA body whose leading prose is malformed.' };
  const { record, recovered } = exportObservation(obs);
  assert.equal(recovered, false, 'a kind-less Actor line must not count as recovered provenance');
  assert.equal(record.actor, LEGACY_ACTOR);
  assert.equal(record.actorKind, LEGACY_ACTOR_KIND);
  assert.match(record.source, /provenance unknown/);
  assert.equal(
    record.content,
    `**${obs.title}**\n\n${obs.content}`,
    'the malformed prose must survive into content (R2-folded), never dropped',
  );
});

// ── scope:personal is filtered, not exported ────────────────────────────────

test('exportObservation: scope:personal is skipped (never promoted to a record)', () => {
  const obs = { ...baseObs, scope: 'personal' };
  const result = exportObservation(obs);
  assert.equal(result.skipped, 'scope:personal');
  assert.equal(result.record, undefined);
});

// ── non-enum type is rejected, never coerced ────────────────────────────────

test('exportObservation: a non-enum type (e.g. "manual") is rejected, not coerced', () => {
  const obs = { ...baseObs, type: 'manual' };
  const result = exportObservation(obs);
  assert.equal(result.record, undefined);
  assert.ok(result.rejected);
  assert.equal(result.rejected.id, 'obs-1034b42dcca30459');
  assert.equal(result.rejected.type, 'manual');
  assert.equal(result.rejected.title, baseObs.title);
  assert.match(result.rejected.reason, /non-enum/);
});

test('exportObservation: another observed non-enum type ("preference") is rejected', () => {
  const obs = { ...baseObs, type: 'preference' };
  const result = exportObservation(obs);
  assert.ok(result.rejected);
  assert.equal(result.rejected.type, 'preference');
});
