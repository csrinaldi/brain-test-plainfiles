// resolution.test.mjs — whole-commit first-parent diff-inversion
// revert-resolution predicate (design §3, revised after judgment-round-1's
// rename bypass, engram #916). Fixtures below are ported DIRECTLY from the
// forge scripts that derived and validated this mechanism against every
// case at once (doctrine #900 — fixtures are derived from the attack, not
// reverse-engineered from the implementation):
//   - forge_final.mjs — the 11-case validation matrix (C2 real loop, pure
//     rename, rename+modify, copy launder, partial revert, invert+extra,
//     drift liveness, F-1 empty, F-2 binary evil/true, whitespace-exact).
//   - forge6.mjs / insp4.mjs — F-4, the attacker-planted `.gitattributes
//     *.md -diff` at tip; content must stay exposed.
//   - blast.mjs — the U3 context-window blast radius: an intervening
//     neighbor edit close to the payload line either conflicts a genuine
//     `git revert` or shifts the rendered hunk so it no longer byte-matches
//     (a documented, accepted trade-off — NOT resolved falls to the human
//     gate); far enough away (>=4 lines), the genuine revert still matches.
//
// The mutation-bar section at the bottom names the specific line each test
// kills if removed (doctrine #900's "reddens against the prior
// plausible-but-wrong fix" bar, generalized to "reddens against a mutant of
// the CURRENT fix").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync,
} from 'node:fs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { gitTry, gitOrThrow } from './git-seam.mjs';
import { isResolvedAt, isReverterOf, makeGit } from './resolution.mjs';

const POSTMERGE_DIR = fileURLToPath(new URL('.', import.meta.url));

// ── Fixture helpers (house pattern — cursor.test.mjs, CP-PR1 hermeticity) ──

// Every repo the fixtures commit into MUST carry its own identity. `git
// clone`/`git init` inherit none, and a fresh runner (actions/checkout) has
// none to auto-detect, so a fixture that commits without setting identity
// fails only off the author's machine. Non-negotiable (CP-PR1 lesson).
function setIdentity(dir) {
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: dir, encoding: 'utf8' });
  spawnSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir, encoding: 'utf8' });
}

function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'resolution-fixture-'));
  t.after(() => removeTempTree(dir));
  spawnSync('git', ['init', '--initial-branch=main', dir], { encoding: 'utf8' });
  setIdentity(dir);
  return dir;
}

// A git command runner scoped to `dir`. Explodes loudly on any failure — a
// sha PRODUCER never fabricates an empty string (the CP-PR1 lesson).
function run(dir, ...argv) {
  const r = spawnSync('git', argv, { cwd: dir, encoding: 'utf8' });
  if (r.status !== 0) {
    throw new Error(`git ${argv.join(' ')} in ${dir} failed (status=${r.status}): ${(r.stderr ?? '').trim()}`);
  }
  return (r.stdout ?? '').trim();
}

// `git revert` failing (a genuine merge conflict) is a DISTINCT, expected
// outcome (blast-radius distance 1 — falls to the human gate, PR4's
// concern, not this predicate's). Returns { ok, stdout } instead of
// throwing so callers can assert on the conflict itself.
function runMaybe(dir, ...argv) {
  const r = spawnSync('git', argv, { cwd: dir, encoding: 'utf8' });
  return { ok: r.status === 0, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() };
}

function headSha(dir) {
  const sha = run(dir, 'rev-parse', 'HEAD');
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error(`headSha(${dir}): not a 40-hex sha: ${JSON.stringify(sha)}`);
  }
  return sha;
}

function realGit(cwd) {
  return { try: (argv) => gitTry(argv, { cwd }), orThrow: (argv) => gitOrThrow(argv, { cwd }) };
}

function writeAndCommit(dir, path, content, message) {
  const abs = join(dir, path);
  mkdirSync(join(abs, '..'), { recursive: true });
  writeFileSync(abs, content);
  run(dir, 'add', path);
  run(dir, 'commit', '-m', message);
  return headSha(dir);
}

// Base commit shared by every fixture: a single unrelated file on main.
function seedBase(dir) {
  return writeAndCommit(dir, 'base.txt', 'base\n', 'C0: base');
}

// Merge `branch` into `main` with `--no-ff`, returning the merge sha. Every
// candidate reverter in this mechanism MUST be a first-parent merge (the
// set `git rev-list --first-parent --merges` enumerates, exactly what
// brain-audit tracks) — a plain, non-merge commit is never a candidate.
function mergeIntoMain(dir, branch, message) {
  run(dir, 'checkout', 'main');
  run(dir, 'merge', '--no-ff', branch, '-m', message);
  return headSha(dir);
}

// An offender MERGE that adds `files` at the given paths (the realistic
// `--first-parent --merges` shape brain-audit tracks). Returns the merge
// sha; its first parent is main's tip before the merge.
function mergeAddingPayload(dir, files, label) {
  run(dir, 'checkout', '-b', `feat-${label}`);
  for (const [path, content] of Object.entries(files)) {
    const abs = join(dir, path);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
    run(dir, 'add', path);
  }
  run(dir, 'commit', '-m', `${label}: add payload`);
  return mergeIntoMain(dir, `feat-${label}`, `${label}: merge payload`);
}

// `git revert -m 1 --no-edit <offender>` on a fresh branch off `main`, then
// merged back in — a GENUINE revert, always landed as a first-parent merge
// (matching the real auto-revert PR flow, design §6). Returns the merge
// sha, or `{ conflict: true }` if the revert itself could not be applied
// cleanly (blast-radius distance 1 — falls to the human gate).
function genuineRevertMerge(dir, offender, branchName, mergeLabel) {
  run(dir, 'checkout', '-b', branchName, 'main');
  const r = runMaybe(dir, 'revert', '-m', '1', '--no-edit', offender);
  if (!r.ok) {
    runMaybe(dir, 'revert', '--abort');
    run(dir, 'checkout', 'main');
    return { conflict: true };
  }
  return { conflict: false, sha: mergeIntoMain(dir, branchName, mergeLabel) };
}

// ── F-1 — anti-vacuity guard ──────────────────────────────────────────────

// An offender with an EMPTY first-parent contribution (tree == first
// parent's tree, via `-s ours`) MUST be refused, loudly, as the FIRST
// branch of isResolvedAt — never a vacuous pass regardless of what else is
// in range.
test('F-1 — an empty-diff offender is refused by the anti-vacuity guard, never a vacuous pass', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  run(dir, 'checkout', '-b', 'feat-empty');
  writeAndCommit(dir, 'sidecar.txt', 'side\n', 'feat work (discarded by -s ours)');
  run(dir, 'checkout', 'main');
  run(dir, 'merge', '--no-ff', '-s', 'ours', 'feat-empty', '-m', 'M: empty-effect merge');
  const m = headSha(dir);
  const git = realGit(dir);

  const result = isResolvedAt(m, m, { git });
  assert.deepEqual(result, { resolved: false, reason: 'offender has no first-parent contribution' });
});

// ── forge_final case 1 (~ A2 liveness) — C2 real D2 revert loop ────────────

test('C2 — a genuine revert merge resolves the offender (liveness, the real D2 loop shape)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'p.md': 'SECRET_PAYLOAD\n' }, 'M');
  const r = genuineRevertMerge(dir, m, 'rv', 'PR2: revert M');
  assert.equal(r.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r.sha, { git }), { resolved: true });
});

