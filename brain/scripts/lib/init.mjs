// init.mjs — `npx brain init`: the non-interactive half of onboarding (issue #400).
//
// Why this verb exists at all. `brain:upgrade` merges NINE brain:* aliases into a
// consumer's package.json (MANAGED_SCRIPT_KEYS, managed-paths.mjs), but it cannot
// inject `brain:upgrade` itself: that merge only runs DURING an upgrade, and starting
// one requires the alias to already exist. Exactly one alias is structurally
// un-injectable, and hand-writing it was the manual README step this replaces — the
// repo's own fresh-install fixture encoded that hand-edit before invoking the upgrade.
//
// A `bin` entry breaks the paradox because it runs without any consumer alias.
//
// This module holds the logic; cli-entry.mjs only dispatches to it, so every decision
// below is unit-testable without spawning a process (the fresh-install e2e proves the
// spawned path separately — the two-level discipline installer-journal.integration
// established).

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MANAGED_SCRIPT_KEYS } from '../../core/managed-paths.mjs';
import { mergePackageJsonScripts, installedPackageRoot, PACKAGE_NAME } from './installer.mjs';

/** The one alias `brain:upgrade` can never inject into a consumer — see the header. */
export const BOOTSTRAP_SCRIPT_KEY = 'brain:upgrade';

/**
 * Derived from `PACKAGE_NAME`, never spelled out (issue #628).
 *
 * This string is written into the CONSUMER's package.json, so a stale literal
 * here does not break brain — it breaks somebody else's repository, on the day
 * they run the verb they run to recover.
 */
export const BOOTSTRAP_SCRIPT_VALUE = `node node_modules/${PACKAGE_NAME}/brain/scripts/brain-upgrade.mjs`;

/**
 * Values brain ITSELF wrote as this alias in earlier releases.
 *
 * `writeBootstrapAlias` keeps a consumer-set value, which is the right rule in
 * general and exactly the wrong one for these: they are brain's own previous
 * output, and after the scoped rename they point at a directory npm no longer
 * creates. So a value byte-identical to one of these is migrated; anything else
 * is the consumer's and is kept.
 *
 * A LIST OF LITERALS, NOT A PATTERN, on purpose. A pattern loose enough to catch
 * the next variant is a pattern that will eventually overwrite something a
 * consumer wrote deliberately.
 */
export const LEGACY_BOOTSTRAP_VALUES = Object.freeze([
  'node node_modules/brain/brain/scripts/brain-upgrade.mjs',
]);

/**
 * Resolves the tag to upgrade to from the INSTALLED package (REQ-400-4).
 *
 * `node_modules/brain/package.json`'s `version` is what the consumer actually
 * resolved, so it is the only source that cannot disagree with what is on disk.
 * Reading the dependency SPEC from the consumer's package.json instead would be
 * wrong: `git+https://…#v1.0.0`, `^1.0.0` and a branch ref denote different things
 * and none is guaranteed to be what the package manager installed.
 *
 * Returns `null` rather than a default when unreadable — the caller refuses, because
 * guessing a tag would silently install a version the consumer did not pin.
 *
 * @param {{ root: string, readFile?: (p: string) => string, exists?: (p: string) => boolean }} opts
 * @returns {string|null} e.g. `v1.0.0`
 */
export function resolveInstalledTag({ root, readFile = (p) => readFileSync(p, 'utf8'), exists = existsSync } = {}) {
  const pkgPath = installedPackageRoot(root, 'package.json');
  if (!exists(pkgPath)) return null;
  try {
    const version = JSON.parse(readFile(pkgPath))?.version;
    return typeof version === 'string' && version.length > 0 ? `v${version}` : null;
  } catch { /* swallow-ok: an unreadable or unparseable package.json reads as "no installed tag" — the resolver's documented null */
    return null;
  }
}

/**
 * The two refusals (REQ-400-5), pure so both are testable without a filesystem.
 *
 * - No consumer package.json: nothing to merge into; `npm init -y` is the remedy.
 * - Inside brain's own checkout: the `.brain-source` marker `brain:upgrade` already
 *   honors. `init` would rewrite brain's own scripts.
 *
 * @param {{ hasPackageJson: boolean, isBrainSource: boolean }} input
 * @returns {{ ok: true } | { ok: false, reason: string, remedy: string }}
 */
