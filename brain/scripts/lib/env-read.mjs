// env-read.mjs — ONE reader for `.env`, one precedence, and a losing value that
// is reported rather than dropped (issue #316, M2).
//
// THE DEFECT THIS CLOSES. Four independent parsers read `.env`, and they
// disagreed on the two things a reader is for:
//
//   brain/scripts/harness/cli.mjs:23   shell first · no value trim · comments skipped
//   brain/scripts/memory/cli.mjs:52    shell first · no value trim · comments skipped
//   brain/scripts/vcs/lib/token.mjs:27 FILE  first · value trimmed · `startsWith("KEY=")`
//   brain/scripts/day-start.mjs:72     FILE  first · value trimmed · `startsWith("KEY=")`
//
// Two and two. Which value an operator gets depended on which module happened to
// ask, and nothing in the tree said so. The ticket's own Deliverables declared
// `process.env > .env > default`, which two of the four already violated.
//
// AND THE QUOTE DIVERGENCE THE TICKET NAMED DOES NOT EXIST. Measured: none of
// the four strips quotes, so `VCS_TOKEN="abc"` resolved to `"abc"` WITH them and
// produced a 401 naming nothing. That is not a divergence, it is a shared
// defect, and it is fixed here rather than preserved for symmetry.
//
// ── THE PRECEDENCE, AND WHY THIS ONE ────────────────────────────────────────
//
// **The shell wins.** Ruled 2026-08-27, on four measurements rather than taste:
// the ticket's Deliverables already said so; two of the four parsers already did
// it; `VAR=… command` is what every operator means by it; and file-first is what
// produced the incident that reopened this ticket — a DEAD `VCS_TOKEN` line in
// `.env` shadowing a healthy `gh` keyring session, with every port verb
// answering `HTTP 401 Bad credentials` while `gh auth status` reported a good
// login. Under shell-first that failure cannot be built.
//
// THE LOSING VALUE IS REPORTED, and that is the whole of Gap C
// (`docs/inbox/credential-roles-coexistence.md`). A precedence rule decides
// which value WINS; it must not decide which value is MENTIONED. Three `.env`
// edits that could not possibly take effect, in silence, is what a rule without
// a reporter costs — so `resolveEnv` returns `shadowed` and `ignored` and the
// caller decides how loudly to say it.
//
// ── WHAT THIS MODULE MAY NOT BECOME ─────────────────────────────────────────
//
// It may not make `BRAIN_REVIEWER_TOKEN` file-readable. ADR-0033 Amendment 1
// (#773) ruled that credential shell-resolved, because a file on disk is not an
// environment variable and `withoutCredentials` only reaches the latter —
// routing the reviewer through a file-reading resolver is exactly the shape that
// would deliver that change while looking like plumbing. `readShellEnv` is the
// named opt-out, spelled at the CALL SITE so a reviewer can see the ruling being
// obeyed rather than having to check an options object.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The value returned for a key nothing states. Never `undefined`: a caller
 *  distinguishing "absent" from "stated empty" reads `source`, not falsiness. */
const ABSENT = null;

/**
 * parseEnvFile() — text in, map out. PURE, and the only parse in the tree.
 *
 * Rules, each of which one of the four call sites got differently:
 *
 *   - `#` comments and blank lines are skipped (token.mjs's `startsWith` never
 *     was — it just failed to match them, which is not the same thing and left
 *     `# KEY=x` able to shadow nothing while looking like it could).
 *   - The FIRST `=` splits; a value may contain more (`URL=https://x?a=b`).
 *   - Key and value are trimmed INDIVIDUALLY. Trimming the line and slicing —
 *     what harness and memory did — yields the key `"KEY "` for `KEY = v`, a key
 *     no lookup can ever reach.
 *   - ONE matched pair of surrounding quotes is stripped. Unmatched quotes and
 *     inner quotes are left exactly as written: stripping those would silently
 *     rewrite a value that may legitimately contain one.
 *
 * @param {string} text
 * @returns {Record<string, string>}
 */
export function parseEnvFile(text) {
  const vars = {};
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    if (!key) continue;
    vars[key] = unquote(trimmed.slice(eq + 1).trim());
  }
  return vars;
}

