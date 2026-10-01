// brain/scripts/i18n/t.mjs — i18n resolver for brain CLI scripts.
//
// Usage:
//   import { t } from './i18n/t.mjs';
//   console.log(await t('common.none'));
//   console.log(await t('day.auth.ok', { user: 'alice', provider: 'github' }));
//
// Active locale is read from brain.config.json `docs.language` (ADR-0009),
// defaulting to 'en'. The locale catalog is lazily imported and cached.
// Per-key English fallback: any key absent from the active catalog resolves
// from en.mjs. A key absent from both catalogs returns the key string itself.
// Never throws.

import en from './en.mjs';
import { loadBrainConfig } from '../lib/brain-config.mjs';

function activeLang() {
  try { return loadBrainConfig().docs?.language || 'en'; } catch { return 'en'; }
}

let _cat = null; // cached ambient-locale catalog (populated on first ambient call to t)

/**
 * Loads the catalog for an EXPLICIT locale. English (or empty/unknown) → `{}`.
 * Never reads or writes the module-level ambient cache — an explicit locale
 * resolves fresh and deterministically. Used for caller-chosen locales
 * (e.g. `resolveSessionStrings`) and for hermetic tests that must not depend
 * on the ambient `brain.config.json`.
 *
 * @param {string} [lang]
 * @returns {Promise<Record<string, string>>}
 */
export async function loadCatalog(lang) {
  if (!lang || lang === 'en') return {};
  try {
    return (await import(`./${lang}.mjs`)).default;
  } catch {
    // Unknown locale or missing file — fall back to English for all keys.
    return {};
  }
}

async function catalog(lang) {
  // Explicit locale → deterministic, uncached (bypasses the ambient singleton).
  if (lang !== undefined) return loadCatalog(lang);
  // Ambient locale → resolve once from brain.config.json and cache for the process.
  if (_cat !== null) return _cat;
  return (_cat = await loadCatalog(activeLang()));
}

/**
 * Pure translation core — exported for unit testing with arbitrary catalogs.
 *
 * @param {string} key
 * @param {Record<string, string|number>} params
 * @param {Record<string, string>} cat   - active locale catalog
 * @param {Record<string, string>} fallbackCat - English catalog
 * @returns {string}
 */
export function translate(key, params, cat, fallbackCat) {
  const tpl = cat[key] ?? fallbackCat[key] ?? key;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (k in params ? String(params[k]) : `{${k}}`));
}

/**
 * Translates a key using the active locale from brain.config.json.
 * Falls back per-key to English; returns the key string for unknown keys.
 * Never throws.
 *
 * Pass `{ locale }` to resolve against an explicit locale instead of the
 * ambient config (bypasses the process cache). Omit it for normal CLI use.
 *
 * @param {string} key
 * @param {Record<string, string|number>} [params={}]
 * @param {{ locale?: string }} [opts={}]
 * @returns {Promise<string>}
 */
export async function t(key, params = {}, { locale } = {}) {
  const cat = await catalog(locale);
  return translate(key, params, cat, en);
}
