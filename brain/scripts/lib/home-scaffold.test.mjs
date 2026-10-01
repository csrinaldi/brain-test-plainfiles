// home-scaffold.test.mjs — Unit tests for home-scaffold.mjs.
// Run with: npm test  (node --test, no dependencies)
//
// Mirrors lib/brain-config.test.mjs: ensureHome(root) is the create-if-absent,
// never-overwrite contract for brain/HOME.md (install-home-scaffold, REQ-1/REQ-2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ensureHome } from './home-scaffold.mjs';

const TEMPLATE_CONTENT = '# Knowledge Base\n\nTemplate fixture content.\n';

function makeTmpTemplate() {
  const dir = mkdtempSync(join(tmpdir(), 'home-scaffold-tpl-'));
  const templatePath = join(dir, 'HOME.template.md');
  writeFileSync(templatePath, TEMPLATE_CONTENT, 'utf8');
  return { dir, templatePath };
}

function makeTmpRoot() {
  return mkdtempSync(join(tmpdir(), 'home-scaffold-root-'));
}

test('ensureHome: absent brain/HOME.md → created, file written with template content', () => {
  const { dir: tplDir, templatePath } = makeTmpTemplate();
  const root = makeTmpRoot();
  try {
    const result = ensureHome(root, { templatePath });
    assert.deepEqual(result, { created: true });

    const written = readFileSync(join(root, 'brain', 'HOME.md'), 'utf8');
    assert.equal(written, TEMPLATE_CONTENT, 'written file must be byte-verbatim copy of the template');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tplDir, { recursive: true, force: true });
  }
});

test('ensureHome: existing brain/HOME.md with arbitrary content → not created, byte-identical', () => {
  const { dir: tplDir, templatePath } = makeTmpTemplate();
  const root = makeTmpRoot();
  const existingContent = '# Curated HOME\n\nConsumer-owned content, not the template.\n';
  try {
    mkdirSync(join(root, 'brain'), { recursive: true });
    writeFileSync(join(root, 'brain', 'HOME.md'), existingContent, 'utf8');

    const result = ensureHome(root, { templatePath });
    assert.deepEqual(result, { created: false });

    const after = readFileSync(join(root, 'brain', 'HOME.md'), 'utf8');
    assert.equal(after, existingContent, 'existing content must remain byte-for-byte unchanged');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tplDir, { recursive: true, force: true });
  }
});

test('ensureHome: second call on a just-created HOME.md → not created, no rewrite', () => {
  const { dir: tplDir, templatePath } = makeTmpTemplate();
  const root = makeTmpRoot();
  try {
    const first = ensureHome(root, { templatePath });
    assert.deepEqual(first, { created: true });

    const homePath = join(root, 'brain', 'HOME.md');
    const afterFirst = readFileSync(homePath, 'utf8');

    const second = ensureHome(root, { templatePath });
    assert.deepEqual(second, { created: false });

    const afterSecond = readFileSync(homePath, 'utf8');
    assert.equal(afterSecond, afterFirst, 'second call must not rewrite the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tplDir, { recursive: true, force: true });
  }
});

test('ensureHome: write:false (dry run) → does not write, still reports created:true', () => {
  const { dir: tplDir, templatePath } = makeTmpTemplate();
  const root = makeTmpRoot();
  try {
    const result = ensureHome(root, { templatePath, write: false });
    assert.deepEqual(result, { created: true });
    assert.equal(existsSync(join(root, 'brain', 'HOME.md')), false, 'dry run must not write the file');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(tplDir, { recursive: true, force: true });
  }
});