export function evaluateInitPreconditions({ hasPackageJson, isBrainSource }) {
  if (isBrainSource) {
    return {
      ok: false,
      reason: 'this is the brain SOURCE repo (.brain-source marker found at repo root).',
      remedy: 'brain init is for CONSUMER repos — running it here would rewrite brain\'s own scripts.',
    };
  }
  if (!hasPackageJson) {
    return {
      ok: false,
      reason: 'no package.json found in the current directory.',
      remedy: 'Run `npm init -y` (or your package manager\'s equivalent) first, then re-run `npx brain init`.',
    };
  }
  return { ok: true };
}

/**
 * The verb surface for `--help` (REQ-400-7). `brain:upgrade` is listed FIRST and
 * separately because it is the one this command writes; the rest arrive from the
 * upgrade itself.
 *
 * Also surfaces the `AGENT_PLATFORM` / `plain` escape hatch — the discoverability
 * gap KNOWN-LIMITATIONS records.
 *
 * @returns {string}
 */
export function helpText() {
  const verbs = MANAGED_SCRIPT_KEYS.map((k) => `    ${k}`).join('\n');
  return [
    'brain — AI-assisted development harness',
    '',
    'Usage:',
    '  npx brain init [tag]     Write the bootstrap alias and copy brain into this repo.',
    '  npx brain --help         This message.',
    '',
    'After `init`, run the interactive setup:',
    '  npm run brain:env:init',
    '',
    `Verbs \`init\` makes available (via ${BOOTSTRAP_SCRIPT_KEY}):`,
    `    ${BOOTSTRAP_SCRIPT_KEY}   (written by init — the rest are merged by the upgrade)`,
    verbs,
    '',
    'Environment:',
    '  AGENT_PLATFORM=claude|antigravity|plain   Which harness to emit for.',
    '  Use `plain` for no harness-specific files.',
    '',
  ].join('\n');
}

/**
 * Merges the single bootstrap alias into the consumer's package.json (REQ-400-2/3).
 *
 * Delegates to `mergePackageJsonScripts` — the SAME writer `brain:upgrade` uses for
 * the other nine verbs. One writer, two callers: a second package.json writer here
 * could drift from the first, which is the class `verb-contract-drift-guard` exists
 * to catch elsewhere.
 *
 * Consumer value wins unconditionally, so a consumer who already defines
 * `brain:upgrade` keeps theirs. Writes only when the bytes change.
 *
 * @param {{ pkgPath: string, readFile?: Function, writeFile?: Function }} opts
 * @returns {{ written: boolean, alreadyPresent: boolean }}
 */
export function writeBootstrapAlias({ pkgPath, readFile = (p) => readFileSync(p, 'utf8'), writeFile }) {
  const before = readFile(pkgPath);
  const current = (() => {
    try {
      return JSON.parse(before)?.scripts?.[BOOTSTRAP_SCRIPT_KEY];
    } catch { /* surfaced: an unparseable package.json is re-raised, with the real parse error, by the merge that follows */
      return undefined; // unparseable — let the merge raise the real error below
    }
  })();
  const alreadyPresent = current !== undefined;

  // A stale alias brain itself wrote (issue #628). Rewritten rather than kept,
  // because "keeping your value" protects a CONSUMER's choice, and this is not
  // one — it is brain's own previous output, pointing at a directory npm stopped
  // creating at the scoped rename.
  const isStale = typeof current === 'string'
    && LEGACY_BOOTSTRAP_VALUES.includes(current)
    && current !== BOOTSTRAP_SCRIPT_VALUE;

  if (isStale) {
    const parsed = JSON.parse(before);
    parsed.scripts[BOOTSTRAP_SCRIPT_KEY] = BOOTSTRAP_SCRIPT_VALUE;
    writeFile(pkgPath, `${JSON.stringify(parsed, null, 2)}\n`);
    return { written: true, alreadyPresent, migrated: true, previous: current };
  }

  const after = mergePackageJsonScripts(
    before,
    { [BOOTSTRAP_SCRIPT_KEY]: BOOTSTRAP_SCRIPT_VALUE },
    pkgPath,
  );

  if (after === before) return { written: false, alreadyPresent, migrated: false };
  writeFile(pkgPath, after);
  return { written: true, alreadyPresent, migrated: false };
}
