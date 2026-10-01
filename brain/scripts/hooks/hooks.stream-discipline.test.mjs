// hooks.stream-discipline.test.mjs — issue #633.
//
// THE RULE
//
//   stdout is PROGRESS. stderr is SOMETHING A HUMAN NEEDS.
//   A hook discards the first and NEVER the second.
//
// `memory/cli.mjs` puts its reports on stderr precisely so the automated
// callers keep them (#598). Two hook lines added `2>&1` anyway, and one of them
// — `post-merge`'s `resolve-index` — is the verb that exists BECAUSE two
// branches merged, i.e. the exact moment `merge=union` mints a duplicate. A
// third, `pre-push`'s `feature-checkpoint`, had `2>/dev/null`: measured on this
// repo that verb writes 0 lines to stdout and 2 to stderr, so it discarded the
// only stream it uses.
//
// ── Two layers, because each catches what the other cannot ──────────────────
//
// 1. BEHAVIOURAL — run the REAL hooks with a mock `node` that writes a distinct
//    marker to each stream, and assert which one survives. This is what proves
//    the redirection actually works, and it follows pre-push.test.mjs's
//    established technique (synthetic PATH, real hook, no real subprocess).
//
// 2. STRUCTURAL — scan every hook file for `cli.mjs` invocations and refuse any
//    that discards stderr. The behavioural layer can only cover the lines that
//    exist today; this one covers the line somebody adds next year. The
//    acceptance asks that "the next line added follows the rule by reading
//    rather than by accident" — reading is optional, a failing test is not.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync, writeFileSync, chmodSync, statSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { testTmp } from '../lib/test-tmp.mjs';

const HOOKS_DIR = fileURLToPath(new URL('.', import.meta.url));

/** Markers chosen so neither can be mistaken for the other in a stream dump. */
const OUT_MARKER = 'MOCK-STDOUT-PROGRESS-LINE';
const ERR_MARKER = 'MOCK-STDERR-SOMETHING-A-HUMAN-NEEDS';

/**
 * A mock `node` that writes BOTH markers on every invocation, plus a mock `git`
 * answering the two questions the hooks ask.
 *
 * The mock writes to both streams unconditionally: the test is about which one
 * the HOOK keeps, so the tool must always offer both. A mock that only wrote to
 * stderr would pass against a hook that discarded stdout too.
 */
