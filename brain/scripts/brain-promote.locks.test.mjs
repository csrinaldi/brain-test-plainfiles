// brain-promote.locks.test.mjs — the DRIFT-GUARD for issue #378's structural
// locks (REQ-378-1 .. REQ-378-4).
//
// This file is the deliverable. `brain:promote` automates precisely the action
// two anti-patterns forbid (`ia-escribe-brain-sin-gate.md`,
// `ia-promueve-sus-propios-artefactos.md`); the locks are what make it safe to
// exist, and an unproven lock is a rule, not a lock.
//
// Guard shapes follow design D1, which follows
// brain/core/anti-patterns/red-proof-blind-along-an-unvaried-axis.md:
//   - the non-TTY refusal is proven against a REAL child process with piped
//     stdio, and asserts the tree is untouched (an exit code alone is blind to
//     "wrote the files, then failed");
//   - the no-bypass guarantee is proven BOTH behaviourally (every `-`-prefixed
//     token aborts) AND structurally (`process.env` occurs ZERO times), because
//     each is blind along the axis the other covers;
//   - "never commits" CANNOT be a source scan — the verb PRINTS a `git commit`
//     command, so that string is in the source by design. It is an allowlist
//     the single git helper enforces, plus an asserted call-SITE COUNT, plus an
//     end-to-end run in a real git repo whose commit count must not move.
//
// Occurrence counts are asserted as NUMBERS, never as booleans: rule 1 of the
// anti-pattern doc.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';

import {
  CONFIRMATION_WORD,
  ALLOWED_GIT_SUBCOMMANDS,
  runGit,
  runPromote,
  stripComments,
} from './brain-promote.mjs';
import { makeFixtureRepo, statusOf, commitCount, stagedPaths, REPO_ROOT } from './__fixtures__/promote-repo.mjs';

const MODULE_PATH = join(REPO_ROOT, 'brain/scripts/brain-promote.mjs');
const SOURCE = readFileSync(MODULE_PATH, 'utf8');

// ── The verb's OWN modules, enumerated from the code, not from memory ────────
// Lock 2's structural half used to scan brain-promote.mjs alone. When the verb
// grew a second module (#509) half of it stopped being covered: an env read
// inserted into planAmendment left this suite 55/55 green while
// BRAIN_PROMOTE_AS forged the `**Signed**:` attribution in a promoted ADR.
//
// The fix is not "add the other file" — it is to derive the list from the
// import statements, and to pin it, so a THIRD module cannot slip in silently
// either. `axes/platform/adapters/antigravity.mjs` and `lib/home-index.mjs` are
// shared library code with their own suites and are deliberately out of scope;
// they are named here so adding a new import fails this test until someone
// decides which side of that line it is on.
//
// CLOSED OVER THE VERB'S OWN HALF (#675). The classification used to read only
// brain-promote.mjs's direct imports, so a module reachable one hop further —
// through an OWN module — was neither scanned nor named, which is the #509 gap
// re-opened one level down. `promote-guards.mjs` arrived through exactly that
// door: it decides whether the verb REFUSES, so an env read or a bypass flag in
// it would be a lock-2 hole. The walk below is transitive over OWN_IMPORTS, and
// classifies by RESOLVED repo-relative path rather than by import specifier:
// `lib/` modules import their siblings as `./x.mjs` while the entry point says
// `./lib/x.mjs`, and a list keyed on the raw string reads one module as two.
// migration-draft.mjs is OWN for the same reason amendment-draft.mjs is: it is
// a draft CONTRACT of this verb — scanned for env reads and bypass flags.
// installer.mjs is SHARED: migrateConfig belongs to the installer/upgrade path
// first; this verb is its third caller (brain-upgrade, brain:config, here).
const OWN_IMPORTS = ['brain/scripts/lib/amendment-draft.mjs', 'brain/scripts/lib/migration-draft.mjs', 'brain/scripts/lib/promote-guards.mjs'];
const SHARED_IMPORTS = [
  'brain/scripts/lib/home-index.mjs',
  'brain/scripts/axes/platform/adapters/antigravity.mjs',
  'brain/scripts/lib/shipped-hostnames.mjs',
  'brain/scripts/lib/fenced-blocks.mjs',
  'brain/scripts/lib/installer.mjs',
];

const importsOf = (file) =>
  [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)[\s\S]*?from\s+'(\.[^']+)';/gm)]
    .map((m) => relative(REPO_ROOT, join(dirname(file), m[1])));

const VERB_MODULES = [MODULE_PATH, ...OWN_IMPORTS.map((rel) => join(REPO_ROOT, rel))];
const CODE = VERB_MODULES.map((f) => stripComments(readFileSync(f, 'utf8'))).join('\n');

