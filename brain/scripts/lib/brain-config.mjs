// brain-config.mjs — Shared loader and writer for brain.config.json.
//
// Reads and parses brain.config.json from the repository root and returns the
// parsed object. All scripts that need project identity values (gitHost,
// gitProjectId, slug, name, etc.) import this instead of duplicating the logic.
//
// Usage:
//   import { loadBrainConfig, ensureProjectIdentity, ensureBrainConfig } from './lib/brain-config.mjs';
//   const config = loadBrainConfig();
//   const { gitHost, gitProjectId, slug, name } = config.project;

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { originIdentity } from '../vcs/lib/repo.mjs';
import { mergeDefaults } from './installer.mjs';
import { migrations, NEW_CONSUMER_DEFAULTS } from '../../core/config-migrations.mjs';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = join(dirname(__filename), '..', '..', '..');
const CONFIG_PATH = join(REPO_ROOT, 'brain.config.json');

/**
 * Loads and returns the parsed brain.config.json from the repository root.
 * Throws a descriptive error if the file is missing or malformed.
 *
 * Classified for the SAME shape gap #975 fixed on `loadBrainConfigOrThrow`
 * (issue #975, Expected item 3) and left UNCHANGED, deliberately: this
 * function has no DENY/exclusion-list caller. Its callers read
 * `governance.ignoreList` (ALLOW/exemption, e.g.
 * `review/evaluators/tranche.mjs:313`), `governance.tier` via
 * `resolveTier()` (a doctrine-ratified fixed fallback, e.g.
 * `vcs/governance-tiers.mjs:520`), or plain status/identity fields with no
 * governance-gate semantics at all (`review/identity.mjs:143,153`,
 * `status/epic-map.mjs:74`, `ticket-new.mjs:76`, `ticket-start.mjs:68`,
 * `day-start.mjs:28`, `archive.mjs:228`, `vcs/cli.mjs:129`). Two call sites
 * (`governance/run-check.mjs:174`, `vcs/phase-order-check.mjs:489`) already
 * wrap the call in `try { … } catch { return {}; }`, so even a raw non-object
 * return degrades to the same `{}` a shape-check throw would produce there.
 * Adding the same shape check here would only change ONE observable case —
 * a top-level `null` no longer crashes on the caller's first unguarded
 * `.` access — for zero DENY-direction benefit, so R8's "keeps throwing on
 * absence and malformation, unchanged" is extended to cover shape too. See
 * `openspec/changes/issue-975-config-shape/proposal.md` for the full
 * caller-by-caller table.
 *
 * @returns {object} The parsed brain.config.json object.
 */
export function loadBrainConfig() {
  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8');
  } catch {
    throw new Error(
      `brain.config.json not found at ${CONFIG_PATH}.\n` +
      'Create it at the repository root with the required project fields.\n' +
      'See brain/project/methodology/developer-environment.md for the expected schema.'
    );
  }
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`brain.config.json is not valid JSON: ${err.message}`);
  }
}

/**
 * True when `value` is a plain JSON object — the only shape every
 * `loadBrainConfigOrThrow` caller can safely optional-chain into
 * (issue #975). `typeof value === 'object'` alone is not enough: it is also
 * true for `null` and for arrays, which is exactly how the shape gap fails
 * open — `null?.governance` and `[].governance` both resolve to
 * `undefined` without throwing, same as `{}.governance`, so a DENY reader
 * downstream cannot tell "the config is a non-object" from "the config has
 * no governance key" and degrades as if it were empty.
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Names a parsed JSON value's shape for the error message (issue #975).
 * `null` and arrays are both `typeof 'object'`, so they are named
 * explicitly before falling back to `typeof` for every other JSON value
 * (`'string'`, `'number'`, `'boolean'`).
 */
