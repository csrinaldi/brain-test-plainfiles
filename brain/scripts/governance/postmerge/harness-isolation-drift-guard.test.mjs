// harness-isolation-drift-guard.test.mjs — PR5 (#310) Phase 5.4, REQ-D2-14.
//
// STANDING generalization of PR4's one-file D1 fixture: a repo-wide meta-test
// that globs EVERY *.test.mjs and, for any file that EXTRACTS and EXECUTES a
// workflow `run:` script, asserts every such bash/sh spawn is BORN ISOLATED per
// design §7.4 — `cwd` outside the repo, `GIT_CONFIG_GLOBAL`/`_SYSTEM`/`_NOSYSTEM`
// neutralized, and an isolated `HOME`. PR4 fixed+proved the ONE known file; this
// prevents a FUTURE file from silently regressing the contract.
//
// 5.4.3: if this reds against the real suite, it is a signal PR4's isolation fix
// (Phase 4.0.2) was incomplete — escalate, do NOT patch a leak locally here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const SCAN_ROOT = join(REPO_ROOT, 'brain', 'scripts');

function allTestFiles(root) {
  const out = [];
  for (const ent of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, ent.name);
    if (ent.isDirectory()) out.push(...allTestFiles(p));
    else if (ent.name.endsWith('.test.mjs')) out.push(p);
  }
  return out;
}

// A file "extracts and executes a workflow run: script" if it both references a
// workflow-extraction seam AND spawns a shell. The four isolation properties
// must then appear near every bash/sh spawn (the same window heuristic as D1).
function isWorkflowExtracting(src) {
  const extracts = /extractRunScript|\.github\/workflows|run:\s*\|/.test(src);
  const spawnsShell = /(spawnSync|execFileSync)\(\s*['"](bash|sh)['"]/.test(src);
  return extracts && spawnsShell;
}

// Return the 1-indexed line numbers of non-isolated shell spawns (code only,
// comments skipped — a spawn mentioned in prose is not an execution).
function nonIsolatedSpawns(src) {
  const lines = src.split('\n');
  const violations = [];
  lines.forEach((l, i) => {
    const t = l.trim();
    if (t.startsWith('//') || t.startsWith('*')) return;
    if (/(spawnSync|execFileSync)\(\s*['"](bash|sh)['"]/.test(l)) {
      const window = lines.slice(i, i + 10).join('\n');
      // Compliant if it routes through isolatedEnv(...) OR spells out the four props.
      const viaHelper = /isolatedEnv\(/.test(window);
      const spelled = /GIT_CONFIG_GLOBAL/.test(window)
        && /GIT_CONFIG_SYSTEM/.test(window)
        && /GIT_CONFIG_NOSYSTEM/.test(window)
        && /HOME\s*:/.test(window)
        && /cwd\s*:/.test(window);
      if (!viaHelper && !spelled) violations.push(i + 1);
    }
  });
  return violations;
}

test('harness-isolation drift-guard: every workflow-extracting test file is born isolated', () => {
  const offenders = [];
  for (const file of allTestFiles(SCAN_ROOT)) {
    const src = readFileSync(file, 'utf8');
    if (!isWorkflowExtracting(src)) continue;
    const bad = nonIsolatedSpawns(src);
    if (bad.length) offenders.push(`${file.replace(REPO_ROOT + '/', '')}: lines ${bad.join(', ')}`);
  }
  // 5.4.3: a non-empty offenders list means PR4's isolation fix was incomplete
  // for a real file — escalate, do not patch locally.
  assert.deepEqual(offenders, [], `workflow-extracting test files with non-isolated shell spawns:\n${offenders.join('\n')}`);
});

// 5.4.1 TEETH: a deliberately non-compliant stub file is flagged before the
// guard is trusted against the real suite. Written to a temp path, scanned, removed.
test('harness-isolation drift-guard: TEETH — a non-compliant workflow-extracting file is flagged', () => {
  const stub = join(SCAN_ROOT, '__isolation_stub__.test.mjs');
  // Assemble the workflow-extraction + shell-spawn tokens at RUNTIME so this
  // teeth-sample is NOT a literal in this file's own source — otherwise the
  // repo-wide scan above would (correctly) flag its own sample and could never
  // pass clean. Same discipline as PR4's D1.
  const extractTok = 'extract' + 'RunScript';
  const spawnTok = 'spawn' + "Sync('bash'";
  const badSrc = [
    "import { readFileSync } from 'node:fs';",
    `const script = ${extractTok}(readFileSync('.github/workflows/x.yml','utf8'), 'step');`,
    `const r = ${spawnTok}, ['-c', script], { cwd: repo, env: { ...process.env } });`,
  ].join('\n');
  writeFileSync(stub, badSrc);
  try {
    assert.ok(isWorkflowExtracting(badSrc), 'the stub must register as workflow-extracting');
    assert.ok(nonIsolatedSpawns(badSrc).length > 0, 'the guard has no teeth — it missed a non-isolated spawn');
  } finally {
    rmSync(stub, { force: true });
  }
});
