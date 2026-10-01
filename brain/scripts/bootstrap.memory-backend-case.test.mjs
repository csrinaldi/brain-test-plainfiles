// bootstrap.memory-backend-case.test.mjs — issue #1112, fifth finding
// (folded from the #1112 issue comments, verified on origin/main at 1.7.0).
//
// bootstrap.sh's §7 `case "$MEMORY_BACKEND" in` had only an `engram)` arm and
// a catch-all `*)` that warns `I18N_BOOTSTRAP_MEMORY_UNKNOWNBACKEND`.
// `MEMORY_BACKEND=plainfiles` is a real, supported backend
// (`axes/memory/adapters/plainfiles.mjs`) but fell into the catch-all and was
// reported as unknown.
//
// Same idiom as bootstrap.worktree.test.mjs / bootstrap.tier-notice.test.mjs:
// the case block is LIFTED OUT OF bootstrap.sh verbatim and executed, so
// there is no second copy of the dispatch logic to drift from the real one
// (#340).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const LINES = readFileSync(BOOTSTRAP, 'utf8').split('\n');

/** The verbatim memory-step helper functions (#1127). */
function helpersBlock() {
  const start = LINES.findIndex((l) => l.includes('BEGIN memory-step-helpers'));
  const end = LINES.findIndex((l, i) => i > start && l.includes('END memory-step-helpers'));
  assert.ok(start >= 0 && end > start, 'bootstrap.sh must carry the memory-step-helpers block');
  return LINES.slice(start, end).join('\n');
}

/** The verbatim `case "$MEMORY_BACKEND" in ... esac` block, as bootstrap.sh writes it. */
function memoryBackendCaseBlock() {
  const start = LINES.findIndex((l) => l.trim() === 'case "$MEMORY_BACKEND" in');
  assert.ok(start >= 0, 'bootstrap.sh must have `case "$MEMORY_BACKEND" in`');
  const end = LINES.findIndex((l, i) => i > start && l.trim() === 'esac');
  assert.ok(end > start, 'bootstrap.sh must close the case with `esac`');
  return LINES.slice(start, end + 1).join('\n');
}

/**
 * Runs the extracted case block with a fake `node`/PM on PATH so `command -v
 * node` succeeds and every `node .../cli.mjs …` / `$PM run …` call is just
 * recorded, never actually spawning real memory backends. Returns
 * {out, calls} — `out` is whatever `ok`/`warn` recorded, `calls` is every
 * recorded node/PM invocation's argv tail.
 */
