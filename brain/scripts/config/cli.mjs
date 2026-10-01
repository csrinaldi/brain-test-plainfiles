#!/usr/bin/env node
// config/cli.mjs — issue #823: `brain:config`, the thin I/O half of the ONE
// config verb (Compuerta 4). Reads brain.config.json at the working root,
// hands EVERYTHING to the pure planner, writes atomically (tmp + rename in
// the same directory), and reports. All rules live in `config-verb.mjs` —
// this file owns exit codes and the write, nothing else.

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { planConfigWrite, resolvePath } from './config-verb.mjs';

const USAGE = `Usage: npm run brain:config -- get <path>
       npm run brain:config -- set <path> <value>
  <path> is dot-separated (e.g. docs.language, sdd.map.cold-review).
  <value> parses as JSON first, bare string on failure.`;

function fail(msg) {
  console.error(`brain:config: ${msg}`);
  process.exit(1);
}

export async function main(argv = process.argv.slice(2), root = process.cwd()) {
  const [op, path, value] = argv;
  if (op !== 'get' && op !== 'set') fail(`unknown op '${op ?? ''}'.\n${USAGE}`);
  if (!path || (op === 'set' && value === undefined)) fail(`missing argument.\n${USAGE}`);

  const configPath = join(root, 'brain.config.json');
  if (!existsSync(configPath)) {
    fail(`brain.config.json not found in ${root} — run from the repo root, or run env:init first.`);
  }
  const config = JSON.parse(readFileSync(configPath, 'utf8'));

  if (op === 'get') {
    // NOT validated against deriveKnownPaths, on purpose (#823 cold review,
    // judgment:cold-2): the verb itself writes `schemaVersion`, which no
    // migration's defaults declare — a schema-validated get would refuse to
    // read a key the verb wrote. Reads report what IS; writes gate what MAY
    // BE. The shared half is the SAFETY rule: resolvePath refuses hostile
    // segments and reads own-keys only, so nothing arrives via the prototype
    // chain through either op.
    const resolved = resolvePath(config, path);
    if (resolved === undefined) fail(`'${path}' is not set (undefined).`);
    console.log(JSON.stringify(resolved, null, 2));
    return;
  }

  // The migrations and the target version come from the INSTALLED package —
  // the same two inputs brain-upgrade hands migrateConfig, resolved here once
  // and passed in, so the planner stays pure.
  const here = dirname(fileURLToPath(import.meta.url));
  const { migrations } = await import(join(here, '../../core/config-migrations.mjs'));
  const targetVersion = JSON.parse(readFileSync(join(here, '../../../package.json'), 'utf8')).version;

  const { next, migrationsApplied, refusal } = planConfigWrite({ config, path, value, migrations, targetVersion });
  if (refusal) fail(refusal);

  // Atomic: same-directory tmp + rename, so a crash mid-write never leaves a
  // half-file where every other verb reads its config.
  const tmp = `${configPath}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
  renameSync(tmp, configPath);

  const migrated = migrationsApplied.length > 0
    ? ` (migrations applied first: ${migrationsApplied.join(', ')})`
    : ' (no pending migrations)';
  console.log(`brain:config: ✓ set ${path}${migrated}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
