// managed-paths.mjs — Distribution manifest for the brain versioned installer.
//
// Defines which paths are UPSTREAM (managed by brain, overwritten on upgrade)
// versus LOCAL (owned by the consumer, never touched). This is the contract
// that enforces ADR-0003 / ADR-0006: "core is read-only in the consumer".
//
// `brain:upgrade` copies only `managed` paths from the installed brain package
// into the consumer repo. `local` paths are listed explicitly as a safety net:
// if a glob ever overlaps, the installer skips the path and warns rather than
// risking a clobber of the consumer's own work.
//
// Glob syntax (matched by brain/scripts/lib/installer.mjs):
//   *   matches anything except a path separator
//   **  matches anything, including path separators (recursive)
//   A trailing `/**` matches every file under that directory.

// The brain:* verb keys that brain:upgrade injects into consumer package.json,
// reconciled against every doctrine `npm run …` mention (#922). Single source
// of truth — imported by installer.mjs mergePackageJson, drift-guarded by
// brain/scripts/lib/managed-script-keys-doctrine.test.mjs. Every key is
// brain:-namespaced (#961 R2): the memory verbs ship as brain:memory:*; the bare
// memory:* names are repo-only aliases in brain's own package.json, never managed.
//
// brain:memory:session-end (#906 A5, measured): the launcher FILE travels to
// every consumer via the brain/scripts/** glob below regardless of this list,
// but the npm SCRIPT that the compiled SessionEnd hook runs
// (`npm run brain:memory:session-end`) is injected into a consumer's
// package.json ONLY for keys listed here (mergePackageJson,
// lib/installer.mjs:1379-1402). Without this entry, every adopter's
// SessionEnd hook prints an npm "missing script" error to a surface Claude
// shows the user — the inert hook this slice ships would not actually be
// inert, it would be noisy.
export const MANAGED_SCRIPT_KEYS = [
  'brain:env:init',
  'brain:day:start',
  'brain:session:start',
  'brain:ticket:start',
  'brain:project:feature',
  'brain:project:status',
  'brain:tracker:board',
  'brain:repo:check',
  'brain:change:verify',
  'brain:memory:session-end',
  'brain:adopt',
  'brain:audit',
  'brain:change:archive',
  'brain:check',
  'brain:config',
  'brain:governance-status',
  'brain:metrics',
  'brain:nav',
  'brain:next',
  'brain:promote',
  'brain:protect',
  'brain:review',
  'brain:review:board',
  'brain:ship',
  'brain:start',
  'brain:upgrade',
  'brain:memory:audit',
  'brain:memory:index',
  'brain:memory:pull',
  'brain:memory:ship',
  'brain:memory:resolve-index',
  'brain:memory:save',
  'brain:memory:share',
];

// The .gitattributes line declaring git's BUILT-IN `union` merge driver for the
// brain-owned durable record log (ADR-0017, REQ-MF-3, issue #214/C1b). Unlike
// the legacy `merge=engram-manifest` line, this needs NO per-clone `git config`
// registration. Single source of truth — drift-guarded against the real
// `.gitattributes` file by managed-paths.test.mjs.
export const RECORDS_UNION_MERGE_GITATTRIBUTES_LINE = '/.memory/records/*.jsonl merge=union';

// Paths brain owns. The upgrade OVERWRITES these in the consumer.
export const managed = [
  'brain/core/**',
  'brain/scripts/**',
  '.gitattributes',
  '.github/workflows/governance.yml',   // the L1 gate travels with brain (ADR-0014)
  'brain/scripts/ci/gitlab-governance.yml', // opt-in GitLab governance pipeline fragment (issue #231
                                             // A2, design.md Decision 1). LITERAL only — brain never
                                             // manages the consumer's root .gitlab-ci.yml (that file
                                             // stays LOCAL; adoption is a single `include: local:` line
                                             // the consumer adds themselves).
  '.github/workflows/release.yml',      // L2 rung-2/rung-3 enforcement travels with brain (issue #176)
  '.github/workflows/governance-postmerge.yml', // L2 rung-2/rung-3 enforcement travels with brain (issue #176)
  '.github/PULL_REQUEST_TEMPLATE.md',   // the Closes/Fixes scaffold the gate parses (ADR-0014)
  '.gitlab/merge_request_templates/Default.md', // the SAME scaffold, emitted for GitLab (issue #570).
                                             // Both files are rendered from ONE neutral source
                                             // (brain/scripts/vcs/contributor-scaffold.mjs) — only the
                                             // DELIVERY is provider-specific. Shipping the GitHub one
                                             // alone left a GitLab consumer with `issue-link` as a
                                             // REQUIRED job parsing MR descriptions for a closing
                                             // reference and no scaffold telling anyone to write one.
                                             // LITERAL, never `.gitlab/**`: the consumer's other merge
                                             // request templates are theirs.
  '.github/CODEOWNERS',                 // L6 rung-1 enhancement, optional (REQ-L6-1, design §6.2)
  '.claude/settings.json',              // Claude Code harness hook — no-verify policy (ADR-0014 §9)
  '.gemini/settings.json',              // Antigravity harness hook — SessionStart & PreToolUse (issue #305)
  // AGENTS.md was HERE (issue #256 B2, REQ-B2-4), shipped on the reasoning that
  // its sources under brain/core/** are already managed. REMOVED by #397 /
  // REQ-397-4: that reasoning missed the fifth source. `brain/HOME.md` is
  // CONSUMER-owned, so copying the compiled artifact handed every consumer
  // brain's own AGENTS.md — a file describing the wrong repository. It is
  // regenerated post-upgrade from the consumer's inputs instead; see
  // managedStrategy's REGENERATE row below.
  'package.json', // additive brain:* verb injection via specialMerge (S5, issue #137).
                  // MUST stay registered in brain-upgrade.mjs specialMerge — a plain copy would overwrite the consumer's package.json.
];

