// scripts/axes/platform/adapters/antigravity.drift.test.mjs — the CHAIN-GUARD for
// the compiled AGENTS.md (issue #256, B2 Half 1, REQ-B2-2 staleness scenario).
//
// Reads the 5 REAL SOURCE_DOCS from disk, calls the pure compileAgentsMd(),
// and asserts BYTE-EQUALITY against the committed AGENTS.md. A hand-edit of
// AGENTS.md, or a source change without regeneration, fails this test — this
// is the chain the #601 governance.ignoreList classification depends on
// (Phase 4 in tasks.md is justified BY this guard; sequence matters).
//
// Mirrors the house regenerate-and-diff pattern already used by
// governance-checks.test.mjs and sdd-layout.test.mjs.
//
// Run with: npm test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { removeTempTree } from '../../../__fixtures__/tmp-tree.mjs';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { SOURCE_DOCS, AGENTS_EMIT_PATH, GEMINI_SETTINGS_EMIT_PATH, compileAgentsMd } from './antigravity.mjs';
import { compileSettingsHooksJson } from '../lib/settings-hooks.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

function compileFromRealSources() {
  const docs = {};
  for (const relPath of SOURCE_DOCS) {
    docs[relPath] = readFileSync(join(REPO_ROOT, relPath), 'utf8');
  }
  return compileAgentsMd(docs);
}

// ── 3.2 / 3.3: the drift-guard itself ────────────────────────────────────────
// RED before task 3.1 lands (AGENTS.md absent or mismatched); GREEN after
// (byte-equality holds by construction — 3.1 generated the file via this
// same compiler).

test('drift-guard: compileAgentsMd() over the REAL 5 SOURCE_DOCS is byte-equal to the committed AGENTS.md', () => {
  const fresh = compileFromRealSources();
  const committed = readFileSync(join(REPO_ROOT, AGENTS_EMIT_PATH), 'utf8');

  assert.equal(
    fresh,
    committed,
    'AGENTS.md has drifted from its 5 canonical SOURCE_DOCS — regenerate via ' +
      '`AGENT_PLATFORM=antigravity node brain/scripts/harness/cli.mjs init` (never hand-edit AGENTS.md)',
  );
});

// ── 3.4: hand-edit regression proof — the guard's teeth ──────────────────────
// Confirms the comparison mechanism actually distinguishes drifted from
// non-drifted content before trusting it against the real file. Does NOT
// hand-edit the committed AGENTS.md — simulates via a string copy.

test('drift-guard proof: a mutated copy of a fresh compile is NOT byte-equal to the fresh compile (the guard has teeth)', () => {
  const fresh = compileFromRealSources();
  const mutatedCopy = fresh + 'X'; // simulated hand-edit: one appended character, never applied to disk

  assert.notEqual(
    mutatedCopy,
    fresh,
    'the byte-equality comparison must distinguish a drifted copy from a non-drifted one',
  );
});

/**
 * The COMMITTED bytes of the emitted settings file, read from git rather than
 * from the working tree (#616). Returns null ONLY when the path is genuinely
 * not tracked — never as a way of swallowing a git failure, which would make
 * "the file is not under version control" indistinguishable from "I could not
 * read it" and turn this guard into a silent pass.
 */
export function committedBytes(relPath, root = REPO_ROOT) {
  // `null` means ONE thing: git ran, answered, and said the path is not tracked.
  // Every other failure throws. Returning null for "git is missing" or "this is
  // not a repository" would make "there is nothing committed" indistinguishable
  // from "I could not look" — the evidence-reader-empty-on-failure class this
  // very guard exists to defeat. Measured on the previous revision: deleting
  // .git, or running without a git binary, turned this guard GREEN.
  const inRepo = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root, encoding: 'utf8' });
  if (inRepo.error || inRepo.status !== 0) {
    throw new Error(
      `cannot judge ${relPath}: git is unusable here (${inRepo.error?.code ?? inRepo.stderr?.trim() ?? `exit ${inRepo.status}`}). ` +
        'Refusing to pass on evidence that was never read.',
    );
  }

  const tracked = spawnSync('git', ['ls-files', '--error-unmatch', '--', relPath], { cwd: root, encoding: 'utf8' });
  if (tracked.error) throw new Error(`cannot judge ${relPath}: ${tracked.error.message}`);
  if (tracked.status === 1) return null; // git answered: genuinely untracked
  if (tracked.status !== 0) {
    throw new Error(`cannot judge ${relPath}: git ls-files exited ${tracked.status} — ${tracked.stderr?.trim()}`);
  }

  const show = spawnSync('git', ['show', `HEAD:${relPath}`], { cwd: root, encoding: 'utf8' });
  if (show.error || show.status !== 0) {
    throw new Error(
      `${relPath} is tracked but its committed copy could not be read — ` +
        `refusing to pass on unread evidence: ${show.stderr?.trim() || show.error?.message}`,
    );
  }
  return show.stdout;
}

