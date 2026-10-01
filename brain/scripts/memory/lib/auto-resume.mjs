// brain/scripts/memory/lib/auto-resume.mjs — isolation-wrapped feature-resume helper.
//
// Provides tryFeatureResume(root, opts) for use by ticket-start.mjs on the
// re-checkout path (branch already exists / resuming, including worktree-attach).
//
// Design contract (REQ-S3-1):
//   - FULLY ISOLATED: any failure (ambiguous feature, non-zero exit, thrown error,
//     engram absent) is caught and produces a null return. NEVER throws.
//   - On exit 0: returns the stdout string (the verb already prints the resume point).
//   - On any failure: returns null so the calling code can show a single-line warning.
//
// Injectable seam:
//   opts._runner(root) — receives the repo root, returns { status, stdout, stderr }.
//   Used in unit tests to avoid real subprocess spawns.
//   Default: spawnSync(process.execPath, ['brain/scripts/memory/cli.mjs', 'feature-resume'],
//             { cwd: root, encoding: 'utf8' })

import { spawnSync } from 'node:child_process';

import { EXIT_UNDECLARED, EXIT_INVALID, DECLARE_FIX } from './backend-resolve.mjs';
// Re-exported: session-start.mjs has a deliberately narrow import allowlist, and this module is on it.
export { EXIT_UNDECLARED, EXIT_INVALID, DECLARE_FIX };

/**
 * Default subprocess runner — spawns `node brain/scripts/memory/cli.mjs feature-resume`
 * with {cwd: root, encoding: 'utf8'}.
 *
 * @param {string} root  Repo root to use as cwd.
 * @returns {{ status: number|null, stdout: string, stderr: string }}
 */
function defaultRunner(root) {
  return spawnSync(
    process.execPath,
    ['brain/scripts/memory/cli.mjs', 'feature-resume'],
    { cwd: root, encoding: 'utf8' },
  );
}

/**
 * Try to run `feature-resume` and return the output, or null on any failure.
 *
 * This function is FULLY ISOLATED — it never throws regardless of:
 *   - Ambiguous feature (multiple openspec/changes/* dirs) → cli exits non-zero → null.
 *   - Missing engram or non-zero exit for any reason → null.
 *   - Runner itself throws (node not found, permission error, etc.) → null.
 *   - A resume.md with no resume point → cli exits 0 with informational message → returns it.
 *
 * Callers may safely log a warning on null and continue with the surrounding
 * checkout / env-copy / VCS-auth flow without any change to that flow's outcome.
 *
 * @param {string} root            Repo root (or worktree root) to run the verb in.
 * @param {object} [opts]          Injectable seams for testing.
 * @param {(root: string) => { status: number|null, stdout: string, stderr: string }}
 *        [opts._runner]           Subprocess runner; defaults to spawnSync wrapper above.
 * @returns {string|null}          stdout on exit 0 (plus a `projection incomplete` line when a
 *                                 non-zero exit still printed a summary); null on any other failure.
 */
export function tryFeatureResume(root, { _runner } = {}) {
  try {
    const run = _runner ?? defaultRunner;
    const result = run(root);
    if (result.status === 0) {
      return result.stdout ?? '';
    }
    // Exit 3/4 is memory/cli.mjs's declaration refusal (#1165): nothing was tried, so this must
    // not read as "no resume point". Matched by CODE, never by (localized) text.
    if (result.status === EXIT_UNDECLARED) return `  ⚠ memory backend not declared — ${DECLARE_FIX}\n`;
    if (result.status === EXIT_INVALID) return `  ⚠ memory backend invalid — see the refusal from \`npm run brain:memory:pull\`; ${DECLARE_FIX}\n`;
    // feature-resume prints the resume summary BEFORE it projects, and exits 1 when a
    // projection failed (#1127). Dropping that stdout would cost the operator the
    // summary for a failure that did not touch it: keep it and name the failure.
    const summary = (result.stdout ?? '').trim();
    if (summary) {
      const stderr = String(result.stderr ?? '');
      const projected = /not projected into engram — ([^\n]*)/.exec(stderr);
      const tail = projected
        ? `projection incomplete: ${projected[1]}`
        : `feature-resume exited ${result.status ?? 'abnormally'}`;
      return `${result.stdout}\n  ⚠ ${tail}\n`;
    }
    return null;
  } catch { /* swallow-ok: the resume hint is advisory; a runner that cannot start yields null, the same as no resume point */
    // Runner threw (binary not found, permission error, etc.) — isolate.
    return null;
  }
}
