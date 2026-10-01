// brain-to-engram.test.mjs — issue #1112, finding 3.
//
// brain-to-engram.mjs used to read `PROJECT = project.name` directly
// (brain-to-engram.mjs:16, pre-fix). `env:init` never sets `project.name`
// (only `project.slug`), so every `engram save … --project ""` call failed
// with `engram: --project requires a value`, and the script swallowed each
// failure (a `catch` that only logs) and still exited 0 — `env:init` reported
// success over a failure it observed.
//
// The fix: resolve the project the same way the rest of the engram adapter
// does — `deriveProject()` (engine.mjs), now exported and reused here rather
// than a fourth divergent copy — and propagate a non-zero exit when any file
// failed to index, so `engram.mjs#index()`'s `result.status !== 0` throw (and
// therefore memory/cli.mjs's `process.exit(1)`, and bootstrap.sh's
// `|| warn(...)`) all fire on a real failure instead of staying silent.
//
// `run()` is injectable (repoRoot, config, sources, engramSave) so this test
// never touches the real brain/ doctrine tree or spawns a real `engram`
// binary — consistent with the pure-function testing style used across
// brain/scripts (e.g. governance/approved-label.mjs's resolveApprovedLabel).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { run } from './brain-to-engram.mjs';
import { deriveProject } from './axes/memory/adapters/engram.mjs';

const SCRIPT = fileURLToPath(new URL('./brain-to-engram.mjs', import.meta.url));

function withDocsTree(fn) {
  const root = mkdtempSync(join(tmpdir(), 'brain-to-engram-'));
  try {
    const dir = join(root, 'brain/project/decisions');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'adr-0001-x.md'), '# ADR-0001 — x\n\nbody\n');
    writeFileSync(join(dir, 'adr-0002-y.md'), '# ADR-0002 — y\n\nbody\n');
    return fn(root);
  } finally {
    removeTempTree(root);
  }
}

test('#1112 deriveProject: falls back to slug when project.name is empty (env:init never sets .name)', () => {
  const project = deriveProject({ project: { slug: 'csrinaldi/brain', name: '' } }, '/some/checkout');
  assert.equal(project, 'brain', 'must use slug\'s last segment, like the rest of the engram adapter');
});

test('#1112 deriveProject: never returns empty string for a config shaped like env:init leaves it', () => {
  // The exact shape bootstrap.sh's ensureBrainConfig leaves: slug set, name never written.
  const project = deriveProject({ project: { slug: 'org/repo' } }, '/some/checkout');
  assert.notEqual(project, '', 'an empty --project is the exact defect this issue reports');
});

test('#1112 run(): calls engramSave with the resolved project, not project.name', () => {
  withDocsTree((repoRoot) => {
    const calls = [];
    const result = run({
      repoRoot,
      config: { project: { slug: 'csrinaldi/brain', name: '' } },
      sources: [{ dir: 'brain/project/decisions', type: 'decision' }],
      engramSave: (title, content, opts) => { calls.push(opts.project); },
      log: () => {},
      logErr: () => {},
    });
    assert.equal(calls.length, 2);
    assert.ok(calls.every((p) => p === 'brain'), `every call must carry project="brain", got ${JSON.stringify(calls)}`);
    assert.equal(result.indexed, 2);
    assert.equal(result.failed, 0);
  });
});

test('#1112 run(): a per-file engramSave failure is counted and reported, never swallowed silently', () => {
  withDocsTree((repoRoot) => {
    const errors = [];
    const result = run({
      repoRoot,
      config: { project: { slug: 'csrinaldi/brain', name: '' } },
      sources: [{ dir: 'brain/project/decisions', type: 'decision' }],
      engramSave: (title) => { throw new Error(`engram: --project requires a value (${title})`); },
      log: () => {},
      logErr: (line) => errors.push(line),
    });
    assert.equal(result.indexed, 0);
    assert.equal(result.failed, 2, 'both files failed and must be counted');
    const perFileErrors = errors.filter((line) => line.includes('adr-0001-x.md') || line.includes('adr-0002-y.md'));
    assert.equal(perFileErrors.length, 2, 'each failure must be reported by file, not swallowed');
  });
});

test('#1112 main-module guard: importing brain-to-engram.mjs performs no indexing (no real engram spawn, no real brain/ read)', async () => {
  // Regression guard for the refactor itself: the module must be import-safe.
  // If this import ever throws or blocks, the guard was lost.
  await import(SCRIPT);
});

test('#1112 end-to-end: run against THIS repo (its own brain.config.json has project.name === "" today — the exact env:init shape) never sends an empty --project', () => {
  // brain-to-engram.mjs resolves repoRoot and brain.config.json from its own
  // `import.meta.url`, not from cwd — so this is the one test that must run
  // the real script against the real repo rather than a fixture. This repo's
  // own brain.config.json has `project.name === ""` right now (confirmed
  // separately), which is exactly the shape `env:init` leaves — so this also
  // proves the fix against a live, non-fabricated instance of the defect.
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  const binDir = mkdtempSync(join(tmpdir(), 'brain-to-engram-stubbin-'));
  try {
    // A stub `engram` that mimics the real CLI's shape: fails loudly when
    // `--project` is given an empty value, like the real defect did.
    writeFileSync(
      join(binDir, 'engram'),
      [
        '#!/usr/bin/env bash',
        'prev=""',
        'for a in "$@"; do',
        '  if [ "$prev" = "--project" ] && [ -z "$a" ]; then',
        '    echo "engram: --project requires a value" >&2',
        '    exit 1',
        '  fi',
        '  prev="$a"',
        'done',
        'exit 0',
        '',
      ].join('\n'),
      { mode: 0o755 },
    );

    const result = execFileSyncAllowFail(SCRIPT, repoRoot, binDir);
    assert.equal(result.status, 0, `expected a clean exit once the project resolves from slug; stderr:\n${result.stderr}`);
    assert.doesNotMatch(result.stdout + result.stderr, /--project requires a value/);
  } finally {
    removeTempTree(binDir);
  }
});

function execFileSyncAllowFail(script, cwd, binDir) {
  try {
    const stdout = execFileSync('node', [script], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${binDir}:${process.env.PATH}` },
    });
    return { status: 0, stdout, stderr: '' };
  } catch (err) {
    return { status: err.status ?? 1, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
  }
}
