// Codex route and readiness helpers.
//
// Setup uses this small adapter instead of teaching the generic stage resolver
// about vendor model catalogues. `stage-engine.mjs` deliberately keeps models
// opaque for every other stage; this transport has a separately specified,
// pinned model contract.

import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { COLD_REVIEW_STAGE, resolveStageEngine } from '../lib/stage-engine.mjs';

export const CODEX_MODEL = 'gpt-5.5';
export const MIN_CODEX_VERSION = Object.freeze([0, 154, 0]);

function versionAtLeast(actual, minimum = MIN_CODEX_VERSION) {
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index];
  }
  return true;
}

function parseVersion(output) {
  const match = String(output ?? '').match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  return match ? match.slice(1).map(Number) : null;
}

function resultText(result) {
  return String(result?.stdout ?? '').trim() || String(result?.stderr ?? '').trim();
}

/**
 * Resolve whether the effective cold-review route makes Codex a dependency.
 * Non-Codex routes stay deliberately outside every Codex check.
 */
export function resolveCodexRoute(config) {
  const routing = resolveStageEngine(config, COLD_REVIEW_STAGE);
  if (routing === null) {
    return { required: false, stage: COLD_REVIEW_STAGE, engine: null, model: null };
  }
  if (routing.engine !== 'codex') {
    return { required: false, stage: COLD_REVIEW_STAGE, engine: routing.engine, model: routing.model };
  }
  if (routing.model !== CODEX_MODEL) {
    throw new Error(`Codex cold-review route requires model ${CODEX_MODEL}; received ${routing.model ?? 'none'}`);
  }
  return {
    required: true,
    stage: COLD_REVIEW_STAGE,
    engine: routing.engine,
    model: routing.model,
    identity: `${COLD_REVIEW_STAGE}:${routing.engine}/${routing.model}`,
  };
}

function defaultCommandExists(bin) {
  return process.env.PATH?.split(':').some((dir) => existsSync(join(dir, bin))) ?? false;
}

function defaultRun(bin, args) {
  try {
    return spawnSync(bin, args, { encoding: 'utf8', timeout: 10_000 });
  } catch (error) {
    return { error, status: null };
  }
}

/**
 * Check only deterministic local prerequisites. A real review invocation still
 * validates model entitlement, network, an isolated writable CODEX_HOME, and
 * the read-only sandbox against its immutable candidate.
 */
export function checkCodexReadiness(route, {
  commandExists = defaultCommandExists,
  run = defaultRun,
} = {}) {
  if (!route?.required) {
    const engine = route?.engine ?? 'no engine';
    return { ready: true, required: false, diagnostic: `cold-review is routed to ${engine}; Codex is not required` };
  }
  if (!commandExists('codex')) {
    return {
      ready: false,
      required: true,
      diagnostic: 'Codex is required by cold-review:codex/gpt-5.5 but is not installed; run npm install -g @openai/codex.',
    };
  }
  const versionResult = run('codex', ['--version']);
  const version = parseVersion(resultText(versionResult));
  if (versionResult?.status !== 0 || version === null || !versionAtLeast(version)) {
    return {
      ready: false,
      required: true,
      diagnostic: `Codex cold-review requires Codex CLI ${MIN_CODEX_VERSION.join('.')} or newer; update @openai/codex.`,
    };
  }
  const authResult = run('codex', ['login', 'status']);
  if (authResult?.status !== 0) {
    return {
      ready: false,
      required: true,
      diagnostic: 'Codex is installed but not authenticated; run codex login before cold review. Credentials are never stored in brain.config.json.',
    };
  }
  return {
    ready: true,
    required: true,
    diagnostic: `Codex ${version.join('.')} is authenticated for ${route.identity}; the review run verifies model access, network, writable isolated state, and the read-only sandbox.`,
  };
}

function loadConfig(cwd) {
  const file = join(cwd, 'brain.config.json');
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`could not resolve the cold-review route from ${file}: ${error.message}`);
  }
}

async function main() {
  const mode = process.argv[2] ?? '--check';
  const config = loadConfig(process.cwd());
  const route = resolveCodexRoute(config);
  if (mode === '--required') {
    process.stdout.write(`${route.required ? 'yes' : 'no'}\n`);
    return;
  }
  if (mode !== '--check') throw new Error(`unknown Codex readiness mode: ${mode}`);
  const result = checkCodexReadiness(route);
  process.stdout.write(`${result.diagnostic}\n`);
  if (!result.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`Codex readiness failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
