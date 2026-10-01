// provenance.test.mjs — unit + property tests for the §4 provenance grammar
// (issue #217, C2). Fixtures are anchored to consolidation-protocol.md §4's
// CANONICAL examples — never to real engram chunks (0/278 real observations
// carry §4 prose; this parser/renderer pair is for future records + the C4
// round-trip, not a description of the current store).
//
// RED: these imports fail until provenance.mjs is created.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseProvenance,
  renderProvenance,
  issueFromFuente,
  ACTOR_MARKER,
  FUENTE_MARKER,
  SUPERSEDE_MARKER,
} from './provenance.mjs';

// ── Markers are shared constants (never duplicated string literals) ─────────

test('the three §4 markers match the consolidation-protocol.md convention', () => {
  assert.equal(ACTOR_MARKER, '**Actor:**');
  assert.equal(FUENTE_MARKER, '**Fuente:**');
  assert.equal(SUPERSEDE_MARKER, '**Supersede:**');
});

// ── parseProvenance — canonical §4 examples ──────────────────────────────────

test('parseProvenance: recovers a human actor from the canonical (humano) example', () => {
  const content = '**Actor:** @crinaldi (humano)\n\nBody text here.';
  const result = parseProvenance(content);
  assert.equal(result.actor, '@crinaldi');
  assert.equal(result.actorKind, 'human');
  assert.equal(result.content, 'Body text here.');
});

test('parseProvenance: recovers an agent actor from the canonical (agente) example', () => {
  const content = '**Actor:** claude-sonnet-4-6 (agente)\n\nBody text here.';
  const result = parseProvenance(content);
  assert.equal(result.actor, 'claude-sonnet-4-6');
  assert.equal(result.actorKind, 'agent');
});

test('parseProvenance: recovers actor + source/issue together (actor+fuente combo)', () => {
  // Per consolidation-protocol.md §4: "Actor: First line of body" — Fuente
  // never appears without a leading Actor line in real prose.
  const content = '**Actor:** @crinaldi (humano)\n**Fuente:** issue #78 / MR !72\n\nBody text.';
  const result = parseProvenance(content);
  assert.equal(result.actor, '@crinaldi');
  assert.equal(result.actorKind, 'human');
  assert.equal(result.source, 'issue #78 / MR !72');
  assert.equal(result.issue, 78);
  assert.equal(result.content, 'Body text.');
});

test('parseProvenance: recovers actor + supersedes together (actor+supersede combo, no fuente)', () => {
  // Per consolidation-protocol.md §4: Actor is always the leading line —
  // Supersede without a preceding Actor line does not round-trip.
  const content = '**Actor:** @crinaldi (humano)\n**Supersede:** observación anterior "Spring prohibido"\n\nBody text.';
  const result = parseProvenance(content);
  assert.equal(result.actor, '@crinaldi');
  assert.equal(result.actorKind, 'human');
  assert.equal(result.supersedes, 'observación anterior "Spring prohibido"');
  assert.equal(result.source, undefined);
  assert.equal(result.content, 'Body text.');
});

test('parseProvenance: recovers all three fields together and strips the block from content', () => {
  const content =
    '**Actor:** @crinaldi (humano)\n**Fuente:** issue #78 / MR !72\n**Supersede:** observación anterior "Spring prohibido"\n\nActual body.\nSecond line.';
  const result = parseProvenance(content);
  assert.equal(result.actor, '@crinaldi');
  assert.equal(result.actorKind, 'human');
  assert.equal(result.source, 'issue #78 / MR !72');
  assert.equal(result.issue, 78);
  assert.equal(result.supersedes, 'observación anterior "Spring prohibido"');
  assert.equal(result.content, 'Actual body.\nSecond line.');
});

test('parseProvenance: content with no §4 prose returns it unchanged, all fields absent', () => {
  const content = 'Just a plain memory, no provenance block.';
  const result = parseProvenance(content);
  assert.equal(result.content, content);
  assert.equal(result.actor, undefined);
  assert.equal(result.actorKind, undefined);
  assert.equal(result.issue, undefined);
  assert.equal(result.supersedes, undefined);
  assert.equal(result.source, undefined);
});

// ── renderProvenance — the inverse ───────────────────────────────────────────

test('renderProvenance: renders the Actor line for a human actor', () => {
  const rendered = renderProvenance({ actor: '@crinaldi', actorKind: 'human', content: 'Body.' });
  assert.equal(rendered, '**Actor:** @crinaldi (humano)\n\nBody.');
});

test('renderProvenance: renders the Actor line for an agent actor', () => {
  const rendered = renderProvenance({ actor: 'claude-sonnet-4-6', actorKind: 'agent', content: 'Body.' });
  assert.equal(rendered, '**Actor:** claude-sonnet-4-6 (agente)\n\nBody.');
});

