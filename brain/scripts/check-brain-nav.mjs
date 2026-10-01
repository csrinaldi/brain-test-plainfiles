#!/usr/bin/env node
// check-brain-nav.mjs — integridad de navegación de brain/.
//
// La base de conocimiento solo sirve si es ABSORBIBLE: un humano o agente que
// arranca en brain/HOME.md tiene que poder llegar, siguiendo links, a TODO doc
// durable. Este check garantiza dos invariantes, de forma determinista y sin
// engram (corre en CI sobre node:alpine):
//
//   1. Sin links rotos: todo [[wikilink]] y link markdown a un .md resuelve a un
//      archivo real (resuelto contra el filesystem completo — un link a la raíz
//      como ../../AGENTS.md es válido).
//   2. Sin huérfanos: todo brain/**/*.md es alcanzable TRANSITIVAMENTE desde
//      brain/HOME.md (siguiendo links a través de índices como los README).
//
// Exit 1 si hay huérfanos o links rotos; exit 0 si la navegación está íntegra.

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");
const BRAIN = join(ROOT, "brain");
const HOME = join(BRAIN, "HOME.md");
const CORE = join(BRAIN, "core");
const PROJECT = join(BRAIN, "project");
const isUnder = (file, dir) => file === dir || file.startsWith(dir + "/");