const count = (haystack, needle) => haystack.split(needle).length - 1;

test('REQ-378-2 harness proof: the scanned module set IS the verb — every relative import is classified', () => {
  // Every import of every scanned module, not just the entry point's: a module
  // the verb reaches through one of its own is still the verb.
  const found = [...new Set(VERB_MODULES.flatMap(importsOf))].sort();
  assert.deepEqual(
    found,
    [...OWN_IMPORTS, ...SHARED_IMPORTS].sort(),
    'the verb imported a module this guard does not know about — classify it as the verb\'s own ' +
      '(scanned for env reads and bypass flags) or as shared library code, then update OWN_IMPORTS/SHARED_IMPORTS.',
  );
  assert.equal(VERB_MODULES.length, 4, 'the verb spans four modules (#809 added migration-draft.mjs); all four must be scanned');
});

test('REQ-378-2 harness proof: the concatenated CODE really contains EVERY scanned module', () => {
  // Without this, a broken path would produce an empty half and every
  // occurrence-count assertion below would pass by reading nothing.
  assert.equal(count(CODE, 'export async function runPromote'), 1, 'brain-promote.mjs must be in the scan');
  assert.equal(count(CODE, 'export function assessEdit'), 1, 'amendment-draft.mjs must be in the scan');
  assert.equal(count(CODE, 'export function checkShippedContent'), 1, 'promote-guards.mjs must be in the scan');
});

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-1 — refuses on a non-TTY, and writes NOTHING
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-378-1: the REAL entry point on a REAL non-TTY exits non-zero', () => {
  const fx = makeFixtureRepo();
  try {
    const r = spawnSync(process.execPath, [MODULE_PATH, fx.draftRel], {
      cwd: fx.root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.notEqual(r.status, 0, `expected a non-zero exit on a non-TTY; got ${r.status}\n${r.stdout}${r.stderr}`);
    assert.match(`${r.stdout}${r.stderr}`, /interactive terminal|non-TTY/i);
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-378-1: the non-TTY refusal leaves the tree and the index UNTOUCHED (exit code alone is blind to "wrote, then failed")', () => {
  const fx = makeFixtureRepo();
  try {
    spawnSync(process.execPath, [MODULE_PATH, fx.draftRel], {
      cwd: fx.root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.equal(statusOf(fx.root), '', 'a non-TTY run must not write or stage anything');
    assert.equal(existsSync(join(fx.root, fx.destRel)), false, 'the ADR must not exist after a non-TTY refusal');
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-378-1: the refusal happens BEFORE the draft is read — a missing draft still reports the TTY reason', () => {
  const fx = makeFixtureRepo();
  try {
    const r = spawnSync(process.execPath, [MODULE_PATH, 'openspec/changes/issue-378-brain-promote/brain-drafts/does-not-exist.md'], {
      cwd: fx.root,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    assert.notEqual(r.status, 0);
    assert.match(`${r.stdout}${r.stderr}`, /interactive terminal|non-TTY/i);
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-2 — no bypass. Behavioural, then structural.
// ═══════════════════════════════════════════════════════════════════════════

// Driven with isTTY:true and the CORRECT answer, so the case can only fail for
// the FLAG. A flag that is merely ignored would let the run succeed → red.
// (The "negative fixture that fails for the wrong reason" mode.)
const BYPASS_FLAGS = [
  '--yes', '-y', '--force', '-f', '--non-interactive', '--no-confirm',
  '--assume-yes', '--auto', '--confirm=PROMOTE', '--skip-confirmation',
];

for (const flag of BYPASS_FLAGS) {
  test(`REQ-378-2: \`${flag}\` is an ABORT, not a bypass and not a silent no-op`, async () => {
    const fx = makeFixtureRepo();
    let prompted = 0;
    try {
      const res = await runPromote({
        argv: [flag, fx.draftRel],
        isTTY: true,
        root: fx.root,
        readLineFn: async () => { prompted += 1; return CONFIRMATION_WORD; },
        write: () => {},
      });
      assert.notEqual(res.exitCode, 0, `${flag} must abort even when the typed word would be supplied`);
      assert.equal(prompted, 0, `${flag} must abort BEFORE the prompt`);
      assert.deepEqual(res.wrote, []);
      assert.equal(statusOf(fx.root), '');
    } finally {
      cleanup(fx.root);
    }
  });
}

const BYPASS_ENV = [
  'BRAIN_PROMOTE_YES', 'BRAIN_PROMOTE_FORCE', 'BRAIN_PROMOTE_NON_INTERACTIVE',
  'CI', 'BRAIN_NON_INTERACTIVE', 'BRAIN_PROMOTE_CONFIRM',
];

for (const name of BYPASS_ENV) {
  test(`REQ-378-2: \`${name}\` in the environment does not skip or satisfy the prompt`, async () => {
    const fx = makeFixtureRepo();
    const had = Object.prototype.hasOwnProperty.call(process.env, name);
    const prev = process.env[name];
    process.env[name] = CONFIRMATION_WORD;
    let prompted = 0;
    try {
      const res = await runPromote({
        argv: [fx.draftRel],
        isTTY: true,
        root: fx.root,
        readLineFn: async () => { prompted += 1; return 'n'; },
        write: () => {},
      });
      // Liveness: if the env var short-circuited the gate, the prompt would
      // never have been reached — so the count is what proves the bypass absent,
      // not merely the refusal (which a wrong answer alone would also produce).
      assert.equal(prompted, 1, `${name} must not short-circuit the prompt`);
      assert.notEqual(res.exitCode, 0);
      assert.deepEqual(res.wrote, []);
      assert.equal(statusOf(fx.root), '');
    } finally {
      if (had) process.env[name] = prev; else delete process.env[name];
      cleanup(fx.root);
    }
  });
}

// ── the comment stripper must be proven before anything is asserted over it ──
// A stripper that ate the file, or one that stripped nothing, both produce
// meaningless greens downstream (anti-pattern doc, "harness failure modes").

test('REQ-378-2 harness proof: stripComments removes a token that appears ONLY in a comment', () => {
  const stripped = stripComments("const A = 1; // process.env.SOMETHING\nconst B = 2;\n");
  assert.equal(count(stripped, 'process.env'), 0, 'a commented token must not survive stripping');
  assert.equal(count(stripped, 'const A'), 1, 'code before the comment must survive');
  assert.equal(count(stripped, 'const B'), 1, 'later code must survive');
});

test('REQ-378-2 harness proof: stripComments removes block comments and keeps code around them', () => {
  const stripped = stripComments('const A = 1;\n/* process.env.X\n   --yes */\nconst B = 2;\n');
  assert.equal(count(stripped, 'process.env'), 0);
  assert.equal(count(stripped, '--yes'), 0);
  assert.equal(count(stripped, 'const A'), 1);
  assert.equal(count(stripped, 'const B'), 1);
});

test('REQ-378-2 harness proof: the stripped REAL source still contains its code sentinels (the stripper did not eat the file)', () => {
  for (const sentinel of ['CONFIRMATION_WORD', 'ALLOWED_GIT_SUBCOMMANDS', 'runPromote', 'spawnSync']) {
    assert.ok(count(CODE, sentinel) > 0, `stripComments must not remove code: '${sentinel}' vanished`);
  }
});

test('REQ-378-2: the module reads process.env ZERO times (kills the env-bypass CLASS, not a list of names)', () => {
  assert.equal(
    count(CODE, 'process.env'),
    0,
    'brain-promote.mjs must not read the environment at all — an env read is a bypass branch by construction',
  );
});

test('REQ-378-2: no bypass flag literal appears anywhere in the code (there is no branch to reach)', () => {
  for (const flag of ['--yes', '--force', '--non-interactive', '--assume-yes', '--no-confirm', '--auto']) {
    assert.equal(count(CODE, flag), 0, `'${flag}' must not appear in brain-promote.mjs`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-3 — stages, never commits, never pushes
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-378-3: ALLOWED_GIT_SUBCOMMANDS excludes commit and push, and is frozen', () => {
  assert.ok(Object.isFrozen(ALLOWED_GIT_SUBCOMMANDS));
  assert.equal(ALLOWED_GIT_SUBCOMMANDS.includes('commit'), false);
  assert.equal(ALLOWED_GIT_SUBCOMMANDS.includes('push'), false);
  assert.deepEqual([...ALLOWED_GIT_SUBCOMMANDS].sort(), ['add', 'config', 'status']);
  // `status` is read-only and was added WITH the write preconditions (#509):
  // `git add` on an unmerged path resolves the conflict, so the allowlist alone
  // never made lock 3 true. The property it protects is what matters, and it is
  // asserted above by name rather than by the list's length.
  for (const forbidden of ['commit', 'push', 'tag', 'reset', 'rebase', 'merge', 'checkout', 'restore']) {
    assert.equal(ALLOWED_GIT_SUBCOMMANDS.includes(forbidden), false, `'${forbidden}' must never be allow-listed`);
  }
});

for (const forbidden of ['commit', 'push', 'tag', 'reset']) {
  test(`REQ-378-3: runGit THROWS on '${forbidden}' and never reaches the spawn`, () => {
    let spawned = 0;
    assert.throws(
      () => runGit(forbidden, [], { cwd: REPO_ROOT, spawnFn: () => { spawned += 1; return { status: 0, stdout: '' }; } }),
      /refuses/i,
    );
    assert.equal(spawned, 0, `runGit must refuse '${forbidden}' BEFORE spawning`);
  });
}

test('REQ-378-3 SITE COUNT: exactly ONE process-spawning call site, and no exec* at all', () => {
  // Enumerated from the CODE, not from the sentence describing it. The first
  // draft of this guard counted `spawnSync(` — which is 0, because the spawn is
  // invoked through the injectable seam `spawnFn(`. Asserting a COUNT surfaced
  // that immediately; asserting a boolean would have passed forever.
  assert.equal(count(CODE, 'spawnFn('), 1, 'a second git call site would be an unguarded path');
  assert.equal(count(CODE, 'child_process'), 1, 'exactly one import of the process-spawning module');
  assert.equal(count(CODE, 'spawnSync'), 2, 'spawnSync may appear only as the import and the seam default');
  assert.equal(count(CODE, 'spawnSync('), 0, 'spawnSync is never called directly — only through the guarded seam');
  assert.equal(count(CODE, 'execSync'), 0);
  assert.equal(count(CODE, 'execFile'), 0);
  assert.equal(count(CODE, 'exec('), 0);
});

test('REQ-378-3 END-TO-END: an ACCEPTED run in a real git repo stages three paths and creates ZERO commits', async () => {
  const fx = makeFixtureRepo();
  try {
    const before = commitCount(fx.root);
    const res = await runPromote({
      argv: [fx.draftRel],
      isTTY: true,
      root: fx.root,
      readLineFn: async () => CONFIRMATION_WORD,
      todayFn: () => '2026-08-07',
      write: () => {},
    });
    assert.equal(res.exitCode, 0, `accepted run must succeed: ${JSON.stringify(res)}`);
    assert.equal(commitCount(fx.root), before, 'brain:promote must NEVER create a commit');
    assert.deepEqual(stagedPaths(fx.root), ['AGENTS.md', 'brain/HOME.md', fx.destRel].sort());
  } finally {
    cleanup(fx.root);
  }
});

test('REQ-378-3: the printed next step is a commit COMMAND for the human, not an executed commit', async () => {
  const fx = makeFixtureRepo();
  const chunks = [];
  try {
    await runPromote({
      argv: [fx.draftRel],
      isTTY: true,
      root: fx.root,
      readLineFn: async () => CONFIRMATION_WORD,
      todayFn: () => '2026-08-07',
      write: (s) => chunks.push(s),
    });
    const out = chunks.join('');
    assert.match(out, /git commit -m '/, 'the commit command must be printed for the human to run');
    assert.equal(commitCount(fx.root), '1');
  } finally {
    cleanup(fx.root);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-378-4 — the confirmation is the typed word, compared exactly
// ═══════════════════════════════════════════════════════════════════════════

const REFUSING_ANSWERS = [
  'y', 'Y', 'yes', 'YES', 'promote', 'Promote', 'pROMOTE', 'PROMOTE!', 'PROMOTEX',
  'PROMOTE ME', '', '\n', 'n', 'no', 'ok', '1', 'true', null, undefined,
];

for (const answer of REFUSING_ANSWERS) {
  test(`REQ-378-4: answer ${JSON.stringify(answer)} aborts with ZERO writes`, async () => {
    const fx = makeFixtureRepo();
    try {
      const res = await runPromote({
        argv: [fx.draftRel],
        isTTY: true,
        root: fx.root,
        readLineFn: async () => answer,
        write: () => {},
      });
      assert.notEqual(res.exitCode, 0, `${JSON.stringify(answer)} must not be accepted`);
      assert.deepEqual(res.wrote, [], 'a declined run writes nothing at all — not even partially');
      assert.equal(existsSync(join(fx.root, fx.destRel)), false);
      assert.equal(statusOf(fx.root), '');
    } finally {
      cleanup(fx.root);
    }
  });
}

for (const answer of [CONFIRMATION_WORD, `  ${CONFIRMATION_WORD}  `, `${CONFIRMATION_WORD}\n`]) {
  test(`REQ-378-4: answer ${JSON.stringify(answer)} is accepted (surrounding whitespace only)`, async () => {
    const fx = makeFixtureRepo();
    try {
      const res = await runPromote({
        argv: [fx.draftRel],
        isTTY: true,
        root: fx.root,
        readLineFn: async () => answer,
        todayFn: () => '2026-08-07',
        write: () => {},
      });
      assert.equal(res.exitCode, 0, JSON.stringify(res));
      assert.equal(res.wrote.length, 3);
    } finally {
      cleanup(fx.root);
    }
  });
}

test('REQ-378-4: the confirmation word is a literal, not a single character', () => {
  assert.equal(CONFIRMATION_WORD, 'PROMOTE');
  assert.ok(CONFIRMATION_WORD.length > 1);
});
