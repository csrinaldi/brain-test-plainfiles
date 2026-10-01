#!/usr/bin/env node
// brain/scripts/axes/platform/adapters/claude.mjs — claude platform backend (issue #305).
//
// Implements the harness verb contract for Claude Code platform backend.
// Emits .claude/settings.json deterministically with workspace hooks.

import { assertRoutableStage } from '../../../lib/stage-engine.mjs';
import { credentialEnvNames, withoutCredentials } from '../../../lib/credential-env.mjs';
import { withForgeConfigDir } from '../../../harness/producer-forge-reach.mjs';
import { DEFAULT_STAGE_TIMEOUT_MS, formatDuration } from '../../../lib/duration.mjs';
import { defaultRun } from '../../lib/agent-runtime.mjs';
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { compileSettingsHooksJson } from '../lib/settings-hooks.mjs';
import { mergeSettings } from '../../../lib/installer.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** Repo-root-relative path for Claude Code native settings hooks (issue #305). */
export const CLAUDE_SETTINGS_EMIT_PATH = '.claude/settings.json';

/**
 * The AI agent runtime this platform needs, as data (issue #123).
 *
 * `brain:day:start` reads whatever the CONFIGURED platform declares here and
 * NOTIFIES — it never runs `updateHint`. Keeping the runtime as a descriptor is
 * what keeps ADR-0005 intact: day-start knows the shape, never the vendor.
 */
export const AGENT_RUNTIME = Object.freeze({
  name: 'claude',
  bin: 'claude',
  versionArgs: ['--version'],
  latest: Object.freeze({ cmd: 'npm', args: ['view', '@anthropic-ai/claude-code', 'version'] }),
  updateHint: 'npm install -g @anthropic-ai/claude-code@latest',
});

// The settings-hooks payload itself is NOT claude-specific and no longer lives
// here (issue #315): it was byte-identical to antigravity's copy. What is
// claude-specific is CLAUDE_SETTINGS_EMIT_PATH above — the only thing that ever
// differed. See settings-hooks.mjs.

function _defaultWriteFile(relPath, content, root) {
  const fullPath = join(root, relPath);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content, 'utf8');
}

/**
 * Reads relPath's raw content, or `null` if it does not exist. Never throws
 * on a missing file — a malformed-but-present file's JSON.parse failure is
 * the caller's business (it knows the path for the error message).
 */
function _defaultReadFile(relPath, root) {
  const fullPath = join(root, relPath);
  if (!existsSync(fullPath)) return null;
  return readFileSync(fullPath, 'utf8');
}

/**
 * Compiles and merges .claude/settings.json hooks into any existing file
 * (issue #1139) using the same `mergeSettings` core `brain:upgrade` uses
 * (`mergeClaudeSettings` in lib/installer.mjs) — never overwrites consumer
 * content. Never throws.
 *
 * @param {object} [opts] Injectable seams.
 * @param {() => (string|null)} [opts._readClaudeSettings]
 *   Reads the existing .claude/settings.json raw content, or `null` if absent.
 * @param {(relPath: string, content: string) => void} [opts._writeClaudeSettings]
 *   Writes the compiled .claude/settings.json content.
 * @param {string} [opts._repoRoot] Repo root used by the default seams.
 * @returns {Promise<undefined|{ok: false, reason: string}>}
 *   `undefined` on success (unchanged contract). `{ok: false, reason}` ONLY
 *   when the existing file could not be parsed as JSON — the one case where
 *   `init()` refuses to write rather than silently overwrite (#1127: no
 *   report-success-over-a-failure).
 */
export async function init({
  _readClaudeSettings,
  _writeClaudeSettings,
  _repoRoot = repoRoot,
} = {}) {
  const readClaudeSettings = _readClaudeSettings ?? (() => _defaultReadFile(CLAUDE_SETTINGS_EMIT_PATH, _repoRoot));
  const writeClaudeSettings = _writeClaudeSettings ?? ((relPath, content) => _defaultWriteFile(relPath, content, _repoRoot));

  const brainSettings = JSON.parse(compileSettingsHooksJson());

  const existingRaw = readClaudeSettings();
  let existingSettings = null;
  if (existingRaw != null) {
    try {
      existingSettings = JSON.parse(existingRaw);
    } catch (err) {
      const reason =
        `claude: ${CLAUDE_SETTINGS_EMIT_PATH} is not valid JSON — ${err.message}. ` +
        `Fix or remove the file, then re-run brain:env:init.`;
      console.warn(`  harness: ${reason}`);
      return { ok: false, reason };
    }
  }

  const merged = mergeSettings(existingSettings, brainSettings);
  const settingsContent = JSON.stringify(merged, null, 2) + '\n';

  try {
    writeClaudeSettings(CLAUDE_SETTINGS_EMIT_PATH, settingsContent);
  } catch (err) {
    console.warn(`  harness: claude could not write ${CLAUDE_SETTINGS_EMIT_PATH} — ${err.message}`);
  }
}

