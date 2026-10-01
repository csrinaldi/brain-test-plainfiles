#!/usr/bin/env node
// verify-change.mjs — Validación según el scope del cambio (monorepo políglota).
//
// Detecta los archivos tocados por el cambio en curso (working tree + staged +
// commits de la rama vs main), los clasifica según la matriz de validación del
// workflow aprobado (brain/project/methodology/project-workflow.md §5 paso 7), reporta
// el plan y corre SOLO las verificaciones que el cambio exige.
//
// Mismo script para local y CI: cero divergencia entre lo que valida un dev y
// lo que valida el pipeline. Se ejecuta con `npm run brain:change:verify` (alias deprecado: change:verify).
// Sin dependencias externas.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectPM } from './lib/pm.mjs';

const ROOT = process.cwd();
const sh = (cmd) => execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim();
const pm = detectPM(ROOT);

// --- Matriz de validación: única fuente, espeja la tabla del workflow ---------
// `match` clasifica un path tocado; `commands` puede ser estático o función de
// los archivos que matchearon (para validaciones por-archivo como node --check).
const MATRIX = [
  {
    scope: 'repo',
    label: 'cualquier cambio',
    match: () => true,
    commands: () => [['node', 'brain/scripts/check-refs.mjs']],
    always: true,
  },
  {
    scope: 'backend',
    label: 'backend/**, pom.xml, settings.xml',
    match: (f) =>
      f.startsWith('backend/') || f.endsWith('pom.xml') || f === 'settings.xml',
    commands: () => [pm.runArgs('backend:build', true)],
  },
  {
    scope: 'contract',
    label: 'backend/contract/** (modelo catastral / contrato Java-TS)',
    match: (f) => f.startsWith('backend/contract/'),
    commands: () => [pm.runArgs('contract:generate', true)],
  },
  {
    scope: 'frontend',
    label: 'frontend/**',
    match: (f) => f.startsWith('frontend/'),
    // --base explícito: nx debe usar el MISMO punto de comparación que este
    // script, no su propia heurística de affected.
    commands: () =>
      BASE
        ? [['npx', 'nx', 'affected', '-t', 'lint,test,build', `--base=${BASE}`, '--head=HEAD']]
        : [['npx', 'nx', 'affected', '-t', 'lint,test,build']],
  },
  {
    scope: 'scripts',
    // package.json entra al scope pero sin chequeo por-archivo propio: si solo
    // se tocó package.json, el scope no aporta comandos y se omite del plan.
    label: 'brain/scripts/**, package.json',
    match: (f) => f.startsWith('brain/scripts/') || f === 'package.json',
    commands: (files) => [
      ...files
        .filter((f) => /\.(mjs|js|cjs)$/.test(f) && existsSync(join(ROOT, f)))
        .map((f) => ['node', '--check', f]),
      ...files
        .filter((f) => f.endsWith('.sh') && existsSync(join(ROOT, f)))
        .map((f) => ['bash', '-n', f]),
    ],
  },
  // brain/**, openspec/**, docs: sin validación extra — repo:check (always) cubre.
];

// --- Archivos tocados: rama vs main + staged + working tree + untracked -------
function changedFiles() {
  const out = new Set();
  const collect = (cmd) => {
    try {
      sh(cmd).split('\n').filter(Boolean).forEach((f) => out.add(f));
    } catch {
      /* sin upstream o repo recién creado: el resto de fuentes cubre */
    }
  };
  let base = null;
  try {
    base = sh('git merge-base origin/main HEAD');
  } catch {
    try {
      base = sh('git merge-base main HEAD');
    } catch {
      /* sin main local ni remota */
    }
  }
  if (base) collect(`git diff --name-only ${base}...HEAD`);
  collect('git diff --name-only --cached');
  collect('git diff --name-only');
  // archivos nuevos aún sin trackear: git diff no los lista
  collect('git ls-files --others --exclude-standard');
  return { files: [...out], base };
}

const { files, base: BASE } = changedFiles();

// Guard de CI: en un shallow clone el merge-base puede degenerar a HEAD y el
// diff queda vacío — eso saltearía validaciones EN SILENCIO. Mejor fallar ruidoso.
const onMain = (process.env.CI_COMMIT_BRANCH || '') === 'main';
if (process.env.CI && !onMain && BASE && BASE === sh('git rev-parse HEAD')) {
  console.error('✗ merge-base == HEAD en CI: shallow clone sin historial suficiente.');
  console.error('  Aumentá GIT_DEPTH o corré `git fetch --unshallow` antes de validar.');
  process.exit(1);
}

if (files.length === 0) {
  console.log('Sin cambios respecto de main: corre solo la validación universal.');
}

// --- Plan: clasificar y reportar ----------------------------------------------
const plan = [];
for (const entry of MATRIX) {
  const matched = entry.always ? files : files.filter(entry.match);
  // los scopes `always` entran al plan aun con cero archivos (validación universal)
  if (!entry.always && matched.length === 0) continue;
  const commands = entry.commands(matched).filter((c) => c.length > 0);
  if (commands.length === 0) continue;
  plan.push({ ...entry, matched, resolved: commands });
}

console.log(`Cambio detectado: ${files.length} archivo(s)\n`);
console.log('Plan de validación:');
for (const p of plan) {
  const detail = p.always ? '' : ` — ${p.matched.length} archivo(s) en scope`;
  console.log(`  [${p.scope}] ${p.label}${detail}`);
  for (const cmd of p.resolved) console.log(`      $ ${cmd.join(' ')}`);
}
const skipped = MATRIX.filter((e) => !plan.some((p) => p.scope === e.scope));
if (skipped.length > 0) {
  console.log(
    `  (se omite, nada aplicable: ${skipped.map((e) => e.scope).join(', ')})`,
  );
}
console.log('');

// --- Ejecución: secuencial, se detiene en la primera falla ---------------------
for (const p of plan) {
  for (const cmd of p.resolved) {
    console.log(`→ [${p.scope}] ${cmd.join(' ')}`);
    const res = spawnSync(cmd[0], cmd.slice(1), {
      cwd: ROOT,
      stdio: 'inherit',
    });
    if (res.error) {
      console.error(`\n✗ [${p.scope}] no se pudo lanzar \`${cmd[0]}\`: ${res.error.message}`);
      process.exit(1);
    }
    if (res.status !== 0) {
      console.error(
        `\n✗ Falló [${p.scope}] \`${cmd.join(' ')}\` (exit ${res.status ?? 'señal'}).`,
      );
      console.error(`  Corregí y volvé a correr \`${pm.name} run change:verify\`.`);
      process.exit(1);
    }
  }
}

console.log(`\n✓ Validación completa: ${plan.map((p) => p.scope).join(' + ')}.`);
