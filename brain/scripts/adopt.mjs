#!/usr/bin/env node
// adopt.mjs — Thin CLI for brain:adopt S1 (read-only inventory + classify).
//
// This is the I/O edge of the brain:adopt pipeline. All pure logic lives in
// brain/scripts/lib/adopt/; this file handles only filesystem reads/writes,
// argument parsing, and stdout output.
//
// Usage:
//   node brain/scripts/adopt.mjs [target-path] [--out <dir>]
//
// Options:
//   target-path   Consumer repo root to inspect (default: cwd)
//   --out <dir>   Output directory for plan.json + report.md
//                 (default: <target>/.brain-adopt/)
//   --help        Show this message
//
// Output (default out-dir decision for open question #2):
//   plan.json and report.md are always written to <out>.
//   The report.md content is NOT echoed to stdout even when --out is omitted.
//   Stdout carries a short summary only, so it stays pipeable and predictable in
//   CI without noise. Open <out>/report.md for the full human-readable report.
//
// Read-only contract:
//   Writes ONLY inside --out / .brain-adopt/. Touches no other file, no git,
//   no config, no hooks. S1 has no --apply flag (that is a future slice).

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { listFiles, installedPackageRoot } from './lib/installer.mjs';
import { buildPlan } from './lib/adopt/build-plan.mjs';
import { renderReport } from './lib/adopt/render-report.mjs';
import { managed, local } from '../core/managed-paths.mjs';

// Resolve the location of this script to build the REPO_ROOT fallback for the
// self-host upstream detection (step 3 in resolveUpstreamRoot below).
//
//   __filename = <repo>/brain/scripts/adopt.mjs
//   __dirname  = <repo>/brain/scripts
//   BRAIN_DIR  = <repo>/brain
//   REPO_ROOT  = <repo>
//
// This is used as the "self-host" upstream when the target is a subdirectory of
// the brain repo itself (e.g., the test fixture) rather than a separate consumer.
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const BRAIN_DIR = dirname(__dirname);
const REPO_ROOT = dirname(BRAIN_DIR);

const HELP = `
brain:adopt — S1 read-only inventory + classification

Usage:
  node brain/scripts/adopt.mjs [target-path] [--out <dir>]

Options:
  target-path   Consumer repo root to inspect (default: cwd)
  --out <dir>   Output directory for plan.json + report.md
                (default: <target>/.brain-adopt/)
  --help        Show this message

Output:
  plan.json     Canonical JSON plan (spec JSON Plan Schema schemaVersion "1")
  report.md     Human-readable Markdown report

Read-only: writes only inside --out. No git, no hooks, no --apply in S1.
`.trim();

/**
 * Resolves the upstream reference root for the brain:adopt pipeline.
 *
 * Priority (first match wins):
 *   1. <targetRoot>/node_modules/brain/ — installed brain package in the consumer
 *   2. targetRoot itself — when targetRoot's package.json.name === "brain"
 *      (the consumer IS the brain repo; self-host mode)
 *   3. REPO_ROOT (where this script lives) — when REPO_ROOT's package.json.name
 *      === "brain" and REPO_ROOT !== targetRoot (running adopt.mjs from a brain
 *      source checkout against a subdirectory such as a fixture)
 *
 * If none applies, upstreamRoot is null: all generic files will be classified
 * as upstream-missing and flagged for review (safe conservative default).
 *
 * @param {string} targetRoot - Absolute path to the consumer repo root.
 * @returns {{ upstreamRoot: string|null, manifestSource: string }}
 */
function resolveUpstreamRoot(targetRoot) {
  // 1. Installed package in the consumer's node_modules.
  const nmBrain = installedPackageRoot(targetRoot);
  if (existsSync(nmBrain)) {
    return { upstreamRoot: nmBrain, manifestSource: 'node_modules/brain' };
  }

  // 2. Target IS the brain repo itself (self-host: brain:adopt run inside brain).
  try {
    const pkg = JSON.parse(readFileSync(join(targetRoot, 'package.json'), 'utf8'));
    if (pkg.name === 'brain') {
      return { upstreamRoot: targetRoot, manifestSource: 'self-host' };
    }
  } catch { /* no readable package.json in targetRoot */ }

  // 3. Script lives inside the brain repo, target is a subdirectory/fixture.
  //    Avoids an infinite loop: only apply when REPO_ROOT !== targetRoot.
  if (REPO_ROOT !== targetRoot) {
    try {
      const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'));
      if (pkg.name === 'brain') {
        return { upstreamRoot: REPO_ROOT, manifestSource: 'self-host' };
      }
    } catch { /* not in a brain repo */ }
  }

  // No upstream found — proceed with null; upstream reads return null.
  return { upstreamRoot: null, manifestSource: 'none' };
}