// Guard: brain/HOME.md es el punto de entrada requerido. Sin este chequeo,
// la BFS de alcanzabilidad (más abajo) lo lee sin validar existencia y
// explota con un stack trace crudo de ENOENT. Fallar acá con un mensaje
// claro y accionable en su lugar (issue #176).
if (!existsSync(HOME)) {
  console.error(
    "\n✗ brain/HOME.md no existe — corré la adopción / brain:env:init para crear el punto de entrada de la base de conocimiento.",
  );
  process.exit(1);
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

// El template scaffold vive SOLO en brain/core/templates/ (fuente de andamiaje,
// no doc navegable). Excluir con ancla precisa a esa ruta — NO un substring
// "/templates/", que sacaría del scan cualquier templates/ del consumer (p.ej.
// brain/project/templates/) y ocultaría huérfanos/links rotos reales.
const brainFiles = walk(BRAIN).filter(
  (f) =>
    f.endsWith(".md") &&
    !f.includes("/__fixtures__/") &&
    !isUnder(f, join(CORE, "templates")),
);
const brainSet = new Set(brainFiles);

// Resuelve el target de un link a una ruta absoluta existente, o null.
// - mdlink: ruta de filesystem relativa al archivo origen (resuelta contra el FS real).
// - wikilink: slug → brain/<slug>.md, o por basename dentro de brain/.
function resolveLink(fromFile, raw, kind) {
  const target = raw.split("#")[0].trim(); // descartar anchor
  if (!target) return fromFile; // link solo-anchor → mismo archivo
  if (kind === "mdlink") {
    const abs = normalize(join(dirname(fromFile), target));
    return existsSync(abs) ? abs : null;
  }
  const norm = target.replace(/\.md$/, "");
  const bySlug = join(BRAIN, `${norm}.md`);
  if (brainSet.has(bySlug)) return bySlug;
  return brainFiles.find((f) => basename(f) === `${basename(norm)}.md`) ?? null;
}

// Extrae links de un doc: [[wikilinks]] y [texto](ruta.md) (solo destinos .md).
function linksOf(file) {
  const c = readFileSync(file, "utf8");
  const out = [];
  for (const m of c.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g))
    out.push({ raw: m[1], kind: "wikilink" });
  for (const m of c.matchAll(/\]\(([^)\s]+\.md(?:#[^)]*)?)\)/g))
    out.push({ raw: m[1], kind: "mdlink" });
  return out;
}

// Extrae RUTAS CITADAS: `brain/...` entre backticks (issue #499).
//
// Un link markdown no es la única forma en que brain/ se apunta a sí mismo — la
// más frecuente en la doctrina es la cita entre backticks, y este checker no la
// veía. Medido en `main` @ 5313182: 22 rutas citadas en 6 archivos no resolvían mientras
// `brain:nav` reportaba "sin links rotos".
//
// Cuatro de ellas eran `brain/decisions/`, `brain/anti-patterns/`,
// `brain/domain/` y `brain/methodology/` — los cuatro directorios que la lista
// "Tier 3 — Prohibido" de agent-authorities.md nombra, y que la reorganización
// core/project dejó sin existir. La prohibición más fuerte de la doctrina, la que
// lleva "even if explicitly asked", no cubría ningún directorio real: lo que
// frenaba a los agentes era Tier 2 más el gate L6, nunca ese listado.
//
// Las otras incluyen §2 citando el anti-patrón que la sostiene en su ruta
// vieja, y consolidation-protocol.md citándose A SÍ MISMO en la suya.
//
// El extractor vive ACÁ, inline, y no en un lib/ importado: este script se COPIA
// solo a fixtures y al scaffolding de adopción, y un import relativo lo rompe
// fuera de su árbol. Medido: moverlo a lib/ puso 5 tests existentes en rojo
// (ERR_MODULE_NOT_FOUND en cada fixture que lo copia suelto). La portabilidad del
// script es una restricción real, no un detalle de estilo.
//
// Sobre los GLOBS (`brain/**`): NO matchean, medido. El regex exige backtick de
// cierre y `*` está fuera de la clase, así que la cita nunca cierra — no degrada a
// `brain/`, simplemente no hay match. El `.filter()` es entonces código muerto
// hoy: una mutación que lo desactiva deja la suite verde, y eso está pinneado a
// propósito. Queda como cinturón y tiradores, anotado como tal, porque una
// protección aparente es la clase de defecto que este ticket persigue.
const CITED_RE = /`(brain\/[A-Za-z0-9_./-]+)`/g;

function citedPathsOf(file) {
  return [...readFileSync(file, "utf8").matchAll(CITED_RE)]
    .map((m) => m[1])
    .filter((p) => !p.includes("*"));
}

// 1. Links rotos + leaks core→project en cualquier doc de brain/.
const dead = [];
const coreLeaks = [];
const deadCitations = [];
for (const f of brainFiles) {
  for (const cited of citedPathsOf(f)) {
    if (!existsSync(join(ROOT, cited))) {
      deadCitations.push(`${relative(ROOT, f)} → \`${cited}\``);
    }
  }
}
for (const f of brainFiles) {
  for (const { raw, kind } of linksOf(f)) {
    const r = resolveLink(f, raw, kind);
    if (r === null) {
      const shown = kind === "wikilink" ? `[[${raw}]]` : raw;
      dead.push(`${relative(ROOT, f)} → ${shown}`);
    } else if (isUnder(f, CORE) && isUnder(r, PROJECT)) {
      // core/** es genérico y se distribuye a consumidores; project/** es del
      // consumidor y varía. Un link core→project resuelve acá (self-hosting)
      // pero rompe en todo consumidor, donde ese target no existe.
      coreLeaks.push(`${relative(ROOT, f)} → ${relative(ROOT, r)}`);
    }
  }
}

// 2. Huérfanos: BFS transitivo desde HOME.md por links que caen dentro de brain/.
const seen = new Set([HOME]);
const queue = [HOME];
while (queue.length) {
  const f = queue.shift();
  for (const { raw, kind } of linksOf(f)) {
    const r = resolveLink(f, raw, kind);
    if (r && brainSet.has(r) && !seen.has(r)) {
      seen.add(r);
      queue.push(r);
    }
  }
}
const orphans = brainFiles.filter((f) => !seen.has(f));

// Reporte.
if (orphans.length) {
  console.error(
    `\n✗ ${orphans.length} documento(s) huérfano(s) — no alcanzables desde brain/HOME.md:`,
  );
  for (const o of orphans) console.error(`  • ${relative(ROOT, o)}`);
  console.error(
    "  Agregalos a un índice navegable (HOME.md o el README de su carpeta).",
  );
}
if (dead.length) {
  console.error(`\n✗ ${dead.length} link(s) roto(s) en brain/:`);
  for (const d of dead) console.error(`  • ${d}`);
}
if (coreLeaks.length) {
  console.error(
    `\n✗ ${coreLeaks.length} link(s) core→project en brain/ (core debe ser genérico):`,
  );
  for (const c of coreLeaks) console.error(`  • ${c}`);
  console.error(
    "  brain/core/** no puede linkear a brain/project/** — el target no existe en los consumidores.",
  );
}

if (deadCitations.length) {
  console.error(
    `\n✗ ${deadCitations.length} ruta(s) CITADA(S) en brain/ que no existen:`,
  );
  for (const c of deadCitations) console.error(`  • ${c}`);
  console.error(
    "  Una ruta citada entre backticks no es menos normativa que un link: si un listado\n" +
      "  de prohibiciones nombra un directorio que no existe, no prohíbe nada (issue #499).",
  );
}

const problems =
  orphans.length + dead.length + coreLeaks.length + deadCitations.length;
if (problems === 0) {
  console.log(
    "✓ Navegación de brain/ íntegra: sin huérfanos, sin links rotos, sin rutas citadas inexistentes.",
  );
  process.exit(0);
}
console.error(`\n${problems} problema(s) de navegación en brain/.`);
process.exit(1);
