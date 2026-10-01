// brain/scripts/axes/lib/agent-runtime.mjs — generic AI-agent-runtime
// probe for the ecosystem step of `brain:day:start` (issue #123).
//
// ADR-0005 is the constraint: brain is harness-agnostic, so this is NOT
// "update claude". It is "ask the harness the repo DECLARES which runtime it
// needs, read that runtime's version, and say something true about it". Each
// platform backend owns one `AGENT_RUNTIME` descriptor; this module knows the
// descriptor shape and nothing else. Adding a fourth platform tomorrow means
// exporting one more descriptor — no edit here, no edit in day-start.mjs.
//
// Notify, never auto-update. `probeAgentRuntime` executes exactly two things:
// the descriptor's version command and its latest-version command. It never
// executes `updateHint` — that string is printed for a human to run, mirroring
// the brain-tag check's stance (ADR-0006 and
// brain/core/anti-patterns/instaladores-autoactualizantes-no-inocuos.md).
//
// Every failure keeps its own name. `absent` (the binary is not installed),
// `unreadable` (it is installed but would not say which version),
// `unknown-latest` (the installed version is known, the newest one is not) and
// `unresolved` (the backend module itself could not be loaded) are four
// different facts and are never collapsed into one another — a reader that
// answers "nothing" to both "there is nothing" and "I could not look" reports
// a silence it never measured.

import { spawnSync } from 'node:child_process';

import { compareSemver } from '../../lib/installer.mjs';
// FROM THE LEAF, NOT FROM THE DISPATCHER. This line used to read
// `from '../../harness/cli.mjs'` and closed the cycle that deadlocked the shipped
// bootstrap path: cli.mjs's top-level await dynamically imports a backend,
// whose static graph came back here and re-entered a module still evaluating.
// A backend may not import the dispatcher — see platform.mjs.
import { resolvePlatform } from '../../harness/platform.mjs';
import { harnessAdapterUrl } from './harness-adapter-url.mjs';

/**
 * The states `probeAgentRuntime`/`agentRuntimeReport` can return, each a
 * distinct fact about the configured runtime.
 */
export const RUNTIME_STATES = Object.freeze([
  'not-declared',    // the backend declares no runtime to check (e.g. plain)
  'seam-missing',    // the backend exports no AGENT_RUNTIME at all — nobody declared anything
  'unresolved',      // the backend module could not be loaded — we did not look
  'timeout',         // the binary is installed and did not answer in time
  'absent',          // the runtime binary is not installed
  'unreadable',      // the binary answered, but not with a version
  'unknown-latest',  // installed version known; newest version could not be read
  'up-to-date',      // installed >= latest
  'update-available',// installed < latest
]);

const SEMVER_RE = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/;

/** First semver-looking token in a command's stdout, or null. */
function parseVersion(stdout) {
  const m = SEMVER_RE.exec(String(stdout ?? ''));
  return m ? m[1] : null;
}

/** Short, non-empty description of why a command produced no version. */
function failureDetail(result) {
  const parts = [
    result?.error?.message,
    String(result?.stderr ?? '').trim(),
    String(result?.stdout ?? '').trim(),
  ].filter(Boolean);
  const detail = parts.join(' — ').split('\n')[0];
  return detail || `exited with status ${result?.status ?? 'unknown'}`;
}

/**
 * How long a single probe command may take. day:start is interactive and the
 * latest-version probe is a network call: without this, an offline or
 * proxy-blocked run hangs the whole verb at this step (spawnSync is
 * synchronous — nothing else proceeds meanwhile).
 */
export const RUN_TIMEOUT_MS = 10_000;

/**
 * Default command runner: captured output, never a shell, always bounded.
 *
 * `cwd` IS PART OF THE CONTRACT, and it was silently dropped until #682's cold
 * review found it. `claude.mjs`'s `runStage` has always called
 * `_run(cmd, args, { cwd, timeoutMs })`, and this function destructured only
 * `timeoutMs` — so `spawnSync` inherited the parent's directory and the engine
 * read whatever tree the operator happened to be standing in. Production masked
 * it because `cli.mjs` makes `root === process.cwd()` when `deps.root` is unset;
 * the day they differ, the engine reviews an unrelated directory, the artifact
 * check at `run-cold-review-stage.mjs` finds nothing, and the run reports "the
 * engine exited cleanly but wrote no artifact" — a true refusal with a false
 * diagnosis.
 *
 * Same shape as the `dispatch`-discards-its-result defect: a seam that drops a
 * value nobody notices is missing. Its oracle has to be the REAL runner — every
 * caller-side test hands in a spy, and a spy records the `cwd` it was given no
 * matter what this function does with it.
 *
 * An absent `cwd` still means "inherit", which is what every probe caller wants.
 *
 * `env` HAS THE SAME CONTRACT AND EXISTS FOR THE OPPOSITE REASON. Absent, the
 * child inherits `process.env` — right for the probes, which need PATH, the
 * proxy vars and the npm registry config to read a version at all. Given, the
 * child gets EXACTLY that object and nothing else, which is what lets
 * `runStage` hand a producer an environment with brain's posting credentials
 * removed (judgment:cold-2). This function does not decide WHICH names those
 * are — see `lib/credential-env.mjs`; it only stops the pass-through from
 * being unrepresentable.
 *
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ timeoutMs?: number, cwd?: string, env?: object }} [opts]
 */
