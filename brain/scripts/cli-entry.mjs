#!/usr/bin/env node
// cli-entry.mjs — the `bin` entry (issue #400). `npx brain <subcommand>`.
//
// This file DISPATCHES; it does not implement. Every decision lives in lib/init.mjs so
// it is unit-testable without spawning a process, while test/fresh-install proves the
// spawned path end-to-end on all four package managers.
//
// It exists because `brain:upgrade` is the one alias the upgrade cannot inject into a
// consumer (see lib/init.mjs's header) — a `bin` entry runs without any alias, which is
// what breaks that bootstrap paradox. NOT a postinstall/prepare hook: those break pnpm
// on git deps (#86), which is why the ticket specifies an explicit verb.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BOOTSTRAP_SCRIPT_KEY,
  evaluateInitPreconditions,
  helpText,
  resolveInstalledTag,
  writeBootstrapAlias,
} from './lib/init.mjs';
import { installedPackageRoot, describeInstalledPackageSearch } from './lib/installer.mjs';

/**
 * `init` — write the bootstrap alias, then delegate to the real upgrade.
 *
 * Deliberately stops before `brain:env:init` (REQ-400-6): `bootstrap.sh` is
 * interactive, and chaining it would hang in CI or a TTY-less container — the very
 * environments an adoption script runs in. `init` is the NON-INTERACTIVE half of
 * onboarding and reports the next step instead of running it.
 *
 * @returns {number} exit code
 */
export function runInit({
  root = process.cwd(),
  argTag = null,
  log = console.log,
  error = console.error,
  spawn = spawnSync,
  exists = existsSync,
  readFile = (p) => readFileSync(p, 'utf8'),
  writeFile = writeFileSync,
} = {}) {
  const pkgPath = join(root, 'package.json');
  const pre = evaluateInitPreconditions({
    hasPackageJson: exists(pkgPath),
    isBrainSource: exists(join(root, '.brain-source')),
  });
  if (!pre.ok) {
    error(`brain init: refusing to run — ${pre.reason}`);
    error(`  ${pre.remedy}`);
    return 1;
  }

  const tag = argTag ?? resolveInstalledTag({ root, exists, readFile });
  if (!tag) {
    // Names every place `resolveInstalledTag` actually probed — see #625.
    error(`brain init: refusing to run — could not read the installed brain version from ${describeInstalledPackageSearch({ rest: ['package.json'] })}.`);
    error('  Install brain first (see README), or pass the tag explicitly: `npx brain init v1.0.0`.');
    error('  Never guessed: a default tag would install a version you did not pin.');
    return 1;
  }

  const { written, alreadyPresent } = writeBootstrapAlias({ pkgPath, readFile, writeFile });
  if (alreadyPresent) {
    log(`brain init: ${BOOTSTRAP_SCRIPT_KEY} already defined — keeping your value.`);
  } else if (written) {
    log(`brain init: added ${BOOTSTRAP_SCRIPT_KEY} to package.json.`);
  }

  log(`brain init: copying managed paths at ${tag} …`);
  const r = spawn(
    process.execPath,
    [installedPackageRoot(root, 'brain', 'scripts', 'brain-upgrade.mjs'), tag],
    { cwd: root, stdio: 'inherit' },
  );
  // Exit honestly (REQ-400-8): a scripted adoption must not report success over a
  // failed install.
  if (r.status !== 0) {
    error(`brain init: the upgrade failed (exit ${r.status ?? 'signal'}). Nothing further was run.`);
    return r.status === null ? 1 : r.status;
  }

  log('');
  log('brain init: done. Next (interactive):');
  log('  npm run brain:env:init');
  return 0;
}

/** @returns {number} exit code */
export function main(argv = process.argv.slice(2), deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const [sub, ...rest] = argv;

  if (sub === undefined || sub === '--help' || sub === '-h' || sub === 'help') {
    log(helpText());
    return 0;
  }
  if (sub === 'init') {
    return runInit({ ...deps, argTag: rest.find((a) => !a.startsWith('-')) ?? null, log, error });
  }

  error(`brain: unknown command "${sub}".`);
  error(helpText());
  return 1;
}

// Entry guard — MUST resolve symlinks. A package manager installs a `bin` as a
// symlink (`node_modules/.bin/brain` -> the real file), so `process.argv[1]` is the
// LINK while `import.meta.url` is the RESOLVED path. Comparing them unresolved is
// always false, which made the command exit 0 printing nothing — the only way it is
// ever invoked in production. Every unit test imports `main` directly and so cannot
// see this; it was caught by installing brain into a scratch consumer repo.
function isDirectInvocation() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch { /* swallow-ok: an argv[1] that cannot be resolved is not a direct invocation of this file (REPL, -e, stdin) */
    return false;
  }
}

if (isDirectInvocation()) {
  process.exit(main());
}
