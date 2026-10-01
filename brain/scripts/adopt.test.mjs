// adopt.test.mjs — CLI integration test for brain:adopt S1.
//
// Self-contained: before() builds a temporary consumer root, populates it with
// the catastro-flat fixture files, and creates an upstream mock at
// <tmpConsumer>/node_modules/brain/brain/core/methodology/intro.md so that
// step-1 resolution (node_modules/brain) wins and manifestSource is
// 'node_modules/brain'. No real brain/core files are read or required at
// runtime — both tmpConsumer and outDir are isolated mkdtemp directories
// cleaned up in after(). The static catastro-flat fixture directory is used
// only as a file-content source during setup.
//
// Assertions (spec requirements §CLI integration test):
//   - plan.json is written and parses as valid JSON matching the canonical schema
//   - report.md is written and contains all expected sections
//   - catastro ES intro.md is classified as 'translation', languageFlag:true,
//     and appears in the Replacements section of report.md
//   - manifestSource is 'node_modules/brain' (temp mock makes step-1 win)
//   - Read-only contract: no file in tmpConsumer is modified by run(), and
//     no file is added outside outDir
//
// Both temp dirs (tmpConsumer + outDir) are cleaned up in all code paths via after().

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  readFileSync,
  statSync,
  readdirSync,
  rmSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

import { run } from './adopt.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(__dirname, 'lib', 'adopt', '__fixtures__', 'catastro-flat');

// ── Shared state set up once across all tests ─────────────────────────────────

let tmpConsumer;
let outDir;
let plan;
let reportMd;
let consumerMtimesBefore;
let consumerMtimesAfter;

/**
 * Recursively snapshots {absolutePath → mtimeMs} for all files under root.
 * Used to assert the consumer tree is not modified by the CLI.
 */
function snapshotMtimes(root) {
  const snap = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else snap[abs] = statSync(abs).mtimeMs;
    }
  };
  walk(root);
  return snap;
}