/** Strips one matched pair of surrounding quotes, and nothing else. */
function unquote(value) {
  if (value.length < 2) return value;
  const first = value[0];
  if ((first === '"' || first === "'") && value[value.length - 1] === first) {
    return value.slice(1, -1);
  }
  return value;
}

/** Reads and parses `<root>/.env`. A missing or unreadable file is `{}` — an
 *  absent file is the common case, not an error. */
function readFile(root, envFile) {
  const path = envFile ?? join(root, '.env');
  try {
    return parseEnvFile(readFileSync(path, 'utf8'));
  } catch {
    return {};
  }
}

/**
 * resolveEnv() — the whole resolution, with its provenance.
 *
 * @param {string} key
 * @param {{env?: object, root?: string, envFile?: string|null,
 *          fallback?: string|null, allowFile?: boolean}} [options]
 *   `allowFile: false` is the ADR-0033 Amendment 1 opt-out. Prefer the named
 *   `readShellEnv` spelling at call sites — see this module's header.
 * @returns {{key: string, value: string|null,
 *            source: 'shell'|'file'|'default'|'absent',
 *            shadowed: {source: 'file', value: string}|null,
 *            ignored: {source: 'file', reason: 'shell-only'}|null}}
 */
export function resolveEnv(key, {
  env = process.env,
  root = process.cwd(),
  envFile = null,
  fallback = ABSENT,
  allowFile = true,
} = {}) {
  const fromShell = Object.prototype.hasOwnProperty.call(env ?? {}, key) ? env[key] : undefined;
  // READ UNCONDITIONALLY, including when `allowFile` is false. A value that
  // exists and is being ignored is exactly what an operator needs told, and a
  // reader that skipped the file on the shell-only path could not tell them.
  const fileVars = readFile(root, envFile);
  const hasFile = Object.prototype.hasOwnProperty.call(fileVars, key);
  const fromFile = hasFile ? fileVars[key] : undefined;

  const ignored = (!allowFile && hasFile) ? { source: 'file', reason: 'shell-only' } : null;

  if (fromShell !== undefined) {
    const shadowed = (allowFile && hasFile && fromFile !== fromShell)
      ? { source: 'file', value: fromFile }
      : null;
    return { key, value: fromShell, source: 'shell', shadowed, ignored };
  }

  if (allowFile && hasFile) {
    return { key, value: fromFile, source: 'file', shadowed: null, ignored };
  }

  if (fallback !== ABSENT && fallback !== undefined) {
    return { key, value: fallback, source: 'default', shadowed: null, ignored };
  }

  return { key, value: ABSENT, source: 'absent', shadowed: null, ignored };
}

/** The convenience spelling: the value, or `null`. */
export function readEnv(key, options = {}) {
  return resolveEnv(key, options).value;
}

/**
 * readShellEnv() — resolve from the shell ONLY, never from a file.
 *
 * The named form of `allowFile: false`, and it is named so that the one place
 * the ruling applies READS like the ruling: `BRAIN_REVIEWER_TOKEN` stays
 * shell-resolved (ADR-0033 Amendment 1, #773). A file value that exists is still
 * reported through `resolveEnv(...).ignored` — refusing to use it is a decision,
 * and refusing to MENTION it is the silence this ticket exists to remove.
 */
export function readShellEnv(key, options = {}) {
  return resolveEnv(key, { ...options, allowFile: false }).value;
}

/**
 * describeResolution() — one line an operator can act on, for refusals and for
 * the doctor verb Gap D asks for.
 *
 * IT NEVER PRINTS THE VALUE. Every caller of this module resolves credentials
 * somewhere, and a diagnostic that leaks one into a log or a CI transcript is a
 * worse defect than the silence it replaces.
 */
export function describeResolution(res) {
  const where = {
    shell: 'the shell environment',
    file: '.env',
    default: 'a built-in default',
    absent: 'nothing — it is unset',
  }[res.source];

  let line = `${res.key}: resolved from ${where}`;
  if (res.shadowed) line += `; a different value in .env was shadowed and NOT used`;
  if (res.ignored) line += `; a value in .env was ignored — this key is shell-only by ruling (ADR-0033 Amendment 1)`;
  return line;
}
