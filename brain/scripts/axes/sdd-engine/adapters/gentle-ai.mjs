#!/usr/bin/env node
// brain/scripts/axes/sdd-engine/adapters/gentle-ai.mjs — gentle-ai harness backend.
//
// Implements the harness verb contract for gentle-ai (ADR-0012).
// Exported functions are called by brain/scripts/harness/cli.mjs; callers should
// never invoke the gentle-ai binary directly.
//
// Ported from bootstrap.sh §6 (the inline `case "$SDD_HARNESS" in gentle-ai)`
// block). All external subprocess calls are injectable for unit testing.
//
// Verbs:
//   init() — ecosystem setup (doctor / install / skill-registry refresh)
//             + SDD project context check (engram search sdd-init/<project>).

/**
 * No agent runtime to version-check here (issue #123).
 *
 * gentle-ai is the SDD ENGINE axis (ADR-0024), not an agent platform:
 * `resolvePlatform` never returns it, and day:start already checks its version
 * in the ecosystem step. The export exists so every backend answers the same
 * question. A backend that omits it entirely reports `seam-missing` and a
 * registry test fails, so "someone forgot" cannot pass for "declares nothing"
 * (#614 — until then the two were byte-identical outcomes).
 */
export const AGENT_RUNTIME = null;

/**
 * gentle-ai's inhabitant surface (issue #814 T2) — the adapter #312's port
 * calls. Answers EVERY stage it is asked about: lifecycle stages from the
 * RECORDED declaration (`gentle-ai.roles.mjs`, provenance inside), a custom
 * stage with the framework's default producer role marked `derived: true`.
 *
 * @param {string[]} stages The resolved stage set to declare a role for.
 * @returns {Record<string, {stage: string, agent: string, model_tier: string, chooses_model: false, instructions: string, derived?: true}>}
 */
export function declareRoles(stages) {
  return Object.fromEntries(stages.map((stage) => {
    const recorded = GENTLE_AI_ROLES[stage];
    return [stage, recorded ? { stage, ...recorded } : derivedRole(stage)];
  }));
}

import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { t } from '../../../i18n/t.mjs';
import { GENTLE_AI_ROLES, derivedRole } from './gentle-ai.roles.mjs';
import { artifactPaths, LIFECYCLE_STAGES } from '../../../lib/sdd-layout.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

// ---------------------------------------------------------------------------
// Default injectable implementations
// ---------------------------------------------------------------------------

function _defaultCheckGentleAi() {
  const r = spawnSync('which', ['gentle-ai'], { encoding: 'utf8' });
  return r.status === 0;
}

