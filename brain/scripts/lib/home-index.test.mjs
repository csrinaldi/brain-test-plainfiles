// home-index.test.mjs — Unit tests for home-index.mjs.
// Run with: npm test  (node --test, no dependencies)
//
// Model: lib/branch-type.test.mjs (pure-fn tests). insertAdrLink(homeText, adr)
// is a pure string→string function; the CLI (spawned below) is the only I/O
// layer (install-home-scaffold, REQ-1 through REQ-4 of home-index spec).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { insertAdrLink } from './home-index.mjs';

const LIB_DIR = dirname(fileURLToPath(import.meta.url));
const CLI_PATH = join(LIB_DIR, 'home-index.mjs');

// ── Pure function: insertAdrLink ─────────────────────────────────────────────

test('insertAdrLink: empty section (heading present, no ADR lines) → inserts immediately after heading', () => {
  const home = [
    '# Knowledge Base',
    '',
    '## Project knowledge',
    '',
    '### Architecture decisions',
    '',
    '---',
    '',
    '> footer',
    '',
  ].join('\n');

  const result = insertAdrLink(home, { number: 1, slug: 'adr-0001-example', description: 'Example: decision' });

  assert.equal(result.inserted, true);
  assert.equal(result.reason, undefined);
  const lines = result.text.split('\n');
  const headingIdx = lines.indexOf('### Architecture decisions');
  assert.equal(
    lines[headingIdx + 1],
    '- [ADR-0001](project/decisions/adr-0001-example.md) — Example: decision',
    'new link must be immediately after the heading line',
  );
});

test('insertAdrLink: section has existing ADR links → inserts after the LAST one, prior lines unchanged', () => {
  const home = [
    '### Architecture decisions',
    '',
    '- [ADR-0001](project/decisions/adr-0001-a.md) — First',
    '- [ADR-0002](project/decisions/adr-0002-b.md) — Second',
    '',
    '---',
  ].join('\n');

  const result = insertAdrLink(home, { number: 3, slug: 'adr-0003-c', description: 'Third' });

  assert.equal(result.inserted, true);
  const lines = result.text.split('\n');
  assert.equal(lines[2], '- [ADR-0001](project/decisions/adr-0001-a.md) — First', 'prior line 1 unchanged');
  assert.equal(lines[3], '- [ADR-0002](project/decisions/adr-0002-b.md) — Second', 'prior line 2 unchanged');
  assert.equal(
    lines[4],
    '- [ADR-0003](project/decisions/adr-0003-c.md) — Third',
    'new link inserted immediately after the last existing link',
  );
});

test('insertAdrLink: heading absent → fail-safe, input untouched, linesToAdd reported', () => {
  const home = ['# Knowledge Base', '', 'No architecture decisions section in this HOME.md.', ''].join('\n');

  const result = insertAdrLink(home, { number: 1, slug: 'adr-0001-x', description: 'X: detail' });

  assert.equal(result.text, home, 'input text must be returned completely unchanged');
  assert.equal(result.inserted, false);
  assert.equal(result.reason, 'anchor-not-found');
  assert.deepEqual(result.linesToAdd, ['- [ADR-0001](project/decisions/adr-0001-x.md) — X: detail']);
});

test('insertAdrLink: re-inserting an already-present ADR link → no-op, no duplicate', () => {
  const home = [
    '### Architecture decisions',
    '',
    '- [ADR-0003](project/decisions/adr-0003-c.md) — Third',
    '',
    '---',
  ].join('\n');

  const result = insertAdrLink(home, { number: 3, slug: 'adr-0003-c', description: 'Third' });

  assert.equal(result.text, home, 'text must be identical to the input — no duplicate line');
  assert.equal(result.inserted, false);
  assert.equal(result.reason, 'already-present');
});

test('insertAdrLink: CRLF HOME.md with empty section → inserts correctly, CRLF preserved', () => {
  const home = [
    '# Knowledge Base',
    '',
    '### Architecture decisions',
    '',
    '---',
    '',
  ].join('\r\n');

  const result = insertAdrLink(home, { number: 1, slug: 'adr-0001-example', description: 'Example: decision' });

  assert.equal(result.inserted, true, 'must insert, not anchor-not-found');
  assert.equal(result.reason, undefined);
  assert.ok(!result.text.includes('\n\n'.replace('\r', '')), 'sanity: text is non-empty');
  // No lone LF: every \n in the output must be immediately preceded by \r.
  assert.doesNotMatch(result.text.replace(/\r\n/g, ''), /\n/, 'output must not contain converted/mixed LF-only newlines');
  assert.match(result.text, /\r\n/, 'output must preserve CRLF line endings');
  const lines = result.text.split('\r\n');
  const headingIdx = lines.indexOf('### Architecture decisions');
  assert.equal(
    lines[headingIdx + 1],
    '- [ADR-0001](project/decisions/adr-0001-example.md) — Example: decision',
    'new link must be immediately after the heading line',
  );
});