// ── Per-path upgrade strategy (issue #397, REQ-397-5) ────────────────────────
//
// `managed` says WHICH paths brain ships. It does not say WHAT the upgrade does
// with each one, and before #397 that answer was inferred from three call sites:
// a path was merged if it appeared in brain-upgrade.mjs's ALL_MERGES, and
// plain-copied otherwise. A strategy readable in one place is auditable; one
// inferred from three is not — which is how seven consumer-curated files came to
// be silently overwritten on every upgrade.
//
// The table below is the classification RATIFIED 04/08/2026 by Cristian Rinaldi
// (Tier-2 / ADR-0013), recorded in
// `openspec/changes/issue-397-clobber-asymmetry/brain-drafts/managed-path-strategy.md`.
// A row may not change without a NEW human signature. `managed-paths.test.mjs`
// holds an independent transcription of the same table and fails on drift.

export const STRATEGY = Object.freeze({
  // Brain owns it; overwrite. Either brain-owned by contract (ADR-0003: core is
  // read-only in the consumer) or brain's own policy for managed paths.
  COPY: 'copy',
  // Consumer content survives; brain's block is applied underneath.
  MERGE: 'merge',
  // No meaningful merge exists — these are policies and prose a team rewrites
  // wholesale. If the file in the consumer's tree is THEIRS, abort and name it;
  // overwriting takes a deliberate, per-path `--force-managed <path>`.
  //
  // "Theirs" covers two cases, and it only covered the first until #601:
  //   · they modified what a previous release shipped, and
  //   · brain is shipping this path for the FIRST time and a file is already
  //     there — nothing of brain's was ever at that path, so those bytes cannot
  //     be anything but the consumer's.
  // The second case used to fall through to a plain collision, which the default
  // run prints and proceeds past. The guarantee therefore started one release
  // late, missing precisely the release where the risk is highest.
  //
  // Untouched paths still copy like anything else: REFUSE is not "always ask".
  // Asking on every release is how a real warning becomes the thing everyone
  // clicks through. A run with no outgoing tree (`--no-install`) refuses
  // nothing on this basis — unknown-because-degraded is not evidence.
  REFUSE: 'refuse',
  // Not a file to copy at all: a build output whose inputs straddle the ownership
  // line. Copying it hands every consumer brain's own artifact, describing the
  // wrong repository. Rebuild it from the consumer's inputs instead.
  REGENERATE: 'regenerate',
});

export const managedStrategy = Object.freeze({
  // Sibling agent-config files with the same shape and the same deterministic
  // merge (#103). No reason to treat two siblings differently.
  '.claude/settings.json': STRATEGY.MERGE,
  '.gemini/settings.json': STRATEGY.MERGE,
  'package.json': STRATEGY.MERGE,

  // Ownership lines are a policy, not a set to union.
  '.github/CODEOWNERS': STRATEGY.REFUSE,
  // Prose a team rewrites wholesale.
  '.github/PULL_REQUEST_TEMPLATE.md': STRATEGY.REFUSE,
  // The GitLab sibling of the row above (issue #570). Same artifact, same class,
  // therefore the same strategy. Classified by extension of an already ratified row
  // rather than as a new class; it is a NEW path, so no signed row changes value.
  //
  // WHAT THIS ROW DOES NOT DO, ON THE RELEASE THAT INTRODUCES IT: refuse. The gate
  // fires only for a path the PREVIOUSLY INSTALLED package shipped (`outgoing` in
  // installer.mjs), and a first-ship path is in no prior release — so a consumer who
  // already owns `.gitlab/merge_request_templates/Default.md` gets it OVERWRITTEN,
  // reported as a collision, unless they ran with `--abort-on-collision`. Measured,
  // not assumed: `contributor-scaffold.test.mjs` pins it, and #601 tracks the hole.
  // The protection is real from the next release onward; saying otherwise here would
  // be the same class of comfortable falsehood #570 is about.
  '.gitlab/merge_request_templates/Default.md': STRATEGY.REFUSE,
  // A consumer who pinned a runner version or added a job loses it silently
  // today. Merging YAML semantically is neither cheap nor safe.
  '.github/workflows/governance.yml': STRATEGY.REFUSE,
  '.github/workflows/release.yml': STRATEGY.REFUSE,
  '.github/workflows/governance-postmerge.yml': STRATEGY.REFUSE,
  // The GitLab sibling. NOTE the overlap: this literal sits under the
  // `brain/scripts/**` COPY glob below, so the resolver MUST give an exact
  // literal priority over a glob or this row is dead text.
  'brain/scripts/ci/gitlab-governance.yml': STRATEGY.REFUSE,

  // Generated from brain/HOME.md (CONSUMER-owned) plus four managed methodology
  // docs (brain's). Copying substitutes brain's inputs for the consumer's.
  'AGENTS.md': STRATEGY.REGENERATE,

  // Signed decision 1: brain-owned. It is brain's line-ending and diff policy
  // for managed paths, not something a consumer curates.
  '.gitattributes': STRATEGY.COPY,
  // ADR-0003: core is read-only in the consumer. Editing them is out of
  // contract; the collision warning is already the right response.
  'brain/core/**': STRATEGY.COPY,
  'brain/scripts/**': STRATEGY.COPY,
});

// Paths the consumer owns. The upgrade NEVER touches these.
// Listed explicitly so the installer can refuse to copy anything that
// (accidentally) matches both sets — local always wins.
export const local = [
  'brain/project/**',
  'brain.config.json',
  '.env',
  'openspec/changes/**',
  '.memory/**',
];
