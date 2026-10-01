import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseAdr, readAdrIndex, homeAdrList, adrDrift, normalizeDate } from './adr-index.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');

const AMENDED = `# ADR-0002 — Git-based team memory in two layers

**Status**: Accepted · **amended 09/09/2026** (Amendments 1-2 — see below)
**Date**: 2026-06-26

## Context

Mentions #123 and #862 in prose.

## Amendment 1 — the manifest was the transport's index, and the transport is gone (issue #863)

## Amendment 2 — the canonical flow points at the lane (issue #862)
`;

// ── R879-3: the prose convention, read ──────────────────────────────────────

test('#879: an amended ADR yields number, title, status, date and its amendments', () => {
  const a = parseAdr(AMENDED, { path: 'brain/project/decisions/adr-0002-x.md' });
  assert.equal(a.ok, true);
  assert.equal(a.number, 2);
  assert.equal(a.title, 'Git-based team memory in two layers');
  assert.equal(a.status, 'Accepted');
  assert.equal(a.date, '2026-06-26');
  assert.deepEqual(a.amendments, [
    { n: 1, date: '2026-09-09', issue: 863, summary: "the manifest was the transport's index, and the transport is gone" },
    { n: 2, date: '2026-09-09', issue: 862, summary: 'the canonical flow points at the lane' },
  ]);
  assert.deepEqual(a.issues, [123, 862, 863], 'every cited ticket, once, sorted');
  assert.equal(a.supersededBy, null);
  assert.deepEqual(a.supersedes, []);
});

test('#879: supersession is read from the header and the headings, never from the body', () => {
  const text = `# ADR-0006 — Distribution

**Status**: Accepted · **amended 18/08/2026** (Amendments 1-2 — see below)
**Date**: 26/06/2026

The body says this supersedes ADR-0001, which is prose, not a relation.

## Amendment 1 — SUPERSEDED by ADR-0030: the premise no longer exists (issue #617)
`;
  const a = parseAdr(text, { path: 'p' });
  assert.equal(a.supersededBy, 30);
  assert.deepEqual(a.supersedes, [], 'the body mention is not asserted');
  assert.equal(a.date, '2026-06-26', 'dd/mm/yyyy is normalised');
});

test('#879: an unparseable ADR is "could not read", never absent', () => {
  const noStatus = parseAdr('# ADR-0001 — Title only\n\nno status line\n', { path: 'p/adr-0001-x.md' });
  assert.deepEqual(noStatus, { ok: false, path: 'p/adr-0001-x.md', reason: 'no `**Status**:` line' });
  const noTitle = parseAdr('**Status**: Accepted\n', { path: 'q' });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.reason, /Title/);
  assert.equal(parseAdr(null, { path: 'r' }).ok, false, 'an unreadable file is the same shape');
});

test('#879: normalizeDate keeps what it cannot read, as written', () => {
  assert.equal(normalizeDate('2026-07-17 -- Cristian Rinaldi'), '2026-07-17');
  assert.equal(normalizeDate('31/07/2026 — Cristian Rinaldi'), '2026-07-31');
  assert.equal(normalizeDate('sometime'), 'sometime');
  assert.equal(normalizeDate(null), null);
});

test('#879: readAdrIndex keeps an unreadable file in place and reports an unlistable dir', () => {
  const files = { 'd/adr-0001-a.md': '# ADR-0001 — A\n\n**Status**: Accepted\n', 'd/adr-0002-b.md': 'garbage' };
  const r = readAdrIndex({
    dir: 'd',
    _list: () => ['adr-0002-b.md', 'README.md', 'adr-0001-a.md'],
    _read: (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.value.map((a) => [a.path, a.ok]), [['d/adr-0001-a.md', true], ['d/adr-0002-b.md', false]], 'sorted, README skipped, the bad one kept');

  const bad = readAdrIndex({ dir: 'nope', _list: () => { throw new Error('ENOENT'); } });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /nope.*ENOENT/);
});

// ── R879-7: drift, both directions ──────────────────────────────────────────

test('#879: adrDrift names what HOME.md lists but the parser cannot read, by path', () => {
  const index = [
    { ok: true, number: 1, path: 'brain/project/decisions/adr-0001-a.md' },
    { ok: false, path: 'brain/project/decisions/adr-0002-b.md', reason: 'no `**Status**:` line' },
    { ok: true, number: 3, path: 'brain/project/decisions/adr-0003-c.md' },
  ];
  const home = homeAdrList([
    '- [ADR-0001](project/decisions/adr-0001-a.md) — a',
    '- [ADR-0002](project/decisions/adr-0002-b.md) — b',
    '- [ADR-0004](project/decisions/adr-0004-d.md) — d',
    '- not an adr line',
  ].join('\n'));
  const d = adrDrift(index, home);
  assert.deepEqual(d.homeOnly, [
    { number: 2, path: 'brain/project/decisions/adr-0002-b.md' },
    { number: 4, path: 'brain/project/decisions/adr-0004-d.md' },
  ]);
  assert.deepEqual(d.filesOnly, [{ number: 3, path: 'brain/project/decisions/adr-0003-c.md' }]);
  assert.deepEqual(d.unreadable, [{ path: 'brain/project/decisions/adr-0002-b.md', reason: 'no `**Status**:` line' }]);
});

// ── the real tree: the convention holds, which is what ruling 2 rests on ────

test('#879: on this repository every ADR parses and HOME.md lists exactly the parsed set', () => {
  const r = readAdrIndex({ root: ROOT });
  assert.equal(r.ok, true);
  const unreadable = r.value.filter((a) => !a.ok);
  assert.deepEqual(unreadable, [], 'a file that stops parsing is a convention break the drift check must show');
  const home = homeAdrList(readFileSync(join(ROOT, 'brain/HOME.md'), 'utf8'));
  const d = adrDrift(r.value, home);
  assert.deepEqual({ homeOnly: d.homeOnly, filesOnly: d.filesOnly }, { homeOnly: [], filesOnly: [] });
  // The amendment trail exists as data now: ADR-0026 carries nine (Amendment 8 is #1124, 9 is #1141).
  const adr26 = r.value.find((a) => a.number === 26);
  assert.equal(adr26.amendments.length, 9);
  assert.equal(adr26.amendments[6].issue, 743);
  assert.equal(adr26.amendments[7].issue, 1124);
  assert.equal(adr26.amendments[8].issue, 1141);
  assert.equal(r.value.find((a) => a.number === 6).supersededBy, 30);
});