function describeJsonType(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/**
 * Loads brain.config.json from `root`, distinguishing ABSENCE from
 * UNREADABILITY (issue #942, R3 — REQ-DENY-1). Mirrors
 * `memory/lib/upstream-records.mjs`'s `loadBrainConfigAt` byte-for-byte in
 * behaviour — the house model, and the only reader in the tree that already
 * made this distinction before this issue.
 *
 * ENOENT is the ONE "there is nothing to read" case, and returns `{}` — a
 * fresh consumer install has no config file, and that must stay green
 * (R11). Every OTHER read failure (a directory in the file's place, a
 * permission error) or any JSON.parse failure is "could not look", and
 * THROWS a named error identifying the file and the failure kind — the
 * parse wrapper says "could not be parsed", never "is not valid JSON",
 * because the wrapped `JSON.parse` message already ends that way (#701 cold
 * review round 2).
 *
 * A THIRD failure kind, added by issue #975: the parse can succeed on JSON
 * that is not a plain object (`null`, an array, a number, a string) — the
 * JSDoc always promised `@returns {object}`, but nothing enforced it. Every
 * caller of this function reads through optional chaining
 * (`config?.governance?.reviewActors`), so a non-object value degrades
 * exactly like `{}` — the #942 class (a DENY/exclusion reader failing open)
 * reached through a shape gap instead of a read/parse failure. The shape
 * check throws a named error identifying the path and the JSON type found,
 * so a DENY-direction caller that does not catch (per its own #942
 * direction) propagates this exactly as it propagates a parse failure.
 *
 * This is NOT a shared deny/allow list and NOT a shared policy function
 * (explicitly rejected — R3's "why"): it shares the READ only. Each caller
 * still handles the throw per its own direction — a deny/exclusion reader
 * propagates it, an allow/exemption reader may still degrade it to `[]`.
 *
 * `loadBrainConfig()` (below) is UNCHANGED (R8, and unchanged again by
 * #975 — see that function's own doc comment for why): it keeps throwing on
 * BOTH absence and malformation for its own callers, which correctly read
 * any throw as "absent". This is a second, additive export for callers
 * that need absence and unreadability to mean different things.
 *
 * @param {string} [root] - Repository root (defaults to this module's repo root).
 * @returns {object} `{}` when brain.config.json is absent; the parsed object otherwise.
 * @throws {Error} when brain.config.json exists but cannot be read, cannot be
 *   parsed, or parses to a JSON value that is not a plain object.
 */
export function loadBrainConfigOrThrow(root = REPO_ROOT) {
  const path = join(root, 'brain.config.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return {};
    throw new Error(`brain.config.json at ${path} could not be read: ${err.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`brain.config.json at ${path} could not be parsed: ${err.message}`);
  }
  if (!isPlainObject(parsed)) {
    throw new Error(`brain.config.json at ${path} must contain a JSON object, got ${describeJsonType(parsed)}`);
  }
  return parsed;
}

/**
 * Fills empty project.gitHost and project.slug in brain.config.json from the
 * git origin. Idempotent: never overwrites non-empty values.
 *
 * Degrades to a no-op if brain.config.json is unreadable or the origin is absent.
 *
 * @param {string} root - Repository root (defaults to this module's repo root).
 * @param {{ identity?: { host: string|null, project: string|null } }} options
 *   - identity: injected origin identity for testing; omit to call originIdentity().
 * @returns {{ filled: string[] }} Names of fields that were written.
 */
export function ensureProjectIdentity(root = REPO_ROOT, { identity } = {}) {
  // Read and parse brain.config.json; degrade to no-op on any error.
  let cfg;
  try {
    const raw = readFileSync(join(root, 'brain.config.json'), 'utf8');
    cfg = JSON.parse(raw);
  } catch {
    return { filled: [] };
  }

  // Resolve origin identity: use injected value when provided, otherwise query git.
  const id = identity !== undefined ? identity : originIdentity();
  if (!id || (!id.host && !id.project)) {
    return { filled: [] };
  }

  if (!cfg.project) cfg.project = {};

  const filled = [];
  if (!cfg.project.gitHost && id.host) {
    cfg.project.gitHost = id.host;
    filled.push('gitHost');
  }
  if (!cfg.project.slug && id.project) {
    cfg.project.slug = id.project;
    filled.push('slug');
  }

  if (filled.length === 0) {
    return { filled: [] };
  }

  writeFileSync(join(root, 'brain.config.json'), JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  return { filled };
}

/**
 * Maps a git host to a VCS provider name.
 *
 * - 'github.com'           → 'github'
 * - any host containing 'gitlab' (e.g. 'gitlab.com', 'gitlab.example.com') → 'gitlab'
 * - anything else          → ''
 *
 * Pure function — no side effects.
 *
 * @param {string|null|undefined} host
 * @returns {string}
 */
export function providerFromHost(host) {
  if (!host) return '';
  if (host === 'github.com') return 'github';
  if (host.includes('gitlab')) return 'gitlab';
  return '';
}

/**
 * Builds the full default brain.config.json by applying all migrations in order
 * onto NEW_CONSUMER_DEFAULTS. Sets schemaVersion to the latest migration version.
 *
 * NEW_CONSUMER_DEFAULTS goes in FIRST (issue #1124): mergeDefaults never
 * overwrites a present value, so the 0.9.0 entry's `standard` — the protection
 * for EXISTING consumers — cannot replace a new consumer's `lite`. Only this
 * function reads it; migrateConfig (brain:upgrade, brain:config) never does.
 *
 * @returns {object}
 */
function buildDefaultConfig() {
  const ordered = [...migrations].sort((a, b) => {
    const va = a.version.split('.').map(Number);
    const vb = b.version.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
      if (va[i] < vb[i]) return -1;
      if (va[i] > vb[i]) return 1;
    }
    return 0;
  });
  let cfg = mergeDefaults({}, NEW_CONSUMER_DEFAULTS);
  for (const m of ordered) {
    if (m.defaults) {
      cfg = mergeDefaults(cfg, m.defaults);
    } else if (typeof m.migrate === 'function') {
      cfg = m.migrate(cfg, { mergeDefaults });
    }
  }
  cfg.schemaVersion = ordered.at(-1)?.version ?? '0.0.0';
  // Deep-clone to avoid mutating the source migration defaults (they are shared
  // references returned by mergeDefaults when keys are first seen). Config values
  // are all primitives, so JSON round-trip is safe and fast.
  return JSON.parse(JSON.stringify(cfg));
}

/**
 * Ensures brain.config.json exists and has project identity fields populated.
 *
 * - If the file DOES NOT EXIST: creates it with the full default schema derived
 *   from all config-migrations, sets project.gitHost / project.slug from the
 *   git origin, and sets vcs.provider via providerFromHost(). Returns
 *   { created: true, filled: string[], provider: string }.
 *
 * - If the file EXISTS: behaves like ensureProjectIdentity — fills empty
 *   gitHost / slug from the origin without touching other values (including
 *   vcs.provider). Returns { created: false, filled: string[], provider: string }.
 *
 * Never throws: degrades to a no-op if the origin is absent or the file is
 * unwritable.
 *
 * @param {string} root - Repository root (defaults to this module's repo root).
 * @param {{ identity?: { host: string|null, project: string|null }, write?: boolean }} options
 *   - identity: injected origin identity for testing; omit to call originIdentity().
 *   - write: set false to skip writing (dry-run). Defaults to true.
 * @returns {{ created: boolean, filled: string[], provider: string }}
 */
export function ensureBrainConfig(root = REPO_ROOT, { identity, write = true } = {}) {
  const configPath = join(root, 'brain.config.json');

  // Resolve origin identity once.
  const id = identity !== undefined ? identity : originIdentity();
  const hasIdentity = id && (id.host || id.project);

  const fileExists = existsSync(configPath);

  if (!fileExists) {
    // CREATE: build full default config from migrations.
    const cfg = buildDefaultConfig();

    const filled = [];
    if (hasIdentity) {
      if (id.host) {
        cfg.project.gitHost = id.host;
        filled.push('gitHost');
      }
      if (id.project) {
        cfg.project.slug = id.project;
        filled.push('slug');
      }
      cfg.vcs.provider = providerFromHost(id.host);
    }

    if (write) {
      try {
        writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      } catch {
        // Unwritable directory — degrade silently.
        return { created: false, filled: [], provider: '' };
      }
    }

    return { created: true, filled, provider: cfg.vcs.provider };
  }

  // EXISTS: fill empty gitHost / slug only (preserve provider and all other values).
  let cfg;
  try {
    const raw = readFileSync(configPath, 'utf8');
    cfg = JSON.parse(raw);
  } catch (err) {
    // Reported, never skipped in silence (#1127): the caller (`ensure`) prints it and exits 1.
    return { created: false, filled: [], provider: '', error: `cannot be read or parsed — ${err.message}` };
  }

  if (!hasIdentity) {
    return { created: false, filled: [], provider: cfg.vcs?.provider ?? '' };
  }

  if (!cfg.project) cfg.project = {};

  const filled = [];
  if (!cfg.project.gitHost && id.host) {
    cfg.project.gitHost = id.host;
    filled.push('gitHost');
  }
  if (!cfg.project.slug && id.project) {
    cfg.project.slug = id.project;
    filled.push('slug');
  }

  if (filled.length > 0 && write) {
    try {
      writeFileSync(configPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
    } catch {
      return { created: false, filled: [], provider: cfg.vcs?.provider ?? '' };
    }
  }

  return { created: false, filled, provider: cfg.vcs?.provider ?? '' };
}

// Main-module guard: run as `node brain/scripts/lib/brain-config.mjs ensure`
if (process.argv[1] === __filename && process.argv[2] === 'ensure') {
  const result = ensureBrainConfig();
  if (result.error) {
    console.error(`  ✗ brain.config.json: ${result.error}`);
    process.exitCode = 1;
  }
  if (result.created) {
    console.log(`  ✓ brain.config.json: created (provider=${result.provider || '?'})`);
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      if (cfg.project?.gitHost)  console.log(`  ✓ brain.config.json: gitHost = ${cfg.project.gitHost}`);
      if (cfg.project?.slug)     console.log(`  ✓ brain.config.json: slug = ${cfg.project.slug}`);
    } catch {}
  } else if (result.filled.length > 0) {
    try {
      const cfg = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
      for (const key of result.filled) {
        const value = key === 'gitHost' ? cfg.project.gitHost : cfg.project.slug;
        console.log(`  ✓ brain.config.json: ${key} = ${value}`);
      }
    } catch {}
  }
  // #1124: the tier line runs on EVERY env:init, created or not — a new consumer
  // is told the tier it was given, an existing one the tier it already has.
  // A dynamic import chained with .then(), NEVER a top-level await: tier-notice.mjs
  // reaches i18n/t.mjs and governance-tiers.mjs, both of which import THIS module.
  // Awaited here, that cycle deadlocks against this module's own unfinished
  // evaluation (measured: "unsettled top-level await", the step exits 13). Chained,
  // it runs after this module has finished evaluating, so the cycle is inert.
  import('./tier-notice.mjs')
    .then(({ printTierNotice }) => printTierNotice({ created: result.created, configPath: CONFIG_PATH }))
    .catch((e) => { console.error(`  ⚠ governance tier: could not report it (${e.message})`); process.exitCode = 1; });
}
