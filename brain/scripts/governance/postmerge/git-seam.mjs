// git-seam.mjs — the ONE git primitive the platform-neutral core is built
// on. A throw-only boolean seam cannot express git's own tri-states (e.g.
// `ls-remote --exit-code` 0/2/other, `diff --quiet` 0/1/128); this seam
// returns the raw status instead, so callers map every code explicitly. An
// unmapped status is uncomputable, never a verdict (design §4).

import { execFileSync } from 'node:child_process';

// Node's execFileSync defaults to a 1 MiB output buffer, which a single
// `git diff --binary` over a memory-sync merge blows straight through
// (.memory/records/*.jsonl is committed and grows monotonically). Exceeding it
// kills the spawn with ENOBUFS, and an ENOBUFS carries no git exit code — so it
// collapsed to -1 and surfaced as `governance:audit-uncomputable`, reddening the
// release gate over an infra limit rather than a governance violation (#332).
// A finite ceiling is deliberate: it stays a backstop against a runaway diff
// exhausting the runner's memory, and when it IS hit the reason is now legible.
const DEFAULT_MAX_BUFFER = 256 * 1024 * 1024;

/**
 * Run `git <argv>`, capturing status/stdout/stderr. NEVER throws on a
 * non-zero exit. A genuine spawn failure (e.g. missing binary) collapses to
 * status -1 — still distinguishable from every real git exit code.
 *
 * @param {string[]} argv
 * @param {{ cwd?: string, maxBuffer?: number }} [opts]
 */
export function gitTry(argv, { cwd = process.cwd(), maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  try {
    const stdout = execFileSync('git', argv, {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer,
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) { /* surfaced: mapped to status -1 with the reason kept; an unmapped status is uncomputable, never a verdict */
    // ENOBUFS is OUR limit, not git's. It still collapses to -1 (an unmapped
    // status is uncomputable, never a verdict — see the module header), but the
    // reason must survive: err.stderr is empty here, so the plain fallback below
    // would report a bare `exited -1:` with nothing to act on.
    if (err.code === 'ENOBUFS') {
      return {
        status: -1,
        stdout: typeof err.stdout === 'string' ? err.stdout : '',
        stderr: `git output exceeded the ${maxBuffer}-byte output buffer (ENOBUFS)`,
      };
    }
    return {
      status: typeof err.status === 'number' ? err.status : -1,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : String(err.message ?? ''),
    };
  }
}

/** Run `git <argv>`; return stdout on status 0, throw (`.status` attached) otherwise. */
export function gitOrThrow(argv, opts = {}) {
  const result = gitTry(argv, opts);
  if (result.status !== 0) {
    const err = new Error(`git ${argv.join(' ')} exited ${result.status}: ${result.stderr.trim()}`);
    err.status = result.status;
    err.stdout = result.stdout;
    err.stderr = result.stderr;
    throw err;
  }
  return result.stdout;
}
