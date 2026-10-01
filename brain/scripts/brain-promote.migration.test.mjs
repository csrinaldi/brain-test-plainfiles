// brain-promote.migration.test.mjs — issue #809: the migration arm, driven
// through runPromote's seams against a TEMP world (its own package.json, its
// own config-migrations.mjs) — the repo's real migration list is never the
// oracle here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { CONFIRMATION_WORD, runPromote } from './brain-promote.mjs';

const MIGRATIONS_FILE = `// fixture
export const migrations = [
  {
    version: '0.1.0',
    description: 'first',
    defaults: { docs: { language: 'en' } },
  },
];
`;

const DRAFT = `# Draft: sdd.engines

prose the human reads

\`\`\`brain-migration/1
${JSON.stringify({ version: '1.4.0', description: 'Add sdd.engines.', defaults: { sdd: { engines: {} } } }, null, 2)}
\`\`\`
`;

function world(t, { migrationsFile = MIGRATIONS_FILE, draft = DRAFT } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-809-'));
  t.after(() => removeTempTree(root));
  // The write-precondition guard reads `git status` — the world must BE a repo.
  spawnSync('git', ['init', '-q'], { cwd: root });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '1.1.0' }) + '\n');
  mkdirSync(join(root, 'brain/core'), { recursive: true });
  writeFileSync(join(root, 'brain/core/config-migrations.mjs'), migrationsFile);
  mkdirSync(join(root, 'openspec/changes/x/brain-drafts'), { recursive: true });
  writeFileSync(join(root, 'openspec/changes/x/brain-drafts/config-migrations-1.4.0.md'), draft);
  return root;
}

const drive = (root, { answer = CONFIRMATION_WORD } = {}) => runPromote({
  argv: ['openspec/changes/x/brain-drafts/config-migrations-1.4.0.md'],
  isTTY: true,
  root,
  readLineFn: async () => answer,
  gitUserNameFn: () => 'Test Human',
  stageFn: (paths) => { drive.staged = paths; return { status: 0, stdout: '' }; },
  write: () => {},
});

test('#809: the happy path — renumber shown, entry spliced, file staged', async (t) => {
  const root = world(t);
  drive.staged = null;
  const r = await drive(root);
  assert.equal(r.exitCode, 0, r.output);
  assert.match(r.output, /1\.4\.0.*promoting as 1\.2\.0|draft says 1\.4\.0/s, 'the renumber happens in the open');
  const next = readFileSync(join(root, 'brain/core/config-migrations.mjs'), 'utf8');
  assert.match(next, /version: "1\.2\.0"/, 'the COMPUTED number lands, never the draft\'s');
  assert.match(next, /sdd/, 'the defaults landed');
  assert.ok(next.indexOf('"1.2.0"') > next.indexOf("'0.1.0'"), 'appended after the tail');
  assert.ok(drive.staged?.some((p) => p.includes('config-migrations.mjs')), 'the write is staged, the commit stays human');
});

test('#809: declining leaves the tree byte-untouched', async (t) => {
  const root = world(t);
  const before = readFileSync(join(root, 'brain/core/config-migrations.mjs'), 'utf8');
  const r = await drive(root, { answer: 'nope' });
  assert.equal(r.exitCode, 1);
  assert.equal(readFileSync(join(root, 'brain/core/config-migrations.mjs'), 'utf8'), before);
});

test('#809 D3: a candidate that cannot PROVE itself refuses before the plan is offered', async (t) => {
  // Syntactically valid file whose import throws (spread of a const defined
  // after use) — the splice succeeds textually, the proof must catch it.
  const broken = `export const migrations = [\n  ...LATER,\n];\nconst LATER = [];\n`;
  const root = world(t, { migrationsFile: broken });
  const r = await drive(root);
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /prove|proof|import|Cannot access/i, 'the refusal shows the proof failure');
  assert.equal(readFileSync(join(root, 'brain/core/config-migrations.mjs'), 'utf8'), broken, 'untouched');
});

test('#809 (review r1): the verb PROMOTES a description carrying apostrophes — the backlog is real prose, not fixture prose', async (t) => {
  const draft = DRAFT.replace('Add sdd.engines.', "Add sdd.engines: distinguishable from 'interrogated and declared nothing' — the inhabitant's own words.");
  const root = world(t, { draft });
  const r = await drive(root);
  assert.equal(r.exitCode, 0, r.output);
  const next = readFileSync(join(root, 'brain/core/config-migrations.mjs'), 'utf8');
  assert.match(next, /inhabitant/, 'the apostrophe prose landed');
});

test('#809: a malformed draft refuses with the parser\'s own sentence', async (t) => {
  const root = world(t, { draft: '# Draft with no block\n' });
  const r = await drive(root);
  assert.equal(r.exitCode, 1);
  assert.match(r.output, /brain-migration\/1/);
});

test('#842: the D3 proof dir dies with the proof — success AND refusal leave tmpdir clean', async (t) => {
  const proofDirs = () => readdirSync(tmpdir()).filter((n) => n.startsWith('brain-promote-proof-'));
  const before = proofDirs();

  // Success path: the proof imports, the plan is offered, the entry lands.
  const okRoot = world(t);
  const ok = await drive(okRoot);
  assert.equal(ok.exitCode, 0, ok.output);

  // Refusal path: the proof import throws — the catch used to be the leak.
  const broken = `export const migrations = [\n  ...LATER,\n];\nconst LATER = [];\n`;
  const badRoot = world(t, { migrationsFile: broken });
  const bad = await drive(badRoot);
  assert.equal(bad.exitCode, 1);

  assert.deepEqual(proofDirs(), before, 'no brain-promote-proof-* dir survives either path');
});
