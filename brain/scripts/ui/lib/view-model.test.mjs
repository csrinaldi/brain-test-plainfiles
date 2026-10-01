// view-model.test.mjs — the four-mode view model (#998 R998-2). Pure,
// imported by the browser and by node:test (D9): no DOM, no clock.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MODES, MODE_IDS, PLACEHOLDERS, initialView, switchMode, nextMode, keyAction } from './view-model.mjs';

test('#998 R998-2: the four modes, in a fixed order, each with a non-empty label', () => {
  // #1059: three modes, not four. The maintainer's rule — per-ticket detail
  // belongs in the panel a ticket opens, the top level is for what is true of
  // the whole project. Implementation slices and Reviews were per-ticket
  // questions wearing a project-wide hat; the panel already answers both, and
  // their project-wide projections moved under Governance, where global lives.
  assert.deepEqual(MODE_IDS, ['map', 'governance', 'memory']);
  for (const mode of MODES) {
    assert.equal(typeof mode.id, 'string');
    assert.equal(typeof mode.label, 'string');
    assert.ok(mode.label.length > 0, `mode "${mode.id}" has no label`);
  }
});

test('#998 R998-2/#882 R882-1/#1059: every mode has real content, and the table carries no mode that does not', () => {
  assert.equal(PLACEHOLDERS.map, null, 'map draws the canvas + drawer, not a placeholder');
  assert.equal(PLACEHOLDERS.governance, null, '#882 R882-1: governance mounts its own sub-nav and sub-router');
  assert.equal(PLACEHOLDERS.memory, null, '#1059: memory draws the .memory/records ledger');
  assert.deepEqual(Object.keys(PLACEHOLDERS).sort(), [...MODE_IDS].sort(),
    'the placeholder table and the mode table name the same modes — a retable that updates one and not the other leaves a mode that routes nowhere');
});

test('#998 R998-2: initialView starts on map', () => {
  assert.equal(initialView(), 'map');
});

test('#998 R998-2: Tab cycles every mode in order and wraps back to map', () => {
  let view = initialView();
  const seen = [view];
  for (let i = 0; i < MODE_IDS.length; i += 1) {
    view = keyAction(view, 'Tab', { nodes: [], selected: null }).mode;
    seen.push(view);
  }
  assert.deepEqual(seen, ['map', 'governance', 'memory', 'map']);
});

test('#998 R998-2: switchMode validates the target mode; nextMode validates the current view', () => {
  assert.equal(switchMode('map', 'memory'), 'memory');
  assert.throws(() => switchMode('map', 'bogus'), /unknown mode/);
  assert.throws(() => nextMode('bogus'), /unknown mode/);
});

// ── J/K traversal fixture matrix: 0 nodes, 1 node, many; selected at the
// first, at the last, at none ──────────────────────────────────────────────

test('#998 R998-2: j/k on an empty canvas selects nothing', () => {
  assert.deepEqual(keyAction('map', 'j', { nodes: [], selected: null }), { type: 'none' });
  assert.deepEqual(keyAction('map', 'k', { nodes: [], selected: null }), { type: 'none' });
});

test('#998 R998-2: j/k on a single node selects it from no selection, and wraps to itself at either end', () => {
  const nodes = [{ number: 5, x: 0, y: 0 }];
  assert.deepEqual(keyAction('map', 'j', { nodes, selected: null }), { type: 'select', issue: 5 });
  assert.deepEqual(keyAction('map', 'k', { nodes, selected: null }), { type: 'select', issue: 5 });
  assert.deepEqual(keyAction('map', 'j', { nodes, selected: 5 }), { type: 'select', issue: 5 });
  assert.deepEqual(keyAction('map', 'k', { nodes, selected: 5 }), { type: 'select', issue: 5 });
});

test('#998 R998-2: j/k traverse many nodes in reading order (top-to-bottom, left-to-right) and wrap at both ends', () => {
  const nodes = [
    { number: 3, x: 100, y: 0 },
    { number: 1, x: 0, y: 0 },
    { number: 2, x: 0, y: 50 },
  ];
  // reading order: #1 (y0,x0), #3 (y0,x100), #2 (y50,x0)
  assert.deepEqual(keyAction('map', 'j', { nodes, selected: null }), { type: 'select', issue: 1 }, 'j with no selection starts at the first');
  assert.deepEqual(keyAction('map', 'k', { nodes, selected: null }), { type: 'select', issue: 2 }, 'k with no selection starts at the last');
  assert.deepEqual(keyAction('map', 'j', { nodes, selected: 1 }), { type: 'select', issue: 3 });
  assert.deepEqual(keyAction('map', 'j', { nodes, selected: 3 }), { type: 'select', issue: 2 });
  // at the last node: j wraps to the first instead of stopping silently
  assert.deepEqual(keyAction('map', 'j', { nodes, selected: 2 }), { type: 'select', issue: 1 });
  // at the first node: k wraps to the last instead of stopping silently
  assert.deepEqual(keyAction('map', 'k', { nodes, selected: 1 }), { type: 'select', issue: 2 });
});

test('#998 R998-2: Escape closes the door only when something is selected', () => {
  assert.deepEqual(keyAction('map', 'Escape', { nodes: [], selected: null }), { type: 'none' });
  assert.deepEqual(keyAction('map', 'Escape', { nodes: [], selected: 7 }), { type: 'close' });
});

test('#998 R998-2: an unknown key is a no-op', () => {
  assert.deepEqual(keyAction('map', 'z', { nodes: [], selected: null }), { type: 'none' });
});

// ── #1059 phase 2: the design gives each mode a glyph ──────────────────────
// The buttons ARE this table (R998-2), so the glyph belongs here beside the
// label — not in the page, where it would be a second copy of the mode list.
test('#1059 region 02: every mode carries the glyph the design draws beside its name', () => {
  const glyphs = MODES.map((m) => m.glyph);
  assert.deepEqual(glyphs, ['●', '▦', '◈'], 'map, governance, memory — one mark per mode, in the table\'s order (#1059 retabled these from four)');
  assert.equal(new Set(glyphs).size, glyphs.length, 'no two modes share a mark, or the nav says two things with one symbol');
  for (const mode of MODES) {
    assert.equal(typeof mode.label, 'string');
    assert.ok(mode.label.length > 0, 'the glyph is beside the word, never instead of it');
  }
});