// ── forge_final case 2 — pure rename does NOT resolve ──────────────────────
// THE security-critical fixture: judgment-round-1 (#916) reproduced a
// bypass here against the prior path-scoped `P ∩ D = ∅` predicate — a
// rename made the offender's original path absent from the diff set while
// the payload survived, unmoved in content, at a new path. This mechanism
// compares whole diff TEXT, never paths in isolation, so a rename that does
// not restore the pre-offender content can never match.
test('pure rename does NOT resolve the offender (the #916 bypass shape)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'p.md': 'SECRET_PAYLOAD\n' }, 'M');
  run(dir, 'checkout', '-b', 'rn', 'main');
  run(dir, 'mv', 'p.md', 'q.md');
  run(dir, 'commit', '-m', 'rn: rename only');
  const r = mergeIntoMain(dir, 'rn', 'PR2: rename launder');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
  // Fixture integrity: the payload really does survive, just relocated.
  const grep = spawnSync('git', ['grep', '-qa', 'SECRET_PAYLOAD', r], { cwd: dir });
  assert.equal(grep.status, 0, 'payload must still be present on disk at the renamed path');
});

// ── forge_final case 3 — rename + modify does NOT resolve ──────────────────

test('rename + content modification does NOT resolve the offender', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'p.md': 'SECRET_PAYLOAD\n' }, 'M');
  run(dir, 'checkout', '-b', 'rnm', 'main');
  run(dir, 'mv', 'p.md', 'q.md');
  writeFileSync(join(dir, 'q.md'), 'SECRET_PAYLOAD\n#x\n');
  run(dir, 'add', 'q.md');
  run(dir, 'commit', '-m', 'rnm: rename + modify');
  const r = mergeIntoMain(dir, 'rnm', 'PR2: rename+modify launder');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

// ── forge_final case 4 — copy launder does NOT resolve ─────────────────────

test('a copy-then-remove launder does NOT resolve the offender', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'p.md': 'SECRET_PAYLOAD\n' }, 'M');
  run(dir, 'checkout', '-b', 'cp', 'main');
  const src = readFileSync(join(dir, 'p.md'));
  writeFileSync(join(dir, 'keep.md'), src);
  run(dir, 'rm', 'p.md');
  run(dir, 'add', 'keep.md');
  run(dir, 'commit', '-m', 'cp: copy then remove original');
  const r = mergeIntoMain(dir, 'cp', 'PR2: copy launder');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

// ── forge_final case 5 (~ A3) — partial revert does NOT resolve ────────────

test('a partial revert (some paths restored, not all) does NOT resolve', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'a.md': 'SEC_A\n', 'b.md': 'SEC_B\n' }, 'M');
  run(dir, 'checkout', '-b', 'pr', 'main');
  run(dir, 'rm', 'a.md');
  run(dir, 'commit', '-m', 'restore only a.md');
  const r = mergeIntoMain(dir, 'pr', 'PR2: partial restore');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

// ── forge_final case 6 — invert + extra damage does NOT resolve ────────────
// A candidate that DOES restore the offender's path but ALSO introduces
// unrelated extra content in the SAME commit is not a clean inversion — the
// candidate's own contribution, read backward, carries the extra damage
// too, so it cannot byte-match the offender's (smaller) contribution.

test('inverting the payload while also introducing extra damage does NOT resolve', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'a.md': 'SEC_A\n' }, 'M');
  run(dir, 'checkout', '-b', 'ie', 'main');
  run(dir, 'rm', 'a.md');
  writeFileSync(join(dir, 'evil.md'), 'EVIL\n');
  run(dir, 'add', 'evil.md');
  run(dir, 'commit', '-m', 'ie: restore + smuggle evil.md');
  const r = mergeIntoMain(dir, 'ie', 'PR2: invert+extra');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

// ── forge_final case 7 — drift liveness ─────────────────────────────────────
// An unrelated intervening commit shifts line numbers elsewhere in the
// file (outside the payload's own context window). A genuine revert still
// matches: normDiff drops the position-only `@@ ...@@` header, keeping only
// the byte-exact content, which is unaffected by the shift.

test('drift liveness — an unrelated intervening edit does not pin a genuine revert', (t) => {
  const dir = makeRepo(t);
  writeAndCommit(dir, 'c.txt', 'L1\nL2\nL3\n', 'base');
  const m = mergeAddingPayload(dir, { 'c.txt': 'L1\nL2\nL3\nSECRET_PAYLOAD\n' }, 'M');
  writeAndCommit(dir, 'c.txt', 'TOP\nL1\nL2\nL3\nSECRET_PAYLOAD\n', 'shift: unrelated prepend, far from the payload line');
  const r = genuineRevertMerge(dir, m, 'rv', 'PR2: revert despite drift');
  assert.equal(r.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r.sha, { git }), { resolved: true });
});

// ── forge_final case 9/10 — F-2 binary payloads ─────────────────────────────

