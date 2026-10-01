// phase-order-check.mjs — L4 SDD phase-order gate: pure evaluator + git I/O wrapper
// + CLI (design §2, REQ-L4-1..5). Sibling to check-refs.mjs. Generic over
// openspec/changes/** file state + git — no harness-specific file is read or
// required (REQ-NEUTRALITY-1/2).
//
// PR4a shipped the pure evaluator (evaluatePhaseOrder). PR4b (this addition) adds
// the git I/O wrapper (git diff --name-only, existsSync/readdirSync artifact
// flags, `- [x]` counting, `git show BASE:path` for statusBefore) and the CLI
// entrypoint wired into DETECTION_JOBS.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadContext } from './ci-context.mjs';
import { artefactFiles, archivePath, CHANGES_ROOT, LEGACY_GRANDFATHERED, LIFECYCLE_STAGES, ARTEFACT_FILE, resolveStageSet } from '../lib/sdd-layout.mjs';
import { loadBrainConfig } from '../lib/brain-config.mjs';
import { resolveTier, tierParams } from './governance-tiers.mjs';
import { mapDetectionToWarning } from '../governance/detection-policy.mjs';

const GATE_NAME = 'phase-order';

// ── Constants ────────────────────────────────────────────────────────────────

const CHANGE_DIR_PREFIX = `${CHANGES_ROOT}/`;

// The accessor-owned archive container's directory name (issue #264), derived
// from archivePath() rather than hardcoded — if the archive location ever
// relocates, this follows the accessor instead of drifting out of sync. It is
// a container of archived changes, never an in-flight change itself, so it
// must never be evaluated as a `touchedDirs` entry (Rule A/C false positive).
const ARCHIVE_DIR_NAME = archivePath('').slice(CHANGE_DIR_PREFIX.length).split('/')[0];

// Allowlist subtracted from the "impl" set (Rule C): files that never count as
// implementation code even when they live outside openspec/changes/**.
const ROOT_MD_RE = /^[^/]+\.md$/;

function isAllowlisted(path) {
  // Hardening (carried from PR4a review): never allowlist a path containing a
  // '..' segment. `git diff --name-only` never emits one, but an unnormalized
  // path must not be able to masquerade as an allowlisted docs/*.md file.
  if (path.split('/').includes('..')) return false;
  if (ROOT_MD_RE.test(path)) return true; // *.md at repo root
  if (path.startsWith('docs/')) return true;
  if (path.startsWith('.memory/')) return true;
  // openspec/specs/** (issue #557 D7-a): the durable, consolidated SDD
  // artifact an archive PR appends to — the same class docs/ and .memory/
  // are already allowlisted for, never implementation code. Without this,
  // every archive PR that consolidates a spec delta trips Rule C ("code
  // without checked tasks") and Rule A ("implementation without
  // spec.md/design.md") on the archived-away folder, forever, because the
  // folder no longer exists at HEAD once the archive move lands.
  if (path.startsWith('openspec/specs/')) return true;
  return false;
}

// ── Rule C — code-without-completed-phases (the enforcing core) ───────────────

function evaluateRuleC(impl, touchedDirs) {
  const findings = [];
  if (impl.length === 0) return findings;

  if (touchedDirs.length === 0) {
    // Unattributable — never fail, only warn (keeps false positives ~0).
    findings.push({
      rule: 'C',
      level: 'warn',
      message:
        'implementation code changed but no openspec/changes/** directory was touched ' +
        'in this diff — cannot attribute the change to a tracked SDD change',
    });
    return findings;
  }

  for (const dir of touchedDirs) {
    if (dir.checkedTasks !== 0) continue;
    findings.push({
      rule: 'C',
      level: 'fail',
      change: dir.name,
      message:
        `implementation code present but openspec/changes/${dir.name}/tasks.md has no ` +
        'checked item — phases not reached apply.',
    });
  }

  return findings;
}

// ── Rule A — artifact completeness, gated on Rule C seeing impl ────────────────
//
// The required artefact SET is tier-scoped (issue #358 Q5, REQ-L4-2′):
// `lite` demands `spec.md` only; `standard` (the default) keeps today's full
// four; `regulated` additionally demands a recorded verification artefact.
// `tierParams(tier).artefacts` (governance-tiers.mjs) is the single source —
// this checker never hardcodes a second copy of the set.