const committedSettings = () => committedBytes(GEMINI_SETTINGS_EMIT_PATH);

test('drift-guard: compileSettingsHooksJson() is valid JSON and byte-equal to the committed .gemini/settings.json', () => {
  const fresh = compileSettingsHooksJson();
  assert.doesNotThrow(() => JSON.parse(fresh));

  const committed = committedSettings();
  if (committed !== null) {
    assert.equal(
      fresh, committed,
      `${GEMINI_SETTINGS_EMIT_PATH} has drifted from the compiler. If you just regenerated it, ` +
        'COMMIT the regenerated file — this guard reads the committed bytes (#616), so a ' +
        'regenerated-but-uncommitted file reads as drift until you commit it.',
    );
  }
});

// Why AGENTS.md above is still judged against the WORKING TREE while the
// settings file is judged against HEAD (#616): the self-heal needs a test that
// writes the tracked file, and only the settings path ever had one. 2.4/2.6 in
// antigravity.test.mjs now make that impossible for both paths, so AGENTS.md
// has no vector to close and keeps the friendlier regenerate-then-test flow.
// If a writer for AGENTS.md ever appears, the same treatment applies here.


// ── The guard must survive a dirty working tree (issue #616) ─────────────────
//
// It used to compare against the working-tree copy of a TRACKED file, and a
// sibling test rewrote that same file by running init() against the real repo
// root. Measured then: with the compiler mutated, run 1 was red, runs 2 and 3
// were green — the guard repaired the evidence it judges. A guard you cannot
// re-run is not a guard.

test('drift-guard: the reader returns the COMMITTED bytes even when the working copy differs', () => {
  // The previous version of this test computed a `dirtied` string and never
  // used it — its final assertion was byte-identical to the one above it, so it
  // passed with the property removed (measured: swapping the reader back to a
  // working-tree readFileSync left all four drift tests green). This builds a
  // real repository where the two genuinely differ.
  const scratch = mkdtempSync(join(tmpdir(), 'brain-616-'));
  try {
    const git = (...args) => {
      const r = spawnSync('git', args, { cwd: scratch, encoding: 'utf8' });
      assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
    };
    git('init', '-q');
    git('config', 'user.email', 'test@example.invalid');
    git('config', 'user.name', 'test');
    writeFileSync(join(scratch, 'f.json'), 'COMMITTED\n', 'utf8');
    git('add', 'f.json');
    git('commit', '-qm', 'seed');

    writeFileSync(join(scratch, 'f.json'), 'DIRTY\n', 'utf8');

    assert.equal(readFileSync(join(scratch, 'f.json'), 'utf8'), 'DIRTY\n', 'the working copy must really differ');
    assert.equal(committedBytes('f.json', scratch), 'COMMITTED\n', 'the reader must ignore the working copy');
    assert.equal(committedBytes('untracked.json', scratch), null, 'an untracked path reads as null, not as an error');
  } finally {
    removeTempTree(scratch);
  }
});

test('drift-guard: the reader REFUSES rather than passing when git cannot answer', () => {
  const notARepo = mkdtempSync(join(tmpdir(), 'brain-616-norepo-'));
  try {
    assert.throws(
      () => committedBytes('anything.json', notARepo),
      /git is unusable here/,
      'outside a repository the reader must throw — returning null would read as "nothing is committed"',
    );
  } finally {
    removeTempTree(notARepo);
  }
});
