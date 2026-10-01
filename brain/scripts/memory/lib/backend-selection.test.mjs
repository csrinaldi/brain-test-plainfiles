// backend-selection.test.mjs — issue #641, the decision and the probe.
//
// Two things are pinned here and they are different in kind:
//
//   1. `probeBinary` is THREE-valued. The whole fallback rests on being able to
//      say "engram is not here" without also saying it when the check itself
//      broke. A two-valued probe is how `evidence-reader-empty-on-failure` gets
//      built, and here it would silently switch someone's backend on the
//      strength of a missing `which`.
//   2. `selectBackend` substitutes on THREE conditions and no fewer. Each test
//      below removes exactly one of them and asserts the substitution does not
//      happen — otherwise the conjunction is untested and any one of the three
//      could be deleted with the suite still green.
//
// The end-to-end half — that a human actually HEARS this — is in
// cli.backend-fallback.test.mjs, which drives the real CLI in a child process.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_BACKEND,
  ENGRAM_BIN,
  FALLBACK_BACKEND,
  FALLBACK_OPS,
  REASON,
  probeBinary,
  selectBackend,
} from './backend-selection.mjs';

// ── probeBinary: present / absent / undetermined are three answers ───────────

test('#641 probeBinary: exit 0 is PRESENT', () => {
  const r = probeBinary('engram', { _spawn: () => ({ status: 0 }) });
  assert.deepStrictEqual(r, { available: true });
});

test('#641 probeBinary: a non-zero exit is ABSENT — the probe ran and answered', () => {
  const r = probeBinary('engram', { _spawn: () => ({ status: 1 }) });
  assert.deepStrictEqual(r, { available: false });
});

test('#641 probeBinary: spawnSync reporting its OWN failure is UNDETERMINED, not absent', () => {
  // The real shape on a container with no `which`: spawnSync returns an object
  // AND sets .error, rather than throwing. Before #641 this landed in
  // `status !== 0` and was reported as "engram binary not found".
  const r = probeBinary('engram', {
    _spawn: () => ({ error: new Error('spawnSync which ENOENT'), status: null }),
  });
  assert.equal(r.available, null, 'a broken probe must never claim the binary is absent');
  assert.match(r.reason, /could not run/);
  assert.match(r.reason, /ENOENT/, 'the reason must carry the cause, not just "unknown"');
});

test('#641 probeBinary: a THROWN spawn is UNDETERMINED', () => {
  const r = probeBinary('engram', {
    _spawn: () => { throw new Error('EACCES'); },
  });
  assert.equal(r.available, null);
  assert.match(r.reason, /threw/);
  assert.match(r.reason, /EACCES/);
});

test('#641 probeBinary: killed by a signal (no numeric status) is UNDETERMINED and names the signal', () => {
  const r = probeBinary('engram', { _spawn: () => ({ status: null, signal: 'SIGKILL' }) });
  assert.equal(r.available, null);
  assert.match(r.reason, /SIGKILL/);
});