test('renderProvenance: with no provenance fields, content passes through unchanged', () => {
  const rendered = renderProvenance({ content: 'Just body.' });
  assert.equal(rendered, 'Just body.');
});

test('renderProvenance: renders all three lines in Actor/Fuente/Supersede order', () => {
  const rendered = renderProvenance({
    actor: '@crinaldi',
    actorKind: 'human',
    source: 'issue #78 / MR !72',
    issue: 78,
    supersedes: 'observación anterior "Spring prohibido"',
    content: 'Actual body.',
  });
  assert.equal(
    rendered,
    '**Actor:** @crinaldi (humano)\n**Fuente:** issue #78 / MR !72\n**Supersede:** observación anterior "Spring prohibido"\n\nActual body.',
  );
});

// ── issue #404: the Fuente line carries BOTH `issue` and `source` ───────────
// `issue` is in the id hashInput; `source` is not. `source` used to WIN the
// single Fuente line outright, so any record carrying both — where `source`
// did not happen to cite that same issue — re-imported WITHOUT its `issue`
// and hashed to a different id, turning REQ-C4-1 red.

test('renderProvenance: #404 — issue + a source that does NOT cite it renders BOTH (source no longer wins)', () => {
  const rendered = renderProvenance({
    actor: '@crinaldi',
    actorKind: 'human',
    issue: 404,
    source: 'PR #405',
    content: 'Body.',
  });
  assert.equal(rendered, '**Actor:** @crinaldi (humano)\n**Fuente:** issue #404 / PR #405\n\nBody.');
  assert.equal(parseProvenance(rendered).issue, 404, 'the hashed field must survive the round trip');
});

test('renderProvenance: #404 — a source ALREADY citing exactly this issue is emitted untouched (no duplicated citation)', () => {
  const rendered = renderProvenance({
    actor: '@crinaldi',
    actorKind: 'human',
    issue: 201,
    source: 'issue #201 / PR #204',
    content: 'Body.',
  });
  assert.equal(rendered, '**Actor:** @crinaldi (humano)\n**Fuente:** issue #201 / PR #204\n\nBody.');
  assert.equal(parseProvenance(rendered).issue, 201);
});

test('renderProvenance: #404 — a source citing a DIFFERENT issue is prepended, never trusted', () => {
  // The old renderer emitted `**Fuente:** issue #999` here, so the parse side
  // recovered 999: a silently CORRUPTED issue, worse than a dropped one.
  // The Actor line is the block ANCHOR — without it parseProvenance() recovers
  // nothing at all, so it must be present for this to assert anything.
  const rendered = renderProvenance({
    actor: '@crinaldi',
    actorKind: 'human',
    issue: 404,
    source: 'issue #999',
    content: 'Body.',
  });
  assert.equal(rendered, '**Actor:** @crinaldi (humano)\n**Fuente:** issue #404 / issue #999\n\nBody.');
  assert.equal(parseProvenance(rendered).issue, 404);
});

test('renderProvenance: #404 — a record with NEITHER issue nor source emits no Fuente line (unchanged)', () => {
  const rendered = renderProvenance({ actor: '@crinaldi', actorKind: 'human', content: 'Body.' });
  assert.equal(rendered, '**Actor:** @crinaldi (humano)\n\nBody.');
});

test('renderProvenance: #404 — source without issue is emitted verbatim (the @legacy shape, the whole real store)', () => {
  const source = 'provenance unknown — migrated from engram chunk obs-1034b42dcca30459';
  const rendered = renderProvenance({ actor: '@legacy', actorKind: 'human', source, content: 'Body.' });
  assert.equal(rendered, `**Actor:** @legacy (humano)\n**Fuente:** ${source}\n\nBody.`);
});

// ── issue #404: the Fuente slot holds exactly ONE physical line ─────────────
// renderProvenance() composes physical lines, so a `source` carrying a newline
// used to push its tail into the BODY — the issue citation fell off the Fuente
// line AND the hashed `content` gained bytes. renderFuente() narrows `source`
// to its first trimmed line so this cannot happen for ANY input, including a
// record already sitting in a consumer's store.

test('renderProvenance: #404 — a MULTI-LINE source is narrowed to its first line, and `issue` keeps the slot', () => {
  const rendered = renderProvenance({
    actor: '@crinaldi',
    actorKind: 'human',
    issue: 404,
    source: '\n\nissue #404',
    content: 'Body.',
  });
  assert.equal(rendered, '**Actor:** @crinaldi (humano)\n**Fuente:** issue #404\n\nBody.');
  const recovered = parseProvenance(rendered);
  assert.equal(recovered.issue, 404, 'the hashed field must not be displaced by the source tail');
  assert.equal(recovered.content, 'Body.', 'the hashed content must not gain the source tail');
});