/**
 * Main entry point for brain:adopt S1.
 *
 * Parses args, resolves upstream, walks the target tree, builds the canonical
 * plan, and writes plan.json + report.md to the output directory.
 *
 * Exported so callers (tests, CI wrappers) can invoke programmatically without
 * spawning a subprocess.
 *
 * @param {string[]} argv - Argument vector (process.argv.slice(2) or override).
 * @returns {Promise<object|null>} The assembled plan, or null when --help exits early.
 */
export async function run(argv) {
  // ── Parse args ────────────────────────────────────────────────────────────
  let targetArg = null;
  let outArg = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--out' || arg === '-o') {
      if (!argv[i + 1] || argv[i + 1].startsWith('-')) {
        console.error('brain:adopt: --out requires a directory path');
        process.exit(1);
      }
      outArg = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      console.log(HELP);
      return null;
    } else if (!arg.startsWith('--')) {
      targetArg = arg;
    }
  }

  const targetRoot = targetArg ? resolve(targetArg) : process.cwd();
  const outDir = outArg ? resolve(outArg) : join(targetRoot, '.brain-adopt');

  // ── Resolve upstream reference root ──────────────────────────────────────
  const { upstreamRoot, manifestSource } = resolveUpstreamRoot(targetRoot);

  // ── Walk the target tree ──────────────────────────────────────────────────
  // listFiles from installer.mjs returns POSIX-style relative paths, skipping
  // node_modules/ and .git/ so the upstream mock in fixtures is not scanned.
  const files = listFiles(targetRoot);

  // ── I/O closures — the ONLY place node:fs reads happen in this pipeline ──
  const readConsumer = (relPath) =>
    readFileSync(join(targetRoot, relPath), 'utf8');

  const readUpstream = (logicalName) => {
    if (!upstreamRoot) return null;
    const abs = join(upstreamRoot, logicalName);
    if (!existsSync(abs)) return null;
    try {
      return readFileSync(abs, 'utf8');
    } catch {
      return null;
    }
  };

  // ── Assemble the canonical plan ───────────────────────────────────────────
  // generatedAt uses real Date here — this is the I/O edge, not a pure lib.
  const plan = await buildPlan({
    files,
    readConsumer,
    readUpstream,
    manifest: { managed, local },
    generatedAt: new Date().toISOString(),
    manifestSource,
  });

  // ── Write output (ONLY writes within outDir — read-only contract) ─────────
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  writeFileSync(join(outDir, 'report.md'), renderReport(plan));

  // ── Print summary to stdout ───────────────────────────────────────────────
  const { summary, target } = plan;
  console.log(`\nbrain:adopt S1 — read-only inventory complete`);
  console.log(`  Target:    ${targetRoot} (shape: ${target.shape})`);
  console.log(
    `  Files:     ${summary.total} total — ` +
    `${summary.generic} managed, ${summary.project} project-owned`,
  );
  if (summary.translation > 0)
    console.log(`  Translations:       ${summary.translation} (see Replacements in report.md)`);
  if (summary.drift > 0)
    console.log(`  Drift (auto-adopt): ${summary.drift}`);
  if (summary.flagForReview > 0)
    console.log(`  Flagged for review: ${summary.flagForReview}`);
  if (summary.upstreamMissing > 0)
    console.log(`  Upstream missing:   ${summary.upstreamMissing}`);
  console.log(`  Output:    ${outDir}`);
  console.log(`    plan.json  — ${plan.files.length} file record(s)`);
  console.log(`    report.md  — human-readable report`);
  console.log();

  return plan;
}

// ── CLI entry point ───────────────────────────────────────────────────────────
// Guard: execute only when this file is the Node.js process entry point.
// When imported by tests or other modules, process.argv[1] is the caller's
// path, not this file's path, so the CLI does not run on import.
if (process.argv[1] === __filename) {
  run(process.argv.slice(2)).catch((err) => {
    console.error(`brain:adopt: ${err.message ?? err}`);
    process.exit(1);
  });
}
