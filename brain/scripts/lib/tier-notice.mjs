// tier-notice.mjs — env:init states the governance tier (issue #1124,
// ADR-0026 Amendment 8).
//
// In #1081 env:init wrote `standard` for a new one-person repository and said
// nothing; at `standard` a merge needs a second, non-author approval, which that
// repository's only maintainer could not give. The ruling: a NEW consumer is
// given `lite`, an EXISTING one keeps what it has, and env:init SAYS which —
// the tier, why, and how to change it — on every run.
//
// Two halves, kept apart on purpose:
//   tierNotice()        DECIDES what to say. Pure: no I/O, no locale.
//   renderTierNotice()  SAYS it, through the i18n catalogs (en.mjs, es.mjs).
// printTierNotice() is the thin I/O shell brain-config.mjs's `ensure` calls.

import { readFileSync } from 'node:fs';

import { TIERS } from '../vcs/governance-tiers.mjs';
import { t } from '../i18n/t.mjs';

/**
 * @typedef {{ tier: string, source: 'new'|'declared'|'absent'|'invalid' }} TierNotice
 */

/**
 * Decides what env:init reports about `governance.tier`.
 *
 * - `new`      — env:init created this config just now; the tier is the one it set.
 * - `declared` — an existing config declares a known tier; it is left unchanged.
 * - `absent`   — an existing config declares none. Reported as `standard`, because
 *                that is what `resolveTier()` reads for an absent key — the notice
 *                states the tier the gates actually run, not a guess.
 * - `invalid`  — an existing config declares a value that is not a tier. Reported
 *                as-is: `resolveTier()` throws on it, so every gate reading the tier
 *                fails closed until it is fixed. Never mapped to a tier here.
 *
 * @param {{ created: boolean, config: object }} args
 * @returns {TierNotice}
 */
export function tierNotice({ created, config }) {
  const raw = config?.governance?.tier;
  if (raw === undefined || raw === null) return { tier: 'standard', source: 'absent' };
  if (!TIERS.includes(raw)) return { tier: String(raw), source: 'invalid' };
  return { tier: raw, source: created ? 'new' : 'declared' };
}

/**
 * Renders a notice as output lines, through the catalogs.
 *
 * @param {TierNotice} notice
 * @param {{ locale?: string }} [opts] explicit locale; omit for the ambient one
 * @returns {Promise<string[]>}
 */
export async function renderTierNotice(notice, { locale } = {}) {
  const opts = { locale };
  const { tier, source } = notice;
  const tiers = TIERS.join(', ');
  if (source === 'invalid') {
    return [
      `  ⚠ ${await t('config.tier.invalid', { tier, tiers }, opts)}`,
      `    ${await t('config.tier.change', {}, opts)}`,
    ];
  }
  const head = source === 'new' ? 'config.tier.new' : source === 'absent' ? 'config.tier.absent' : 'config.tier.declared';
  const lines = [`  ✓ ${await t(head, { tier }, opts)}`];
  const why = await whyLine(tier, opts);
  if (why) lines.push(`    ${why}`);
  lines.push(`    ${await t('config.tier.change', {}, opts)}`);
  return lines;
}

async function whyLine(tier, opts) {
  const key = `config.tier.why.${tier}`;
  const text = await t(key, {}, opts);
  return text === key ? null : text;
}

/**
 * Decides what env:init reports about the memory lane (issue #1166). The lane
 * (ADR-0034) ships memory records on their own pull request; `memory.lane.enabled`
 * is false on every tier by default and an absent key reads as false, exactly as
 * the launcher and the sweep read it. Same two halves as the tier notice.
 *
 * @param {{ config: object }} args
 * @returns {{ enabled: boolean }}
 */
export function laneNotice({ config }) {
  return { enabled: config?.memory?.lane?.enabled === true };
}

/**
 * @param {{ enabled: boolean }} notice
 * @param {{ locale?: string }} [opts]
 * @returns {Promise<string[]>}
 */
export async function renderLaneNotice({ enabled }, { locale } = {}) {
  const opts = { locale };
  if (enabled) return [`  ✓ ${await t('config.lane.on', {}, opts)}`];
  return [
    `  ✓ ${await t('config.lane.off', {}, opts)}`,
    `    ${await t('config.lane.why', {}, opts)}`,
    `    ${await t('config.lane.enable', {}, opts)}`,
  ];
}

/**
 * Reads the config env:init just ensured and prints the notice. Never throws:
 * an unreadable config is already reported by the ensure step itself.
 *
 * @param {{ created: boolean, configPath: string, log?: (s: string) => void }} args
 */
export async function printTierNotice({ created, configPath, log = console.log }) {
  let config;
  try {
    config = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return;
  }
  const locale = config?.docs?.language || 'en';
  for (const l of await renderTierNotice(tierNotice({ created, config }), { locale })) log(l);
  for (const l of await renderLaneNotice(laneNotice({ config }), { locale })) log(l);
}
