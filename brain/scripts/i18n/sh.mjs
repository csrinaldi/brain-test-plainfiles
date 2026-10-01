// brain/scripts/i18n/sh.mjs — Emit sourceable shell variable assignments for the active locale.
//
// When run as a script, prints eval-able shell assignments for every key in
// en.mjs, using the active locale (brain.config.json docs.language) with
// English fallback applied per-key.
//
// Usage in shell scripts:
//   eval "$(node brain/scripts/i18n/sh.mjs)"
//   printf "$I18N_DAY_AUTH_OK\n" "$user" "$provider"
//
// Key conversion: 'day.auth.ok' → 'I18N_DAY_AUTH_OK'
// Placeholder conversion: '{placeholder}' → '%s' (positional, for printf)
//
// Exported pure functions (keyToVar, templateToShell, renderCatalog) are the
// testable core; the main-module guard at the bottom calls them when run directly.

import { fileURLToPath } from 'node:url';
import en from './en.mjs';
import { loadBrainConfig } from '../lib/brain-config.mjs';

/**
 * Convert a dotted i18n key to a shell variable name.
 *
 * @example keyToVar('day.auth.ok') → 'I18N_DAY_AUTH_OK'
 * @param {string} key
 * @returns {string}
 */
export function keyToVar(key) {
  return 'I18N_' + key.replace(/\./g, '_').toUpperCase();
}

/**
 * Replace {placeholder} slots with positional %s for shell printf.
 * Order matches the order of slots in the template string (documented per key).
 *
 * @example templateToShell('Hello {name}') → 'Hello %s'
 * @param {string} tpl
 * @returns {string}
 */
export function templateToShell(tpl) {
  return tpl.replace(/\{(\w+)\}/g, '%s');
}

/**
 * Merge the active-locale catalog over the English fallback (per-key) and
 * render shell variable assignments — one per line.
 *
 * Output format:  VARNAME='value with %s placeholders'
 * Single-quoted so the shell never expands $vars or backslashes inside.
 * Any literal single-quote in a value is safely escaped as '\''.
 *
 * @param {Record<string, string>} cat          - active locale catalog
 * @param {Record<string, string>} fallbackCat  - English catalog (all keys)
 * @returns {string} newline-separated shell assignments
 */
export function renderCatalog(cat, fallbackCat) {
  const lines = [];
  for (const [key, englishTpl] of Object.entries(fallbackCat)) {
    const activeTpl = cat[key] ?? englishTpl; // per-key fallback
    const varName = keyToVar(key);
    const shellValue = templateToShell(activeTpl).replace(/'/g, "'\\''"); // escape '
    lines.push(`${varName}='${shellValue}'`);
  }
  return lines.join('\n');
}

// ── Main: only runs when this file is the entry point ─────────────────────────
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  let cat = {};
  try {
    const config = loadBrainConfig();
    const lang = config.docs?.language || 'en';
    if (lang && lang !== 'en') {
      try {
        const mod = await import(`./${lang}.mjs`);
        cat = mod.default;
      } catch {
        // Unknown locale — stay with English fallback for every key.
      }
    }
  } catch {
    // brain.config.json not found — use English everywhere.
  }
  process.stdout.write(renderCatalog(cat, en) + '\n');
}
