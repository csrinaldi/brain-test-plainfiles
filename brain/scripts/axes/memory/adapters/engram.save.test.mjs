// engram.save.test.mjs — unit tests for axes/memory/adapters/engram.mjs#save (#874, split
// A). Mirrors plainfiles.save.test.mjs's seam-injection discipline: every
// seam (root, getBranch, getTimestamp, getHostname, getGitConfig, getEnv,
// plus the engram-only `_hydrate` terminal step) is injected, so no real
// git/clock/hostname/env/engram dependency runs in `npm test`.
//
// R1: this file mirrors plainfiles.save.test.mjs's cases on purpose — the two
// bodies are duplicated (R1), and the parity table (save-parity.test.mjs)
// pins that they refuse identically. `_hydrate` is stubbed here to isolate
// save()'s own gate order from hydrate()'s own behaviour (covered by
// engram.hydrate.test.mjs).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { save } from './engram.mjs';
import { appendRecord as appendRecordReal, rebuildIndex as rebuildIndexReal } from '../../../memory/lib/store.mjs';

function tmpRoot() {
  return mkdtempSync(join(tmpdir(), 'engram-save-'));
}

const identitySeams = {
  getGitConfig: (key) => (key === 'brain.actor' ? '@test' : null),
  getEnv: () => ({}),
};

const noopHydrate = async () => ({ written: 0, skipped: 0 });

// ── happy path — record + index + the hydrate seam is called as the terminal step ──