test('F-2 — a different binary payload at the same path does NOT resolve the offender', (t) => {
  const dir = makeRepo(t);
  writeAndCommit(dir, 'a.bin', Buffer.from([0x00, 0x6f, 0x72, 0x69, 0x67]), 'binary base');
  const m = mergeAddingPayload(dir, { 'a.bin': Buffer.from([0x00, 0x41, 0x41, 0x41]) }, 'M');
  run(dir, 'checkout', '-b', 'ev', 'main');
  writeFileSync(join(dir, 'a.bin'), Buffer.from([0x00, 0x42, 0x42, 0x42]));
  run(dir, 'add', 'a.bin');
  run(dir, 'commit', '-m', 'ev: different binary payload, not a real revert');
  const r = mergeIntoMain(dir, 'ev', 'PR2: binary evil-modify');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

test('F-2 — a genuine revert of a binary payload resolves the offender (liveness)', (t) => {
  const dir = makeRepo(t);
  writeAndCommit(dir, 'a.bin', Buffer.from([0x00, 0x6f, 0x72, 0x69, 0x67]), 'binary base');
  const m = mergeAddingPayload(dir, { 'a.bin': Buffer.from([0x00, 0x41, 0x41, 0x41]) }, 'M');
  const r = genuineRevertMerge(dir, m, 'rv', 'PR2: revert binary payload');
  assert.equal(r.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r.sha, { git }), { resolved: true });
});

// ── forge_final case 11 — whitespace is part of content, never normalized ──

test('whitespace-only differences (indentation) are NOT treated as a match', (t) => {
  const dir = makeRepo(t);
  writeAndCommit(dir, 'w.txt', 'x\ny\n', 'base');
  const m = mergeAddingPayload(dir, { 'w.txt': 'x\nPAY\ny\n' }, 'M');
  run(dir, 'checkout', '-b', 'b', 'main');
  writeFileSync(join(dir, 'w.txt'), 'x\n    PAY\ny\n'); // re-indented, not byte-identical
  run(dir, 'add', 'w.txt');
  run(dir, 'commit', '-m', 'b: indented differently, not a byte-exact revert');
  const r = mergeIntoMain(dir, 'b', 'PR2: whitespace drift');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

// ── F-4 (forge6.mjs / insp4.mjs) — attacker-planted .gitattributes ─────────
// An attacker plants `*.md -diff` in `.gitattributes` at tip AFTER the
// offender lands, to make git render the payload as an opaque binary stub.
// `--binary` ALONE defeats this (the predicate is pure-read — no
// `.git/info/attributes` write): a `-diff`-attributed file still renders as
// a content-bearing base85 patch, so a non-revert candidate with DIFFERENT
// content is still correctly refused. (The ADD-shaped case below passes via
// path asymmetry; the MODIFY+MODIFY case is the one that actually reddens if
// `--binary` is dropped — see 'F-4 same-path MODIFY' below.)
test('F-4 — a planted .gitattributes "-diff" does not launder a non-revert candidate', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'secret.md': 'PAYLOAD_AAA\n' }, 'M');
  // Attacker plants the attribute AFTER the offender, directly on main.
  writeAndCommit(dir, '.gitattributes', '*.md -diff\n', 'chore: attributes (attacker-planted)');
  run(dir, 'checkout', '-b', 'ev', 'main');
  writeFileSync(join(dir, 'secret.md'), 'PAYLOAD_BBB\n');
  run(dir, 'add', 'secret.md');
  run(dir, 'commit', '-m', 'ev: different content, not a real revert');
  const r = mergeIntoMain(dir, 'ev', 'PR2: attribute-shielded launder attempt');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

// F-4 same-path MODIFY — the test that actually exercises the `--binary`
// defense (judgment-round-2, Judge A). The offender MODIFIES a pre-existing
// file (its diff has no `/dev/null` side), and a non-revert candidate
// MODIFIES the same path to DIFFERENT content, under the attacker's
// `*.md -diff`. WITHOUT `--binary` both first-parent diffs render as the
// identical content-blind "Binary files a/secret.md and b/secret.md differ"
// stub → they compare EQUAL → false `resolved:true`. WITH `--binary` the
// base85 blocks carry content → distinct → correctly refused. So dropping
// `--binary` reddens THIS test (the ADD-shaped F-4 case above cannot).
test('F-4 same-path MODIFY — a planted "-diff" cannot launder a modify-to-different-content (reddens on --binary drop)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  writeAndCommit(dir, 'secret.md', 'ORIGINAL\n', 'seed: secret.md pre-exists so the offender MODIFIES it');
  run(dir, 'checkout', '-b', 'off', 'main');
  writeFileSync(join(dir, 'secret.md'), 'PAYLOAD_AAA\n');
  run(dir, 'add', 'secret.md');
  run(dir, 'commit', '-m', 'off: modify secret.md to AAA');
  const m = mergeIntoMain(dir, 'off', 'PR1: modify offender');
  // attacker plants -diff, then a MODIFY fake-reverter to DIFFERENT content
  writeAndCommit(dir, '.gitattributes', '*.md -diff\n', 'chore: attributes (attacker-planted)');
  run(dir, 'checkout', '-b', 'ev', 'main');
  writeFileSync(join(dir, 'secret.md'), 'PAYLOAD_BBB\n');
  run(dir, 'add', 'secret.md');
  run(dir, 'commit', '-m', 'ev: modify to BBB, not a revert');
  const r = mergeIntoMain(dir, 'ev', 'PR2: modify launder under -diff');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

// A genuine revert must ALSO still resolve under the same planted
// attribute — the hardening must not create a false NEGATIVE either.
test('F-4 — a genuine revert still resolves despite the planted .gitattributes', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'secret.md': 'PAYLOAD_AAA\n' }, 'M');
  writeAndCommit(dir, '.gitattributes', '*.md -diff\n', 'chore: attributes (attacker-planted)');
  const r = genuineRevertMerge(dir, m, 'rv', 'PR2: genuine revert under attribute attack');
  assert.equal(r.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r.sha, { git }), { resolved: true });
});

// ── blast.mjs — the U3 context-window blast radius (documented tradeoff) ───
// A single-line payload edit at position P; an intervening, unrelated
// neighbor edit near P. Distance measured in lines from the payload.

function blastTrial(t, distance) {
  const dir = makeRepo(t);
  const N = 60;
  const P = 30;
  const base = Array.from({ length: N }, (_, i) => `line_${i}`);
  writeAndCommit(dir, 'f.txt', `${base.join('\n')}\n`, 'base');
  const withPayload = [...base];
  withPayload[P - 1] = 'line_PAYLOAD';
  const m = mergeAddingPayload(dir, { 'f.txt': `${withPayload.join('\n')}\n` }, 'M');
  if (distance !== null) {
    const shifted = [...withPayload];
    shifted[P - 1 - distance] = 'line_NEIGHBOR';
    writeAndCommit(dir, 'f.txt', `${shifted.join('\n')}\n`, `neighbor edit at distance ${distance}`);
  }
  const r = genuineRevertMerge(dir, m, `rv-${distance}`, `PR2: revert at distance ${distance}`);
  return { dir, m, r };
}

test('blast radius — no intervening edit: genuine revert resolves', (t) => {
  const { dir, m, r } = blastTrial(t, null);
  assert.equal(r.conflict, false);
  const git = realGit(dir);
  assert.deepEqual(isResolvedAt(m, r.sha, { git }), { resolved: true });
});

test('blast radius — neighbor edit at distance 1 conflicts the revert itself (falls to the human gate)', (t) => {
  const { r } = blastTrial(t, 1);
  assert.equal(r.conflict, true);
});

test('blast radius — neighbor edit at distance 2 (within context) does NOT resolve', (t) => {
  const { dir, m, r } = blastTrial(t, 2);
  assert.equal(r.conflict, false);
  const git = realGit(dir);
  assert.deepEqual(isResolvedAt(m, r.sha, { git }), { resolved: false });
});

test('blast radius — neighbor edit at distance 4 (outside context) resolves normally', (t) => {
  const { dir, m, r } = blastTrial(t, 4);
  assert.equal(r.conflict, false);
  const git = realGit(dir);
  assert.deepEqual(isResolvedAt(m, r.sha, { git }), { resolved: true });
});

// ── isReverterOf — the reverter-skip (design §3.3) ──────────────────────────

test('isReverterOf — a genuine auto-revert is a reverter; a claim-only merge is not', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'docs/adr/0001-thing.md': '# ADR 1\n' }, 'M');
  const r = genuineRevertMerge(dir, m, 'rv', 'PR2: genuine auto-revert');
  assert.equal(r.conflict, false);
  const git = realGit(dir);

  assert.equal(isReverterOf(m, r.sha, { git }), true);

  // A merge that merely CLAIMS (via commit message) to revert M but has no
  // tree effect on M's own contribution.
  run(dir, 'checkout', '-b', 'rc', 'main');
  writeAndCommit(dir, 'other.txt', 'noise\n', `Rc: claims revert\n\nThis reverts commit ${m}.`);
  const rc = mergeIntoMain(dir, 'rc', 'PR3: claim-only merge');

  assert.equal(isReverterOf(m, rc, { git }), false);
});

// ── Checkpoint gate — violation-class → mechanism mapping (design §3.5) ────