/** Maps a design §2.C artefact name to its changeDirs boolean flag. */
const ARTEFACT_FIELD = Object.freeze({
  proposal: 'hasProposal',
  spec: 'hasSpec',
  design: 'hasDesign',
  tasks: 'hasTasks',
  verification: 'hasVerification',
});

// today's shipped Rule A set (standard tier — REQ-TIER-10 no-op-migration
// default) — used both as evaluateRuleA's default `artefacts` param
// (preserving every pre-tiering call site/test unchanged) and to detect the
// legacy literal message below.
//
// Imported from sdd-layout.mjs (issue #456 slice A, design D2) instead of a
// private literal — this WAS the third of three declarations of the same set
// §1's measurement found, invisible to the drift guard because it is written
// in bare names, not `.md`-suffixed ones. The import already existed on this
// line before this change (design D7: "the seam already exists"); only the
// binding grew. `LIFECYCLE_STAGES` is not resolvable (never config-dependent),
// which is exactly why the positional sentinel below is safe to compare
// against it — see messageForArtefacts.
const STANDARD_ARTEFACTS = LIFECYCLE_STAGES;

/**
 * #810 (#456 slice B) — the walk set Rule A demands, derived from BOTH owners:
 * the tier table scopes the FOUR (REQ-L4-2 prime — plus `verification`, tier
 * vocabulary that no consumer declares), and `sdd.stages` contributes every
 * declared custom stage IN ITS DECLARED POSITION — declaring a stage IS the
 * demand (ADR-0019 Amendment 5). Zero-config resolves to the tier table
 * byte-identically, which keeps `messageForArtefacts`' positional sentinel
 * honest. Throws whatever `resolveStageSet` throws — the caller maps a
 * malformed declaration to an uncomputable verdict, never a crash.
 *
 * @param {{config?: object, tier: string}} args
 * @returns {{artefacts: string[], fileMap: Record<string,string>, customNames: string[]}}
 */
export function resolveWalkSet({ config, tier }) {
  const tierNames = tierParams(tier).artefacts;
  const { stages, files } = resolveStageSet(config);
  const artefacts = stages.filter(
    (name) => (LIFECYCLE_STAGES.includes(name) ? tierNames.includes(name) : true),
  );
  for (const name of tierNames) {
    // `verification` and any future tier vocabulary outside the declarable set.
    if (!LIFECYCLE_STAGES.includes(name) && !artefacts.includes(name)) artefacts.push(name);
  }
  const customNames = stages.filter((name) => !LIFECYCLE_STAGES.includes(name));
  return { artefacts, fileMap: { ...ARTEFACT_FILE, ...files }, customNames };
}

/**
 * Builds the "implementation without ..." message. Preserves the EXACT
 * pre-tiering literal text ("spec.md/design.md") when the artefact set is the
 * historical standard-tier four — regression-guarded by this file's own
 * tests, which assert that literal substring regardless of which of the four
 * flags actually failed. For any other artefact set (lite/regulated, or a
 * future custom set), names the artefacts ACTUALLY missing on this dir.
 */
function messageForArtefacts(artefacts, dir, fileMap = ARTEFACT_FILE) {
  if (artefacts.length === STANDARD_ARTEFACTS.length && artefacts.every((a, i) => a === STANDARD_ARTEFACTS[i])) {
    return 'spec.md/design.md';
  }
  const missing = artefacts.filter(name => !artefactPresent(dir, name));
  // #555: through the shared map, not `${name}.md`. This message named
  // `verification.md` while `buildChangeDir` probed `verify-report.md` — the same
  // invented-filename defect, here before #555 touched anything, and the reason
  // the mapping is one declaration now. #810: a custom stage's file comes from
  // the RESOLVED map — the fixed map still answers for the five fixed names.
  return artefactFiles(missing, fileMap).join('/');
}

/** #810 — the generic presence read: fixed names keep their boolean flags
 * (every pre-#810 caller and test unchanged); a declared custom stage is read
 * from the `present` map its resolved-file probe fills. */
function artefactPresent(dir, name) {
  const flag = ARTEFACT_FIELD[name];
  return flag ? Boolean(dir[flag]) : Boolean(dir.present?.[name]);
}