test('save: a clean input writes a record, rebuilds the index, and calls hydrate as the terminal step', async () => {
  const root = tmpRoot();
  try {
    const calls = [];
    const result = await save('a title', 'the body', { type: 'discovery', project: 'brain' }, {
      root,
      getBranch: () => 'main',
      getTimestamp: () => '2026-09-10T09:00:00Z',
      getHostname: () => 'my-host',
      ...identitySeams,
      _hydrate: async (args) => {
        calls.push(args);
        return { written: 1, skipped: 0 };
      },
    });

    assert.equal(result.written, true);
    assert.equal(result.hydrated, true, 'hydrated must reflect the _hydrate seam result');
    assert.ok(result.id.startsWith('rec-'));
    assert.ok(existsSync(result.file));

    assert.equal(calls.length, 1, 'hydrate must be called exactly once, as the terminal step');
    assert.equal(calls[0].recordId, result.id);
    assert.equal(calls[0].record.id, result.id);

    const indexPath = join(root, '.memory', 'index.jsonl');
    assert.ok(existsSync(indexPath), 'index.jsonl must be rebuilt after a successful save');
    const indexRaw = readFileSync(indexPath, 'utf8');
    assert.ok(indexRaw.includes(result.id));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── cold review C1 (#924): composeSource() must name the backend that
// actually ran, not a hardcoded 'plainfiles' ─────────────────────────────

test('save: source names "engram", not "plainfiles" (cold review C1)', async () => {
  const root = tmpRoot();
  try {
    const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root,
      getBranch: () => 'main',
      getTimestamp: () => '2026-09-10T09:00:00Z',
      getHostname: () => 'my-host',
      ...identitySeams,
      _hydrate: noopHydrate,
    });
    const record = JSON.parse(readFileSync(result.file, 'utf8').trim());
    assert.ok(
      record.source.startsWith('engram save on '),
      `expected source to start with 'engram save on ', got: ${record.source}`,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── caller-mistake refusals — FIRST of all, fixable in the same second ─────

test('save: refuses when type is missing, naming the seven-member enum', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(
      () => save('t', 'c', { project: 'brain' }, { root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h', ...identitySeams, _hydrate: noopHydrate }),
      (err) => {
        assert.match(err.message, /type/i);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('save: refuses a non-integer --issue', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(
      () => save('t', 'c', { type: 'discovery', project: 'brain', issue: 'abc' }, { root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h', ...identitySeams, _hydrate: noopHydrate }),
    );
    assert.equal(existsSync(join(root, '.memory', 'records')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── actor gate — BEFORE any store read ──────────────────────────────────────

test('save: an unset actor refuses BEFORE the store is ever read (_readRecordIds never called)', async () => {
  const root = tmpRoot();
  try {
    let readRecordIdsCalled = false;
    await assert.rejects(() =>
      save('t', 'c', { type: 'discovery', project: 'brain', supersedes: 'rec-0123456789abcdef' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
        getGitConfig: () => null, getEnv: () => ({}),
        _readRecordIds: () => { readRecordIdsCalled = true; return new Set(); },
        _hydrate: noopHydrate,
      }),
    );
    assert.equal(readRecordIdsCalled, false, 'the actor refusal must fire before the supersedes gate reads the store');
    assert.equal(existsSync(join(root, '.memory', 'records')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('save: a malformed brain.actor refuses, naming the remedy', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(
      () => save('t', 'c', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
        getGitConfig: (key) => (key === 'brain.actor' ? 'no-at-sign' : null), getEnv: () => ({}),
        _hydrate: noopHydrate,
      }),
      /git config --local brain\.actor/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('save: the reserved @legacy actor refuses', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(() =>
      save('t', 'c', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
        getGitConfig: (key) => (key === 'brain.actor' ? '@legacy' : null), getEnv: () => ({}),
        _hydrate: noopHydrate,
      }),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── derived issue notice ────────────────────────────────────────────────────

test('save: an issue derived from the branch prints a notice', async () => {
  const root = tmpRoot();
  const orig = console.log;
  const logs = [];
  console.log = (...args) => logs.push(args.join(' '));
  try {
    await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root, getBranch: () => 'feat/issue-874-record-first', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
      ...identitySeams, _hydrate: noopHydrate,
    });
    assert.ok(logs.some((l) => l.includes('874')), `expected a derived-issue notice: ${JSON.stringify(logs)}`);
  } finally {
    console.log = orig;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── --supersedes: malformed touches no IO ───────────────────────────────────

test('save: a malformed --supersedes id touches no IO and no write', async () => {
  const root = tmpRoot();
  try {
    let appendCalled = false;
    await assert.rejects(() =>
      save('t', 'c', { type: 'discovery', project: 'brain', supersedes: 'not-shaped-right' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
        ...identitySeams,
        _appendRecord: () => { appendCalled = true; return { file: 'x' }; },
        _hydrate: noopHydrate,
      }),
    );
    assert.equal(appendCalled, false);
    assert.equal(existsSync(join(root, '.memory', 'records')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── scope/topic — warn loudly, never silently dropped ───────────────────────

test('save: warns when --scope/--topic are passed, naming both', async () => {
  const root = tmpRoot();
  const orig = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    const result = await save('t', 'c', { type: 'discovery', project: 'brain', scope: 'project', topic: 'sdd/x/y' }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
      ...identitySeams, _hydrate: noopHydrate,
    });
    assert.equal(result.written, true);
    assert.ok(warnings.some((w) => w.includes('scope') && w.includes('topic')), `expected a warning naming scope/topic: ${JSON.stringify(warnings)}`);
    // E2 (cold review #924): engram's own warning must not reuse plainfiles'
    // text — on engram, scope/topic are not "unsupported by the format", they
    // are DISCARDED and replaced by hydrate's own values (scope: 'project',
    // topic: the record's own id).
    assert.ok(
      !warnings.some((w) => w.toLowerCase().includes('plainfiles')),
      `engram save() must not warn with plainfiles-flavored text: ${JSON.stringify(warnings)}`,
    );
    assert.ok(
      warnings.some((w) => w.toLowerCase().includes('discard')),
      `expected the warning to say scope/topic are discarded, not merely unsupported: ${JSON.stringify(warnings)}`,
    );
  } finally {
    console.warn = orig;
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #637 — index rebuild failure is an annotated rethrow, not "save failed" ─

// ── #469 re-proof (R10): a secret in `content` never reaches disk — neither
// `.memory/records/*.jsonl` nor the engram store. Two tests: (i) the refusal
// itself, with every downstream seam proved unreachable; (ii) the call order
// on a clean input, scan → append → hydrate, never any other order.

test('save (R10, i): a secret in content throws — _appendRecord, _rebuildIndex, and _engramSave (via _hydrate) are never called', async () => {
  const root = tmpRoot();
  try {
    let appendCalled = false;
    let rebuildCalled = false;
    let hydrateCalled = false;
    await assert.rejects(() =>
      save('leaked token', 'ghp_abcdefghijklmnopqrstuvwx', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
        ...identitySeams,
        _appendRecord: () => { appendCalled = true; return { file: 'x' }; },
        _rebuildIndex: () => { rebuildCalled = true; return { count: 0 }; },
        _hydrate: async () => { hydrateCalled = true; return { written: 0, skipped: 0 }; },
      }),
    );
    assert.equal(appendCalled, false, 'appendRecord must never run when a secret is found');
    assert.equal(rebuildCalled, false, 'rebuildIndex must never run when a secret is found');
    assert.equal(hydrateCalled, false, 'hydrate (and so _engramSave) must never run when a secret is found');
    assert.equal(existsSync(join(root, '.memory', 'records')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('save (R10, ii): on a clean input, the call order is scan → append → hydrate — never any other order', async () => {
  const root = tmpRoot();
  try {
    const order = [];
    await save('t', 'clean content, no secret here', { type: 'discovery', project: 'brain' }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
      ...identitySeams,
      _appendRecord: (record, opts) => { order.push('append'); return appendRecordReal(record, opts); },
      _rebuildIndex: (opts) => { order.push('rebuildIndex'); return rebuildIndexReal(opts); },
      _hydrate: async () => { order.push('hydrate'); return { written: 1, skipped: 0 }; },
    });
    // The scan itself has no seam (scanTextForSecrets runs inline, synchronously,
    // before _appendRecord is ever reached) — its position is proved by the FIRST
    // logged call being 'append', never 'hydrate' or 'rebuildIndex' out of order.
    assert.deepEqual(order, ['append', 'rebuildIndex', 'hydrate']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('save: a rebuildIndex failure is annotated and rethrown (#637) — the record is already durable', async () => {
  const root = tmpRoot();
  try {
    await assert.rejects(
      () => save('t', 'c', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
        ...identitySeams,
        _rebuildIndex: () => { throw new Error('boom — index corrupt'); },
        _hydrate: noopHydrate,
      }),
      (err) => {
        assert.equal(err.indexFailed, true);
        assert.ok(err.recordId.startsWith('rec-'));
        assert.ok(err.recordFile);
        assert.match(err.message, /boom/);
        return true;
      },
    );
    // the record itself IS on disk — the append happened before the index rebuild.
    const recordsDir = join(root, '.memory', 'records');
    assert.ok(existsSync(recordsDir));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── #712 — a secret policy that cannot be read is not the default secret
// policy. `_loadConfig` is NOT injected in either test below — it is the
// unit. Every OTHER seam a step past the read could throw on is neutralized
// with `identitySeams` (a VALID `@test` handle) — without it, an unset
// `brain.actor` would throw its OWN refusal just three lines after the
// config read (`engram.mjs:964`, right after `:952`), and T-E1 would pass
// for that wrong reason instead of the config read under test.

test('T-E1 — an unreadable brain.config.json makes save() reject with the primitive\'s message, and _appendRecord is never called (#712, REQ-SCAN-1/4)', async () => {
  const root = tmpRoot();
  try {
    // present but unparseable, at `root` — the exact path `_defaultLoadBrainConfig` reads.
    writeFileSync(join(root, 'brain.config.json'), '{ not valid json', 'utf8');

    let appendCalled = false;
    await assert.rejects(
      () => save('t', 'c', { type: 'discovery', project: 'brain' }, {
        root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
        ...identitySeams,
        _appendRecord: () => { appendCalled = true; return { file: 'x' }; },
        _rebuildIndex: () => ({ count: 0 }),
        _hydrate: noopHydrate,
      }),
      (err) => {
        assert.match(err.message, /brain\.config\.json/, 'the message must name the file');
        assert.match(err.message, /could not be parsed/, 'the message must name the failure kind');
        return true;
      },
    );
    assert.equal(appendCalled, false, '_appendRecord must never run when the config read refuses');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('T-E2 — no brain.config.json at all leaves save() on the default pattern set, record written (#712, REQ-SCAN-3)', async () => {
  const root = tmpRoot();
  try {
    // no brain.config.json written — tmpRoot() never creates one.
    const result = await save('t', 'c', { type: 'discovery', project: 'brain' }, {
      root, getBranch: () => 'main', getTimestamp: () => '2026-09-10T09:00:00Z', getHostname: () => 'h',
      ...identitySeams,
      _hydrate: noopHydrate,
    });
    assert.equal(result.written, true, 'the absent-config case must not refuse — the default pattern set applies');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