test('renderProvenance: #404 — a multi-line source WITHOUT an issue keeps `content` intact', () => {
  const rendered = renderProvenance({
    actor: '@crinaldi',
    actorKind: 'human',
    source: 'see the tracker\n(context: issue #999)',
    content: 'Body.',
  });
  const recovered = parseProvenance(rendered);
  assert.equal(recovered.content, 'Body.', 'the second source line must not become body text');
  assert.equal(recovered.source, 'see the tracker');
  assert.equal(recovered.issue, undefined, 'a citation on a dropped line is not recovered');
});

test('renderProvenance: #404 — an empty/whitespace source is treated as absent (byte fixed point on the FIRST pass)', () => {
  // Previously `{issue: 404, source: ''}` rendered `**Fuente:** issue #404 / `,
  // which reparsed to `issue #404 /` — a fixed point only from the second pass.
  const once = renderProvenance({ actor: '@crinaldi', actorKind: 'human', issue: 404, source: '', content: 'Body.' });
  assert.equal(once, '**Actor:** @crinaldi (humano)\n**Fuente:** issue #404\n\nBody.');
  assert.equal(renderProvenance(parseProvenance(once)), once, 'first pass is already the fixed point');

  const blank = renderProvenance({ actor: '@crinaldi', actorKind: 'human', source: '   ', content: 'Body.' });
  assert.equal(blank, '**Actor:** @crinaldi (humano)\n\nBody.', 'no Fuente line for a source with no text');
});

test('issueFromFuente: ONE extraction rule, shared by both halves of the pair', () => {
  assert.equal(issueFromFuente('issue #78 / MR !72'), 78);
  assert.equal(issueFromFuente('issue #404'), 404);
  assert.equal(issueFromFuente('PR #405'), undefined, '# alone is not an issue citation');
  assert.equal(issueFromFuente('provenance unknown — migrated from engram chunk obs-abc'), undefined);
  assert.equal(issueFromFuente(''), undefined);
  assert.equal(issueFromFuente(undefined), undefined);
});

// ── BLOCKER-1: provenance is ONLY the leading block — body content that ────
// happens to contain marker-shaped lines must never be scraped, and the
// round trip must be byte-lossless. Repro: a record whose BODY contains
// `**Actor:**`/`**Fuente:**`/`**Supersede:**`-shaped lines used to get those
// lines wrongly hoisted into fields and stripped from content.

test('parseProvenance: BLOCKER-1 — marker-shaped lines in the BODY (not the leading block) are never scraped; round-trip is byte-lossless', () => {
  const record = {
    actor: '@x',
    actorKind: 'human',
    content: 'Real body.\n**Actor:** @fake (humano)\n**Fuente:** fake source\n**Supersede:** old\nmore',
  };
  const rendered = renderProvenance(record);
  const recovered = parseProvenance(rendered);
  assert.equal(recovered.content, record.content, 'content must survive round-trip byte-for-byte');
  assert.equal(recovered.actor, record.actor);
  assert.equal(recovered.actorKind, record.actorKind);
  assert.equal(recovered.source, undefined, 'no field may be fabricated from the body');
  assert.equal(recovered.supersedes, undefined, 'no field may be fabricated from the body');
});

// ── Property test (mandatory): parse(render(record)) recovers exact fields ──
// Fixtures anchored to consolidation-protocol.md §4 canonical examples.