before(async () => {
  // Create two isolated temp directories: one for the consumer root, one for output.
  tmpConsumer = mkdtempSync(join(tmpdir(), 'brain-adopt-consumer-'));
  outDir = mkdtempSync(join(tmpdir(), 'brain-adopt-out-'));

  // Helper: write content to a consumer-relative path, creating parent dirs.
  const write = (rel, content) => {
    const abs = join(tmpConsumer, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  };

  // Populate the consumer to mirror the catastro-flat scenario.
  // File content is read from the static fixture directory.
  write(
    'brain/methodology/intro.md',
    readFileSync(join(FIXTURE_DIR, 'brain', 'methodology', 'intro.md'), 'utf8'),
  );
  write(
    'brain/project/custom/notes.md',
    readFileSync(join(FIXTURE_DIR, 'brain', 'project', 'custom', 'notes.md'), 'utf8'),
  );
  write(
    'docs/onboarding/guide.md',
    readFileSync(join(FIXTURE_DIR, 'docs', 'onboarding', 'guide.md'), 'utf8'),
  );
  write(
    'scripts/setup.sh',
    readFileSync(join(FIXTURE_DIR, 'scripts', 'setup.sh'), 'utf8'),
  );

  // Create upstream mock inside the consumer's node_modules so that step-1
  // resolution (node_modules/brain) wins and manifestSource is 'node_modules/brain'.
  // The EN content mirrors the Spanish translation's heading structure
  // (same count and order) so classify-divergence assigns divergenceKind 'translation'.
  // node_modules/ is gitignored in real projects — this path is never committed.
  write(
    'node_modules/brain/brain/core/methodology/intro.md',
    [
      '# Brain Methodology — Introduction',
      '',
      '## What is Brain Methodology?',
      '',
      'The Brain methodology provides a structured system for managing knowledge in',
      'software development teams.',
      '',
      '## How It Works',
      '',
      'Brain uses a list of managed paths to determine which files are the package\'s',
      'responsibility and which belong to the team.',
      '',
      '### Conflict Resolution',
      '',
      'When a managed file differs from upstream, the installer notifies the team.',
      '',
      '## Additional Conventions',
      '',
      'Remember that every project has its unique characteristics.',
      '',
      '## References',
      '',
      '- `brain/core/managed-paths.mjs`: list of managed paths',
      '- `brain/project/README.md`: entry point for project documentation',
    ].join('\n'),
  );

  // Snapshot consumer state BEFORE the run to verify the read-only contract.
  consumerMtimesBefore = snapshotMtimes(tmpConsumer);

  // Run the CLI once; share results across all tests in this file.
  await run([tmpConsumer, '--out', outDir]);

  // Snapshot AFTER — no file in tmpConsumer should have changed.
  consumerMtimesAfter = snapshotMtimes(tmpConsumer);

  plan = JSON.parse(readFileSync(join(outDir, 'plan.json'), 'utf8'));
  reportMd = readFileSync(join(outDir, 'report.md'), 'utf8');
});

after(() => {
  rmSync(tmpConsumer, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
});

// ── Tests ─────────────────────────────────────────────────────────────────────

test('plan.json exists and matches canonical spec schema', () => {
  assert.equal(plan.schemaVersion, '1', 'schemaVersion must be "1"');
  assert.equal(plan.tool, 'brain:adopt', 'tool must be "brain:adopt"');
  assert.ok(
    typeof plan.generatedAt === 'string' && plan.generatedAt.length > 0,
    'generatedAt must be an ISO string',
  );
  assert.ok(plan.target && typeof plan.target.shape === 'string', 'target.shape required');
  assert.ok(typeof plan.target.root === 'string', 'target.root required');
  assert.equal(
    plan.manifestSource,
    'node_modules/brain',
    'manifestSource must be node_modules/brain (temp mock makes step-1 resolution win)',
  );
  assert.ok(plan.summary && typeof plan.summary.total === 'number', 'summary.total required');
  assert.ok(Array.isArray(plan.files), 'files must be an array');
  // All per-file records must carry the required spec fields.
  for (const record of plan.files) {
    assert.ok('sourcePath' in record, 'sourcePath required in record');
    assert.ok('logicalName' in record, `logicalName required in ${record.sourcePath}`);
    assert.ok('classification' in record, `classification required in ${record.sourcePath}`);
    assert.ok('matchedGlob' in record, `matchedGlob required in ${record.sourcePath}`);
    assert.ok('divergenceKind' in record, `divergenceKind required in ${record.sourcePath}`);
    assert.ok('languageFlag' in record, `languageFlag required in ${record.sourcePath}`);
    assert.ok('proposedAction' in record, `proposedAction required in ${record.sourcePath}`);
    assert.ok('reason' in record, `reason required in ${record.sourcePath}`);
    assert.ok(
      ['generic', 'project'].includes(record.classification),
      `classification must be generic|project, got ${record.classification} in ${record.sourcePath}`,
    );
    assert.equal(
      typeof record.languageFlag,
      'boolean',
      `languageFlag must be boolean in ${record.sourcePath}`,
    );
  }
});

test('report.md exists with all expected sections', () => {
  assert.ok(typeof reportMd === 'string' && reportMd.length > 0, 'report.md must be non-empty');
  assert.ok(reportMd.includes('# brain:adopt Report'), 'report must have title');
  assert.ok(reportMd.includes('## Summary'), 'report must have Summary section');
  assert.ok(reportMd.includes('## Generic Files'), 'report must have Generic Files section');
  assert.ok(
    reportMd.includes('## Replacements (translations to be adopted from upstream)'),
    'report must have Replacements section',
  );
  assert.ok(reportMd.includes('## Project Files'), 'report must have Project Files section');
  assert.ok(
    reportMd.includes('## Auto-adopted from upstream'),
    'report must have Auto-adopted from upstream section',
  );
});

test('catastro intro.md shows as translation in plan.files and in Replacements section', () => {
  const intro = plan.files.find((f) => f.sourcePath === 'brain/methodology/intro.md');
  assert.ok(intro, 'intro.md must be present in plan.files');
  assert.equal(
    intro.divergenceKind,
    'translation',
    'intro.md must be classified as translation (ES dominant)',
  );
  assert.equal(intro.languageFlag, true, 'intro.md languageFlag must be true');
  assert.equal(intro.classification, 'generic', 'intro.md must be classified generic');

  // Verify the file path appears in the Replacements section of report.md.
  // Split on the Replacements heading; take content before the next h2.
  const afterReplacements = reportMd.split('## Replacements')[1] ?? '';
  const repSection = afterReplacements.split(/\n## /)[0];
  assert.ok(
    repSection.includes('brain/methodology/intro.md'),
    'intro.md must appear under ## Replacements in report.md',
  );
});

test('read-only contract: no consumer file modified and no new file created outside outDir', () => {
  // Every file that existed before run() must have the same mtime after.
  for (const [path, mtime] of Object.entries(consumerMtimesBefore)) {
    assert.equal(
      consumerMtimesAfter[path],
      mtime,
      `consumer file must not be modified by run(): ${path}`,
    );
  }
  // No new files must have been created inside the consumer tree.
  // outDir is a sibling mkdtemp dir, not inside tmpConsumer, so consumer
  // snapshots are unaffected by output writes.
  for (const path of Object.keys(consumerMtimesAfter)) {
    assert.ok(
      path in consumerMtimesBefore,
      `unexpected new file in consumer after run(): ${path}`,
    );
  }
});
