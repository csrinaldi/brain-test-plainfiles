// duplicates.i18n.test.mjs — Spanish CONTENT for the `memory.duplicates.*`
// family (#638 cold review, F2).
//
// `duplicates.test.mjs`'s own assertions only drive `formatDuplicateReport`
// through the default `en` fallback catalog (`coverage.test.mjs` proves en/es
// KEY parity, but never renders the es VALUES). Measured: replacing
// `memory.duplicates.why`'s es value with `TOTALLY WRONG TEXT` passed
// 948/948 across the i18n and memory suites before this file existed — the
// twelve `memory.duplicates.*` Spanish strings were unverified content, only
// verified as present keys.
//
// Follows the neighbours' own precedent (`cli.ship.test.mjs`,
// `plainfiles.save-index-failure.test.mjs`, and `coverage.test.mjs`'s
// `translate()`-based `bootstrap.*`/`session.*` tests) rather than twelve
// brittle full-string equalities: one assertion per RENDERING FAMILY,
// matched on a distinctive Spanish word/phrase that could not survive a
// mistranslation or a dropped key.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { translate } from '../../i18n/t.mjs';
import en from '../../i18n/en.mjs';
import es from '../../i18n/es.mjs';

// ── summary / summaryWithIndex — the two lines every report opens with ──────

test('memory.duplicates.summary/summaryWithIndex render Spanish prose, not the English fallback', () => {
  const s1 = translate('memory.duplicates.summary', { ids: 2, lines: 3, surface: 'el índice' }, es, en);
  assert.match(s1, /id\(s\) de registro duplicado\(s\)/, 'the Spanish noun phrase must render');
  assert.match(s1, /colapsada\(s\) en el índice/, 'the surface interpolates into Spanish prose');
  assert.doesNotMatch(s1, /duplicate record|collapsed into/i, 'must not silently fall back to English');

  const s2 = translate(
    'memory.duplicates.summaryWithIndex',
    { ids: 2, lines: 3, surface: 'el índice', total: 5, indexCount: 2 },
    es,
    en,
  );
  assert.match(s2, /indexada\(s\)/, 'the index-gap clause must render in Spanish');
  assert.doesNotMatch(s2, /indexed/i);
});

// ── why — the rationale paragraph ────────────────────────────────────────────

test('memory.duplicates.why renders the Spanish rationale ("Deduplicado, no rechazado"), not English', () => {
  const s = translate('memory.duplicates.why', { lines: 3 }, es, en);
  assert.match(s, /Deduplicado, no rechazado/);
  assert.doesNotMatch(s, /Deduplicated, not refused/i);
});

// ── divergent — the disagreement paragraph ───────────────────────────────────

test('memory.duplicates.divergent renders "DISCREPAN fuera de los campos hasheados", not "DISAGREE"', () => {
  const s = translate('memory.duplicates.divergent', { count: 1 }, es, en);
  assert.match(s, /DISCREPAN fuera de los campos hasheados/);
  assert.doesNotMatch(s, /DISAGREE/);
});

// ── brief — the pointer to `brain:memory:reindex` ──────────────────────────────────

test('memory.duplicates.brief uses the Spanish imperative "Corré", not "Run"', () => {
  const s = translate('memory.duplicates.brief', {}, es, en);
  assert.match(s, /Corré `npm run brain:memory:reindex`/);
  assert.doesNotMatch(s, /\bRun `npm run brain:memory:reindex`/);
});

// ── moreOccurrences / moreGroups — the truncation tails ──────────────────────

test('memory.duplicates.moreOccurrences/moreGroups render "más", not "more"', () => {
  const s1 = translate('memory.duplicates.moreOccurrences', { count: 3 }, es, en);
  assert.match(s1, /\+3 más/);
  assert.doesNotMatch(s1, /more\b/i);

  const s2 = translate('memory.duplicates.moreGroups', { count: 2 }, es, en);
  assert.match(s2, /id\(s\) duplicado\(s\) más/);
  assert.doesNotMatch(s2, /more duplicated/i);
});

// ── unknownId — the one key in the per-id-line family that IS translated ────

test('memory.duplicates.unknownId renders "(id desconocido)", not "(unknown id)"', () => {
  const s = translate('memory.duplicates.unknownId', {}, es, en);
  assert.equal(s, '(id desconocido)');
  assert.notEqual(s, en['memory.duplicates.unknownId']);
});

// ── group / groupDivergent — placeholders + the `[divergent]` marker only ───
//
// UNLIKE every family above, these two keys carry NO natural-language prose
// to mistranslate — `en.mjs` and `es.mjs` are byte-identical here by design
// (only `{id}`, `×{count}`, `{locations}`, and the untranslated `[divergent]`
// marker). A content-diff assertion would be a false requirement for a key
// with nothing to translate, so this test instead proves the KEY resolves and
// interpolates correctly in the `es` catalog — the structural half of the
// same guarantee, without inventing Spanish prose the real strings don't have.
test('memory.duplicates.group/groupDivergent interpolate correctly in es (no prose to translate — identical to en by design)', () => {
  assert.equal(es['memory.duplicates.group'], en['memory.duplicates.group'], 'documented exception: no translatable content in this key');
  assert.equal(es['memory.duplicates.groupDivergent'], en['memory.duplicates.groupDivergent'], 'documented exception: no translatable content in this key');

  const g = translate('memory.duplicates.group', { id: 'rec-aaa', count: 2, locations: 'a.jsonl:1, a.jsonl:2' }, es, en);
  assert.equal(g, '  rec-aaa ×2 — a.jsonl:1, a.jsonl:2');

  const gd = translate('memory.duplicates.groupDivergent', { id: 'rec-bbb', count: 2, locations: 'b.jsonl:1, b.jsonl:2' }, es, en);
  assert.match(gd, /\[divergent\]/);
});
