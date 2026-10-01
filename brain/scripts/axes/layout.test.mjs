// layout.test.mjs — one directory per axis (issue #1141, the directory half of
// #1114 and #1128).
//
// Every adapter lives under `brain/scripts/axes/<axis>/adapters/`, and the three
// directories that used to hold them — one of which mixed three axes — are gone.
// This guard is written against the TREE, not against a list the move maintains:
// it was RED before the move (the old directories existed and `axes/` held no
// adapters) and turns red again if anyone recreates an old directory or drops an
// adapter out of its axis.
//
// What it does NOT check: which module a resolver loads. The resolvers are
// unchanged by #1141 and collapse in #1114.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPTS = join(dirname(fileURLToPath(import.meta.url)), '..');
const AXES = join(SCRIPTS, 'axes');

/** The directories #1141 retires. None may exist again. */
const RETIRED_DIRS = [
  'harness/backends',
  'memory/backends',
  'vcs/providers',
];

/**
 * The adapters each axis must hold (issue #1141's axis list). A dual-axis
 * adapter appears under both of its axes: one of the two files is the physical
 * module and the other a logic-free re-export (see the change's design.md).
 */
const EXPECTED_ADAPTERS = {
  memory: ['engram', 'plainfiles'],
  vcs: ['github', 'gitlab'],
  platform: ['claude', 'antigravity', 'plain'],
  'sdd-engine': ['gentle-ai', 'plain'],
  'review-engine': ['claude', 'codex', 'gemini'],
};

for (const rel of RETIRED_DIRS) {
  test(`#1141: brain/scripts/${rel}/ no longer exists`, () => {
    assert.equal(
      existsSync(join(SCRIPTS, rel)), false,
      `brain/scripts/${rel}/ must not exist — its adapters live under brain/scripts/axes/<axis>/adapters/`,
    );
  });
}

for (const [axis, adapters] of Object.entries(EXPECTED_ADAPTERS)) {
  test(`#1141: axes/${axis}/adapters/ holds ${adapters.join(', ')}`, () => {
    const dir = join(AXES, axis, 'adapters');
    assert.ok(
      existsSync(dir) && statSync(dir).isDirectory(),
      `brain/scripts/axes/${axis}/adapters/ must exist`,
    );
    const present = new Set(readdirSync(dir).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs')));
    for (const name of adapters) {
      assert.ok(present.has(`${name}.mjs`), `axes/${axis}/adapters/${name}.mjs must exist`);
    }
  });
}
