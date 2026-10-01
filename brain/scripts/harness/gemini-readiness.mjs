// Gemini route and readiness helpers.
//
// Setup uses this small adapter instead of teaching the generic stage resolver
// about vendor model catalogues.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { COLD_REVIEW_STAGE, resolveStageEngine } from '../lib/stage-engine.mjs';
import { GEMINI_MODEL, hasAgyAuth } from '../axes/review-engine/adapters/gemini.mjs';

/**
 * Resolve whether the effective cold-review route makes Gemini a dependency.
 * Non-Gemini routes stay deliberately outside every Gemini check.
 */
export function resolveGeminiRoute(config) {
  const routing = resolveStageEngine(config, COLD_REVIEW_STAGE);
  if (routing === null || routing.engine !== 'gemini') {
    return { required: false, stage: COLD_REVIEW_STAGE, engine: routing?.engine ?? null, model: routing?.model ?? null };
  }
  const model = routing.model ?? GEMINI_MODEL;
  return {
    required: true,
    stage: COLD_REVIEW_STAGE,
    engine: routing.engine,
    model,
    identity: `${COLD_REVIEW_STAGE}:${routing.engine}/${model}`,
  };
}

function defaultCommandExists(bin, env = process.env) {
  return env?.PATH?.split(':').some((dir) => existsSync(join(dir, bin))) ?? false;
}

/**
 * Check only deterministic local prerequisites for Gemini.
 */
export function checkGeminiReadiness(route, {
  commandExists = defaultCommandExists,
  env = process.env,
  agyAuthCheck = hasAgyAuth,
} = {}) {
  if (!route?.required) {
    const engine = route?.engine ?? 'no engine';
    return { ready: true, required: false, diagnostic: `cold-review is routed to ${engine}; Gemini is not required` };
  }
  const hasAgy = commandExists('agy', env) && agyAuthCheck(env);
  const hasGemini = commandExists('gemini', env);
  const hasApiKey = typeof env?.GEMINI_API_KEY === 'string' && env.GEMINI_API_KEY.trim() !== '';
  const hasGoogleCreds = typeof env?.GOOGLE_APPLICATION_CREDENTIALS === 'string' && env.GOOGLE_APPLICATION_CREDENTIALS.trim() !== '';

  if (!hasAgy && !hasGemini) {
    return {
      ready: false,
      required: true,
      diagnostic: 'Gemini is required by cold-review:gemini but neither agy (authenticated via Antigravity CLI for Google AI Pro subscriptions) nor gemini CLI is installed.',
    };
  }

  if (!hasAgy && !hasApiKey && !hasGoogleCreds) {
    return {
      ready: false,
      required: true,
      diagnostic: 'Gemini CLI is installed but not authenticated; set GEMINI_API_KEY or GOOGLE_APPLICATION_CREDENTIALS before cold review.',
    };
  }

  const runner = hasAgy
    ? 'agy (Google AI Pro subscription)'
    : (hasApiKey ? 'gemini (API key)' : 'gemini (ADC)');
  return {
    ready: true,
    required: true,
    diagnostic: `Gemini runner ${runner} is available for ${route.identity}; the review run verifies model access, network, and the read-only sandbox.`,
  };
}

export function loadConfig(cwd) {
  const file = join(cwd, 'brain.config.json');
  if (!existsSync(file)) return {};
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`could not resolve the cold-review route from ${file}: ${error.message}`);
  }
}

async function main() {
  const mode = process.argv[2] ?? '--check';
  const config = loadConfig(process.cwd());
  const route = resolveGeminiRoute(config);
  if (mode === '--required') {
    process.stdout.write(`${route.required ? 'yes' : 'no'}\n`);
    return;
  }
  if (mode !== '--check') throw new Error(`unknown Gemini readiness mode: ${mode}`);
  const result = checkGeminiReadiness(route);
  process.stdout.write(`${result.diagnostic}\n`);
  if (!result.ready) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    process.stderr.write(`Gemini readiness failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