function mockBin({ repoRoot } = {}) {
  const dir = testTmp('brain-633-bin-');
  // Pre-push (issue #890) only checkpoints when an active
  // openspec/changes/<feature>/ directory exists under the resolved repo
  // root, so the mock root must be a REAL directory with that shape —
  // unlike the old unconditional checkpoint call, a nonexistent fake path
  // silently skips the checkpoint and empties this test's whole assertion.
  const root = repoRoot ?? testTmp('brain-633-root-');
  mkdirSync(join(root, 'openspec', 'changes', 'mock-feature'), { recursive: true });
  repoRoot = root;

  writeFileSync(
    join(dir, 'node'),
    [
      '#!/usr/bin/env sh',
      // Only the memory dispatcher speaks; check-refs.mjs and the tier scripts
      // must stay quiet or pre-push's later steps would pollute the assertion.
      'case "$1" in',
      '  *memory/cli.mjs)',
      `    printf '%s %s\\n' "${OUT_MARKER}" "$2"`,
      `    printf '%s %s\\n' "${ERR_MARKER}" "$2" >&2`,
      '    ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(dir, 'node'), 0o755);

  writeFileSync(
    join(dir, 'git'),
    [
      '#!/usr/bin/env sh',
      'if [ "$1" = "rev-parse" ]; then',
      `  printf '%s\\n' "${repoRoot}"`,
      'fi',
      'exit 0',
    ].join('\n'),
  );
  chmodSync(join(dir, 'git'), 0o755);

  return dir;
}

const SAFE_SYSTEM_PATH = '/usr/local/bin:/usr/bin:/bin';

function runHook(name) {
  const bin = mockBin();
  return spawnSync('sh', [join(HOOKS_DIR, name)], {
    env: { PATH: `${bin}:${SAFE_SYSTEM_PATH}`, HOME: process.env.HOME ?? '/tmp' },
    encoding: 'utf8',
    timeout: 10000,
  });
}

/** Which ops' stderr survived the hook, in order. */
const opsOnStderr = (stderr) =>
  (stderr.match(new RegExp(`${ERR_MARKER} (\\S+)`, 'g')) ?? []).map((m) => m.split(' ')[1]);

// ── layer 1: the real hooks, measured ───────────────────────────────────────

test('#633 pre-push: the memory verb\'s STDERR reaches the operator', () => {
  // Issue #890 retires `share` from pre-push entirely — feature pushes no
  // longer transport durable records, so `share` never runs here at all.
  // `feature-checkpoint` is the one cli.mjs op pre-push still calls.
  const r = runHook('pre-push');

  const ops = opsOnStderr(r.stderr);
  assert.ok(
    !ops.includes('share'),
    `share is retired (#890) and must never run from pre-push; got ops: ${JSON.stringify(ops)}`,
  );
  assert.ok(
    ops.includes('feature-checkpoint'),
    `feature-checkpoint's stderr must survive — it writes NOTHING to stdout, so 2>/dev/null silenced it entirely; got: ${JSON.stringify(ops)}`,
  );
});

test('#633 pre-push: the progress line on STDOUT is still discarded', () => {
  // The other direction. A hook that simply stopped redirecting would pass the
  // test above and be wrong: the per-run progress line really is noise on every
  // push, which is why `>/dev/null` stays.
  const r = runHook('pre-push');
  assert.doesNotMatch(r.stdout, new RegExp(OUT_MARKER), `stdout must stay quiet; got:\n${r.stdout}`);
});

test('#633 post-merge: resolve-index\'s STDERR reaches the operator', () => {
  const r = runHook('post-merge');

  const ops = opsOnStderr(r.stderr);
  assert.ok(
    ops.includes('resolve-index'),
    `resolve-index exists BECAUSE two branches merged, which is when merge=union mints a duplicate — its stderr is the one that must not be swallowed; got: ${JSON.stringify(ops)}`,
  );
  assert.ok(ops.includes('import'), `import's stderr already survived and must keep doing so; got: ${JSON.stringify(ops)}`);
});

test('#633 post-merge: the progress line on STDOUT is still discarded', () => {
  const r = runHook('post-merge');
  assert.doesNotMatch(r.stdout, new RegExp(OUT_MARKER), `stdout must stay quiet; got:\n${r.stdout}`);
});

test('#633 neither hook blocks: a talking tool still exits 0', () => {
  // `|| true` / `|| exit 0` are a separate decision from the redirection and
  // must survive this change untouched — the whole reason the old lines were
  // written defensively.
  for (const hook of ['pre-push', 'post-merge']) {
    assert.equal(runHook(hook).status, 0, `${hook} must never block`);
  }
});

// ── layer 2: the rule, enforced over every hook, including future lines ─────

test('#633 NO hook may discard stderr on a cli.mjs invocation — present or future', () => {
  // Structural, and deliberately not limited to the three lines this ticket
  // repaired: the acceptance asks that the next line added follow the rule, and
  // prose in a header cannot make that happen.
  const offenders = [];

  for (const name of readdirSync(HOOKS_DIR)) {
    if (name.endsWith('.mjs') || name.endsWith('.md')) continue;
    const path = join(HOOKS_DIR, name);
    if (!statSync(path).isFile()) continue;

    readFileSync(path, 'utf8').split('\n').forEach((line, i) => {
      const code = line.trim();
      if (code.startsWith('#') || !code.includes('cli.mjs')) return;
      // `2>&1` folds stderr into a discarded stdout; `2>/dev/null` drops it outright.
      if (/2>&1/.test(code) || /2>\s*\/dev\/null/.test(code)) {
        offenders.push(`${name}:${i + 1} — ${code}`);
      }
    });
  }

  assert.deepStrictEqual(
    offenders,
    [],
    'stdout is progress, stderr is something a human needs — a hook discards the first and never the second:\n  '
      + offenders.join('\n  '),
  );
});

test('#633 the rule is written where the next hook author will read it', () => {
  // The acceptance asks for the rule to be stated, not only enforced. Pinned so
  // a later edit cannot quietly remove the explanation and leave the test as
  // the only trace of a decision nobody can find the reasoning for.
  for (const name of ['pre-push', 'post-merge']) {
    const src = readFileSync(join(HOOKS_DIR, name), 'utf8');
    assert.match(src, /STREAM DISCIPLINE FOR HOOKS \(issue #633\)/, `${name} must state the rule`);
    assert.match(src, /stdout is PROGRESS\. stderr is SOMETHING A HUMAN NEEDS\./, `${name} must state it in full`);
  }
});