test('#641 probeBinary: the probed name is the one asked for, and `which` is what runs', () => {
  const calls = [];
  probeBinary(ENGRAM_BIN, { _spawn: (...args) => { calls.push(args); return { status: 0 }; } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'which');
  assert.deepStrictEqual(calls[0][1], [ENGRAM_BIN]);
});

// ── selectBackend: the substitution and each of its three preconditions ──────

const ABSENT = { available: false };
const PRESENT = { available: true };

test('#641 selectBackend: defaulted + absent + covered op → SUBSTITUTED', () => {
  // `share` was the original covered example; it left FALLBACK_OPS in #874
  // split B (R11/B4a fix) since engram.share() no longer needs the binary.
  // `pull` is FALLBACK_OPS' one remaining covered op.
  const r = selectBackend({ requested: DEFAULT_BACKEND, stated: false, op: 'pull', probe: ABSENT });
  assert.equal(r.backend, FALLBACK_BACKEND);
  assert.equal(r.substituted, true);
  assert.equal(r.reason, REASON.SUBSTITUTED);
  assert.equal(r.from, DEFAULT_BACKEND, 'the notice has to be able to name what was unavailable');
});

test('#641 selectBackend: PRECONDITION 1 removed — a STATED engram is never overridden', () => {
  const r = selectBackend({ requested: DEFAULT_BACKEND, stated: true, op: 'pull', probe: ABSENT });
  assert.equal(r.backend, DEFAULT_BACKEND, 'an operator-stated selector wins (ADR-0004)');
  assert.equal(r.substituted, false);
  assert.equal(r.reason, REASON.STATED_BUT_ABSENT);
});

test('#641 selectBackend: PRECONDITION 2 removed — engram PRESENT means engram runs', () => {
  const r = selectBackend({ requested: DEFAULT_BACKEND, stated: false, op: 'share', probe: PRESENT });
  assert.equal(r.backend, DEFAULT_BACKEND);
  assert.equal(r.substituted, false);
  assert.equal(r.reason, REASON.AVAILABLE);
});

test('#641 selectBackend: PRECONDITION 3 removed — an op that is not BLOCKED by the binary keeps engram', () => {
  // Measured, not reasoned about. `setup` and `index` exit 0 with no engram
  // installed; `save`/`search` are refused by design and their refusal already
  // names the records-only route; `share` (#874 split B, R11) no longer calls
  // the binary at all. Only a genuine binary-not-found failure may be
  // replaced — see FALLBACK_OPS for the full measurement.
  for (const op of ['setup', 'save', 'search', 'share', 'index', 'import', 'feature-checkpoint', 'feature-resume']) {
    const r = selectBackend({ requested: DEFAULT_BACKEND, stated: false, op, probe: ABSENT });
    assert.equal(r.substituted, false, `${op} must not be substituted`);
    assert.equal(r.reason, REASON.OP_NOT_COVERED);
    assert.equal(r.backend, DEFAULT_BACKEND);
  }
});

test('#641 FALLBACK_OPS covers ONLY the ops that engram cannot run without its binary', () => {
  // The regression this pins: `setup` was in the list, and `engram.setup()`
  // needs no binary — it creates the `.engram → .memory` symlink and registers
  // the `merge=union` driver (ADR-0002). Substituting `plainfiles.setup()`,
  // which does neither, silently dropped the merge driver on every machine
  // without engram. `share` was removed for the same reason (#874 split B,
  // R11/B4a fix): `engram.share()` no longer calls `requireEngram()` or the
  // binary at all, so there is no longer a failure on this op for the
  // fallback to replace — and a live substitution would silently switch
  // which reindex implementation runs, mirroring the `setup` regression this
  // test already pins.
  assert.deepStrictEqual([...FALLBACK_OPS], ['pull']);
  for (const op of ['setup', 'save', 'search', 'share', 'index']) {
    assert.ok(!FALLBACK_OPS.includes(op), `'${op}' exits without the binary — there is no failure to replace`);
  }
});

test('#641 selectBackend: an UNDETERMINED probe substitutes nothing and says which case it is', () => {
  const r = selectBackend({
    requested: DEFAULT_BACKEND,
    stated: false,
    op: 'share',
    probe: { available: null, reason: '`which engram` could not run — ENOENT' },
  });
  assert.equal(r.substituted, false, 'an unmeasured absence must not switch a backend');
  assert.equal(r.reason, REASON.PROBE_FAILED);
  assert.notEqual(r.reason, REASON.OP_NOT_COVERED);
  assert.match(r.detail, /ENOENT/, 'the reason must travel out so the notice can state it');
});

test('#641 selectBackend: a missing/garbled probe is UNDETERMINED, never a green light', () => {
  for (const probe of [undefined, {}, { available: undefined }]) {
    const r = selectBackend({ requested: DEFAULT_BACKEND, stated: false, op: 'share', probe });
    assert.equal(r.reason, REASON.PROBE_FAILED, `probe ${JSON.stringify(probe)} must not read as an answer`);
    assert.equal(r.backend, DEFAULT_BACKEND);
  }
});

test('#641 selectBackend: a non-default backend is passed through untouched', () => {
  const r = selectBackend({ requested: 'plainfiles', stated: true, op: 'share', probe: ABSENT });
  assert.equal(r.backend, 'plainfiles');
  assert.equal(r.substituted, false);
  assert.equal(r.reason, REASON.NOT_DEFAULT);
});

// ── the covered ops must actually be servable by the fallback ────────────────

test('#641 FALLBACK_OPS: every covered op is really implemented by the fallback, and does not merely defer', async () => {
  // Necessary but NOT sufficient — being implemented is why a substitution CAN
  // work, never why it is warranted. What warrants it is that engram cannot run
  // the op at all without its binary, which the test above pins.
  //
  // Measured against the real module rather than a list copied here (#340).
  // `index`/`featureCheckpoint`/`featureResume` ARE exported functions on
  // plainfiles, so `typeof === function` cannot tell them apart from real ones;
  // they defer via unsupportedOp, so the distinction is BEHAVIOURAL.
  const plainfiles = await import('../../axes/memory/adapters/plainfiles.mjs');
  const verbExport = (op) => ({ import: 'importMemory' })[op] ?? op.replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  for (const op of FALLBACK_OPS) {
    assert.equal(typeof plainfiles[verbExport(op)], 'function', `plainfiles must implement '${op}'`);
    // And it must be a REAL implementation, not a loud deferral wearing one.
    await assert.doesNotReject(
      () => plainfiles[verbExport(op)]({ root: '/nonexistent-root-for-shape-check' }, {
        _rebuildIndex: () => ({ count: 0 }),
        _gitPull: () => {},
      }),
      `'${op}' must be a real plainfiles op — a deferral here would make the fallback a worse message`,
    );
  }

  for (const op of ['index', 'feature-checkpoint', 'feature-resume']) {
    assert.ok(!FALLBACK_OPS.includes(op), `'${op}' defers on plainfiles and must stay uncovered`);
    await assert.rejects(
      () => plainfiles[verbExport(op)](),
      /not supported by the 'plainfiles'/,
      `'${op}' is expected to DEFER — if it became real, FALLBACK_OPS should be revisited`,
    );
  }

  assert.equal(plainfiles.importMemory, undefined, "plainfiles has no 'import'; it must stay uncovered");
  assert.ok(!FALLBACK_OPS.includes('import'));
});