const FIXTURES = [
  {
    actor: '@crinaldi',
    actorKind: 'human',
    source: 'issue #78 / MR !72',
    issue: 78,
    supersedes: 'observación anterior "Spring prohibido"',
    content: 'A full record with every provenance field.',
  },
  {
    actor: 'claude-sonnet-4-6',
    actorKind: 'agent',
    source: 'issue #201',
    issue: 201,
    content: 'An agent-authored record with no supersede.',
  },
  {
    actor: '@crinaldi',
    actorKind: 'human',
    content: 'A record with only the actor declared — no Fuente, no Supersede.',
  },
  {
    actor: '@crinaldi',
    actorKind: 'human',
    supersedes: 'observación anterior "Spring prohibido"',
    content: 'A record with actor + supersede declared — no Fuente.',
  },
  {
    // issue #404: `issue` alongside a `source` that does NOT cite it. The
    // render side used to let `source` WIN and drop `issue` entirely.
    actor: '@crinaldi',
    actorKind: 'human',
    issue: 404,
    source: 'PR #405',
    content: 'The shape that broke REQ-C4-1: issue + a source citing something else.',
    // `source` is hash-excluded and widens by design — asserted separately below.
    sourceRoundTripsTo: 'issue #404 / PR #405',
  },
  {
    // issue #404: `issue` alongside a `source` citing a DIFFERENT issue. The
    // old render emitted only `source`, so the parse side recovered 999 — a
    // silently CORRUPTED `issue`, not merely a dropped one.
    actor: 'claude-sonnet-4-6',
    actorKind: 'agent',
    issue: 404,
    source: 'superseded by issue #999',
    content: 'issue + a source citing a different issue.',
    sourceRoundTripsTo: 'issue #404 / superseded by issue #999',
  },
  {
    // issue #404: `issue` with no `source` at all.
    actor: '@crinaldi',
    actorKind: 'human',
    issue: 368,
    content: 'issue alone, no source text.',
    sourceRoundTripsTo: 'issue #368',
  },
  {
    // issue #404: a MULTI-LINE `source` — the shape that used to displace the
    // citation off the Fuente line and prepend its tail to the hashed content.
    actor: '@crinaldi',
    actorKind: 'human',
    issue: 404,
    source: '\n\nissue #404',
    content: 'A multi-line source may not leak into the body.',
    sourceRoundTripsTo: 'issue #404',
  },
  {
    // issue #404: an EMPTY `source` — absent, not an empty Fuente slot.
    actor: '@crinaldi',
    actorKind: 'human',
    issue: 404,
    source: '',
    content: 'An empty source is absent, and the first render is already the fixed point.',
    sourceRoundTripsTo: 'issue #404',
  },
];

for (const [i, fixture] of FIXTURES.entries()) {
  test(`property: parse(render(record)) recovers exact fields — fixture ${i}`, () => {
    const rendered = renderProvenance(fixture);
    const recovered = parseProvenance(rendered);
    assert.equal(recovered.actor, fixture.actor);
    assert.equal(recovered.actorKind, fixture.actorKind);
    // `issue` is EXACT — it is in the id hashInput (format.mjs#computeRecordId),
    // so a dropped or altered value is a different record id (issue #404).
    assert.equal(recovered.issue, fixture.issue);
    assert.equal(recovered.supersedes, fixture.supersedes);
    // `source` is hash-excluded, so it may widen to carry the issue citation.
    assert.equal(recovered.source, fixture.sourceRoundTripsTo ?? fixture.source);
    assert.equal(recovered.content, fixture.content);
  });

  test(`property: render is idempotent from the second pass on — fixture ${i}`, () => {
    // The widened `source` must be a FIXED POINT: re-rendering the recovered
    // record may not keep prepending citations on every share/import cycle.
    const once = renderProvenance(fixture);
    const twice = renderProvenance(parseProvenance(once));
    assert.equal(twice, once);
  });
}

// ── Ruling 3b (CP-C2 re-split): malformed / partial §4 prose ────────────────
// PINNED POLICY (see openspec/changes/issue-217.../design.md §"Malformed §4
// prose"): the Actor line is the block ANCHOR and is all-or-nothing — it must
// carry a well-formed `@actor (humano|agente)` pair or NO provenance block is
// recognized (the whole content, malformed prose included, is returned as body
// so the export's @legacy fallback preserves it verbatim, never silently
// dropped). The optional Fuente/Supersede lines are best-effort and
// order-anchored: a malformed one ends the block and stays in content.

test('parseProvenance: Actor line without a (kind) is NOT a block — no recovery, content preserved verbatim', () => {
  const content = `${ACTOR_MARKER} @crinaldi\nbody line`;
  const parsed = parseProvenance(content);
  assert.equal(parsed.actor, undefined, 'a kind-less Actor line must not anchor a block');
  assert.equal(parsed.content, content, 'the malformed prose must remain in content, never dropped');
});

test('parseProvenance: Actor line with an unknown kind (robot) is NOT a block — no recovery, content preserved', () => {
  const content = `${ACTOR_MARKER} @crinaldi (robot)\nbody line`;
  const parsed = parseProvenance(content);
  assert.equal(parsed.actor, undefined, 'an out-of-enum kind must not anchor a block');
  assert.equal(parsed.content, content);
});

test('parseProvenance: valid Actor + malformed Fuente → actor recovered, the malformed Fuente stays in body (partial, best-effort optionals)', () => {
  const content = `${ACTOR_MARKER} @crinaldi (humano)\n${FUENTE_MARKER}\nbody line`;
  const parsed = parseProvenance(content);
  assert.equal(parsed.actor, '@crinaldi', 'the well-formed anchor still recovers');
  assert.equal(parsed.actorKind, 'human');
  assert.equal(parsed.source, undefined, 'an empty Fuente line is not a source');
  assert.equal(parsed.content, `${FUENTE_MARKER}\nbody line`, 'the malformed optional line remains in body');
});