// ── run-stage — #682 slice B, ADR-0033 ───────────────────────────────────────

/**
 * The wall clock a stage engine gets, RE-EXPORTED rather than declared
 * (judgment:cold-6). This was its own `10 * 60_000` beside an identical literal
 * in the review port whose docstring claimed the default was "one number rather
 * than one per backend". It is now.
 *
 * The comment that used to sit here — "a review reads a diff; it is not a
 * build" — was wrong about what a reviewer does, and the first real run proved
 * it: the engine opens the files the diff does NOT touch, reads the ADRs a
 * finding must cite, and runs probes of its own. See `lib/duration.mjs`.
 */
export const STAGE_TIMEOUT_MS = DEFAULT_STAGE_TIMEOUT_MS;

/**
 * runStage() — spawn an engine to produce one stage's artifact.
 *
 * THE CONTRACT IS THE FILE, AND BRAIN DOES NOT PARSE STDOUT. The engine writes
 * the stage's artifact (`openspec/reviews/pr-NNN/` for `cold-review`) and brain
 * reads it afterwards with its own reader. Nothing here interprets what the
 * agent said, which is what keeps the boundary auditable: the only thing that
 * crosses is a file whose shape has its own tests.
 *
 * IT HOLDS NO VCS CREDENTIAL AND POSTS NOTHING. The poster keeps every one of
 * reviewer-protocol.md §2's three locks; a producer that could post would need
 * each of them re-proved on a second surface, and would need the credential
 * #604 proved cannot be trusted where the environment injects it.
 *
 * THAT SENTENCE WAS A CLAIM WITH NO READER UNTIL judgment:cold-2. `defaultRun`
 * spawned with no `env`, so the child inherited `process.env` whole —
 * `BRAIN_REVIEWER_TOKEN` and `GH_TOKEN` included, measured — and the only thing
 * between the producer and the pull request was a line of prompt text asking it
 * not to post. The scrub below is what makes the capitals true.
 *
 * IT SCRUBS BY DEFAULT, AND THE CALLER MAY ONLY WIDEN. `credentialEnv` defaults
 * to `credentialEnvNames()`, so a future stage whose caller forgets to pass
 * anything still gets a producer that cannot authenticate as brain's poster.
 * The review layer passes the repo's CONFIGURED `reviewer.tokenEnv` on top,
 * because this layer cannot read `brain.config.json` — `loadBrainConfig`
 * resolves from the module's own location, which in a consumer is inside
 * `node_modules`. A default that is already fail-closed is what makes that
 * threading a widening rather than the whole mechanism.
 *
 * WHAT IT DOES NOT CLOSE is written down in `credential-env.mjs` and matters
 * here too: an environment that injects credentials ambiently (#604) is
 * untouched by scrubbing one — `gatherIdentity` refuses the whole run on that
 * axis before this is ever reached — and a REPO-LOCAL credential on disk is kept
 * out by the detached worktree, not by this.
 *
 * A CREDENTIAL STORE OUTSIDE THE REPOSITORY IS NEITHER. This paragraph used to
 * say "a credential on disk", which read as all of them; `~/.config/gh` plus the
 * OS keyring sit on disk, outside any worktree, and survived the scrub when the
 * third cold review measured them. `producer-forge-reach.mjs` is what closes
 * that channel, and it PROBES rather than asserts — the capitals above are true
 * of the `env` axis by construction and of that axis by measurement, which are
 * two different warrants and are no longer written as one.
 *
 * A NON-ZERO EXIT IS A FAILURE, never an empty result. `cli.mjs` refuses to post
 * on a failure rather than render a verdict declaring a control it never applied
 * — "the engine broke" and "the engine found nothing" are the two states #552
 * exists to keep apart, and this is the layer where they are easiest to fold.
 *
 * @param {{stage: string, prompt: string, model?: string|null, cwd?: string,
 *          timeoutMs?: number, credentialEnv?: string[], _env?: object,
 *          _run?: Function}} args
 * @returns {Promise<{ok: true} | {ok: false, reason: string}>}
 */
/**
 * Whatever the engine managed to say before it was killed, trimmed to something
 * a terminal line can carry. `stderr` first — that is where a tool explains
 * itself — then `stdout`, because an engine that printed its reasoning to the
 * wrong stream still printed it.
 */
function tail(r, max = 300) {
  const text = String(r?.stderr ?? '').trim() || String(r?.stdout ?? '').trim();
  if (!text) return '';
  const last = text.split('\n').filter(Boolean).slice(-2).join(' / ');
  return ` — the engine last said: ${last.length > max ? `${last.slice(0, max)}…` : last}`;
}

