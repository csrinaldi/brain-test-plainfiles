// plainfiles-roundtrip.integration.test.mjs — REQ-C3-6, CP-C3 evidence: the
// round-trip proving the durability claim is not n=1. Reuses C4's
// already-proven `importMemory` seam — hermetic, no live engram binary and
// no live git spawned in `npm test`. The engram → plainfiles direction this
// file once also covered (via `dualWriteRecords`) retired with that
// function (#955 R5, epic task 2.4) — `share()` had no caller wired to it
// since #874 split B, and #955 deleted it outright rather than giving it
// one. The plainfiles → engram direction and the durability check below are
// unaffected.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { importMemory } from '../../axes/memory/adapters/engram.mjs';
import { save } from '../../axes/memory/adapters/plainfiles.mjs';
import { RECORD_TYPES } from './format.mjs';

// #820: a faked backend has no store to protect — never take the real machine guard from a test.
const noGuard = () => ({ held: true, release() {} });


function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

// #738: a deterministic identity, so this suite's verdict does not depend on
// this machine's ambient git config / process env.
const identitySeams = {
  getGitConfig: (key) => (key === 'brain.actor' ? '@fixture' : null),
  getEnv: () => ({}),
};

// ── plainfiles → engram: save() into a temp root, importMemory() captures the engram-save calls ──

test('REQ-C3-6: plainfiles → engram round-trips with record-level equality, no live engram/git', async () => {
  const root = tmpRoot('c3-roundtrip-p2e-');
  try {
    const seams = {
      getBranch: () => 'fixture-branch', getTimestamp: () => '2026-07-01T00:00:00Z', getHostname: () => 'fixture-host',
      ...identitySeams,
    };
    const saved = [];
    for (const type of RECORD_TYPES) {
      const result = await save(`P2E ${type}`, `${type} content from plainfiles`, { type, project: 'brain' }, { root, ...seams });
      saved.push(result);
    }

    // #433: the import is now ONE batch rather than one `engram save` per
    // record. The round-trip guarantee this test exists for is unchanged —
    // every saved record reaches engram, keyed by its content-addressed id —
    // only the seam it is observed through moved.
    //
    // `_engramExistingTopicKeys` is stubbed deliberately: its default shells out
    // to `engram export`, and this test's whole contract is "no live
    // engram/git". Without the stub it would silently start needing a real
    // binary, which is exactly the hermeticity the name promises.
    const captured = [];
    const importResult = await importMemory({
      _guard: noGuard,
      root,
      _requireEngram: () => 'engram',
      _engramExistingTopicKeys: () => new Set(),
      _engramImport: (payload) => { captured.push(...payload.observations); },
    });
    assert.equal(importResult.written, saved.length, 'importMemory must import exactly what save() wrote');

    for (const s of saved) {
      const o = captured.find((c) => c.topic_key === s.id);
      assert.ok(o, `expected an imported observation with topic_key === record id ${s.id} (the idempotency anchor)`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── durability is executable, not asserted ──────────────────────────────────

test('REQ-C3-6: durability is executable — a plain Node grep of records/*.jsonl answers a decision topic, no engram/rg', async () => {
  const root = tmpRoot('c3-roundtrip-durability-');
  try {
    const seams = {
      getBranch: () => 'main', getTimestamp: () => '2026-07-01T00:00:00Z', getHostname: () => 'h',
      ...identitySeams,
    };
    const decisionText = 'the durability decision: plainfiles ships as the second real backend';
    await save('Durability decision', decisionText, { type: 'decision', project: 'brain' }, { root, ...seams });

    const recordsDir = join(root, '.memory', 'records');
    const files = readdirSync(recordsDir);
    const found = files.some((f) => readFileSync(join(recordsDir, f), 'utf8').includes(decisionText));
    assert.ok(found, 'a plain Node read/grep of records/*.jsonl must retrieve the known decision content — no engram, no rg');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
