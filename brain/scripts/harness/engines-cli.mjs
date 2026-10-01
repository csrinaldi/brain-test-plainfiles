#!/usr/bin/env node
// engines-cli.mjs — issue #824: `brain:engines`, the discovery verb's I/O
// half. Survey by default; `--record` writes each healthy row through
// `config-verb.mjs`'s planner (Compuerta 4's one validator, second caller).
// All rules live in `engines-report.mjs` and the planner — this file owns
// reading the config, the table, exit codes, and the atomic write.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SDD_ENGINES } from './platform.mjs';
import { buildEnginesReport, planEngineRecord, resolveStageSet } from './engines-report.mjs';

function fail(msg) {
  console.error(`brain:engines: ${msg}`);
  process.exit(1);
}

export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const record = argv.includes('--record');

  const configPath = join(root, 'brain.config.json');
  if (!existsSync(configPath)) fail(`brain.config.json not found in ${root} — run from the repo root.`);
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  const stages = resolveStageSet(config).stages;
  const rows = await buildEnginesReport({ config, engines: SDD_ENGINES });

  console.log(`brain:engines — ${rows.length} framework(s), stages: ${stages.join(', ')}\n`);
  for (const row of rows) {
    if (!row.ok) {
      console.log(`✗ ${row.engine}: ${row.refusal}\n`);
      continue;
    }
    console.log(`✓ ${row.engine}`);
    for (const stage of stages) {
      const r = row.roles[stage];
      const tier = r.model_tier === null ? 'no-agent (human)' : r.model_tier;
      const marks = [r.derived ? 'derived' : 'recorded', r.instructions === null ? 'no prompt' : 'instructions'];
      // Cold review round 1 on this PR: the port computes state/reason and this
      // was the only surface that could show them — dropping the field was the
      // same laundering this module's header forbids, for a different field.
      if (r.state === 'disabled') marks.push(`DISABLED — ${r.reason}`);
      console.log(`    ${stage.padEnd(12)} agent=${r.agent}  tier=${tier}  chooses_model=${r.chooses_model}  [${marks.join(', ')}]`);
    }
    // The drift line tasks.md promised and the first cut never built (cold
    // review round 1, editorial — the box was checked over an overstatement).
    // A recorded entry is a CLAIM about this engine; when the fresh survey
    // disagrees, the disagreement is named member by member, never counted.
    const recorded = config.sdd?.engines?.[row.engine];
    if (recorded && Array.isArray(recorded.stages)) {
      const fresh = Object.keys(row.roles);
      const gone = recorded.stages.filter((st) => !fresh.includes(st));
      const added = fresh.filter((st) => !recorded.stages.includes(st));
      if (gone.length > 0 || added.length > 0) {
        const parts = [];
        if (gone.length > 0) parts.push(`recorded but no longer surveyed: ${gone.join(', ')}`);
        if (added.length > 0) parts.push(`surveyed but not recorded: ${added.join(', ')}`);
        console.log(`    ⚠ drift vs sdd.engines.${row.engine} (recordedAt ${recorded.recordedAt}): ${parts.join('; ')}`);
      }
    }
    console.log('');
  }

  if (!record) return;

  // The migrations and target version resolve exactly as brain:config's CLI
  // resolves them — the installed package, read once, handed to the planner.
  const here = dirname(fileURLToPath(import.meta.url));
  const { migrations } = await import(join(here, '../../core/config-migrations.mjs'));
  const targetVersion = JSON.parse(readFileSync(join(here, '../../../package.json'), 'utf8')).version;

  let next = config;
  const recorded = [];
  for (const row of rows.filter((r) => r.ok)) {
    const planned = planEngineRecord({ config: next, row, migrations, targetVersion });
    if (planned.refusal) fail(planned.refusal);
    next = planned.next;
    recorded.push(row.engine);
  }
  if (recorded.length === 0) fail('nothing recordable — every framework refused its interrogation.');

  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, configPath);
  console.log(`brain:engines: ✓ recorded ${recorded.join(', ')} → sdd.engines.*`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