function evaluateRuleA(impl, touchedDirs, artefacts = STANDARD_ARTEFACTS, fileMap = ARTEFACT_FILE) {
  const findings = [];
  // Planning-only PRs (no impl code) are never subjected to Rule A — they may
  // legitimately be mid-phase (design §10-A).
  if (impl.length === 0) return findings;

  for (const dir of touchedDirs) {
    const complete = artefacts.every(name => artefactPresent(dir, name));
    if (!complete) {
      findings.push({
        rule: 'A',
        level: 'fail',
        change: dir.name,
        message: `openspec/changes/${dir.name}: implementation without ${messageForArtefacts(artefacts, dir, fileMap)}`,
      });
    }
  }

  return findings;
}

// ── Rule B — monotonic status ───────────────────────────────────────────────

const STATUS_LADDER = [
  'draft',
  'proposed',
  'spec',
  'designed',
  'tasked',
  'applying',
  'verified',
  'archived',
];

function evaluateRuleB(touchedDirs) {
  const findings = [];

  for (const dir of touchedDirs) {
    const { statusBefore, statusAfter, name } = dir;
    if (!statusBefore || !statusAfter) continue; // absent frontmatter → no-op

    const idxBefore = STATUS_LADDER.indexOf(statusBefore);
    const idxAfter = STATUS_LADDER.indexOf(statusAfter);
    if (idxBefore === -1 || idxAfter === -1) continue; // unknown/custom → no-op
    if (idxAfter >= idxBefore) continue; // unchanged or forward-only → no-op

    findings.push({
      rule: 'B',
      level: 'fail',
      change: name,
      message:
        `openspec/changes/${name}: status regressed from '${statusBefore}' to ` +
        `'${statusAfter}' — backward phase jump`,
    });
  }

  return findings;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Evaluates the L4 phase-order rules against pre-computed changed-file + change-dir
 * state. Pure — no git, no filesystem access (fully testable with fixtures).
 *
 * @param {object} input
 * @param {string[]} input.changedFiles  Paths from `git diff --name-only BASE...HEAD`.
 * @param {Array<{
 *   name: string,
 *   hasProposal: boolean,
 *   hasSpec: boolean,
 *   hasDesign: boolean,
 *   hasTasks: boolean,
 *   checkedTasks: number,
 *   statusBefore: string|null|undefined,
 *   statusAfter: string|null|undefined,
 * }>} input.changeDirs  One entry per openspec/changes/** directory the caller knows
 *   about. `hasSpec` MUST be true if EITHER `spec.md` OR `specs/*\/spec.md` exists
 *   (Gap G1 — the wrapper is responsible for probing both conventions; this pure
 *   function only consumes the resulting boolean).
 * @param {string[]} [input.artefacts]  Tier-scoped required artefact names
 *   (issue #358 Q5, `tierParams(tier).artefacts`) — defaults to the historical
 *   standard-tier four (`proposal`/`spec`/`design`/`tasks`), preserving every
 *   pre-tiering call site unchanged.
 * @returns {{ level: 'pass'|'warn'|'fail', findings: Array<{rule: string, level: string, change?: string, message: string}> }}
 */
export function evaluatePhaseOrder({ changedFiles = [], changeDirs = [], artefacts = STANDARD_ARTEFACTS, fileMap = ARTEFACT_FILE } = {}) {
  const impl = changedFiles.filter(f => !f.startsWith(CHANGE_DIR_PREFIX) && !isAllowlisted(f));

  const touchedDirs = changeDirs.filter(
    dir =>
      dir.name !== ARCHIVE_DIR_NAME &&
      changedFiles.some(f => f.startsWith(`${CHANGE_DIR_PREFIX}${dir.name}/`))
  );

  const findings = [
    ...evaluateRuleC(impl, touchedDirs),
    ...evaluateRuleA(impl, touchedDirs, artefacts, fileMap),
    ...evaluateRuleB(touchedDirs),
  ];

  const level = findings.some(f => f.level === 'fail')
    ? 'fail'
    : findings.some(f => f.level === 'warn')
      ? 'warn'
      : 'pass';

  return { level, findings };
}

// ── Baseline / grandfather allowlist (REQ-L4-5, Gap G3) ────────────────────────
//
// Pre-v3 legacy openspec/changes/** dirs, sourced from the B0-sealed
// LEGACY_GRANDFATHERED set (sdd-layout.mjs) — REQ-B1-3. The original 3-dir
// BASELINE_EXEMPT_DIRS literal (installer-versionado, vcs-adapter, cli-i18n)
// is a strict subset of the sealed 12 (proven by sdd-layout.test.mjs 1.7), so
// this swap does not change which dirs are exempted for any existing dir —
// the 9 additional grandfathered dirs all carry a nested spec artifact and
// never produced a downgradeable `fail` in the first place (design §2.1).

/**
 * Post-processes an evaluatePhaseOrder() result: any `fail` finding attributed
 * to a baseline/grandfather dir is downgraded to a non-blocking `exempt`
 * finding rather than silently dropped, so the baseline dir's status stays
 * visible in detection-mode output (REQ-L4-5).
 *
 * @param {{level: string, findings: Array}} evaluation
 * @param {string[]} [baselineDirs]
 * @returns {{level: string, findings: Array}}
 */
export function applyBaselineExemption(evaluation, baselineDirs = LEGACY_GRANDFATHERED) {
  const findings = evaluation.findings.map(f => {
    if (f.change && baselineDirs.includes(f.change) && f.level === 'fail') {
      return {
        ...f,
        level: 'exempt',
        message:
          `${f.message} — pre-v3 baseline exemption (REQ-L4-5): known, not ` +
          'failing in detection mode.',
      };
    }
    return f;
  });

  const level = findings.some(f => f.level === 'fail')
    ? 'fail'
    : findings.some(f => f.level === 'warn')
      ? 'warn'
      : 'pass';

  return { level, findings };
}

// ── Git I/O wrapper (PR4b) ──────────────────────────────────────────────────
//
// Gathers evaluatePhaseOrder()'s inputs from git + the filesystem. Every I/O
// operation is dependency-injectable via `deps` — real git/fs is used only as
// the default — so tests exercise this wrapper with plain-data fakes and never
// touch real git state or the real cwd (same CI-fragility discipline as
// run-check.mjs / check-refs.mjs).
//
// Path convention: every `deps` function takes/returns paths **relative to
// `cwd`** (POSIX `/`-separated, no leading `./`), never an absolute path —
// this keeps fakes trivial (a flat relative-path → content map) regardless of
// where `cwd` happens to point.

const STATUS_FRONTMATTER_RE = /^status:\s*(\S+)/m;

function parseStatus(text) {
  if (!text) return undefined;
  const m = text.match(STATUS_FRONTMATTER_RE);
  return m ? m[1] : undefined;
}

function countCheckedTasks(text) {
  if (!text) return 0;
  return (text.match(/^- \[x\]/gim) ?? []).length;
}

function defaultDiffNameOnly(cwd) {
  return (baseSha, headSha) => {
    const out = execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], {
      cwd,
      encoding: 'utf8',
    });
    return out.split('\n').filter(Boolean);
  };
}

