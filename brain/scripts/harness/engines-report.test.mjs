// engines-report.test.mjs — issue #824 (PR3 of #814's ruled chain): the pure
// half of `brain:engines`. Every input is RECEIVED — engines, loader, config,
// migrations — so the oracle is the rule, never this machine's installs.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildEnginesReport, planEngineRecord } from './engines-report.mjs';

const CONFIG = { schemaVersion: '0.3.0' };
const goodInhabitant = {
  declareRoles: (stages) => Object.fromEntries(stages.map((stage) => [stage, {
    stage, agent: 'a', model_tier: 'balanced', chooses_model: false, instructions: 'x',
  }])),
};

test('#824: every engine is interrogated against the CURRENT resolved stage set', async () => {
  const report = await buildEnginesReport({
    config: CONFIG,
    engines: ['plain-ish', 'rich-ish'],
    _load: async () => goodInhabitant,
  });
  assert.deepEqual(report.map((r) => r.engine), ['plain-ish', 'rich-ish']);
  for (const row of report) {
    assert.equal(row.ok, true);
    assert.deepEqual(Object.keys(row.roles).sort(), ['design', 'proposal', 'spec', 'tasks'],
      'the stage set is RESOLVED from config, never enumerated here');
  }
});

test('#824: a refusing engine is a reported ROW, not a crash — and the others still answer', async () => {
  const report = await buildEnginesReport({
    config: CONFIG,
    engines: ['broken', 'fine'],
    _load: async (engine) => (engine === 'broken' ? { notDeclareRoles: true } : goodInhabitant),
  });
  const [broken, fine] = report;
  assert.equal(broken.ok, false);
  assert.match(broken.refusal, /declareRoles/, "the port's own refusal travels into the row");
  assert.equal(fine.ok, true, 'one broken engine must not silence the rest');
});

test('#824: an engine whose module fails to LOAD is also a row — absence and refusal both report', async () => {
  const report = await buildEnginesReport({
    config: CONFIG,
    engines: ['ghost'],
    _load: async () => { throw new Error('Cannot find module ghost.mjs'); },
  });
  assert.equal(report[0].ok, false);
  assert.match(report[0].refusal, /Cannot find module/);
});

test('#824: --record writes sdd.engines.<name> THROUGH the config planner — one validator, two callers', () => {
  const MIGRATIONS = [{ version: '0.3.0', description: 't', defaults: { sdd: { engines: {} } } }];
  const row = { engine: 'fine', ok: true, roles: { proposal: {}, spec: {} } };
  const { next, refusal } = planEngineRecord({
    config: { schemaVersion: '0.3.0' }, row, migrations: MIGRATIONS, targetVersion: '0.3.0',
    _now: () => '2026-09-02T13:00:00Z',
  });
  assert.equal(refusal, null);
  assert.deepEqual(next.sdd.engines.fine, { recordedAt: '2026-09-02T13:00:00Z', stages: ['proposal', 'spec'] });
});

test('#824: --record FAILS CLOSED while sdd.engines is undeclared — the sequencing consequence, pinned', () => {
  const SHIPPED_WITHOUT = [{ version: '0.3.0', description: 't', defaults: { sdd: { map: {} } } }];
  const { next, refusal } = planEngineRecord({
    config: { schemaVersion: '0.3.0' }, row: { engine: 'fine', ok: true, roles: {} },
    migrations: SHIPPED_WITHOUT, targetVersion: '0.3.0', _now: () => 'x',
  });
  assert.equal(next, null, 'a path becomes settable in the migration that declares it — not before');
  assert.match(refusal, /sdd\.engines\.fine/);
});

test('#824: a refusing engine is NEVER recorded — a recording vouches, and there is nothing to vouch for', () => {
  const MIGRATIONS = [{ version: '0.3.0', description: 't', defaults: { sdd: { engines: {} } } }];
  const { next, refusal } = planEngineRecord({
    config: {}, row: { engine: 'broken', ok: false, refusal: 'no declareRoles' },
    migrations: MIGRATIONS, targetVersion: '0.3.0', _now: () => 'x',
  });
  assert.equal(next, null);
  assert.match(refusal, /broken/);
});
