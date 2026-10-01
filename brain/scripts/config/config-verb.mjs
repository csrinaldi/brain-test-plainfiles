// config-verb.mjs — issue #823: the ONE config verb Compuerta 4 ruled
// (#323, 28/08/2026), first slice. PURE: config, migrations and the target
// version are RECEIVED, never read — `role-port.mjs`'s discipline — so the
// CLI beside this file and #824's discovery verb are two CALLERS of one
// validator, never two validators of one schema.
//
// THE SCHEMA IS THE MIGRATIONS'. `deriveKnownPaths` reads the same `defaults`
// objects `migrateConfig` applies, so a key becomes settable in the same
// commit that declares it, and a hand-written second schema — the
// one-rule-two-implementations defect C4 names — has nowhere to grow. Two
// kinds of knowledge fall out of a defaults tree:
//   · a LEAF ("docs.language": 'en')  → settable exactly, nothing beneath it;
//   · an EMPTY OBJECT ("sdd.map": {}) → an OPEN FAMILY: the migration declares
//     the container and the consumer names the members, so any subpath under
//     it is settable (`sdd.map.<stage>` — the ruled spelling).
// Migration entries that use `migrate()` instead of `defaults` contribute no
// paths — a rename/restructure declares no new settable surface.
//
// MIGRATION BELONGS TO THE VERB (C4, verbatim). `planConfigWrite` runs every
// pending migration BEFORE the write, through `installer.mjs`'s own
// `migrateConfig` — the exact function `brain-upgrade` runs, at a second call
// site, never a re-implementation.

import { migrateConfig } from '../lib/installer.mjs';
import { MEMORY_BACKENDS } from '../memory/lib/backend-resolve.mjs';

// Values a path accepts, checked at WRITE time (#1165): a typo in a selector is refused here,
// not at the next `pull` on another machine. '' is allowed — it clears to undeclared.
const ALLOWED_VALUES = Object.freeze({ 'memory.backend': MEMORY_BACKENDS });

/**
 * Walks every migration's `defaults` tree once.
 * @param {Array<{defaults?: object}>} migrations
 * @returns {{leaves: Set<string>, families: Set<string>}}
 */
export function deriveKnownPaths(migrations) {
  const leaves = new Set();
  const families = new Set();
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
        if (Object.keys(value).length === 0) families.add(path);
        else walk(value, path);
      } else {
        leaves.add(path);
      }
    }
  };
  for (const m of migrations) if (m.defaults) walk(m.defaults, '');
  return { leaves, families };
}

/**
 * Segments the LANGUAGE owns, not the schema (#823 cold review, blocker
 * judgment:cold-1 — reproduced: `set sdd.map.__proto__.polluted true` left
 * `({}).polluted === true`). An open family says "the consumer names the
 * members", and these three names are never the consumer's to give: writing
 * through them mutates Object.prototype — far more than the addressed key —
 * and reading through them walks the prototype chain. One rule, shared by
 * BOTH verbs: `planConfigWrite` refuses loudly (a write is an intent, the
 * operator must hear no), `resolvePath` answers undefined (a read of a path
 * that cannot exist reports absence, exactly as any other missing path does).
 */
const HOSTILE_SEGMENTS = Object.freeze(['__proto__', 'constructor', 'prototype']);
const hostileSegment = (path) => path.split('.').find((seg) => HOSTILE_SEGMENTS.includes(seg)) ?? null;
// A malformed path IS an unknown path (round 2 — reproduced: 'sdd.map..x'
// wrote a '' key with no refusal). Empty segments come from doubled, leading
// or trailing dots; nothing an operator means is spelled that way.
const hasEmptySegment = (path) => path.split('.').some((seg) => seg.length === 0);

/** JSON first, bare string on failure — `set sdd.map.x '{"engine":"plain"}'` and `set docs.language es` both work. */
export function parseValue(raw) {
  try { return JSON.parse(raw); } catch { return String(raw); }
}

/** `get`'s resolver — undefined for a missing path, never a throw. */
export function resolvePath(config, path) {
  if (hostileSegment(path) !== null || hasEmptySegment(path)) return undefined;
  return path.split('.').reduce(
    (node, key) => (node != null && Object.hasOwn(node, key) ? node[key] : undefined),
    config,
  );
}

/** The nearest known family/leaf for a refusal — longest shared prefix wins, then shortest name. */
function nearestKnown(path, known) {
  const all = [...known.leaves, ...known.families];
  const score = (candidate) => {
    let i = 0;
    while (i < Math.min(candidate.length, path.length) && candidate[i] === path[i]) i++;
    return i;
  };
  return all.sort((a, b) => score(b) - score(a) || a.length - b.length)[0] ?? null;
}

/**
 * The ONE write path. Refuses closed on an unknown path; migrates first;
 * writes one value. Never touches I/O.
 *
 * @param {{config: object, path: string, value: string, migrations: Array<object>, targetVersion: string}} args
 * @returns {{next: object|null, migrationsApplied: string[], refusal: string|null}}
 */
export function planConfigWrite({ config, path, value, migrations, targetVersion }) {
  if (hasEmptySegment(path)) {
    return {
      next: null,
      migrationsApplied: [],
      refusal: `config: path '${path}' has an empty segment — refused, nothing written. ` +
        'A doubled, leading or trailing dot spells no key an operator means.',
    };
  }
  const hostile = hostileSegment(path);
  if (hostile !== null) {
    return {
      next: null,
      migrationsApplied: [],
      refusal: `config: path '${path}' contains '${hostile}' — refused, nothing written. ` +
        'That segment is owned by the language, never by the schema: writing through it ' +
        'mutates the prototype chain, not the addressed key.',
    };
  }
  const allowedValues = ALLOWED_VALUES[path];
  if (allowedValues) {
    const v = parseValue(value);
    if (v !== '' && !allowedValues.includes(v)) {
      return {
        next: null,
        migrationsApplied: [],
        refusal: `config: '${path}' must be one of ${allowedValues.join(' | ')} (or "" to clear) — got ${JSON.stringify(v)}. Nothing written.`,
      };
    }
  }

  const known = deriveKnownPaths(migrations);
  const inFamily = [...known.families].some((f) => path.startsWith(`${f}.`));
  if (!known.leaves.has(path) && !inFamily) {
    const near = nearestKnown(path, known);
    return {
      next: null,
      migrationsApplied: [],
      refusal: `config: unknown path '${path}' — refused, nothing written.` +
        (near ? ` Nearest declared path family: '${near}'.` : '') +
        ' A path becomes settable in the migration that declares it (the schema IS the migrations).',
    };
  }

  const { config: migrated, applied } = migrateConfig(config, migrations, targetVersion);

  const next = structuredClone(migrated);
  const keys = path.split('.');
  let node = next;
  for (const key of keys.slice(0, -1)) {
    if (node[key] == null || typeof node[key] !== 'object') node[key] = {};
    node = node[key];
  }
  node[keys[keys.length - 1]] = parseValue(value);

  return { next, migrationsApplied: applied, refusal: null };
}