function _defaultRunDoctor() {
  // Returns true when 'gentle-ai doctor' output contains 'state file OK'.
  const r = spawnSync('gentle-ai', ['doctor'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return r.status === 0 && (r.stdout ?? '').includes('state file OK');
}

function _defaultRunInstall() {
  // Interactive install — inherits TTY so the user can interact.
  const r = spawnSync('gentle-ai', ['install'], { stdio: 'inherit' });
  return r.status === 0;
}

function _defaultRefreshRegistry() {
  const r = spawnSync('gentle-ai', ['skill-registry', 'refresh'], {
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  return r.status === 0;
}

function _defaultCheckTty() {
  // isTTY is true when stdin is connected to an interactive terminal.
  return Boolean(process.stdin.isTTY);
}

/**
 * Extract the bare repo name (last path segment) from a slug or origin-project
 * path. Engram scopes projects by the bare repo name, not the full owner/repo
 * path that config files or git origins typically provide.
 *
 * Examples:
 *   "csrinaldi/brain"      → "brain"
 *   "group/sub/repo"       → "repo"
 *   "brain"                → "brain"
 *   null / ""              → null
 *
 * @param {string|null} slug Full project path or slug.
 * @returns {string|null} Bare repo name, or null when input is falsy/empty.
 */
export function _toEngramProject(slug) {
  if (!slug) return null;
  return slug.split('/').filter(Boolean).pop() ?? null;
}

function _defaultResolveProject() {
  // Resolve the engram project name (bare repo name = last path segment of the
  // slug or git-origin project path). Engram scopes this repo as "brain", not
  // the full slug "csrinaldi/brain" that brain.config.json or git origin provides.
  const configPath = join(repoRoot, 'brain.config.json');
  if (existsSync(configPath)) {
    try {
      const cfg = JSON.parse(readFileSync(configPath, 'utf8'));
      if (cfg?.project?.slug) return _toEngramProject(cfg.project.slug);
    } catch {
      // brain.config.json malformed — fall through
    }
  }
  // Fallback: derive project from git origin remote URL
  try {
    const r = spawnSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8',
      cwd: repoRoot,
    });
    if (r.status !== 0 || !r.stdout) return null;
    const m = r.stdout.trim().match(
      /(?:https?:\/\/(?:[^@/]+@)?|git@)[^/:]+(?::\d+)?[/:](.+?)(?:\.git)?$/,
    );
    return m ? _toEngramProject(m[1]) : null;
  } catch {
    return null;
  }
}

function _defaultCheckEngram() {
  const r = spawnSync('which', ['engram'], { encoding: 'utf8' });
  return r.status === 0;
}

function _defaultRunEngramSearch(project) {
  // Returns true when engram reports at least one result for sdd-init/<project>.
  const r = spawnSync(
    'engram',
    ['search', `sdd-init/${project}`, '--project', project, '--limit', '1'],
    { encoding: 'utf8', timeout: 8000 },
  );
  if (r.status !== 0) return false;
  const out = (r.stdout ?? '').trim();
  return out.length > 0 && !out.includes('No memories found');
}

function _defaultResolveDecisionsDir() {
  return join(repoRoot, 'brain', 'project', 'decisions');
}

/**
 * Returns true when the decisions directory contains at least one `.md` file;
 * false when the directory is absent, empty, or unreadable.
 *
 * @param {string} dir Absolute path to the decisions directory.
 * @returns {boolean}
 */
function _defaultCheckDecisionsDir(dir) {
  try {
    if (!existsSync(dir)) return false;
    return readdirSync(dir).some((f) => f.endsWith('.md'));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Internal helper: SDD project context check (Step 3)
// ---------------------------------------------------------------------------

/**
 * Checks whether the engram SDD context for this project exists.
 * Bare returns here exit only this helper, not init() — allowing Step 4 to
 * always run regardless of the engram/project resolution outcome.
 */
async function checkSddContext({ _resolveProject, _checkEngram, _runEngramSearch }) {
  const project = (() => { try { return _resolveProject(); } catch { return null; } })();
  if (!project) {
    console.warn('  harness: could not resolve project slug — skipping SDD context check');
    return;
  }

  const engramPresent = (() => { try { return _checkEngram(); } catch { return false; } })();
  if (!engramPresent) {
    // engram absent is non-fatal — user may not have set it up yet
    return;
  }

  try {
    const found = _runEngramSearch(project);
    if (!found) {
      console.log(`  harness: SDD context 'sdd-init/${project}' not found in engram.`);
      console.log(
        '    The agent Init Guard will create it on the first /sdd-* command.',
      );
      console.log('    To create it now, run: /sdd-init');
    }
    // Context found — no noise needed; ecosystem is ready.
  } catch {
    // engram call failed — non-fatal
    console.warn('  harness: SDD context check failed (non-blocking)');
  }
}

// ---------------------------------------------------------------------------
// Verb: init
// ---------------------------------------------------------------------------

/**
 * Initialize the gentle-ai SDD ecosystem and check SDD project context.
 *
 * Ecosystem step (mirrors bootstrap.sh §6 case gentle-ai block):
 *   1. If gentle-ai binary absent → warn and return.
 *   2. If `gentle-ai doctor` reports healthy → log ok, skip install.
 *   3. If unhealthy + TTY → run `gentle-ai install` (interactive).
 *   4. If unhealthy + no TTY → warn.
 *   5. Refresh skill registry (best-effort, non-fatal).
 *
 * SDD context step:
 *   6. Resolve engram project name (bare repo name) from brain.config.json or git origin.
 *   7. Search engram for `sdd-init/<project>` in the project namespace.
 *   8. If NOT found → print a clear notice that the agent Init Guard will
 *      create it on the first /sdd-* command (or run /sdd-init explicitly).
 *   9. Never throws — guard ensures missing engram/gentle-ai is non-fatal.
 *
 * All external calls are injectable via opts for unit testing.
 *
 * @param {object} [opts] Injectable seams.
 * @param {() => boolean} [opts._checkGentleAi]  Returns true if gentle-ai binary present.
 * @param {() => boolean} [opts._runDoctor]       Returns true if ecosystem is healthy.
 * @param {() => boolean} [opts._runInstall]      Runs install; returns true on success.
 * @param {() => boolean} [opts._refreshRegistry] Refreshes skill registry; returns true on success.
 * @param {() => boolean} [opts._checkTty]        Returns true if stdin is a TTY.
 * @param {() => string|null} [opts._resolveProject] Returns bare engram project name or null.
 * @param {() => boolean} [opts._checkEngram]     Returns true if engram binary present.
 * @param {(project: string) => boolean} [opts._runEngramSearch]
 *   Returns true if sdd-init/<project> found in engram.
 * @param {() => string} [opts._resolveDecisionsDir]
 *   Returns the absolute path to brain/project/decisions/.
 * @param {(dir: string) => boolean} [opts._checkDecisionsDir]
 *   Returns true when the dir contains at least one .md file; false when absent or empty.
 */
export async function init({
  _checkGentleAi  = _defaultCheckGentleAi,
  _runDoctor      = _defaultRunDoctor,
  _runInstall     = _defaultRunInstall,
  _refreshRegistry = _defaultRefreshRegistry,
  _checkTty       = _defaultCheckTty,
  _resolveProject = _defaultResolveProject,
  _checkEngram    = _defaultCheckEngram,
  _runEngramSearch = _defaultRunEngramSearch,
  _resolveDecisionsDir = _defaultResolveDecisionsDir,
  _checkDecisionsDir   = _defaultCheckDecisionsDir,
} = {}) {

  // ── Step 1: Ecosystem ─────────────────────────────────────────────────────

  if (!_checkGentleAi()) {
    console.warn(
      '  harness: gentle-ai not found — brew install gentle-ai and re-run brain:env:init',
    );
    return;
  }

  let doctorOk = false;
  try { doctorOk = _runDoctor(); } catch { /* treat as unhealthy */ }

  if (doctorOk) {
    console.log('  harness: ecosystem already initialized (gentle-ai doctor)');
  } else if (_checkTty()) {
    let installOk = false;
    try { installOk = _runInstall(); } catch { /* fall through to warn */ }
    if (installOk) {
      console.log('  harness: ecosystem configured (skills, engram, gga)');
    } else {
      console.warn(
        '  harness: gentle-ai install failed — run it manually and re-run brain:env:init',
      );
    }
  } else {
    console.warn("  harness: no TTY — run 'gentle-ai install' manually");
  }

  // ── Step 2: Skill registry refresh (best-effort) ─────────────────────────

  try {
    const ok = _refreshRegistry();
    if (ok) {
      console.log('  harness: skill registry updated');
    } else {
      console.warn('  harness: skill-registry refresh failed (non-blocking)');
    }
  } catch {
    console.warn('  harness: skill-registry refresh failed (non-blocking)');
  }

  // ── Step 3: SDD project context check ────────────────────────────────────
  //
  // Delegated to checkSddContext() so its bare `return`s do not exit init().
  // Step 4 (pure-fs ADR gap detection) must always run regardless of whether
  // the engram / project-slug resolution succeeds.

  await checkSddContext({ _resolveProject, _checkEngram, _runEngramSearch });

  // ── Step 4: Project ADR gap detection (pure fs — no network) ─────────────

  const adrsPresent = _checkDecisionsDir(_resolveDecisionsDir());
  if (!adrsPresent) {
    console.log(`  harness: ${await t('bootstrap.sdd.noProjectAdrs')}`);
    console.log(`    ${await t('bootstrap.sdd.noProjectAdrsHint')}`);
  }
}

/**
 * The S2 evidence guard, shared verbatim by both engine wirings (#323 S4 D3):
 * a lifecycle payload without BOUND routed evidence refuses at the engine
 * layer too — the same demand the transport guard makes, one layer earlier.
 */
function assertBoundEvidence(stage, routed, changeId) {
  // Round 5: the two INPUTS themselves. An unnamed stage is a caller that lost
  // its argument (stage-engine's own history, mirrored at last), and a
  // lifecycle run without a changeId would target 'openspec/changes/undefined/…'
  // — silent wrong behavior, the inverse of a refusal.
  if (typeof stage !== 'string' || stage.trim() === '') {
    throw new Error(`run-stage: ${JSON.stringify(stage)} is not a stage name — a caller that lost its argument, refused before it targets anything.`);
  }
  if (LIFECYCLE_STAGES.includes(stage) && (typeof changeId !== 'string' || changeId.trim() === '')) {
    throw new Error(`run-stage: lifecycle stage "${stage}" needs a changeId — without one the target would be a path literally containing "undefined".`);
  }
  // Round 2 of #836's cold review: the guard mirrors assertRoutableStage's
  // OPTION-A split exactly — only LIFECYCLE stages owe evidence; a custom
  // stage (cold-review, the flagship) arrives evidence-free by the very rule
  // this change shipped, and demanding it here produced a FALSE refusal on a
  // reachable config. Reproduced before fixing.
  if (!LIFECYCLE_STAGES.includes(stage)) {
    if (routed && routed.routed === true && routed.stage !== stage) {
      throw new Error(
        `run-stage: routed evidence was computed for "${routed.stage}" and handed to "${stage}" — bound, never bearer.`
      );
    }
    return;
  }
  if (!(routed && routed.routed === true)) {
    throw new Error(
      `run-stage: lifecycle stage "${stage}" arrived without routed evidence — call ` +
      'assertRoutedStage({config, stage}) and hand its result through (#323 S2, condition 4).'
    );
  }
  if (routed.stage !== stage) {
    throw new Error(
      `run-stage: routed evidence was computed for "${routed.stage}" and handed to "${stage}" — bound, never bearer.`
    );
  }
}

/**
 * gentle-ai's run-stage (#323 S4 D2): the framework runs ON the platform,
 * explicitly. The prompt is composed FROM the port's recorded instructions —
 * `routed.role.instructions`, never the installed files (#814's rule) — and
 * the spawn is DELEGATED to the claude backend as transport: a
 * sibling-backend import, stated; the dispatcher stays unimported
 * (platform.mjs's rule intact). The transport's own {ok, reason} rides
 * through untouched — the seam's doctrine one layer down.
 *
 * @param {{stage: string, routed?: object, changeId?: string, model?: string|null,
 *          _transport?: (payload: object) => Promise<object>}} payload — every
 *          field not named here (cwd, timeoutMs, credentialEnv, forgeConfigDir,
 *          and whatever arrives next) rides ...rest to the transport untouched.
 * @returns {Promise<object>} the transport's answer, verbatim
 */
export async function runStage({ stage, prompt: callerPrompt, routed, changeId, model = null, _transport, ...rest } = {}) {
  assertBoundEvidence(stage, routed, changeId);
  const target = artifactPaths(changeId)[stage];
  // Round 2: S2's custom-stage evidence carries NO role (stage-engine returns
  // {routed, stage, routing} there) — reading role.instructions crashed with a
  // TypeError, which is not a refusal. A custom stage composes from THIS
  // engine's own declaration (its recorded data or derivedRole — module-local,
  // the same #814 rule: never installed files). A lifecycle stage keeps the
  // port-resolved role its evidence guarantees.
  const role = routed?.role ?? (GENTLE_AI_ROLES[stage] ? { stage, ...GENTLE_AI_ROLES[stage] } : derivedRole(stage));
  // Round 8, the deepest of the family: the caller's prompt used to land in
  // ...rest and the composed one OVERWROTE it by object-literal precedence —
  // the assembled cold-review prompt (the only carrier of prNumber, the diff
  // range and the artifact path) silently discarded on every routed run. The
  // caller's prompt WINS; composition from the port is the fallback for runs
  // that arrive without one.
  const prompt = callerPrompt ?? [
    role.instructions,
    '',
    // Round 7: the LAST unguarded interpolation — its two siblings (stage,
    // target) were guarded in rounds 5-6; this one hid three lines above.
    `You are producing the "${stage}" artefact${changeId ? ` for change "${changeId}"` : ''}.`,
    target
      ? `Write exactly one file: ${target} — the layout's single accessor names it; do not relocate or rename it.`
      : `The "${stage}" stage writes to its own declared root — follow its chain's conventions; it is not one of the four lifecycle artefacts.`,
    'Follow the repository\'s existing artefact conventions; run nothing destructive.',
  ].join('\n');

  const transport = _transport ?? (async (payload) => {
    const { runStage: claudeRunStage } = await import('../../platform/adapters/claude.mjs');
    return claudeRunStage(payload);
  });
  // Round 4 of #836's cold review killed the destructure-and-drop CLASS here:
  // credentialEnv and forgeConfigDir were the fifth dropped-field instance —
  // and the one that spawned the child UNSCRUBBED while the forge-reach probe
  // verified the shadow (ADR-0033). Everything this wrapper does not consume
  // rides ...rest to the transport, so a sixth field cannot be dropped.
  return transport({ ...rest, stage, prompt, model: model ?? routed?.routing?.model ?? null, routed });
}
