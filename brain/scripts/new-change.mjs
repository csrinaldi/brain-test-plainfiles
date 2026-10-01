#!/usr/bin/env node
// Scaffolder de changes SDD en formato OpenSpec — harness-neutral.
// No depende de ningún harness (gentle-ai u otro): el repo sabe crear su
// propia estructura SDD. Ver brain/project/decisions/adr-0002-harness-reemplazable-openspec.md
//
// Uso:
//   npm run brain:project:feature -- --issue 104 --title "valuacion masiva"
// --title (el slug) es OBLIGATORIO (#595 pin 2, REQ-B1-5) — ver
// brain/core/methodology/sdd-layout.md. Nunca se deriva un placeholder.
// (alias deprecado: npm run project:feature)

import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { changeDir, artifactPaths, resolveStageSet, LIFECYCLE_STAGES } from "./lib/sdd-layout.mjs";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--issue") args.issue = argv[++i];
    else if (argv[i] === "--title") args.title = argv[++i];
  }
  return args;
}

function slugify(text) {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

const { issue, title } = parseArgs(process.argv.slice(2));

if (!issue || !/^\d+$/.test(issue)) {
  fail(
    'Falta el ID del issue. Uso: npm run project:feature -- --issue 104 --title "nombre" (--title es obligatorio)',
  );
}

// REQ-B1-5 (#595 pin 2): the slug is mandatory — symmetric with the --issue
// check above. NEVER a derived placeholder (e.g. issue-<N>-change): a
// placeholder would be a silent lie, the same sin as the #216 hand-edit
// errata. Fail fast with an actionable message instead.
const slug = title ? slugify(title) : "";
if (!slug) {
  fail(
    'Falta el título/slug del change (obligatorio). Uso: npm run project:feature -- --issue 104 --title "nombre" ' +
      "— ver brain/core/methodology/sdd-layout.md.",
  );
}

const changeId = `issue-${issue}-${slug}`;
const targetDir = join(repoRoot, changeDir(changeId));

// #810 (#456 slice B, ADR-0019 Amendment 5): the scaffold produces the FULL
// declared stage set — never tier-scoped (REQ-L4-2'). The config is read
// directly (never via brain-config.mjs: this script's test fixture copies it
// together with sdd-layout.mjs ALONE — the #555 module-drag trap). An
// unreadable config degrades to zero-config; a declaration resolveStageSet
// REFUSES is a hard stop with the resolver's own message, before any write.
let config = {};
try {
  config = JSON.parse(readFileSync(join(repoRoot, "brain.config.json"), "utf8"));
} catch {
  config = {};
}
let stageSet;
try {
  stageSet = resolveStageSet(config);
} catch (error) {
  fail(error.message);
}
const customStages = stageSet.stages.filter((name) => !LIFECYCLE_STAGES.includes(name));

if (existsSync(targetDir)) {
  fail(`El change "${changeId}" ya existe en openspec/changes/. No se sobrescribe.`);
}

const heading = `${title} (issue ${issue})`;

const proposal = `---
status: draft
issue: ${issue}
---

# Propuesta — ${heading}

## Qué
<Una frase: qué se va a cambiar.>

## Por qué
<El problema o la necesidad que motiva el cambio. Vincular al issue #${issue}.>

## Alcance
- Incluye: <...>
- No incluye: <...>
`;

const spec = `---
status: draft
issue: ${issue}
---

# Spec — ${heading}

## Requisitos delta
<Qué requisitos nuevos o modificados introduce este cambio. Vincular al issue #${issue}.>

## Escenarios
<GIVEN/WHEN/THEN de los casos que este cambio debe cubrir.>
`;

const design = `---
status: draft
issue: ${issue}
---

# Diseño — ${heading}

## Decisiones técnicas
<Cómo se resuelve. Decisiones de arquitectura, módulos afectados, contrato.>

## Contract / API impact
<Does this change mutate the public contract or API? If yes, describe the impact and any generation steps needed.>

## Alternativas descartadas
<Qué se evaluó y por qué no.>
`;

const tasks = `---
status: draft
issue: ${issue}
---

# Tareas — ${heading}

- [ ] <Primera tarea aislada>
- [ ] <Segunda tarea>

## Micro-decisiones en caliente
<Acuerdos técnicos de la sesión. Se promueven al cerebro en el MR — ver
brain/core/methodology/consolidation-protocol.md>
`;

const paths = artifactPaths(changeId);
mkdirSync(targetDir, { recursive: true });
writeFileSync(join(repoRoot, paths.proposal), proposal);
writeFileSync(join(repoRoot, paths.spec), spec);
writeFileSync(join(repoRoot, paths.design), design);
writeFileSync(join(repoRoot, paths.tasks), tasks);

for (const stage of customStages) {
  const stub = `---
status: draft
issue: ${issue}
stage: ${stage}
---

# ${stage} — ${heading}

<Artefacto del stage declarado "${stage}" (sdd.stages). Completalo antes de
implementar: phase-order lo exige en su posición declarada.>
`;
  writeFileSync(join(targetDir, stageSet.files[stage]), stub);
}

// Derived from the resolver, never a literal — the slice-A drift guard scans
// for rival declarations of the artefact set, and it caught this line's first
// cut (a fifth array of the four file names).
const scaffolded = stageSet.stages.map((stage) => stageSet.files[stage]).join("  ");

console.log(`
  ✓ Change SDD creado: ${changeDir(changeId)}/
      ${scaffolded}

  Siguiente: completá la propuesta y abrí la rama {tipo}/${changeId}.
  ({tipo}: feat | fix | chore | refactor | docs | ci | build)
`);
