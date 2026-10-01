// brain/scripts/axes/lib/harness-adapter-url.mjs — where a harness backend NAME
// lives now that its old directory is split by axis (issue #1141).
//
// Until #1141 one directory, `brain/scripts/harness/backends/`, held three axes:
// platforms (claude, antigravity), SDD engines (gentle-ai, plain) and review
// engines (codex, gemini, claude). Three loaders read it by name —
// `harness/cli.mjs`'s dispatcher, `agent-runtime.mjs`'s platform probe and the
// role port's `loadInhabitant` — and none of them knew or cared which axis a
// name belonged to.
//
// #1141 is a pure move, so those loaders must resolve every name to the SAME
// module they resolved before. This is that lookup and nothing more: the three
// axis directories that used to be one, searched in a fixed order. A dual-axis
// name (`plain`, `claude`) has ONE physical module and a logic-free re-export in
// its other axis, so the order decides which file is read, never which code runs.
//
// It is not the axis resolver. #1114 replaces it with one resolver per axis; until
// then this keeps the old single-directory behaviour over the new layout.

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** The axes `harness/backends/` used to hold, in lookup order. */
export const HARNESS_ADAPTER_AXES = Object.freeze(['platform', 'sdd-engine', 'review-engine']);

/** The adapters directory of one harness axis, as a URL ending in `/`. */
export function harnessAdapterDir(axis) {
  return new URL(`../${axis}/adapters/`, import.meta.url);
}

/**
 * The module URL for a harness backend name: the first axis whose `adapters/`
 * holds `<name>.mjs`. When none does, the first axis's candidate is returned so
 * the import fails with the same module-not-found error it always did.
 *
 * @param {string} name A backend name, e.g. `claude`, `gentle-ai`, `codex`.
 * @returns {URL}
 */
export function harnessAdapterUrl(name) {
  const candidates = HARNESS_ADAPTER_AXES.map((axis) => new URL(`${name}.mjs`, harnessAdapterDir(axis)));
  return candidates.find((url) => existsSync(fileURLToPath(url))) ?? candidates[0];
}