function defaultExists(cwd) {
  return relPath => existsSync(join(cwd, relPath));
}

function defaultListDir(cwd) {
  return relPath => readdirSync(join(cwd, relPath));
}

function defaultReadFile(cwd) {
  return relPath => {
    try {
      return readFileSync(join(cwd, relPath), 'utf8');
    } catch {
      return null;
    }
  };
}

function defaultShowAtRef(cwd) {
  return (ref, relPath) => {
    try {
      return execFileSync('git', ['show', `${ref}:${relPath}`], { cwd, encoding: 'utf8' });
    } catch {
      return null; // file did not exist at that ref — treated as absent frontmatter
    }
  };
}

/** True when a change dir has a spec artifact under EITHER convention (Gap G1). */
function hasNestedSpec(relDir, { exists, listDir }) {
  const specsDir = `${relDir}/specs`;
  if (!exists(specsDir)) return false;
  let entries;
  try {
    entries = listDir(specsDir);
  } catch {
    return false;
  }
  return entries.some(name => exists(`${specsDir}/${name}/spec.md`));
}

/**
 * Extracts the set of touched openspec/changes/** directory names from a list
 * of changed file paths, in first-seen order.
 */
function touchedDirNames(changedFiles) {
  const names = [];
  const seen = new Set();
  for (const f of changedFiles) {
    if (!f.startsWith(CHANGE_DIR_PREFIX)) continue;
    const name = f.slice(CHANGE_DIR_PREFIX.length).split('/')[0];
    if (name && !seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }
  return names;
}

/**
 * Builds one changeDirs entry for evaluatePhaseOrder from filesystem + git-show
 * state. `hasSpec` folds BOTH conventions (Gap G1): a root `spec.md` OR any
 * `specs/*\/spec.md` nested file. `statusBefore`/`statusAfter` are sourced from
 * `tasks.md`'s frontmatter (design §2 — the file this checker also reads
 * `checkedTasks` from), before vs. after this diff. `hasVerification` checks
 * for `verify-report.md` (the sdd-verify artefact convention) — consumed only
 * by `regulated`'s tier-scoped Rule A artefact set (issue #358 Q5, REQ-L4-2′).
 */
function buildChangeDir(name, { exists, listDir, readFile, showAtRef, baseSha, fileMap = ARTEFACT_FILE, customNames = [] }) {
  const relDir = `${CHANGE_DIR_PREFIX}${name}`;
  const tasksPath = `${relDir}/tasks.md`;

  const hasProposal = exists(`${relDir}/proposal.md`);
  const hasDesign = exists(`${relDir}/design.md`);
  const hasTasks = exists(tasksPath);
  const hasSpecRoot = exists(`${relDir}/spec.md`);
  const hasSpec = hasSpecRoot || hasNestedSpec(relDir, { exists, listDir });
  const hasVerification = exists(`${relDir}/verify-report.md`);

  const tasksTextAfter = readFile(tasksPath);
  const checkedTasks = countCheckedTasks(tasksTextAfter);
  const statusAfter = parseStatus(tasksTextAfter);
  const statusBefore = parseStatus(showAtRef(baseSha, tasksPath));

  // #810 — the generic probe: a declared custom stage's presence is read from
  // its RESOLVED file (the same map the message renders), never `${name}.md`.
  const present = {};
  for (const custom of customNames) {
    present[custom] = exists(`${relDir}/${fileMap[custom]}`);
  }

  return { name, hasProposal, hasSpec, hasDesign, hasTasks, hasVerification, checkedTasks, statusBefore, statusAfter, present };
}

/**
 * Gathers `evaluatePhaseOrder`'s `{ changedFiles, changeDirs }` input from git
 * + the filesystem (or from injected `deps` in tests).
 *
 * @param {{ baseSha: string, headSha: string, cwd?: string, deps?: object }} args
 * @returns {{ changedFiles: string[], changeDirs: Array }}
 */
export function gatherPhaseOrderInputs({ baseSha, headSha, cwd = process.cwd(), deps = {}, fileMap = ARTEFACT_FILE, customNames = [] } = {}) {
  const diffNameOnly = deps.diffNameOnly ?? defaultDiffNameOnly(cwd);
  const exists = deps.exists ?? defaultExists(cwd);
  const listDir = deps.listDir ?? defaultListDir(cwd);
  const readFile = deps.readFile ?? defaultReadFile(cwd);
  const showAtRef = deps.showAtRef ?? defaultShowAtRef(cwd);

  const changedFiles = diffNameOnly(baseSha, headSha);
  const changeDirs = touchedDirNames(changedFiles).map(name =>
    buildChangeDir(name, { exists, listDir, readFile, showAtRef, baseSha, fileMap, customNames })
  );

  return { changedFiles, changeDirs };
}

/** Default `readConfig` dep: reads brain.config.json via the shared loader.
 * Never throws — an unreadable/missing config degrades to `{}`, which
 * resolveTier() treats as the 'standard' default (REQ-TIER-10). */
function defaultReadConfig() {
  try {
    return loadBrainConfig();
  } catch {
    return {};
  }
}

/**
 * Builds the uncomputable-diff verdict, tier-scoped per REQ-TIER-3 (issue
 * #358 Q5, finding A): `phase-order`'s policy is `required` at
 * `standard`/`regulated` and `detection` at `lite` (governance-tiers.mjs
 * `GATE_MATRIX['phase-order']`). At a `required` tier the uncomputable diff
 * still FAILS CLOSED (`level: 'fail'`, exit 1) — ADR-0015's recorded
 * precondition for this gate's standard/regulated promotion (Phase 5): a PR
 * whose diff this checker cannot compute must be fixed before merge, never
 * silently waved through. At `lite` (`detection`), REQ-TIER-3 requires this
 * job to still run and still surface the problem, but it MUST exit 0 with a
 * `::warning::`-annotated reason naming the tier — never a hard block at a
 * tier whose policy for this gate is not `required` ("every job whose lite
 * policy is detection exits 0 with a warning annotation stating the tier as
 * the reason"). `mapDetectionToWarning` (governance/detection-policy.mjs,
 * design §8) is the one shared helper every tier-aware check routes an
 * uncomputable-diff result through, rather than duplicating the tier branch
 * here.
 *
 * @param {string} message
 * @param {'lite'|'standard'|'regulated'} tier
 * @returns {{ level: 'warn'|'fail', findings: Array }}
 */
function uncomputableVerdict(message, tier) {
  const mapped = mapDetectionToWarning({ pass: false, reason: message }, tier, GATE_NAME);
  const level = mapped.pass ? 'warn' : 'fail';
  return {
    level,
    findings: [
      {
        rule: 'wrapper',
        level,
        message: mapped.reason,
      },
    ],
  };
}

/**
 * Runs the full L4 phase-order check: gathers inputs (git I/O), evaluates the
 * pure rules, and applies the baseline/grandfather exemption. Never throws —
 * an uncomputable diff (missing BASE_SHA/HEAD_SHA, or a failing git command)
 * is tier-scoped via `uncomputableVerdict()`: it fails closed at
 * `standard`/`regulated` (`resolveGatePolicy('phase-order', tier) ===
 * 'required'`) and degrades to a `::warning::`-annotated `warn` (exit 0) at
 * `lite` (`'detection'`) — REQ-TIER-3, issue #358 Q5 finding A.
 *
 * Rule A's artefact set is tier-scoped (issue #358 Q5, REQ-L4-2′):
 * `deps.tier` overrides tier resolution directly (tests); otherwise the tier
 * is resolved from `deps.readConfig()` (defaults to the real
 * brain.config.json reader) via `resolveTier()` — which itself defaults to
 * `'standard'` when `governance.tier` is absent, so every pre-tiering caller
 * of this function keeps evaluating the historical four-artefact Rule A
 * unchanged.
 *
 * @param {{ cwd?: string, baseSha?: string, headSha?: string, ctx?: object, tier?: string, readConfig?: () => object, deps?: object }} [deps]
 * @returns {{ level: 'pass'|'warn'|'fail', findings: Array }}
 */
export function runPhaseOrderCheck(deps = {}) {
  const cwd = deps.cwd ?? process.cwd();
  const ctx = deps.ctx ?? {};
  const baseSha = deps.baseSha ?? ctx.baseSha;
  const headSha = deps.headSha ?? ctx.headSha;

  const readConfig = deps.readConfig ?? defaultReadConfig;
  const config = readConfig();
  const tier = deps.tier ?? resolveTier(config);
  // #810: the walk set is derived from tier AND declaration; a refused
  // declaration is an uncomputable input, same posture as a missing sha.
  let walk;
  try {
    walk = resolveWalkSet({ config, tier });
  } catch (err) {
    return uncomputableVerdict(`sdd.stages declaration refused: ${err.message}`, tier);
  }
  const { artefacts, fileMap, customNames } = walk;

  if (!baseSha || !headSha) {
    return uncomputableVerdict(
      'diff uncomputable (cannot verify artefact presence): BASE_SHA/HEAD_SHA not set.',
      tier
    );
  }

  let inputs;
  try {
    inputs = gatherPhaseOrderInputs({ baseSha, headSha, cwd, deps, fileMap, customNames });
  } catch (err) {
    return uncomputableVerdict(
      `diff uncomputable (cannot verify artefact presence): ${err.message}`,
      tier
    );
  }

  return applyBaselineExemption(evaluatePhaseOrder({ ...inputs, artefacts, fileMap }));
}

function formatFinding(f) {
  const rulePart = f.rule && f.rule !== 'wrapper' ? `Rule ${f.rule}` : 'wrapper';
  const changePart = f.change ? `${f.change}: ` : '';
  return `  [${f.level}] (${rulePart}) ${changePart}${f.message}`;
}

/**
 * Runs the check, prints the verdict, and returns the process exit code — kept
 * separate from `process.exit()` itself so it stays testable (mirrors
 * run-check.mjs's main()). Exit 0 on pass/warn, 1 on fail.
 *
 * @param {object} [deps]
 * @returns {0|1}
 */
export function main(deps = {}) {
  const result = runPhaseOrderCheck(deps);
  console.log(`phase-order-check: ${result.level}`);
  for (const finding of result.findings) {
    console.log(formatFinding(finding));
  }
  return result.level === 'fail' ? 1 : 0;
}

// ── CLI entrypoint ───────────────────────────────────────────────────────────

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const ctx = await loadContext();
  process.exit(main({ ctx }));
}
