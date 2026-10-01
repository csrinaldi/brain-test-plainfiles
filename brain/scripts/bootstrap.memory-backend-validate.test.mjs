// bootstrap.memory-backend-validate.test.mjs — issue #1112, cold-review
// should-fix 3.
//
// bootstrap.sh's interactive MEMORY_BACKEND prompt (§7) accepted ANY typed
// string and wrote it verbatim into `.env` — a typo landed in `.env`, and the
// consequence only surfaced later, deep inside `memory/cli.mjs`'s backend
// dispatch, far from where the operator typed it.
//
// The fix reuses the EXACT SAME validation loop shape as
// vcs-provider-validate.test.mjs's fragment (issue #1112, finding 2) —
// `while :; do read; case … in <valid>|'') break ;; *) reject ;; esac; done`
// — restricted to the two real backends (`axes/memory/adapters/engram.mjs`,
// `axes/memory/adapters/plainfiles.mjs`), rather than inventing a second
// validation style for the same class of prompt.
//
// Same idiom as the other bootstrap.*.test.mjs files: the fragment is LIFTED
// OUT OF bootstrap.sh between two sentinel comments and executed, so there is
// no second copy of the validation logic to drift from the real one (#340).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { maskNonCode } from './lib/mask-non-code.mjs';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const LINES = readFileSync(BOOTSTRAP, 'utf8').split('\n');

function fragment(beginMarker, endMarker) {
  const start = LINES.findIndex((l) => l.includes(beginMarker));
  assert.ok(start >= 0, `bootstrap.sh must have a ${beginMarker} marker`);
  const end = LINES.findIndex((l, i) => i > start && l.includes(endMarker));
  assert.ok(end > start, `bootstrap.sh must have a matching ${endMarker} marker`);
  return LINES.slice(start + 1, end).join('\n');
}

// Extracted ONCE, outside any try/catch — a missing-marker AssertionError
// must fail the suite loudly (same discipline as vcs-provider-validate's own
// fragment extraction).
const FRAGMENT = fragment('BEGIN memory-backend-validate', 'END memory-backend-validate');

/**
 * Runs the extracted loop, feeding `stdinLines` (one `read -r -p` answer per
 * line). Prints the final `MEMORY_BACKEND` value on its own line at the end
 * so the test can read it without needing the surrounding env_get/env_set
 * machinery.
 */
