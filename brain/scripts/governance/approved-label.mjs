// approved-label.mjs — resolves the governance approved-issue label per VCS
// provider (design.md Decision 4, REQ-A2-3, issue #231 A2 phase 1).
//
// `governance.approvedLabel` is an additive brain.config.json entry (default
// base form below). GitHub uses the plain form as-is; GitLab scoped labels
// use `::` — the mapping from the base `key:value` form to GitLab's scoped
// `key::value` form is mechanical, so only ONE string is stored in config. A
// consumer-set `governance.approvedLabel` value always wins over the default;
// the provider mapping then applies to whatever base form is configured.
//
// A tiny CLI printer is exported alongside the resolver so a non-Node
// consumer (the GitHub `issue-link` bash step, wired in a later phase) can
// source the resolved value without a bash config-parser.

import { fileURLToPath } from 'node:url';

import { loadBrainConfig } from '../lib/brain-config.mjs';

const DEFAULT_APPROVED_LABEL = 'status:approved';

/**
 * Resolves the approved-issue label for the given VCS provider.
 *
 * @param {{ governance?: { approvedLabel?: string } }} [config] brain.config.json
 *   (or a subset) — reads `governance.approvedLabel`; falls back to the
 *   default base form when absent/empty.
 * @param {'github'|'gitlab'|string|null|undefined} provider
 * @returns {string}
 */
export function resolveApprovedLabel(config, provider) {
  const base = config?.governance?.approvedLabel || DEFAULT_APPROVED_LABEL;
  if (provider === 'gitlab') {
    // GitLab scoped labels use `::`. Already-scoped overrides pass through
    // unchanged; otherwise the mapping is mechanical: first `:` becomes `::`.
    return base.includes('::') ? base : base.replace(':', '::');
  }
  return base;
}

// ── CLI printer ──────────────────────────────────────────────────────────────

/**
 * Prints the resolved approved-label for `provider` (argv[0]). Injectable
 * `deps.loadConfig` for tests; defaults to reading brain.config.json via
 * `loadBrainConfig()`. Never throws — an unreadable/missing config degrades
 * to the default base form.
 *
 * @param {string[]} argv `process.argv.slice(2)`-shaped — argv[0] is the provider.
 * @param {{ loadConfig?: () => object }} [deps]
 * @returns {string}
 */
export function main(argv, deps = {}) {
  const provider = argv?.[0];
  const loadConfig = deps.loadConfig ?? loadBrainConfig;
  let config;
  try {
    config = loadConfig();
  } catch {
    config = {};
  }
  return resolveApprovedLabel(config, provider);
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(main(process.argv.slice(2)));
}
