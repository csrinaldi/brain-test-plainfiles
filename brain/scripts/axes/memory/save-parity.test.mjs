// save-parity.test.mjs — R2: `engram.save()` and `plainfiles.save()` MUST
// refuse the same inputs in the same order and, when accepted, emit records
// of the same shape (record-id parity). Drift between the two duplicated
// bodies (R1) is pinned here rather than by a shared-core refactor.
//
// engram's `_hydrate` seam is stubbed to a no-op in every case below, so this
// file compares ONLY the record shape — hydration itself is proved by
// engram.hydrate.test.mjs and the call-order pair in engram.save.test.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { save as plainfilesSave } from './adapters/plainfiles.mjs';
import { save as engramSave } from './adapters/engram.mjs';

function tmpRoot(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

const noopHydrate = async () => ({ written: 0, skipped: 0 });

const identitySeams = {
  getGitConfig: (key) => (key === 'brain.actor' ? '@test' : null),
  getEnv: () => ({}),
};

function pinnedSeams(root) {
  return {
    root,
    getBranch: () => 'main',
    getTimestamp: () => '2026-09-10T09:00:00Z',
    getHostname: () => 'parity-host',
    ...identitySeams,
    _hydrate: noopHydrate, // engram-only seam; harmlessly ignored by plainfiles.save
  };
}

// ── refusal parity — the SAME table drives both backends ───────────────────

const REFUSAL_CASES = [
  { name: 'type is missing', opts: { project: 'brain' } },
  { name: '--issue is not an integer', opts: { type: 'discovery', project: 'brain', issue: 'abc' } },
  {
    name: '--supersedes is not shaped like a record id',
    opts: { type: 'discovery', project: 'brain', supersedes: 'not-a-record-id' },
  },
];

for (const { name, opts } of REFUSAL_CASES) {
  test(`save-parity: both backends refuse the same input — ${name}`, async () => {
    const plainRoot = tmpRoot('parity-plain-');
    const engramRoot = tmpRoot('parity-engram-');
    try {
      await assert.rejects(() => plainfilesSave('t', 'c', opts, pinnedSeams(plainRoot)), `plainfiles must refuse: ${name}`);
      await assert.rejects(() => engramSave('t', 'c', opts, pinnedSeams(engramRoot)), `engram must refuse: ${name}`);
    } finally {
      rmSync(plainRoot, { recursive: true, force: true });
      rmSync(engramRoot, { recursive: true, force: true });
    }
  });
}

test('save-parity: an unconfigured actor refuses on both backends identically', async () => {
  const plainRoot = tmpRoot('parity-plain-actor-');
  const engramRoot = tmpRoot('parity-engram-actor-');
  const noActorSeams = (root) => ({
    root,
    getBranch: () => 'main',
    getTimestamp: () => '2026-09-10T09:00:00Z',
    getHostname: () => 'parity-host',
    getGitConfig: () => null,
    getEnv: () => ({}),
    _hydrate: noopHydrate,
  });
  try {
    await assert.rejects(() => plainfilesSave('t', 'c', { type: 'discovery', project: 'brain' }, noActorSeams(plainRoot)));
    await assert.rejects(() => engramSave('t', 'c', { type: 'discovery', project: 'brain' }, noActorSeams(engramRoot)));
  } finally {
    rmSync(plainRoot, { recursive: true, force: true });
    rmSync(engramRoot, { recursive: true, force: true });
  }
});

// ── acceptance parity — one clean input, pinned seams, SAME record id ──────

test('save-parity: a clean input under pinned seams produces the SAME record id on both backends', async () => {
  const plainRoot = tmpRoot('parity-plain-clean-');
  const engramRoot = tmpRoot('parity-engram-clean-');
  try {
    const opts = { type: 'discovery', project: 'brain' };
    const plainResult = await plainfilesSave('a title', 'the body', opts, pinnedSeams(plainRoot));
    const engramResult = await engramSave('a title', 'the body', opts, pinnedSeams(engramRoot));

    assert.equal(plainResult.written, true);
    assert.equal(engramResult.written, true);
    assert.equal(
      engramResult.id,
      plainResult.id,
      'the same inputs under the same pinned seams must hash to the same record id',
    );

    const plainRecord = JSON.parse(readFileSync(plainResult.file, 'utf8').trim());
    const engramRecord = JSON.parse(readFileSync(engramResult.file, 'utf8').trim());
    assert.equal(engramRecord.id, plainRecord.id);
    assert.equal(engramRecord.type, plainRecord.type);
    assert.equal(engramRecord.actor, plainRecord.actor);
    assert.equal(engramRecord.actorKind, plainRecord.actorKind);
    assert.equal(engramRecord.content, plainRecord.content);
  } finally {
    rmSync(plainRoot, { recursive: true, force: true });
    rmSync(engramRoot, { recursive: true, force: true });
  }
});