function runFragment(stdinLines, { eof, raw } = {}) {
  // The answer bytes go to a file the script adopts as fd 0 (`exec 0<file`). They are NEVER passed
  // through spawnSync's `input` option: in the cold reviewer's Codex sandbox that pipe never sees
  // EOF, so a `read` that needs EOF (the newline-less answers) blocked until the timeout (#1221).
  // A closed stdin (`eof`) is an empty file: `read` hits EOF at once, the same as /dev/null.
  const dir = mkdtempSync(join(tmpdir(), 'brain-1221-stdin-'));
  try {
    const answers = join(dir, 'answers');
    writeFileSync(answers, eof ? '' : (raw ?? stdinLines.join('\n') + '\n'));
    const script = [
      'set -euo pipefail',
      `exec 0<${shQuote(answers)}`,
      'I18N_BOOTSTRAP_MEMORY_PROMPT="Which memory backend does this team use? (engram|plainfiles): "',
      FRAGMENT,
      'printf \'%s\' "$MEMORY_BACKEND"',
    ].join('\n');
    // The timeout turns any future hang into a failure instead of a stalled suite.
    const result = spawnSync('bash', ['-c', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      timeout: 10_000,
    });
    return { backend: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const shQuote = (v) => "'" + String(v).split("'").join("'\\''") + "'";

test('#1112 an invalid backend is rejected and never accepted', () => {
  const { backend } = runFragment(['not-a-backend', 'engram']);
  assert.equal(backend, 'engram', 'the invalid answer must never be the final value');
});

test('#1112 the rejection is reported, not silent', () => {
  const { stderr } = runFragment(['typo-backend', 'plainfiles']);
  assert.match(stderr, /Unknown backend/);
  assert.match(stderr, /typo-backend/);
});

test('#1112 "engram" on the first answer still works (no regression)', () => {
  const { backend } = runFragment(['engram']);
  assert.equal(backend, 'engram');
});

test('#1112 "plainfiles" is accepted — the fifth #1112 finding\'s own backend', () => {
  const { backend } = runFragment(['plainfiles']);
  assert.equal(backend, 'plainfiles');
});

test('#1205 an empty answer re-prompts and never becomes a backend', () => {
  const { backend, status } = runFragment(['', 'plainfiles']);
  assert.equal(status, 0);
  assert.equal(backend, 'plainfiles', 'Enter must not select anything; the next real answer does');
});

test('#1205 several empty answers in a row never default to engram', () => {
  const { backend } = runFragment(['', '', 'engram']);
  assert.equal(backend, 'engram');
});

test('#1205 a closed stdin leaves the backend undeclared (empty), not engram', () => {
  const result = { ...runFragment([], { eof: true }) };
  result.stdout = result.backend;
  assert.equal(result.status, 0, `EOF must not abort the script; stderr:\n${result.stderr}`);
  assert.equal(result.stdout, '', 'EOF is an undeclared backend, never a guess');
});

test('#1205 bootstrap.sh no longer defaults the backend to engram after the prompt', () => {
  assert.ok(!LINES.some((l) => l.includes('MEMORY_BACKEND:-engram')), 'ADR-0004 Amendment 3: NO default');
});

test('#1112 re-prompts as many times as needed before accepting a valid value', () => {
  const { backend, stderr } = runFragment(['x', 'y', 'z', 'plainfiles']);
  assert.equal(backend, 'plainfiles');
  const rejections = (stderr.match(/Unknown backend/g) || []).length;
  assert.equal(rejections, 3, `expected exactly 3 rejections before the valid answer; stderr:\n${stderr}`);
});

// #1214 correction 1: `read` returns non-zero at EOF even when it filled the variable (a final
// line with no trailing newline). That answer was typed; discarding it left the backend
// undeclared after the operator typed `plainfiles` then Ctrl-D.
test('#1214 a valid answer without a trailing newline is kept', () => {
  const { backend, status } = runFragment([], { raw: 'plainfiles' });
  assert.equal(status, 0);
  assert.equal(backend, 'plainfiles');
});

test('#1214 a valid engram answer without a trailing newline is kept', () => {
  assert.equal(runFragment([], { raw: 'engram' }).backend, 'engram');
});

test('#1214 an invalid answer at EOF is undeclared and does not loop forever', () => {
  const { backend, status } = runFragment([], { raw: 'typo' });
  assert.equal(status, 0, 'must terminate (the spawn timeout would give a null status)');
  assert.equal(backend, '');
});

// #1214 correction 3: the caller block after the fragment. Lifted between its own markers and
// driven with `node` and `warn` stubbed as shell functions, so nothing touches a real config.
const DECLARE = fragment('BEGIN memory-backend-declare', 'END memory-backend-declare');

function runDeclare(answer, { nodeExit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-1214-'));
  const log = join(dir, 'node.log');
  const script = [
    'set -euo pipefail',
    'BRAIN_SCRIPTS=/stub',
    'I18N_BOOTSTRAP_MEMORY_UNDECLARED=UNDECLARED',
    'I18N_BOOTSTRAP_MEMORY_DECLARED=DECLARED',
    'I18N_BOOTSTRAP_MEMORY_DECLAREFAILED="FAILED %s"',
    'MISSING_OPTIONAL=()',
    '_mb_source=""',
    'warn() { printf "warn:%s\\n" "$1"; }',
    // The caller sends node's output to /dev/null, so the stub records its argv in a file.
    `node() { printf "node:%s\\n" "$*" >> ${JSON.stringify(log)}; return ${nodeExit}; }`,
    `MEMORY_BACKEND=${JSON.stringify(answer)}`,
    DECLARE,
    'printf "missing:%s\\n" "${MISSING_OPTIONAL[*]:-}"',
    'printf "source:%s\\n" "$_mb_source"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 10_000,
  });
  const nodeCalls = existsSync(log) ? readFileSync(log, 'utf8') : '';
  rmSync(dir, { recursive: true, force: true });
  return { out: (result.stdout ?? '') + nodeCalls, stderr: result.stderr ?? '', status: result.status };
}

test('#1214 undeclared: warns, records MISSING_OPTIONAL and writes nothing to config', () => {
  const { out, status } = runDeclare('');
  assert.equal(status, 0);
  assert.match(out, /warn:UNDECLARED/);
  assert.match(out, /missing:memory backend undeclared/);
  assert.doesNotMatch(out, /node:/, 'config/cli.mjs set must not run when nothing was declared');
});

test('#1214 declared: calls config/cli.mjs set memory.backend <value>', () => {
  const { out, status } = runDeclare('plainfiles');
  assert.equal(status, 0);
  assert.match(out, /node:\/stub\/config\/cli\.mjs set memory\.backend plainfiles/);
  assert.match(out, /warn:DECLARED/);
  assert.match(out, /source:config/);
  assert.doesNotMatch(out, /UNDECLARED/);
});

test('#1214 declared but the config write fails: reported, source falls back to prompt', () => {
  const { out } = runDeclare('engram', { nodeExit: 1 });
  assert.match(out, /warn:FAILED engram/);
  assert.match(out, /missing:memory backend not saved/);
  assert.match(out, /source:prompt/);
});

// #1221: a child spawned with `spawnSync(..., { input })` never sees EOF on its stdin pipe in the
// cold reviewer's Codex sandbox, so anything that reads to EOF hangs until the timeout. This file's
// spawns therefore feed stdin from a FILE (`exec 0<file`) and never use the `input` option. Read
// from this file's own source, comments and strings masked, so the guard cannot be satisfied by prose.
test('#1221 no spawn in this file feeds stdin through the `input` option', () => {
  const own = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.doesNotMatch(maskNonCode(own), /\binput\s*:/, 'feed stdin from a file, never the input option');
});
