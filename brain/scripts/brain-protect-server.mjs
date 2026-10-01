#!/usr/bin/env node
// brain-protect-server.mjs — Install the pre-receive hook into a bare git repository.
//
// Copies brain/scripts/hooks/pre-receive into <bare-repo-path>/hooks/pre-receive
// and sets the file mode to 0755, making it executable.
//
// USAGE: npm run brain:protect-server -- /path/to/repo.git
//
// Validates that the target path is a git repository before installing.
// Performs NO action on import — the installation runs only when invoked as a CLI
// (the guard at the bottom). Importing this module is side-effect-free.

import { copyFileSync, chmodSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Install the pre-receive hook into a bare git repository.
 *
 * @param {string} bareRepoPath - Absolute or relative path to the bare git repo.
 * @returns {{ success: boolean, message: string }}
 */
export function installPreReceiveHook(bareRepoPath, { force = false } = {}) {
  if (!bareRepoPath) {
    return {
      success: false,
      message: 'Usage: brain:protect-server <bare-repo-path> [--force]',
    };
  }

  const repoPath = resolve(bareRepoPath);

  // Validate that the target is a git repository.
  const check = spawnSync('git', ['-C', repoPath, 'rev-parse', '--git-dir'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (check.status !== 0) {
    return {
      success: false,
      message: `brain:protect-server: "${repoPath}" is not a git repository (or does not exist).`,
    };
  }

  // Must be a BARE repo: a pre-receive hook under a non-bare repo's hooks/ dir is
  // never executed by git, so installing there would be silently useless. Point
  // this at the server-side repo.git, not a working clone.
  const bare = spawnSync('git', ['-C', repoPath, 'rev-parse', '--is-bare-repository'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (bare.stdout.trim() !== 'true') {
    return {
      success: false,
      message: `brain:protect-server: "${repoPath}" is not a bare repository — pre-receive only runs on the server-side bare repo (repo.git).`,
    };
  }

  const hookSrc = resolve(__dirname, 'hooks', 'pre-receive');
  const hooksDir = join(repoPath, 'hooks');
  const hookDst = join(hooksDir, 'pre-receive');

  // Refuse to silently clobber an existing pre-receive hook (it may be another
  // governance gate). The operator must opt in with --force.
  if (existsSync(hookDst) && !force) {
    return {
      success: false,
      message: `brain:protect-server: a pre-receive hook already exists at ${hookDst}. Re-run with --force to overwrite it.`,
    };
  }

  try {
    mkdirSync(hooksDir, { recursive: true });
    copyFileSync(hookSrc, hookDst);
    chmodSync(hookDst, 0o755);
  } catch (e) {
    return {
      success: false,
      message: `brain:protect-server: failed to install hook — ${e.message}`,
    };
  }

  return {
    success: true,
    message: `brain:protect-server: pre-receive hook installed at ${hookDst}`,
  };
}

// CLI guard — installation runs ONLY when this file is invoked directly
// (`node brain/scripts/brain-protect-server.mjs` / `npm run brain:protect-server`),
// NEVER on import.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const bareRepoPath = args.find((a) => !a.startsWith('--'));
  const result = installPreReceiveHook(bareRepoPath, { force });
  console.log(result.message);
  if (!result.success) process.exit(1);
}
