// unsupported-op.mjs — the shared "loud, never-cryptic deferral" helper
// (C3 design Decision 5). Both directions of the Q1 asymmetry ruling
// (sdd/issue-246-c3/constraints, obs #578) route through this ONE helper:
//   - `plainfiles.mjs`'s `index`/`featureCheckpoint`/`featureResume` defer
//     with the generic `memory.op.unsupported` key.
//   - `engram.mjs`'s `search` refuses with the friendlier
//     `memory.search.engramUnsupported` key, pointing the caller at the
//     native engram tool. `save`'s matching key retired at #874, split A
//     (D7): `engram.save()` is now the record-first producer path, and no
//     longer routes through this helper at all.
//
// Never a silent no-op: the caller's op stays async so `await unsupportedOp(...)`
// rejects, and cli.mjs's existing catch-and-exit-1 dispatch path (cli.mjs:237-243)
// surfaces the message unmodified — no bespoke passthrough machinery needed.

import { t } from '../../i18n/t.mjs';

/**
 * @param {string} op       The op name being deferred (e.g. 'index', 'save').
 * @param {string} backend  The backend name that does not implement it (e.g. 'plainfiles', 'engram').
 * @param {{key?: string, params?: Record<string, string|number>}} [opts]
 * @returns {Promise<never>}
 */
export async function unsupportedOp(op, backend, { key = 'memory.op.unsupported', params = {} } = {}) {
  throw new Error(await t(key, { op, backend, ...params }));
}
