// env.mjs — shared test util for neutralising an ambient env var around a
// real (unstubbed) production seam.
//
// Issue #714: several integration tests deliberately drive the REAL
// `upstreamRecordEntries`/`upstreamRecordIds` predicate (not the
// `_upstreamRecordIds` / `_upstreamRecordEntries` seams) to pin the exporter's
// actual call shape. Those predicates fall back to `process.env` on purpose —
// `BRAIN_MEMORY_UPSTREAM_REF` is the documented escape hatch and it is
// correct that it wins. The defect #714 is about is narrower: the SUITE's
// verdict must not depend on whether the developer running it happens to have
// that variable exported, which is exactly the case for anyone debugging
// `brain:memory:share` or the #701 gate.
//
// `withoutEnv` was originally local to
// `axes/memory/adapters/engram.upstream-scope.test.mjs` (the one test file that first
// needed it) and is promoted here so every file with the same real-predicate
// shape can share one implementation instead of re-deriving it.
export function withoutEnv(t, name) {
  const prior = process.env[name];
  delete process.env[name];
  t.after(() => {
    if (prior === undefined) delete process.env[name];
    else process.env[name] = prior;
  });
}
