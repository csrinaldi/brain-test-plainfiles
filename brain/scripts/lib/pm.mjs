// brain/scripts/lib/pm.mjs — Package manager detection adapter.
//
// Detects the active package manager for a consumer project root and builds
// consistent install/run argv arrays for the four supported PMs: npm, pnpm,
// yarn classic, and bun.
//
// Detection order (Corepack-first, spec §2):
//   1. package.json → "packageManager" field (Corepack standard, most authoritative)
//   2. Lockfile presence:  pnpm-lock.yaml → pnpm
//                          yarn.lock      → yarn (or yarn Berry guard)
//                          bun.lockb      → bun
//                          package-lock.json → npm
//   3. Fallback: npm (npm consumer path stays byte-identical to pre-change)
//
// Yarn Berry PnP rejection: if yarn.lock + .yarnrc.yml contains `nodeLinker: pnp`,
// detectPM throws a human-readable Error with a workaround hint (spec §3).
//
// CLI subcommand for bash shim:
//   node brain/scripts/lib/pm.mjs name   → prints detected PM name to stdout
//
// Zero external dependencies. Pure Node.js built-ins only.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── PM configuration table ────────────────────────────────────────────────────

/** @typedef {{ name: string, installArgs: string[], runArgs(script: string, silent?: boolean): string[] }} PMConfig */

/**
 * Per-PM configuration constants. Pure: no FS access.
 * @type {Record<string, PMConfig>}
 */
const PM_CONFIGS = {
  npm: {
    name: 'npm',
    installArgs: ['npm', 'install', '-D'],
    runArgs(script, silent = false) {
      return silent
        ? ['npm', 'run', '--silent', script]
        : ['npm', 'run', script];
    },
  },
  pnpm: {
    name: 'pnpm',
    installArgs: ['pnpm', 'add', '-D'],
    runArgs(script, silent = false) {
      return silent
        ? ['pnpm', 'run', '--silent', script]
        : ['pnpm', 'run', script];
    },
  },
  yarn: {
    name: 'yarn',
    installArgs: ['yarn', 'add'],
    // yarn classic: verbose by default; no --silent equivalent injected.
    // Accepted edge case per design (ADR: yarn classic verbose is acceptable).
    runArgs(script) {
      return ['yarn', script];
    },
  },
  bun: {
    name: 'bun',
    installArgs: ['bun', 'add', '-d'],
    // bun: quiet by default; no --silent flag needed.
    runArgs(script) {
      return ['bun', 'run', script];
    },
  },
};

/**
 * Returns the PMConfig for a given package manager name. Pure: no FS access.
 * Throws if the name is not one of npm | pnpm | yarn | bun.
 *
 * @param {string} name
 * @returns {PMConfig}
 */
export function getPMConfig(name) {
  const cfg = PM_CONFIGS[name];
  if (!cfg) {
    throw new Error(
      `Unsupported package manager: "${name}". Supported: npm, pnpm, yarn, bun.`,
    );
  }
  return cfg;
}

/**
 * Returns the pnpm PMConfig, appending `-w` to installArgs when `root` is a
 * pnpm workspace root (pnpm-workspace.yaml present). `pnpm add` on a
 * workspace root aborts with ERR_PNPM_ADDING_TO_ROOT unless `-w` /
 * `--workspace-root` is passed; non-workspace pnpm must NOT get `-w` (it
 * would itself error there).
 *
 * @param {string} root
 * @returns {PMConfig}
 */
function getPnpmConfig(root) {
  const base = getPMConfig('pnpm');
  if (!existsSync(join(root, 'pnpm-workspace.yaml'))) {
    return base;
  }
  return {
    ...base,
    installArgs: [...base.installArgs, '-w'],
  };
}

// ── Detection helpers ─────────────────────────────────────────────────────────

/**
 * Reads the `packageManager` field from package.json at root.
 * Returns null if absent or unparseable.
 *
 * @param {string} root
 * @returns {string|null}  e.g. "pnpm@8.0.0" → "pnpm"
 */
function readPackageManagerField(root) {
  const pkgPath = join(root, 'package.json');
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
    const field = pkg?.packageManager;
    if (typeof field === 'string' && field.trim()) {
      // "pnpm@8.0.0" → "pnpm"
      return field.split('@')[0].trim();
    }
  } catch {
    // Malformed JSON — fall through to lockfile detection.
  }
  return null;
}

/**
 * Checks for yarn Berry PnP mode. Returns true if .yarnrc.yml declares
 * `nodeLinker: pnp`, otherwise false.
 *
 * @param {string} root
 * @returns {boolean}
 */
function isYarnBerryPnP(root) {
  const rcPath = join(root, '.yarnrc.yml');
  if (!existsSync(rcPath)) return false;
  try {
    const content = readFileSync(rcPath, 'utf8');
    // Match `nodeLinker: pnp` (YAML, possibly with extra whitespace).
    return /^\s*nodeLinker\s*:\s*pnp\s*$/m.test(content);
  } catch {
    return false;
  }
}

/**
 * Detects the package manager used in the given project root.
 *
 * Detection order:
 *   1. package.json `packageManager` field (Corepack standard)
 *   2. Lockfile: pnpm-lock.yaml → pnpm | yarn.lock → yarn | bun.lockb → bun | package-lock.json → npm
 *   3. Fallback: npm
 *
 * @param {string} [root=process.cwd()]
 * @returns {PMConfig}
 * @throws {Error} when yarn Berry PnP is detected (unsupported; see error message for workaround)
 */
export function detectPM(root = process.cwd()) {
  // 1. Corepack `packageManager` field wins.
  const fieldName = readPackageManagerField(root);
  if (fieldName) {
    if (!PM_CONFIGS[fieldName]) {
      // Unknown PM declared in packageManager — fall through to lockfile detection.
    } else if (fieldName === 'pnpm') {
      return getPnpmConfig(root);
    } else {
      return getPMConfig(fieldName);
    }
  }

  // 2. Lockfile detection — priority order per spec: pnpm → yarn → bun → npm.
  if (existsSync(join(root, 'pnpm-lock.yaml'))) {
    return getPnpmConfig(root);
  }

  if (existsSync(join(root, 'yarn.lock'))) {
    // Yarn Berry PnP guard: .yarnrc.yml with `nodeLinker: pnp` → unsupported.
    if (isYarnBerryPnP(root)) {
      throw new Error(
        'Yarn Berry PnP (Plug\'n\'Play) is not supported by brain.\n' +
        'brain requires a node_modules layout to function correctly.\n' +
        'Workaround: set `nodeLinker: node-modules` in .yarnrc.yml, or\n' +
        'switch to npm, pnpm, or bun.',
      );
    }
    return getPMConfig('yarn');
  }

  if (existsSync(join(root, 'bun.lockb'))) {
    return getPMConfig('bun');
  }

  if (existsSync(join(root, 'package-lock.json'))) {
    return getPMConfig('npm');
  }

  // 3. Fallback: npm (no signals found — greenfield or non-standard layout).
  return getPMConfig('npm');
}

// ── CLI subcommand ────────────────────────────────────────────────────────────
// Usage: node brain/scripts/lib/pm.mjs name
// Prints the detected PM name to stdout. Used by bootstrap.sh via:
//   PM=$(node brain/scripts/lib/pm.mjs name 2>/dev/null || echo npm)

if (process.argv[2] === 'name') {
  try {
    const { name } = detectPM(process.cwd());
    process.stdout.write(name + '\n');
  } catch (err) {
    process.stderr.write(`pm.mjs: ${err.message}\n`);
    process.exit(1);
  }
}