test('insertAdrLink: heading with trailing space is still matched', () => {
  const home = [
    '# Knowledge Base',
    '',
    '### Architecture decisions ',
    '',
    '---',
    '',
  ].join('\n');

  const result = insertAdrLink(home, { number: 1, slug: 'adr-0001-example', description: 'Example: decision' });

  assert.equal(result.inserted, true, 'heading with trailing space must still be recognized as the anchor');
  assert.equal(result.reason, undefined);
});

test('insertAdrLink: ambiguous anchor (heading appears twice) → fail-safe, input untouched', () => {
  const home = [
    '### Architecture decisions',
    '',
    '---',
    '',
    '### Architecture decisions',
    '',
    '---',
  ].join('\n');

  const result = insertAdrLink(home, { number: 1, slug: 'adr-0001-x', description: 'X' });

  assert.equal(result.text, home);
  assert.equal(result.inserted, false);
  assert.equal(result.reason, 'anchor-ambiguous');
  assert.deepEqual(result.linesToAdd, ['- [ADR-0001](project/decisions/adr-0001-x.md) — X']);
});

// ── CLI (I/O only) ────────────────────────────────────────────────────────────

function makeTmpHome(content) {
  const dir = mkdtempSync(join(tmpdir(), 'home-index-cli-'));
  const homePath = join(dir, 'HOME.md');
  writeFileSync(homePath, content, 'utf8');
  return { dir, homePath };
}

test('CLI: insert patches the file and exits 0', (t) => {
  const { dir, homePath } = makeTmpHome(
    ['### Architecture decisions', '', '---', ''].join('\n'),
  );
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = spawnSync('node', [
    CLI_PATH, 'insert',
    '--home', homePath,
    '--number', '7',
    '--slug', 'adr-0007-x',
    '--desc', 'X: detail',
  ], { encoding: 'utf8' });

  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /HOME\.md patched: inserted ADR-0007/);
  const after = readFileSync(homePath, 'utf8');
  assert.match(after, /- \[ADR-0007\]\(project\/decisions\/adr-0007-x\.md\) — X: detail/);
});

test('CLI: already-indexed ADR → exit 0, no-op notice, no duplicate write', (t) => {
  const original = [
    '### Architecture decisions',
    '',
    '- [ADR-0007](project/decisions/adr-0007-x.md) — X: detail',
    '',
    '---',
    '',
  ].join('\n');
  const { dir, homePath } = makeTmpHome(original);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = spawnSync('node', [
    CLI_PATH, 'insert',
    '--home', homePath,
    '--number', '7',
    '--slug', 'adr-0007-x',
    '--desc', 'X: detail',
  ], { encoding: 'utf8' });

  assert.equal(r.status, 0, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stdout, /already indexed/);
  const after = readFileSync(homePath, 'utf8');
  assert.equal(after, original, 'file must be byte-identical — no duplicate line written');
});

test('CLI: fail-safe when anchor is absent → exit 3, file untouched, linesToAdd printed', (t) => {
  const original = ['# Knowledge Base', '', 'No architecture section here.', ''].join('\n');
  const { dir, homePath } = makeTmpHome(original);
  t.after(() => rmSync(dir, { recursive: true, force: true }));

  const r = spawnSync('node', [
    CLI_PATH, 'insert',
    '--home', homePath,
    '--number', '9',
    '--slug', 'adr-0009-y',
    '--desc', 'Y: detail',
  ], { encoding: 'utf8' });

  assert.equal(r.status, 3, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /ABORTED/);
  assert.match(r.stderr, /- \[ADR-0009\]\(project\/decisions\/adr-0009-y\.md\) — Y: detail/);
  const after = readFileSync(homePath, 'utf8');
  assert.equal(after, original, 'HOME.md must be left completely untouched on fail-safe');
});

test('CLI: --home points at a nonexistent file → exit 1, clean stderr message naming the path, no stack trace', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'home-index-cli-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const missingPath = join(dir, 'does-not-exist.md');

  const r = spawnSync('node', [
    CLI_PATH, 'insert',
    '--home', missingPath,
    '--number', '9',
    '--slug', 'adr-0009-y',
    '--desc', 'Y: detail',
  ], { encoding: 'utf8' });

  assert.equal(r.status, 1, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.ok(r.stderr.includes(missingPath), 'stderr must name the offending path');
  assert.doesNotMatch(r.stderr, /Error:/, 'stderr must not contain a raw Error: stack-trace prefix');
  assert.doesNotMatch(r.stderr, /at Object\.<anonymous>/, 'stderr must not contain a Node.js stack trace');
});

test('CLI: missing required arg → exit 2, usage message', (t) => {
  const r = spawnSync('node', [
    CLI_PATH, 'insert',
    '--number', '9',
    '--slug', 'adr-0009-y',
    '--desc', 'Y: detail',
  ], { encoding: 'utf8' });

  assert.equal(r.status, 2, `stdout:\n${r.stdout}\nstderr:\n${r.stderr}`);
  assert.match(r.stderr, /Usage:/);
});
