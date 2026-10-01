// home-scaffold.mjs — Create-if-absent scaffold for brain/HOME.md.
//
// Every consumer that adopts brain gets a brain/HOME.md navigation entry point
// created automatically at brain:env:init, from an agnostic, managed, nav-clean
// template — closing the gap where bootstrap.sh advertises "Read brain/HOME.md"
// but nothing ever creates it (install-home-scaffold, REQ-1/REQ-2).
//
// Contract mirrors ensureBrainConfig: create-if-absent, never overwrite.
//
// Usage:
//   import { ensureHome } from './lib/home-scaffold.mjs';
//   const { created } = ensureHome();

import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..', '..');
const TEMPLATE_PATH = join(dirname(__filename), '..', '..', 'core', 'templates', 'HOME.template.md');

/**
 * Creates brain/HOME.md from the template when absent. Never overwrites an
 * existing brain/HOME.md, regardless of its content — the file is consumer-owned
 * once it exists.
 *
 * Byte-verbatim copy of the template — no token substitution (Decision 1: a
 * project-name placeholder would add a code path and break the byte-identical
 * no-overwrite assertion; nav-correctness needs no project name).
 *
 * Never throws: degrades to a no-op if the target directory is unwritable.
 *
 * @param {string} root - Repository root (defaults to this module's repo root).
 * @param {{ templatePath?: string, write?: boolean }} options
 *   - templatePath: injected template location for testing; defaults to the
 *     real brain/core/templates/HOME.template.md, resolved relative to
 *     import.meta.url (never cwd) so bootstrap.sh and tests agree.
 *   - write: set false to skip writing (dry run). Defaults to true.
 * @returns {{ created: boolean }}
 */
export function ensureHome(root = REPO_ROOT, { templatePath = TEMPLATE_PATH, write = true } = {}) {
  const homePath = join(root, 'brain', 'HOME.md');
  if (existsSync(homePath)) return { created: false };

  const template = readFileSync(templatePath, 'utf8');
  if (write) {
    try {
      mkdirSync(dirname(homePath), { recursive: true });
      writeFileSync(homePath, template, 'utf8');
      // The template advertises where project knowledge goes, and brain/project/**
      // is deliberately NOT a managed path — nothing else creates it. Writing an
      // entry point that cites two directories the consumer does not have is the
      // defect issue #499 opened on, one tense forward: not "this path was true
      // once" but "this path is where you will put your ADRs".
      //
      // .gitkeep, not a README: the orphan rule walks brain/**/*.md, so a markdown
      // file here would be unreachable from HOME.md and turn the gate red again for
      // a different reason. An empty marker keeps the directory through a clone
      // without entering the navigation graph at all.
      mkdirSync(join(root, 'brain', 'project', 'decisions'), { recursive: true });
      writeFileSync(join(root, 'brain', 'project', 'decisions', '.gitkeep'), '', 'utf8');
    } catch {
      return { created: false };
    }
  }
  return { created: true };
}

// Main-module guard: run as `node brain/scripts/lib/home-scaffold.mjs ensure`
if (process.argv[1] === __filename && process.argv[2] === 'ensure') {
  if (ensureHome().created) {
    console.log('  ✓ brain/HOME.md: created from template');
  }
}
