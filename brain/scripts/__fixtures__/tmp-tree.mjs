// __fixtures__/tmp-tree.mjs — re-export shim (issue #887, correction C2).
//
// `removeTempTree` moved to `../lib/tmp-tree.mjs`: `memory/lane/collect.mjs`
// (#887 Slice B) became a third PRODUCTION module importing a helper from a
// directory named `__fixtures__` — a name that reads test-only — and #802's
// own scope note had already flagged that layering question for the first
// two (`review/cold-boot.mjs`, `axes/memory/adapters/engram.mjs`) without
// resolving it. Every existing `import { removeTempTree } from
// '.../__fixtures__/tmp-tree.mjs'` across this repo's test suite keeps
// working unchanged through this re-export — only NEW imports should reach
// for `lib/tmp-tree.mjs` directly. See `lib/tmp-tree.mjs`'s own header for
// the full history (issue #800/#801/#802) and the mechanism itself.
export { removeTempTree } from '../lib/tmp-tree.mjs';
