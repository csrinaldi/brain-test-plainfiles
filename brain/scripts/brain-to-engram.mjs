#!/usr/bin/env node
// Reproyector brain → engram. Materializa el principio D6:
//   MD (brain/) = fuente de verdad   ·   engram = índice reconstruible.
// Indexa los documentos DURABLES del cerebro a engram de forma idempotente
// (--topic derivado del path → upsert, no duplica al re-correr).
// Si se pierde engram: `npm run brain:memory:index` lo reconstruye desde brain/.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, basename } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadBrainConfig } from "./lib/brain-config.mjs";
import { deriveProject } from "./axes/memory/adapters/engram.mjs";

// Carpetas durables a indexar → tipo de observación en engram
const SOURCES = [
  { dir: "brain/project/decisions", type: "decision" },
  { dir: "brain/core/anti-patterns", type: "pattern" },
  { dir: "brain/project/anti-patterns", type: "pattern" },
  { dir: "brain/project/domain", type: "reference" },
  { dir: "brain/project/methodology", type: "reference" },
  { dir: "brain/core/methodology", type: "reference" },
];

function mdFiles(dir) {
  let out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out = out.concat(mdFiles(p));
    else if (e.endsWith(".md")) out.push(p);
  }
  return out;
}

function titleOf(content, file) {
  const h = content.match(/^#\s+(.+)$/m);
  return h ? h[1].trim() : basename(file, ".md");
}

function defaultEngramSave(title, content, { type, project, topic }) {
  execFileSync(
    "engram",
    ["save", title, content, "--type", type, "--project", project, "--topic", topic],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
}

/**
 * Indexes every durable doc under `sources` into engram, project-scoped and
 * idempotent (topic-keyed upsert).
 *
 * Injectable (repoRoot, config, sources, engramSave, log, logErr) so this is
 * testable without touching the real brain/ tree or spawning a real `engram`
 * binary (issue #1112, finding 3).
 *
 * A per-file failure is counted in `failed` and reported via `logErr` — never
 * swallowed silently. The caller (the main-module block below) turns a
 * non-zero `failed` count into a non-zero exit code, so `engram.mjs#index()`
 * (`result.status !== 0` → throw), `memory/cli.mjs` (catch → `process.exit(1)`)
 * and `bootstrap.sh` (`|| warn(...)`) all report the failure instead of
 * `env:init` finishing as if nothing happened.
 *
 * @param {{ repoRoot: string, config: object, sources?: Array<{dir: string, type: string}>,
 *   engramSave?: Function, log?: Function, logErr?: Function }} opts
 * @returns {{ indexed: number, failed: number }}
 */
export function run({
  repoRoot,
  config,
  sources = SOURCES,
  engramSave = defaultEngramSave,
  log = console.log,
  logErr = console.error,
} = {}) {
  // Resolves the engram `--project` value the same way the rest of the
  // engram adapter does (issue #1112, finding 3): `deriveProject`, imported
  // straight from `axes/memory/adapters/engram.mjs` (the SAME function, not
  // a fourth divergent copy) — `config.project.name` alone is wrong here
  // because `env:init`/`ensureBrainConfig` only ever set `project.slug`,
  // leaving `name` empty and every `engram save … --project ""` call
  // failing (cold-review nit: this used to be a one-line pass-through
  // wrapper with no logic of its own; called directly instead).
  const project = deriveProject(config, repoRoot);
  let indexed = 0;
  let failed = 0;
  for (const { dir, type } of sources) {
    for (const file of mdFiles(join(repoRoot, dir))) {
      const content = readFileSync(file, "utf8");
      const rel = relative(repoRoot, file);
      const topic = rel.replace(/\.md$/, ""); // ej: brain/project/decisions/adr-0001-...
      try {
        engramSave(titleOf(content, file), content, { type, project, topic });
        log(`  ✓ ${rel}  →  engram [${type}]  topic=${topic}`);
        indexed++;
      } catch (err) {
        logErr(`  ✗ ${rel}: ${String(err.stderr || err.message).trim()}`);
        failed++;
      }
    }
  }
  log(`\n${indexed} documentos del cerebro indexados a engram (proyección reconstruible desde brain/).`);
  if (failed > 0) {
    logErr(`\n✗ ${failed} documento(s) fallaron al indexar — ver errores arriba.`);
  }
  return { indexed, failed };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../..");
  const config = loadBrainConfig();
  const { failed } = run({ repoRoot, config });
  process.exit(failed > 0 ? 1 : 0);
}