function runCase(memoryBackend) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-1112-membackend-'));
  try {
    const bin = join(dir, 'bin');
    execFileSync('mkdir', ['-p', bin]);
    const callsFile = join(dir, 'calls.log');
    writeFileSync(callsFile, '');
    // Fake `node`: records argv, always exits 0 (setup/index "succeed").
    writeFileSync(
      join(bin, 'node'),
      `#!/usr/bin/env bash\necho "node $*" >> "${callsFile}"\nexit 0\n`,
    );
    chmodSync(join(bin, 'node'), 0o755);

    // A stand-in engram binary: hydration/index are only attempted when it exists (#1127).
    writeFileSync(join(bin, 'engram'), '#!/usr/bin/env bash\nexit 0\n');
    chmodSync(join(bin, 'engram'), 0o755);

    const outFile = join(dir, 'out.log');
    writeFileSync(outFile, '');
    const script = [
      'set -euo pipefail',
      `ok() { echo "OK:$1" >> "${outFile}"; }`,
      `warn() { echo "WARN:$1" >> "${outFile}"; }`,
      'BRAIN_SCRIPTS=/fake/brain/scripts',
      `WORKTREE_ROOT="${dir}"`,
      // bootstrap.sh calls `$PM run --silent ...` — PM is a plain word, not a
      // function call, so give it a real command name via a wrapper script.
      `PM="${bin}/pm"`,
      `MEMORY_BACKEND=${memoryBackend}`,
      'I18N_BOOTSTRAP_MEMORY_NODEABSENT=node-absent',
      'I18N_BOOTSTRAP_MEMORY_ENGRAM_OK=engram-ok',
      'I18N_BOOTSTRAP_MEMORY_ENGRAM_FAILED=engram-failed',
      'I18N_BOOTSTRAP_MEMORY_PULL_OK=pull-ok',
      'I18N_BOOTSTRAP_MEMORY_PULL_FAILED=pull-failed',
      'I18N_BOOTSTRAP_MEMORY_INDEX_OK=index-ok',
      'I18N_BOOTSTRAP_MEMORY_INDEX_FAILED=index-failed',
      'I18N_BOOTSTRAP_MEMORY_PLAINFILES_OK=plainfiles-ok',
      'I18N_BOOTSTRAP_MEMORY_PLAINFILES_FAILED=plainfiles-failed',
      'I18N_BOOTSTRAP_MEMORY_PLAINFILES_NOINDEX=plainfiles-noindex',
      "I18N_BOOTSTRAP_MEMORY_UNKNOWNBACKEND=unknown-backend-%s",
      // Slice A (#1127): pull/index run through the helpers, and engram hydration needs the engram
      // binary. The preflight is stubbed; the dispatch under test is the case arm.
      'I18N_BOOTSTRAP_MEMORY_PULL_SKIPPED=pull-skipped-%s',
      'I18N_BOOTSTRAP_MEMORY_PULL_OFFLINE=offline',
      'I18N_BOOTSTRAP_MEMORY_ENGRAMABSENT=engram-absent',
      'MISSING_OPTIONAL=(); REQUIRED_FAILURES=()',
      helpersBlock(),
      'memory_pull_unavailable() { return 1; }',
      memoryBackendCaseBlock(),
    ].join('\n');

    writeFileSync(
      join(bin, 'pm'),
      `#!/usr/bin/env bash\necho "pm $*" >> "${callsFile}"\nexit 0\n`,
    );
    chmodSync(join(bin, 'pm'), 0o755);

    execFileSync('bash', ['-c', script], {
      cwd: dir,
      env: { PATH: `${bin}:${process.env.PATH}` },
      encoding: 'utf8',
    });

    return {
      out: readFileSync(outFile, 'utf8').trim().split('\n').filter(Boolean),
      calls: readFileSync(callsFile, 'utf8').trim().split('\n').filter(Boolean),
    };
  } finally {
    removeTempTree(dir);
  }
}

test('#1112 MEMORY_BACKEND=plainfiles is never reported as an unknown backend', () => {
  const { out } = runCase('plainfiles');
  assert.ok(
    !out.some((l) => l.includes('unknown-backend')),
    `plainfiles must not be reported as unknown; got: ${JSON.stringify(out)}`,
  );
});

test('#1112 MEMORY_BACKEND=plainfiles: setup and pull run, index does not (unsupported by design, C3 Decision 5)', () => {
  const { out, calls } = runCase('plainfiles');
  assert.ok(out.some((l) => l === 'OK:plainfiles-ok'), `expected a plainfiles setup OK; got: ${JSON.stringify(out)}`);
  assert.ok(calls.some((c) => c.includes('memory/cli.mjs setup')), `expected a setup call; got: ${JSON.stringify(calls)}`);
  assert.ok(calls.some((c) => c.includes('pm run --silent brain:memory:pull')), `expected a pull call; got: ${JSON.stringify(calls)}`);
  assert.ok(
    !calls.some((c) => c.includes('brain:memory:index')),
    `plainfiles must never call brain:memory:index (always throws — unsupported by design); got: ${JSON.stringify(calls)}`,
  );
});

test('#1112 MEMORY_BACKEND=engram: unchanged — setup, pull AND index all run', () => {
  const { calls } = runCase('engram');
  assert.ok(calls.some((c) => c.includes('memory/cli.mjs setup')));
  assert.ok(calls.some((c) => c.includes('pm run --silent brain:memory:pull')));
  assert.ok(calls.some((c) => c.includes('pm run --silent brain:memory:index')));
});

test('#1112 a genuinely unknown backend still reports as unknown (no regression)', () => {
  const { out } = runCase('some-typo');
  assert.ok(
    out.some((l) => l.includes('unknown-backend-some-typo')),
    `a real unknown backend must still warn; got: ${JSON.stringify(out)}`,
  );
});