export function defaultRun(cmd, args, { timeoutMs = RUN_TIMEOUT_MS, cwd, env } = {}) {
  return spawnSync(cmd, args, { stdio: 'pipe', encoding: 'utf8', timeout: timeoutMs, cwd, env });
}

/**
 * Reads the state of one declared agent runtime. Pure apart from the injected
 * `_run` seam; never throws.
 *
 * @param {object|null} descriptor A backend's `AGENT_RUNTIME`:
 *   `{ name, bin, versionArgs, latest: { cmd, args } | null, updateHint }`.
 * @param {{ _run?: (cmd: string, args: string[]) => object }} [opts]
 * @returns {{ state: string, name: string|null, bin: string|null,
 *   installed: string|null, latest: string|null, updateHint: string|null,
 *   detail: string|null }}
 */
export function probeAgentRuntime(descriptor, { _run = defaultRun } = {}) {
  const base = {
    name: descriptor?.name ?? null,
    bin: descriptor?.bin ?? null,
    installed: null,
    latest: null,
    updateHint: descriptor?.updateHint ?? null,
    detail: null,
  };

  if (!descriptor) return { ...base, state: 'not-declared' };

  let versionResult;
  try {
    versionResult = _run(descriptor.bin, descriptor.versionArgs ?? []);
  } catch (err) {
    // The runner itself blew up — we never got an answer ABOUT the binary.
    return { ...base, state: 'unreadable', detail: err.message };
  }

  // Only ENOENT means "not installed" — and it is the CODE that says so, never
  // the message. spawnSync also sets `error` for ETIMEDOUT (installed, hung
  // past our own timeout) and EACCES (installed, not executable by this user);
  // both describe a binary that IS there. Reading `error` alone told an
  // operator behind a proxy to install the CLI they already had (#614).
  if (versionResult?.error) {
    const code = versionResult.error.code;
    if (code === 'ENOENT') {
      return { ...base, state: 'absent', detail: failureDetail(versionResult) };
    }
    return {
      ...base,
      state: code === 'ETIMEDOUT' ? 'timeout' : 'unreadable',
      detail: failureDetail(versionResult),
    };
  }
  if (versionResult?.status !== 0) {
    return { ...base, state: 'unreadable', detail: failureDetail(versionResult) };
  }

  const installed = parseVersion(versionResult.stdout);
  if (!installed) {
    // The binary is here and answered — it just did not answer with a version.
    return { ...base, state: 'unreadable', detail: failureDetail(versionResult) };
  }

  if (!descriptor.latest) {
    return {
      ...base,
      state: 'unknown-latest',
      installed,
      detail: 'the backend declares no latest-version probe',
    };
  }

  let latestResult;
  try {
    latestResult = _run(descriptor.latest.cmd, descriptor.latest.args ?? []);
  } catch (err) {
    return { ...base, state: 'unknown-latest', installed, detail: err.message };
  }

  if (latestResult?.error || latestResult?.status !== 0) {
    return { ...base, state: 'unknown-latest', installed, detail: failureDetail(latestResult) };
  }

  const latest = parseVersion(latestResult.stdout);
  if (!latest) {
    return { ...base, state: 'unknown-latest', installed, detail: failureDetail(latestResult) };
  }

  const order = compareSemver(latest, installed);
  if (order === 0 && latest !== installed) {
    // compareSemver reads major.minor.patch only. Two strings it ranks equal
    // while differing (a prerelease suffix, build metadata) were NOT ordered —
    // saying "up to date" there would assert a comparison nobody made.
    return {
      ...base,
      state: 'unknown-latest',
      installed,
      detail: `cannot order "${installed}" against "${latest}" — prerelease/build suffixes are not compared`,
    };
  }

  return { ...base, state: order > 0 ? 'update-available' : 'up-to-date', installed, latest };
}

/**
 * Reads BOTH platform axis keys through the caller's env reader, so a repo
 * declaring only the legacy `SDD_HARNESS` (ADR-0024 keeps it as a fallback)
 * resolves to what it declared instead of the default platform.
 *
 * @param {(key: string) => string|null} readEnvVar
 * @returns {{ AGENT_PLATFORM: string|null, SDD_HARNESS: string|null }}
 */
export function platformEnvVars(readEnvVar) {
  return {
    AGENT_PLATFORM: readEnvVar('AGENT_PLATFORM'),
    SDD_HARNESS: readEnvVar('SDD_HARNESS'),
  };
}

/**
 * Normalizes brain.config.json's optional harness declaration into the shape
 * `resolvePlatform` reads. A consumer may reasonably write either
 * `"harness": "claude"` (a string) or `"harness": { "platform": "claude" }`;
 * passing the raw string through as the config object silently resolves to the
 * default instead of to what the consumer declared.
 *
 * @param {object|null} config The full brain.config.json object.
 * @returns {{ platform?: string, harness?: string }}
 */
