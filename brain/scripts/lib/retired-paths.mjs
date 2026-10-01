// brain/scripts/lib/retired-paths.mjs — files brain once shipped under a managed
// COPY glob and no longer does (issue #1141).
//
// `copyManaged` walks the INCOMING package, so a file a release stops shipping is
// never visited and would survive every upgrade in the consumer's tree. Each
// path here is removed from the consumer by `brain:upgrade` when present, unless
// the consumer declared it `local` or the incoming package ships it again.
//
// WHY AN EXACT LIST, NOT "WHATEVER THE PACKAGE NO LONGER HAS". A consumer may keep
// its own file in a directory brain also writes to, and under `--no-install` the
// outgoing package is already gone, so the tree alone cannot say which files were
// brain's. Only the release that stopped shipping a file knows it did.
//
// `brain-upgrade.mjs` reads this module from the INCOMING package. Guarded by
// lib/installer.retired.test.mjs: every entry is absent from brain and sits under
// a managed COPY glob.

export const RETIRED_PATHS = Object.freeze([
  // #1141: every adapter moved to brain/scripts/axes/<axis>/.
  'brain/scripts/harness/backends/agent-runtime.mjs',
  'brain/scripts/harness/backends/agent-runtime.test.mjs',
  'brain/scripts/harness/backends/antigravity.drift.test.mjs',
  'brain/scripts/harness/backends/antigravity.mjs',
  'brain/scripts/harness/backends/antigravity.test.mjs',
  'brain/scripts/harness/backends/claude.mjs',
  'brain/scripts/harness/backends/claude.test.mjs',
  'brain/scripts/harness/backends/codex.mjs',
  'brain/scripts/harness/backends/codex.test.mjs',
  'brain/scripts/harness/backends/gemini.mjs',
  'brain/scripts/harness/backends/gemini.test.mjs',
  'brain/scripts/harness/backends/gentle-ai.mjs',
  'brain/scripts/harness/backends/gentle-ai.roles.mjs',
  'brain/scripts/harness/backends/gentle-ai.roles.test.mjs',
  'brain/scripts/harness/backends/gentle-ai.test.mjs',
  'brain/scripts/harness/backends/plain.mjs',
  'brain/scripts/harness/backends/plain.test.mjs',
  'brain/scripts/harness/backends/settings-hooks.mjs',
  'brain/scripts/harness/backends/settings-hooks.test.mjs',
  'brain/scripts/memory/backends/engram.batch-import.test.mjs',
  'brain/scripts/memory/backends/engram.branch.test.mjs',
  'brain/scripts/memory/backends/engram.duplicates.test.mjs',
  'brain/scripts/memory/backends/engram.feature.test.mjs',
  'brain/scripts/memory/backends/engram.heal.integration.test.mjs',
  'brain/scripts/memory/backends/engram.heal.test.mjs',
  'brain/scripts/memory/backends/engram.hydrate.test.mjs',
  'brain/scripts/memory/backends/engram.import.test.mjs',
  'brain/scripts/memory/backends/engram.mjs',
  'brain/scripts/memory/backends/engram.pull.test.mjs',
  'brain/scripts/memory/backends/engram.save.test.mjs',
  'brain/scripts/memory/backends/engram.search-unsupported.test.mjs',
  'brain/scripts/memory/backends/engram.setup.test.mjs',
  'brain/scripts/memory/backends/engram.share.test.mjs',
  'brain/scripts/memory/backends/no-artifact.parity.test.mjs',
  'brain/scripts/memory/backends/plainfiles.actorkind-consistency.test.mjs',
  'brain/scripts/memory/backends/plainfiles.mjs',
  'brain/scripts/memory/backends/plainfiles.pull.test.mjs',
  'brain/scripts/memory/backends/plainfiles.save-index-failure.test.mjs',
  'brain/scripts/memory/backends/plainfiles.save.test.mjs',
  'brain/scripts/memory/backends/plainfiles.search.test.mjs',
  'brain/scripts/memory/backends/plainfiles.setup.test.mjs',
  'brain/scripts/memory/backends/plainfiles.share.test.mjs',
  'brain/scripts/memory/backends/plainfiles.unsupported.test.mjs',
  'brain/scripts/memory/backends/reindex-parity.test.mjs',
  'brain/scripts/memory/backends/save-parity.test.mjs',
  'brain/scripts/roles/fixtures/stage-set-custom.json',
  'brain/scripts/roles/role-port.mjs',
  'brain/scripts/roles/role-port.test.mjs',
  'brain/scripts/roles/roles.contract.test.mjs',
  'brain/scripts/vcs/providers/github.mjs',
  'brain/scripts/vcs/providers/gitlab.mjs',
  'brain/scripts/vcs/providers/identity.drift.test.mjs',
  'brain/scripts/vcs/providers/vcs.contract.test.mjs',
]);