export async function runStage({
  stage, prompt, model = null, cwd = process.cwd(),
  timeoutMs = STAGE_TIMEOUT_MS, credentialEnv = null, forgeConfigDir = null,
  routed = undefined,
  _env = process.env, _run = defaultRun, _now = Date.now,
} = {}) {
  // #323 S2: a lifecycle stage needs the routing check's evidence — the caller
  // runs assertRoutedStage and hands the result through. Custom stages (every
  // caller today) are untouched.
  assertRoutableStage(stage, { routed });

  if (typeof prompt !== 'string' || prompt.trim() === '') {
    return { ok: false, reason: `no prompt for stage "${stage}" — an engine with nothing to do is not a run` };
  }

  // The model rides as given. #323 ruled it an opaque pass-through, so brain
  // neither validates it nor supplies a default: an absent model means the
  // engine's own, which is the engine's business.
  //
  // --settings {disableAllHooks: true} (#1010): this repo's own committed
  // `.claude/settings.json` wires a SessionStart hook that runs
  // `npm run brain:session:start`. Every stage this backend runs, including a
  // cold review over the repo's OWN candidate worktree, inherits that hook —
  // so the producer's SessionStart side effects landed inside the very
  // candidate the stage exists to judge (measured: `.engram -> .memory`
  // appearing mid-review, `candidate-snapshot.mjs` then refusing or crashing
  // on it). The CLI honours `disableAllHooks`, closing that path
  // unconditionally rather than trusting every future hook addition to check
  // "am I running inside a review candidate" for itself. Platform-specific by
  // design: brain's contract with an engine is "must not mutate the
  // candidate", not "must not run hooks" — this is how the claude backend
  // keeps that contract.
  const args = [
    '-p', prompt,
    ...(model ? ['--model', model] : []),
    '--settings', JSON.stringify({ disableAllHooks: true }),
  ];

  // Computed here, not at the call: an `env` built by the caller could be
  // handed in unscrubbed, and then the property would hold only for callers
  // that remembered. `credentialEnv` names what to REMOVE, never what to keep.
  const scrubbed = withoutCredentials(
    _env,
    Array.isArray(credentialEnv) ? credentialEnvNames({ extra: credentialEnv }) : credentialEnvNames(),
  );

  // #775 — THE SHADOW IS APPLIED TO THE SCRUBBED ENV, AND THE ORDER IS THE
  // WHOLE GUARANTEE. `forgeConfigDir` points the forge CLIs brain names at a
  // per-run directory the caller owns, so a keyring session the scrub cannot
  // reach becomes one the CLI cannot FIND. Applied to `_env` and merged
  // afterwards it could re-admit a credential the scrub had just removed, so it
  // is applied here and takes a PATH rather than an env bag: there is no
  // spelling of this parameter that adds a variable brain did not name.
  //
  // NO DEFAULT. A directory invented here would shadow the operator's forge CLI
  // on every stage brain ever routes. The caller that owns the cold review's
  // isolation owns this too, and it is the same caller that runs the probe —
  // which is what keeps the probe measuring the env the child actually gets.
  const env = forgeConfigDir ? withForgeConfigDir(scrubbed, forgeConfigDir) : scrubbed;

  let r;
  const startedAt = _now();
  // MEASURED ON EVERY RUN, not only on the failing one. `STAGE_TIMEOUT_MS` was a
  // number nobody had exercised until the first end-to-end cold review died at
  // it, and the reason nobody could say whether ten minutes was close or absurd
  // is that no run had ever reported how long it took. See stage-timeout.mjs.
  const elapsed = () => _now() - startedAt;

  try {
    r = _run('claude', args, { cwd, timeoutMs, env });
  } catch (err) {
    return { ok: false, elapsedMs: elapsed(), reason: `the engine could not be spawned: ${err.message}` };
  }

  // spawnSync reports a timeout through `error`, not through `status`. Read both
  // or a hung engine returns `status: null` and reads as success.
  if (r?.error) {
    // THE OUTPUT RIDES ALONG, and it did not until F.9. This branch returned
    // `r.error.message` alone, so on a timeout — the one failure where knowing
    // what the engine was doing matters most — everything it had printed was
    // discarded. `spawnSync` captures both streams up to the moment it kills the
    // child, so the evidence existed and was thrown away: the `dispatch`-drops-
    // its-result shape again, in the branch that can least afford it.
    const timedOut = r.error.code === 'ETIMEDOUT';
    return {
      ok: false,
      elapsedMs: elapsed(),
      reason:
        (timedOut
          ? `the engine did not finish within ${formatDuration(timeoutMs)}`
          : `the engine failed to run: ${r.error.message}`) +
        (timedOut
          ? '. Raise `reviewer.stageTimeoutMs` if the change is large — a review opens the files the ' +
            'diff does not touch, reads the ADRs a finding must cite, and may run the suite'
          : '') +
        tail(r),
    };
  }
  if (r?.status !== 0) {
    return {
      ok: false,
      elapsedMs: elapsed(),
      reason: `the engine exited ${r?.status === null ? 'without a status (timed out?)' : `with status ${r?.status}`}` +
        `${r?.stderr ? ` — ${String(r.stderr).trim().split('\n')[0]}` : ''}`,
    };
  }

  return { ok: true, elapsedMs: elapsed() };
}