export function platformConfig(config) {
  const harness = config?.harness;
  if (typeof harness === 'string') return { harness };
  if (harness && typeof harness === 'object') return { ...harness };
  return {};
}

/**
 * Renders one probe result as operator-facing text. Pure.
 *
 * Strings are English literals rather than `t()` keys: the i18n catalogs live
 * in `brain/scripts/i18n/**`, outside this change's file claim. See the PR.
 *
 * @param {object} status A `probeAgentRuntime` result.
 * @param {string} [platform] The configured platform name, for the states that
 *   describe the backend rather than the runtime.
 * @returns {{ level: 'ok'|'info'|'warn', message: string, hint: string|null }}
 */
export function formatRuntimeNotice(status, platform = null) {
  const who = status?.name ?? platform ?? 'agent runtime';
  const detail = status?.detail ? ` (${status.detail})` : '';

  switch (status?.state) {
    case 'not-declared':
      return {
        level: 'info',
        message: `harness '${platform ?? who}' declares no agent runtime to check.`,
        hint: null,
      };
    case 'unresolved':
      return {
        level: 'warn',
        message: `agent runtime not checked — harness '${platform ?? who}' could not be loaded${detail}.`,
        hint: 'Check AGENT_PLATFORM / brain.config.json — the configured harness has no backend.',
      };
    case 'absent':
      return {
        level: 'info',
        message: `${who} is not installed${detail}.`,
        hint: status?.updateHint ? `Install it with: ${status.updateHint}` : null,
      };
    case 'seam-missing':
      return {
        level: 'warn',
        message: `harness '${platform ?? who}' declares no AGENT_RUNTIME export at all.`,
        hint: 'Every backend must declare the seam — export `AGENT_RUNTIME = null` if there is deliberately nothing to probe.',
      };
    case 'timeout':
      return {
        level: 'warn',
        message: `${who} is installed but did not answer in time${detail}.`,
        hint: 'Version check skipped — a slow network or proxy will do this; the runtime itself may be fine.',
      };
    case 'unreadable':
      return {
        level: 'warn',
        message: `${who} is installed but did not report a version${detail}.`,
        hint: 'Version check skipped — brain will not guess which version is running.',
      };
    case 'unknown-latest':
      return {
        level: 'info',
        message: `${who} ${status.installed} — latest version unknown${detail}.`,
        hint: null,
      };
    case 'update-available':
      return {
        level: 'warn',
        message: `New ${who} version available: ${status.installed} → ${status.latest}`,
        hint: `${status.updateHint ?? 'update it with your package manager'} — not applied automatically.`,
      };
    case 'up-to-date':
      return {
        level: 'ok',
        message: `${who} up to date (${status.installed}).`,
        hint: null,
      };
    default:
      return {
        level: 'warn',
        message: `${who}: unrecognized runtime state '${status?.state}'.`,
        hint: null,
      };
  }
}

async function defaultLoadBackend(platform) {
  return import(harnessAdapterUrl(platform));
}

/**
 * Resolves the CONFIGURED platform, reads its declared runtime, and returns the
 * probe result plus the text to print. Never throws, never auto-updates.
 *
 * @param {object} [opts]
 * @param {object} [opts.env]     Process env (for AGENT_PLATFORM).
 * @param {object} [opts.envVars] Parsed .env vars.
 * @param {object} [opts.config]  brain.config.json's harness section.
 * @param {(platform: string) => Promise<object>} [opts._loadBackend]
 * @param {(cmd: string, args: string[]) => object} [opts._run]
 * @returns {Promise<{ platform: string, status: object, notice: object }>}
 */
export async function agentRuntimeReport({
  env = process.env,
  envVars = {},
  config = {},
  _loadBackend = defaultLoadBackend,
  _run = defaultRun,
} = {}) {
  const platform = resolvePlatform({ env, envVars, config });

  let backend;
  try {
    backend = await _loadBackend(platform);
  } catch (err) {
    const status = {
      state: 'unresolved',
      name: null,
      bin: null,
      installed: null,
      latest: null,
      updateHint: null,
      detail: err.message,
    };
    return { platform, status, notice: formatRuntimeNotice(status, platform) };
  }

  // `?? null` here would make "nobody wrote the export" indistinguishable from
  // "this backend deliberately declares nothing" — the two comments that used
  // to claim otherwise were measurably false (#614).
  if (!backend || !Object.hasOwn(backend, 'AGENT_RUNTIME')) {
    const status = {
      state: 'seam-missing', name: null, bin: null,
      installed: null, latest: null, updateHint: null,
      detail: `backend '${platform}' exports no AGENT_RUNTIME`,
    };
    return { platform, status, notice: formatRuntimeNotice(status, platform) };
  }

  const status = probeAgentRuntime(backend.AGENT_RUNTIME, { _run });
  return { platform, status, notice: formatRuntimeNotice(status, platform) };
}