// 2.4.1-equivalent: diffSize-shaped — a genuine revert resolves via the
// SAME predicate used for every class; there is no diffSize-specific
// branch.
test('diffSize-shaped offender — a genuine revert resolves via the same predicate (design §3.5 mechanism B)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const big = `${Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n')}\n`;
  const m = mergeAddingPayload(dir, { 'big.txt': big }, 'M');
  const r = genuineRevertMerge(dir, m, 'rv', 'PR2: revert oversized offender');
  assert.equal(r.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r.sha, { git }), { resolved: true });
});

// THE OWNER'S CASE — adrPresence forward-fix. M adds an ADR at path P. A
// LATER merge adds the missing brain/HOME.md at a DIFFERENT path Q, never
// touching P. Tree-effect (now diff-inversion) fails CLOSED forever: no
// merge's own contribution can ever equal pO, because none of them touch
// P at all. The ONLY path that clears M is the human gate
// (cursor.mjs accept, PR1) — outside resolution.mjs's concern by design.
test("owner's case — an adrPresence forward-fix (adds a DIFFERENT path) is NOT resolved, fails closed forever", (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'docs/adr/0002-thing.md': '# ADR 2\n' }, 'M');
  const forwardFix = mergeAddingPayload(dir, { 'brain/HOME.md': '# HOME\n' }, 'fix');
  const later = mergeAddingPayload(dir, { 'more.txt': 'later\n' }, 'later');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, forwardFix, { git }), { resolved: false });
  assert.deepEqual(isResolvedAt(m, later, { git }), { resolved: false });
});

// Design-intent assertion (no new code exercised) — enumerates the four
// violation classes brain-audit emits against the resolution mechanism each
// maps to, citing design §3.5's table, so a future reader sees the mapping
// is deliberate, not incidental.
test('violation-class -> resolution-mechanism mapping is deliberate (design §3.5)', () => {
  // Mechanisms per design §3.5:
  //   A = automatic re-evaluation (mutable input makes the check PASS)
  //   B = automatic diff-inversion skip (settled-by-revert; the ONLY use)
  //   C = human gate (accept --reason)
  //   D = exit-2 (uncomputable)
  const MECHANISMS_BY_CLASS = {
    diffSize: ['B', 'A', 'C'],
    issueLink: ['B', 'A', 'C'],
    adrPresence: ['B', 'C'], // revert ONLY — NO automatic forward-fix path
    memoryPresence: ['A'], // repo-global; re-eval ONLY, never tree-effect
  };

  assert.deepEqual(
    Object.keys(MECHANISMS_BY_CLASS).sort(),
    ['adrPresence', 'diffSize', 'issueLink', 'memoryPresence'],
    'exactly the four classes brain-audit emits (brain-audit.mjs:254-262)',
  );
  assert.equal(MECHANISMS_BY_CLASS.adrPresence.includes('A'), false);
  assert.equal(MECHANISMS_BY_CLASS.memoryPresence.includes('B'), false);
  const diffInversionClasses = Object.entries(MECHANISMS_BY_CLASS)
    .filter(([, m]) => m.includes('B')).map(([c]) => c).sort();
  assert.deepEqual(diffInversionClasses, ['adrPresence', 'diffSize', 'issueLink']);
});

// ── Drift guards ─────────────────────────────────────────────────────────

// The deleted discriminators must not exist anywhere in the postmerge
// SOURCE (non-test .mjs) — a mechanical trip-wire against the exact
// regression this module exists to prevent (design §3.0).
test('drift-guard — isRevertedInRange/findTrailerCandidates/trailerRegex are absent from postmerge source', () => {
  const banned = ['isRevertedInRange', 'findTrailerCandidates', 'trailerRegex'];
  const files = readdirSync(POSTMERGE_DIR).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  assert.ok(files.length > 0, 'expected at least one non-test .mjs under postmerge/');
  for (const f of files) {
    const src = readFileSync(join(POSTMERGE_DIR, f), 'utf8');
    for (const name of banned) {
      assert.equal(src.includes(name), false, `${name} must not exist in ${f} (design §3.0)`);
    }
  }
});

// §3.4 drift-guard — no \x1e/\x1f record framing may reappear in postmerge
// source. Tree-effect/diff-inversion reads no commit bodies at all.
test('drift-guard — no \\x1e/\\x1f framing constant exists in postmerge source', () => {
  const files = readdirSync(POSTMERGE_DIR).filter((f) => f.endsWith('.mjs') && !f.endsWith('.test.mjs'));
  for (const f of files) {
    const src = readFileSync(join(POSTMERGE_DIR, f), 'utf8');
    assert.equal(/\\x1[ef]/.test(src), false, `escaped \\x1e/\\x1f framing must not exist in ${f}`);
    assert.equal(/[\x1e\x1f]/.test(src), false, `raw \\x1e/\\x1f control byte must not exist in ${f}`);
  }
});

// ── MUTATION BAR — each test below reddens if the named guard is removed ───
// These are not hypothetical: every collision asserted "must NOT happen"
// here was empirically reproduced (in a throwaway scratch harness) by
// actually dropping the named flag/call and observing the predicate flip
// to a false positive. The comment on each test names the exact mutation.

// MUTATION: remove the `pO === ''` anti-vacuity guard (the first branch of
// isResolvedAt). Without it, an empty-diff offender's pO ('') would be
// compared against every candidate's reverse diff, including another,
// UNRELATED empty-diff merge later in the same range (also '') — a trivial
// match, falsely resolving an offender that never contributed anything.
test('MUTATION GUARD (F-1) — an empty-diff offender never matches an unrelated later empty-diff merge', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  // M: an empty-effect merge (-s ours discards the feature branch's diff).
  run(dir, 'checkout', '-b', 'feat-empty');
  writeAndCommit(dir, 'sidecar.txt', 'side\n', 'feat work (discarded by -s ours)');
  run(dir, 'checkout', 'main');
  run(dir, 'merge', '--no-ff', '-s', 'ours', 'feat-empty', '-m', 'M: empty-effect merge');
  const m = headSha(dir);
  // A distinct, LATER empty-effect merge — also zero first-parent contribution.
  run(dir, 'checkout', '-b', 'feat-empty-2');
  writeAndCommit(dir, 'sidecar2.txt', 'side2\n', 'unrelated feat work (also discarded)');
  run(dir, 'checkout', 'main');
  run(dir, 'merge', '--no-ff', '-s', 'ours', 'feat-empty-2', '-m', 'N: unrelated empty-effect merge');
  const tip = headSha(dir);
  const git = realGit(dir);

  // WITH the guard: refused before the empty-vs-empty comparison is even
  // attempted (M's own pO is '', so the function returns immediately).
  assert.deepEqual(isResolvedAt(m, tip, { git }), { resolved: false, reason: 'offender has no first-parent contribution' });
});

// MUTATION: drop `--binary` from DIFF_ARGS. Without it, git's fallback for
// a binary-attributed/binary-content MODIFY is the content-blind stub
// "Binary files a/<path> and b/<path> differ" — IDENTICAL text for ANY two
// different binary payloads modifying the SAME path, collapsing a
// non-revert "evil" candidate onto the offender's own contribution.
// `--binary` is the load-bearing content/tree defense here (design §3.2) —
// this predicate is pure-read (no `hardenDiffRendering`/info-attributes
// write, judgment-round-1, engram #916/#921), so `--binary` alone is what
// stands between this attack and a false `resolved: true`. Behaviorally
// verified to redden on drop (see Definition of Done below).
test('MUTATION GUARD (--binary) — two different binary payloads at the same path never collapse to the content-blind stub', (t) => {
  const dir = makeRepo(t);
  writeAndCommit(dir, 'a.bin', Buffer.from([0x00, 0x6f, 0x72, 0x69, 0x67]), 'binary base');
  const m = mergeAddingPayload(dir, { 'a.bin': Buffer.from([0x00, 0x41, 0x41, 0x41]) }, 'M');
  run(dir, 'checkout', '-b', 'ev', 'main');
  writeFileSync(join(dir, 'a.bin'), Buffer.from([0x00, 0x42, 0x42, 0x42]));
  run(dir, 'add', 'a.bin');
  run(dir, 'commit', '-m', 'ev: different binary payload, not a real revert');
  const r = mergeIntoMain(dir, 'ev', 'PR2: binary stub-collapse attempt');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

// MUTATION: drop BOTH `--no-renames` AND `diff.renames=false` (git's
// default is renames=true, so only dropping the PAIR re-enables rename
// detection; dropping either one alone leaves renames off and stays green).
// A PURE
// rename (100% similarity, no content modification in the SAME commit)
// renders as "similarity index 100%\nrename from X\nrename to Y" with
// ZERO content bytes — self-consistent regardless of what the actual bytes
// are. An offender that is itself a pure rename, followed by tampering the
// content IN PLACE, followed by a "reverter" that pure-renames the
// (now-tampered) file back to the original path collapses to the SAME
// zero-content rename text as the offender's own contribution — laundering
// tampered content through a name-only match, exactly the class of bypass
// (#916) this module exists to close.
test('MUTATION GUARD (--no-renames) — a 100%-similarity rename never launders tampered content', (t) => {
  const dir = makeRepo(t);
  mkdirSync(join(dir, 'templates'), { recursive: true });
  mkdirSync(join(dir, 'docs', 'adr'), { recursive: true });
  writeAndCommit(dir, 'templates/adr-template.md', 'ORIGINAL_CONTENT_C\n', 'base');

  // M: a PURE rename (the violation is the relocation itself), content C unchanged.
  run(dir, 'checkout', '-b', 'f');
  run(dir, 'mv', 'templates/adr-template.md', 'docs/adr/0099-secret.md');
  run(dir, 'commit', '-m', 'o: pure rename (the violation)');
  const m = mergeIntoMain(dir, 'f', 'PR1: pure rename offender');

  // Tamper: an ordinary commit corrupts the content IN PLACE (C -> D).
  writeAndCommit(dir, 'docs/adr/0099-secret.md', 'TAMPERED_CONTENT_D\n', 'tamper: corrupt content in place');

  // Attacker's fake reverter: a PURE rename back, content D left UNCHANGED
  // (never restored to C) — still 100% self-similar within this commit.
  run(dir, 'checkout', '-b', 'ev', 'main');
  mkdirSync(join(dir, 'templates'), { recursive: true });
  run(dir, 'mv', 'docs/adr/0099-secret.md', 'templates/adr-template.md');
  run(dir, 'commit', '-m', 'ev: pure rename back, content NOT restored');
  const r = mergeIntoMain(dir, 'ev', 'PR2: rename-back launder attempt');
  const git = realGit(dir);

  // WITHOUT --no-renames, BOTH M's own contribution and R's reverse
  // contribution render as "similarity index 100%\nrename from ... to ...\n"
  // with ZERO content — byte-identical regardless of C vs D, and this
  // assertion FAILS.
  assert.deepEqual(isResolvedAt(m, r, { git }), { resolved: false });
});

// ── HOSTILE-ENV ROBUSTNESS (ports forge_forkb3.mjs) — the verdict must be
// INDEPENDENT of the ambient git config of the machine the predicate runs
// on, not merely "defended by one specific flag". Runs the FULL public API
// (`isResolvedAt`) under an adversarial `GIT_CONFIG_GLOBAL`: a hostile
// textconv driver + `diff.external` + a global attributesFile (both
// referencing a helper that collapses content to a constant string) +
// `diff.algorithm=histogram`, with `GIT_CONFIG_SYSTEM=/dev/null` so no real
// system config leaks in. `--binary` (plus the other pinned flags) must
// still: (a) let a genuine revert resolve true (liveness) and (b) refuse a
// content-launder (safety) — replacing the deleted tautologies (a source
// grep for `--binary`, a direct `.git/info/attributes` content assertion)
// with an honest behavioral proof that the verdict does not depend on the
// environment (design §3.2, the CP-PR1/B6 "green that depends on the
// environment" failure class). Liveness and safety are asserted in TWO
// separate repos/offenders (not one shared history) — a genuine revert
// commit that lands before a later, unrelated launder merge would
// otherwise fall inside the ALREADY-resolved `(offender, tip]` range and
// make the launder assertion vacuously pass for the wrong reason.
function withHostileEnv(dir, t) {
  const helper = join(dir, 'constant.sh');
  writeFileSync(helper, '#!/bin/sh\necho COLLAPSED\n');
  spawnSync('chmod', ['+x', helper]);
  const globalAttrsPath = join(dir, 'hostile.attributes');
  writeFileSync(globalAttrsPath, '*.md diff=hide\n*.bin diff=hide\n');
  const hostileConfigPath = join(dir, 'hostile.gitconfig');
  writeFileSync(hostileConfigPath, [
    '[diff "hide"]',
    `\ttextconv = ${helper}`,
    '[diff]',
    `\texternal = ${helper}`,
    '\talgorithm = histogram',
    '[core]',
    `\tattributesFile = ${globalAttrsPath}`,
  ].join('\n'));

  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;
  const savedSystem = process.env.GIT_CONFIG_SYSTEM;
  process.env.GIT_CONFIG_GLOBAL = hostileConfigPath;
  process.env.GIT_CONFIG_SYSTEM = '/dev/null';
  t.after(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (savedSystem === undefined) delete process.env.GIT_CONFIG_SYSTEM;
    else process.env.GIT_CONFIG_SYSTEM = savedSystem;
  });
}

test('HOSTILE-ENV ROBUSTNESS — liveness: a genuine revert still resolves under adversarial ambient git config (forge_forkb3)', (t) => {
  const dir = makeRepo(t);
  withHostileEnv(dir, t);

  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'secret.md': 'PAYLOAD_AAA\n' }, 'M');
  const genuine = genuineRevertMerge(dir, m, 'rv', 'PR2: genuine revert under hostile ambient config');
  assert.equal(genuine.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(
    isResolvedAt(m, genuine.sha, { git }),
    { resolved: true },
    'liveness: a genuine revert must still resolve under a hostile ambient git config',
  );
});

test('HOSTILE-ENV ROBUSTNESS — safety: a content-launder is still refused under adversarial ambient git config (forge_forkb3)', (t) => {
  const dir = makeRepo(t);
  withHostileEnv(dir, t);

  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'secret.md': 'PAYLOAD_AAA\n' }, 'M');
  run(dir, 'checkout', '-b', 'ev', 'main');
  writeFileSync(join(dir, 'secret.md'), 'PAYLOAD_BBB\n');
  run(dir, 'add', 'secret.md');
  run(dir, 'commit', '-m', 'ev: different content, not a real revert');
  const launder = mergeIntoMain(dir, 'ev', 'PR2: content-launder attempt under hostile ambient config');
  const git = realGit(dir);

  assert.deepEqual(
    isResolvedAt(m, launder, { git }),
    { resolved: false },
    'safety: a content-launder must still be refused under a hostile ambient git config',
  );
});

// ===== PR2b FINDER FIXTURES — FROZEN at RED (REQ-D2-14) — patcher MUST NOT edit; escalate instead =====
//
// Property under attack (all this block is given): isResolvedAt(m, tip)
// must return { resolved: true } IFF m's first-parent payload is NET-ABSENT
// from the tree at `tip`. A payload that was reverted and then
// RE-INTRODUCED by ANY means (a fresh re-add, OR a revert-of-the-revert) is
// NET-PRESENT and MUST be { resolved: false }. The offender is NOT settled
// merely because SOME inverse of it exists somewhere in `(offender, tip]`.
// These fixtures assert ONLY on the public `isResolvedAt` return value.

// A5 — a fresh re-add AFTER a genuine revert is NET-PRESENT again.
// M adds payload P; R genuinely reverts M (P removed); a LATER, non-revert
// merge X re-adds P's EXACT content. The verdict is TIP-RELATIVE: at tip=R
// the payload is net-absent (resolved), but at tip=X it is net-present, so
// the offence is LIVE and MUST NOT be resolved. A predicate that only asks
// "does some inverse (R) exist in range?" wrongly clears M at X.
test('A5 — a fresh re-add after a genuine revert is NET-PRESENT: offender NOT resolved at the re-add tip', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = mergeAddingPayload(dir, { 'p.md': 'A5_PAYLOAD\n' }, 'M');
  const r = genuineRevertMerge(dir, m, 'rv', 'PR-R: genuine revert of M');
  assert.equal(r.conflict, false);
  // A LATER, non-revert merge re-adds P's EXACT content (P was deleted by R).
  const x = mergeAddingPayload(dir, { 'p.md': 'A5_PAYLOAD\n' }, 'X');
  const git = realGit(dir);

  // Liveness anchor: at tip=R the payload is net-ABSENT → resolved.
  assert.deepEqual(isResolvedAt(m, r.sha, { git }), { resolved: true });
  // THE ATTACK: at tip=X the payload is net-PRESENT again → NOT resolved.
  assert.deepEqual(isResolvedAt(m, x, { git }), { resolved: false });
});

// A7 — revert-of-a-revert (THE CRITICAL). O adds payload (an independent
// offender: an ADR with no paired brain/HOME.md). R = genuine revert of O
// (removes it; R is itself record-less — an independent offender in its own
// right). R2 = genuine revert of R — re-adds O's EXACT payload. At tip=R2:
//   - O's payload is LIVE at HEAD via R2  → isResolvedAt(O)  = false
//   - R was itself reverted by R2         → isResolvedAt(R)  = true
//   - nothing after R2 inverts it         → isResolvedAt(R2) = false
// The current predicate finds R (an inverse of O) in range and clears O —
// the exact over-resolution this fixture reddens.
test('A7 — revert-of-a-revert re-introduces the payload: O NOT resolved, R resolved, R2 NOT resolved (THE CRITICAL)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'docs/adr/0007-thing.md': '# ADR 7\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: genuine revert of O');
  assert.equal(r.conflict, false);
  const r2 = genuineRevertMerge(dir, r.sha, 'rv2', 'PR-R2: genuine revert of R (re-adds O)');
  assert.equal(r2.conflict, false);
  const git = realGit(dir);

  // THE ATTACK: O's payload is live at HEAD via R2 → NOT resolved.
  assert.deepEqual(isResolvedAt(o, r2.sha, { git }), { resolved: false });
  // R was itself reverted by R2 → resolved.
  assert.deepEqual(isResolvedAt(r.sha, r2.sha, { git }), { resolved: true });
  // Nothing after R2 inverts it → NOT resolved.
  assert.deepEqual(isResolvedAt(r2.sha, r2.sha, { git }), { resolved: false });
});

// A8 — an EVEN chain settles (liveness / no over-correction). O, R, R2, R3
// each a genuine merged revert of the prior. At tip=R3 O's payload is
// net-ABSENT → resolved. This may already be GREEN against the current
// code; its job is to stop a FUTURE over-correction that would wrongly
// redden a genuinely-settled chain, not to redden today.
test('A8 — an EVEN chain of genuine reverts settles: O is net-absent, resolved (liveness / no over-correction)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'p.md': 'A8_PAYLOAD\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: revert O');
  assert.equal(r.conflict, false);
  const r2 = genuineRevertMerge(dir, r.sha, 'rv2', 'PR-R2: revert R');
  assert.equal(r2.conflict, false);
  const r3 = genuineRevertMerge(dir, r2.sha, 'rv3', 'PR-R3: revert R2');
  assert.equal(r3.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(o, r3.sha, { git }), { resolved: true });
});

// C3(a) — RANGE EDGE: the inverter R immediately after O's own commit
// boundary. At tip=R the payload is net-absent → resolved.
test('C3(a) — inverter immediately after the offender boundary resolves it (range edge)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'p.md': 'C3A_PAYLOAD\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: revert immediately after O');
  assert.equal(r.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(o, r.sha, { git }), { resolved: true });
});

// C3(b) — RANGE EDGE: the inverter R exactly at tip (HEAD-most), with an
// unrelated merge sitting between O and R. At tip=R the payload is
// net-absent → resolved.
test('C3(b) — inverter exactly at tip (HEAD-most), unrelated merge between, resolves the offender (range edge)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'p.md': 'C3B_PAYLOAD\n' }, 'O');
  mergeAddingPayload(dir, { 'unrelated.txt': 'noise\n' }, 'U'); // between O and R
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: revert at HEAD');
  assert.equal(r.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(o, r.sha, { git }), { resolved: true });
});

// C3(c) — RANGE EDGE: the offender O itself exactly at tip (HEAD). A merge
// at HEAD must NEVER be wholesale-resolved as its own canceller — the
// half-open range (O, O] is empty, so nothing inverts it → NOT resolved.
test('C3(c) — the offender itself at HEAD is NEVER wholesale-resolved as its own canceller (range edge)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'p.md': 'C3C_PAYLOAD\n' }, 'O');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(o, o, { git }), { resolved: false });
});

// C3(d) — RANGE EDGE: a genuine cleanup revert R sitting at HEAD with the
// offender O behind it. O really is net-absent at tip=R → resolved.
test('C3(d) — a genuine cleanup revert at HEAD with the offender behind it resolves the offender (range edge)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'p.md': 'C3D_PAYLOAD\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: cleanup revert at HEAD');
  assert.equal(r.conflict, false);
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(o, r.sha, { git }), { resolved: true });
});

// global-gap — the sole, HEAD-most merge that carries a live payload is NOT
// self-resolved: with no later merge to invert it, the offence stands.
test('global-gap — the sole, HEAD-most merge carrying a live payload is NOT self-resolved', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const headMerge = mergeAddingPayload(dir, { 'p.md': 'GLOBAL_GAP_PAYLOAD\n' }, 'M');
  const git = realGit(dir);

  assert.deepEqual(isResolvedAt(headMerge, headMerge, { git }), { resolved: false });
});

// ===== END PR2b FINDER FIXTURES =====

// ===== PR2b PATCH-AUTHOR WHITE-BOX PRIMITIVE TESTS (below the frozen block) =====
// Unit tests for the net-parity primitives the frozen isResolvedAt fixtures
// compose (design §15.3). These exercise `sign`, `netPresent`, and
// `netAddFull` DIRECTLY — none of these exports exist under the merged PR2
// pairwise predicate, so this whole block is RED against that code (an import
// error) and GREEN only after the net-parity rewrite. They live OUTSIDE the
// frozen finder block by contract (the finder owns the end-to-end
// `isResolvedAt` fixtures; the patch author owns the primitive white-box).

import { sign, netPresent, netAddFull } from './resolution.mjs';

// 2b.2.1 — `sign` is a pure 3-way classifier over (fW, s, sInv): re-add,
// invert, or unrelated. `sInv` is a DISTINCT computation, never a textual
// reversal of `s`, so it is passed in precomputed.
test('sign — +1 when the candidate re-introduces s, −1 when it inverts s, 0 otherwise', () => {
  const s = 'PATCH_S'; // a target signature (opaque diff text)
  const sInv = 'PATCH_S_INV'; // its exact reverse patch (a distinct git computation)
  assert.equal(sign(s, s, sInv), 1); // re-add
  assert.equal(sign(sInv, s, sInv), -1); // invert
  assert.equal(sign('UNRELATED_RENAME', s, sInv), 0); // neither (e.g. a rename)
});

// 2b.2.3 — netPresent on a bare offender (nothing after it) is its own +1 base.
test('netPresent — a bare offender with no candidates after it counts 1 (its own base term)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'p.md': 'WB_BARE\n' }, 'O');
  const git = realGit(dir);
  assert.equal(netPresent(o, o, { git }), 1);
  assert.deepEqual(isResolvedAt(o, o, { git }), { resolved: false });
});

// 2b.2.4 — netPresent on O,R (single genuine revert, A2 shape) nets to 0.
test('netPresent — a single genuine revert cancels the offender to net 0 (liveness)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'p.md': 'WB_OR\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR2: revert O');
  assert.equal(r.conflict, false);
  const git = realGit(dir);
  assert.equal(netPresent(o, r.sha, { git }), 0);
  assert.deepEqual(isResolvedAt(o, r.sha, { git }), { resolved: true });
});

// 2b.3.1 — netAddFull on a sole genuine reverter over its window nets to 0
// (the A6 shape re-expressed as a full-window signed count; exempt).
test('netAddFull — a sole genuine reverter over its window nets to 0 (exempt)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'docs/adr/0001-x.md': '# ADR 1\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR2: revert O');
  assert.equal(r.conflict, false);
  const git = realGit(dir);
  // window [O, R] sees O (fW == dRinv) and R (fW == dR): 1 − 1 = 0.
  assert.equal(netAddFull(r.sha, { git, from: o, to: r.sha }), 0);
});

// 2b.3.2 — netAddFull on the A7 R2 carrier is +1 (NOT exempt): O and R2 both
// carry dO, only R inverts it (2 − 1 = +1). This is the reverter-skip half of
// THE CRITICAL — the net-anchored replacement must NOT crown R2.
test('netAddFull — the revert-of-a-revert carrier (A7 R2) nets to +1, NOT exempt', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'docs/adr/0007-thing.md': '# ADR 7\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: revert O');
  assert.equal(r.conflict, false);
  const r2 = genuineRevertMerge(dir, r.sha, 'rv2', 'PR-R2: revert R (re-adds O)');
  assert.equal(r2.conflict, false);
  const git = realGit(dir);
  // window [O, R2]: {O, R2} carry dO (== dR2) → 2; {R} inverts it → 1. 2 − 1 = +1.
  assert.equal(netAddFull(r2.sha, { git, from: o, to: r2.sha }), 1);
});

// 2b.6.4 — full-window vs directional asymmetry: a cleanup revert R sitting at
// HEAD is reverter-EXEMPT (full-window netAddFull sees O behind it → 0) even
// though it is NOT resolved-skipped (directional netPresent counts its own +1
// → 1). A directional-only reverter count over (R, tip] (empty) would wrongly
// leave R un-exempt — this is exactly why the two ranges MUST differ (design
// §15.3's "why the ranges differ" note).
test('range asymmetry — a tip-most cleanup revert is full-window exempt yet directionally net-present', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'p.md': 'WB_ASYM\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: cleanup revert at HEAD');
  assert.equal(r.conflict, false);
  const git = realGit(dir);
  // FULL-WINDOW [O, R] sees O behind R → exempt (≤ 0).
  assert.equal(netAddFull(r.sha, { git, from: o, to: r.sha }), 0);
  // DIRECTIONAL netPresent(R, R): R's own +1 base, nothing after it to cancel
  // → net-present (1), so R is (correctly) NOT resolved-skipped.
  assert.equal(netPresent(r.sha, r.sha, { git }), 1);
  assert.deepEqual(isResolvedAt(r.sha, r.sha, { git }), { resolved: false });
});

// ===== PR2b PATCH-AUTHOR EXPORTED-VACUITY GUARD (F-1 on the export surface) =====
// The F-1 anti-vacuity guard must hold on the EXPORTED primitives themselves,
// not only upstream in `isResolvedAt`. `netPresent`/`netAddFull`/`sign` are all
// exported: their contract is for FUTURE direct callers (PR3 is the first new
// one), so an empty payload signature (`dO`/`dC`/`s` === '') MUST be refused
// fail-closed — never a vacuous net-present/exempt verdict.
//
// MUTATION BAR (RED→GREEN): each assertion reddens if its guard is dropped.
//   - Drop `netPresent`'s `if (dO === '') throw` → `sign('', ...)` returns +1
//     for empty-diff merges in range → a spurious net count, NO throw → RED.
//   - Drop `netAddFull`'s `if (dC === '') throw` → a content-free candidate can
//     score `≤ 0` and be spuriously exempted, NO throw → RED.
//   - Drop `sign`'s `if (s === '') throw` → `sign('', '', '')` returns +1 → RED.
// These call the exports DIRECTLY with an empty-diff offender/candidate (built
// with `-s ours`, the same empty-effect merge the frozen F-1 fixture uses), so
// they are sound in isolation regardless of any upstream guard.

// An empty-effect (`-s ours`) merge: its tree equals its first parent's, so
// `normDiff(m^1, m) === ''` — a vacuous payload signature.
function emptyEffectMerge(dir, branchLabel, mergeLabel) {
  run(dir, 'checkout', '-b', `feat-${branchLabel}`);
  writeAndCommit(dir, `sidecar-${branchLabel}.txt`, 'side\n', 'feat work (discarded by -s ours)');
  run(dir, 'checkout', 'main');
  run(dir, 'merge', '--no-ff', '-s', 'ours', `feat-${branchLabel}`, '-m', mergeLabel);
  return headSha(dir);
}

// F-1/export — netPresent called DIRECTLY with an empty-diff offender THROWS
// fail-closed; it never returns a vacuous net-present count.
test('F-1/export — netPresent refuses an empty-diff offender fail-closed (never a vacuous count)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = emptyEffectMerge(dir, 'np-empty', 'M: empty-effect merge');
  const git = realGit(dir);
  assert.throws(
    () => netPresent(m, m, { git }),
    /no first-parent contribution.*F-1 vacuity|F-1 vacuity.*refused/,
    'netPresent must throw (fail-closed) on an empty-diff offender, not return a count',
  );
});

// F-1/export — netAddFull called DIRECTLY with an empty-diff candidate THROWS
// fail-closed; it never returns a vacuous (spuriously exempt) count.
test('F-1/export — netAddFull refuses an empty-diff candidate fail-closed (never a vacuous exempt)', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const m = emptyEffectMerge(dir, 'naf-empty', 'M: empty-effect merge');
  const git = realGit(dir);
  assert.throws(
    () => netAddFull(m, { git, from: m, to: m }),
    /no first-parent contribution.*F-1 vacuity|F-1 vacuity.*refused/,
    'netAddFull must throw (fail-closed) on an empty-diff candidate, not return a count',
  );
});

// F-1/export — sign called DIRECTLY with an empty target signature THROWS,
// closing the same exported-vacuity class at the primitive term (an empty `s`
// would otherwise match an empty `fW` and return a spurious +1).
test('F-1/export — sign refuses an empty target signature fail-closed', () => {
  assert.throws(() => sign('', '', ''), /empty target signature.*F-1 vacuity/);
  assert.throws(() => sign('anything', '', 'x'), /empty target signature.*F-1 vacuity/);
});

// ===== PR3 — the (c′) LIVENESS GUARD on the reverter exemption ==============
// `addedPathsAbsentAt(C, tip)` — C's OWN ADDED paths (first-parent diff, added
// status) must ALL be ABSENT from the tree at the audited tip for the reverter
// exemption to be available (external ruling rev 4, issue #297).
//
// WHY THIS PRIMITIVE EXISTS. `netAddFull` is a signed count over a WINDOW: it
// answers "did C's contribution cancel out inside [from,to]?", never "is C's
// payload live right now?". When the payload's ORIGINAL introduction sits
// BEHIND the window base, the window sees only a delete and a re-add and nets
// to 0 — so a live-at-tip offender earned the exemption and the audit exited 0
// (the A8 fail-open, frozen end-to-end in brain-audit.test.mjs). The rejected
// rev-3 binding gated the exemption on `isResolvedAt`, whose DIRECTIONAL
// `(C, tip]` range is EMPTY for any tip-most merge → resolved:false always →
// it denied the exemption to every legitimate tip-most cleanup revert (frozen
// A2/A6). This primitive tests the tree at the tip DIRECTLY, so it is blind to
// both ranges and to how the payload got there.
//
// FAILURE DIRECTION (closed): denying an available exemption yields an EXTRA
// [FAIL], never a missed one. The empty added-set → `true` branch is the
// cleanup shape (pure deletes) and is exemptible BY RULING, not by accident.
//
// MUTATION BAR (RED→GREEN) — each test below kills a specific mutant:
//   - Drop the `added.length === 0` early return → `ls-tree ... --` with ZERO
//     pathspecs lists the WHOLE tree → every pure-delete reverter scores
//     "present" → the cleanup-revert test RED (and A2/A6 with it).
//   - Drop the `--no-renames`/`diff.renames=false` PAIR → a 100%-similar rename
//     renders as `R`, never `A` → the added-set is empty → a renamed live
//     payload is vacuously "absent" → the rename test RED. As in `normDiff`,
//     only dropping BOTH reddens: git's default is `diff.renames=true`.
//   - Anchor at the candidate instead of `tip` → the tip-anchor test RED.

import { addedPathsAbsentAt } from './resolution.mjs';

// c′.1 — the CLEANUP shape (frozen A2/A6): a genuine revert of an add-only
// offender contributes pure deletes, so its added-set is EMPTY → vacuously
// absent → the exemption stays available. This is the test the whole guard has
// to not break; it is also the zero-pathspec mutant's grave.
test("addedPathsAbsentAt — a pure-delete cleanup revert adds nothing: vacuously absent (exemption stays available)", (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'docs/adr/0009-cleanup.md': '# ADR 9\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: cleanup revert at HEAD');
  assert.equal(r.conflict, false);
  const git = realGit(dir);
  assert.equal(addedPathsAbsentAt(r.sha, r.sha, { git }), true,
    'a tip-most cleanup revert adds no path — its exemption must stay available');
});

// c′.2 — the RE-ADD carrier (frozen A7 R2 / A8 O): the candidate's own added
// path is LIVE in the tree at the tip → exemption DENIED, regardless of what
// any windowed count says about it.
test('addedPathsAbsentAt — a re-add carrier whose added path is live at the tip is refused the exemption', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'docs/adr/0010-readd.md': '# ADR 10\n' }, 'O');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: revert O');
  assert.equal(r.conflict, false);
  const r2 = genuineRevertMerge(dir, r.sha, 'rv2', 'PR-R2: revert R (re-adds the payload)');
  assert.equal(r2.conflict, false);
  const git = realGit(dir);
  assert.equal(addedPathsAbsentAt(r2.sha, r2.sha, { git }), false,
    'R2 re-adds the payload and it is live at the tip — the exemption must be denied');
});

// c′.3 — the TIP is the anchor, not the candidate. The SAME offender O is
// refused at its own tip (payload live) and allowed once a later revert has
// removed the payload from the tree at the audited tip.
test('addedPathsAbsentAt — the audited tip is the anchor: the same offender flips once its payload is gone', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  const o = mergeAddingPayload(dir, { 'docs/adr/0011-anchor.md': '# ADR 11\n' }, 'O');
  const git = realGit(dir);
  assert.equal(addedPathsAbsentAt(o, o, { git }), false,
    'at O the payload O added is live — refused');
  const r = genuineRevertMerge(dir, o, 'rv', 'PR-R: revert O');
  assert.equal(r.conflict, false);
  assert.equal(addedPathsAbsentAt(o, r.sha, { git }), true,
    'at R the payload O added is gone from the tree — absent');
});

// c′.4 — MUTATION GUARD (--no-renames PAIR): a 100%-similarity rename relocates
// a LIVE payload. With git's default rename detection the new path renders as
// `R`, never `A`, so an unpinned implementation sees an EMPTY added-set and
// vacuously exempts a candidate that put content back on the tree under a new
// name — the rename-laundering class the module already defends in `normDiff`,
// re-armed here on the path surface.
test('addedPathsAbsentAt — MUTATION GUARD (--no-renames): a 100%-similar rename never launders a live payload into a vacuous absence', (t) => {
  const dir = makeRepo(t);
  seedBase(dir);
  mergeAddingPayload(dir, { 'docs/adr/0012-rename.md': '# ADR 12\n' }, 'O');
  run(dir, 'checkout', '-b', 'mv-payload', 'main');
  run(dir, 'mv', 'docs/adr/0012-rename.md', 'docs/adr/0012-renamed.md');
  run(dir, 'commit', '-m', 'C: relocate the payload (100% similarity)');
  const c = mergeIntoMain(dir, 'mv-payload', 'C: merge relocation');
  const git = realGit(dir);
  assert.equal(addedPathsAbsentAt(c, c, { git }), false,
    'the relocated payload is live at the tip under its new path — the exemption must be denied');
});
