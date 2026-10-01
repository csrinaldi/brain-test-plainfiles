// sdd-layout.mjs — the single source of truth for the canonical openspec/changes/**
// layout (issue #250, slice B0). Pure ESM, no side effects at import, fs-injectable
// (mirrors vcs/phase-order-check.mjs's DI discipline: every I/O op is injectable,
// real fs only as the default). B0 ships this accessor; B1 wires the six measured
// call sites onto it (see openspec/changes/issue-250-b0/tasks.md — B1 worklist).

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';



/**
 * The file each tier-table artefact name resolves to (#555).
 *
 * NOT a suffix rule. `verification` is `verify-report.md` — the sdd-verify
 * convention `phase-order-check.mjs` has always probed. The first cut of #555
 * derived filenames by appending `.md`, which produced `verification.md`: a file
 * this repository writes nowhere. A `regulated` change carrying all five REAL
 * artefacts then passed `phase-order` and failed `check-refs` — #555's own
 * complaint, relocated from `lite` to `regulated`.
 *
 * The mapping used to exist twice — here as a suffix, and in `phase-order-check`'s
 * `buildChangeDir` as explicit probes — and they disagreed. This is the one copy.
 * `phase-order`'s missing-artefact MESSAGE reads from it too: that message carried
 * the same defect before #555 touched anything, naming `verification.md` for a
 * probe of `verify-report.md`.
 */
export const ARTEFACT_FILE = Object.freeze({
  proposal: 'proposal.md',
  spec: 'spec.md',
  design: 'design.md',
  tasks: 'tasks.md',
  verification: 'verify-report.md',
});

/**
 * Bare artefact names → the files they are written as. Refuses an unknown name
 * rather than guessing, because guessing is exactly what produced the blocker:
 * a name with no file behind it is a config error, and inventing one hides it
 * until a consumer at that tier cannot satisfy a gate it has already satisfied.
 *
 * @param {string[]} names
 * @param {Record<string,string>} [fileMap] defaults to the frozen `ARTEFACT_FILE`.
 *   `resolveStageSet` (issue #456 slice A, design D3) passes a per-call merge of
 *   `{...ARTEFACT_FILE, ...declared}` here so a consumer's custom stage resolves
 *   through the SAME refusal path as the four — the unknown-name refusal stays
 *   intact for both, "which map is consulted" changed, not whether one is.
 * @returns {string[]}
 */
export function artefactFiles(names, fileMap = ARTEFACT_FILE) {
  return names.map((name) => {
    const file = fileMap[name];
    if (!file) {
      throw new Error(
        `sdd-layout: unknown artefact name "${name}" — no file is declared for it. ` +
        'Appending ".md" would invent a path no gate probes (#555).',
      );
    }
    return file;
  });
}

/**
 * The four SDD lifecycle stages, in canonical order (issue #456 slice A, the
 * maintainer's additive-only ruling). THE ONE declaration: `stage-engine.mjs`'s
 * `SDD_LIFECYCLE_STAGES` and `phase-order-check.mjs`'s default `artefacts` param
 * both import this instead of holding their own bare-name literal (design §1 —
 * the set was declared THREE times, and the drift guard only saw the `.md`
 * notation, so it was blind to two of the three).
 *
 * NOT config-dependent — additive-only guarantees these four are always
 * present in a resolved set, so nothing that needs "the four" (`assertRoutableStage`'s
 * refusal, the phase-order positional sentinel) needs `resolveStageSet` at all;
 * it reads this constant directly and stays untouched by a consumer's declaration.
 */
export const LIFECYCLE_STAGES = Object.freeze(['proposal', 'spec', 'design', 'tasks']);

/**
 * The SCAFFOLD set: what `brain:project:feature` writes into a new change dir.
 * Four, at every tier.
 *
 * This is NOT what the gates demand — that is tier-scoped, `requiredArtifactsFor`
 * (governance-tiers.mjs). REQ-L4-2′ draws the line in as many words: "the tier
 * scopes what the GATE demands, never what the SCAFFOLD produces." #555's first
 * cut deleted this constant while fixing the gate question, collapsing two things
 * the spec deliberately separates.
 */
export const REQUIRED_ARTIFACTS = Object.freeze(artefactFiles(LIFECYCLE_STAGES));

/**
 * Resolves `config.sdd.stages` against the four, additive-only (maintainer
 * ruling, 2026-08-29, engram `sdd/issue-456-stage-set/ruling-additive-only`):
 * a consumer may declare stages BEYOND the four; it may never omit or reorder
 * one relative to the others (D5/D5a). PURE — `config` is RECEIVED, never
 * read: this module's header promises no side effects at import, and #555's
 * first cut broke exactly that promise once, caught by a fixture (D1's "hard
 * constraint discovered"). The edge (whatever loads `brain.config.json`) is
 * responsible for reading it; this function only resolves what it is given.
 *
 * Absent-or-empty `sdd.stages` is the ABSENCE of a declaration, not a
 * declaration of zero stages — it resolves to the default four. This is the
 * shape the `0.11.0` migration ships on every existing consumer (`{}`),
 * because writing the four into JSON would be a FOURTH declaration of the set,
 * in a file the drift guard (Phase 5, scans `brain/scripts/**\/*.mjs`) cannot
 * see at all.
 *
 * Full-set semantics, not delta: a declared `sdd.stages` enumerates the WHOLE
 * set, so omitting one of the four is refused rather than being structurally
 * impossible. Delta semantics (only declare the extras) is arguably safer but
 * is rejected (design D5): the maintainer ruled for a refusal that names WHICH
 * of the four are missing, which delta semantics could never fire, and the
 * unknown-stage refusal below wants one list to validate a custom stage's
 * artefact against rather than a union recomputed per call.
 *
 * @param {{sdd?: {stages?: Record<string, {artefact?: string}>}}} [config]
 * @returns {{stages: string[], files: Record<string,string>}}
 * @throws when a declared set omits one of the four (naming the missing
 *   stage(s)), reorders them relative to each other (D5a — refused, not
 *   normalised: `phase-order-check.mjs`'s message sentinel compares
 *   positionally and a silently reordered declaration would flip it without
 *   telling the operator), or a declared artefact collides with an existing
 *   lifecycle file (a custom stage impersonating a gate artefact "changes
 *   what the gates demand", which ADR-0019 Amendment 1 withholds)
 */
export function resolveStageSet(config) {
  const declared = config?.sdd?.stages;
  const names = declared && typeof declared === 'object' ? Object.keys(declared) : [];

  if (names.length === 0) {
    return {
      stages: [...LIFECYCLE_STAGES],
      files: Object.fromEntries(LIFECYCLE_STAGES.map((name) => [name, ARTEFACT_FILE[name]])),
    };
  }

  const missing = LIFECYCLE_STAGES.filter((stage) => !names.includes(stage));
  if (missing.length > 0) {
    throw new Error(
      `sdd-layout: sdd.stages omits lifecycle stage(s) ${missing.map((s) => `"${s}"`).join(', ')} — the SDD ` +
      'stage set is ADDITIVE-ONLY. A consumer may declare stages beyond the four; it may not remove one. ' +
      'Removing a lifecycle stage changes what the gates demand, which ADR-0019 Amendment 1 ("What this ' +
      'amendment does NOT authorise") withholds and #456\'s ruling settled. Declare all four and add yours ' +
      'alongside them.',
    );
  }

  // D5a — relative order, refused rather than normalised: normalisation has no
  // defined answer once a custom stage interleaves with the four (which of two
  // neighbouring canonical stages does it sort next to?), and it would silently
  // rewrite a declaration the fail-closed posture elsewhere in this repo
  // (`resolveTier`'s unknown-tier refusal) already treats as the wrong move.
  const declaredLifecycleOrder = names.filter((name) => LIFECYCLE_STAGES.includes(name));
  const canonicalSubsequence = LIFECYCLE_STAGES.filter((stage) => declaredLifecycleOrder.includes(stage));
  const inOrder = declaredLifecycleOrder.every((stage, i) => stage === canonicalSubsequence[i]);
  if (!inOrder) {
    throw new Error(
      'sdd-layout: sdd.stages declares the four lifecycle stages out of relative order — expected ' +
      `${LIFECYCLE_STAGES.join(', ')} (custom stages may interleave between them; the four may not swap ` +
      'places relative to each other). A declared order is not normalised: phase-order-check.mjs\'s gate ' +
      'message compares positionally, and reordering a consumer\'s declaration behind their back would ' +
      'rewrite intent instead of reporting it (D5a).',
    );
  }

  // Shape validation (#810 final round) — a declared name and artefact are
  // IDENTIFIERS, never paths. The reviewer wrote a config with
  // `artefact: "../../../escaped.md"` and the scaffold put a file at the REPO
  // ROOT while the gate's probe traversed the same way — a config string
  // reaching the filesystem unvalidated, the same class as #841's shell
  // injection. Names follow #823's hostile-segment discipline (a key like
  // `__proto__` lands in a spread-built file map); artefacts are bare .md
  // filenames — no separators, no leading dot, nothing for join() to walk.
  for (const [name, entry] of Object.entries(declared)) {
    // `constructor` passes the kebab regex and still poisons a spread-built
    // map — the exact reason #576's ARCHETYPES is a Map and #823 refuses
    // these three segments. Checked by name, not by regex.
    if (!/^[a-z][a-z0-9-]*$/.test(name) || name === 'constructor' || name === 'prototype') {
      throw new Error(
        `sdd-layout: sdd.stages key "${name}" is not a plain stage identifier (lowercase kebab, ` +
        'never a prototype-chain name). Stage names become object keys and path parts; anything ' +
        'else is refused.',
      );
    }
    const artefact = entry?.artefact;
    if (artefact === undefined) continue;
    if (typeof artefact !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.md$/.test(artefact) || artefact.includes('/') || artefact.includes('\\')) {
      throw new Error(
        `sdd-layout: sdd.stages["${name}"].artefact ${JSON.stringify(artefact)} is not a bare .md ` +
        'filename. An artefact is a file IN the change dir — no path separators, no leading dot, ' +
        'no traversal: a declared path would escape the one layout every reader assumes.',
      );
    }
  }

  // Lifecycle-rename collision (#810 round 3) — the FOUR may not rename their
  // own artefacts. Gate flags (`hasProposal` probes `proposal.md`), the
  // scaffold's artifactPaths, requiredArtifactsFor and the reviewer checkpoint
  // all read the four through fixed vocabulary; honoring a rename here would
  // fork the resolver's answer from every other reader's — the operator told
  // their config is valid while no gate ever recognises the renamed file.
  // Amendment 5 authorises a CUSTOM stage's artefact joining the contract; it
  // does not authorise changing what the gates demand of the four. Declaring
  // the OWN canonical file stays legal — slice A's 1.3b ruled the collision
  // refusal skips the owner, and this refusal honours the same line.
  for (const [name, entry] of Object.entries(declared)) {
    if (LIFECYCLE_STAGES.includes(name) && entry?.artefact !== undefined && entry.artefact !== ARTEFACT_FILE[name]) {
      throw new Error(
        `sdd-layout: sdd.stages["${name}"].artefact is not declarable — the four lifecycle stages' ` +
        `files are canon ("${name}" is always "${ARTEFACT_FILE[name]}"). Declaring a different file ` +
        'changes what the gates demand, which ADR-0019 Amendment 5 does not authorise; declare the ' +
        'stage bare ({}) and add custom stages alongside it instead.',
      );
    }
  }

  // Reserved-name collision (#810 round 2) — a declared stage may not take a
  // name from the FIXED vocabulary outside the declarable four ("verification"
  // today; anything ARTEFACT_FILE learns tomorrow). The gate reads such names
  // through fixed boolean flags while the message renders the resolved map —
  // letting the declaration through forks the two: Rule A would demand
  // verify-report.md while the failure message names the overridden file.
  for (const name of names) {
    if (!LIFECYCLE_STAGES.includes(name) && Object.hasOwn(ARTEFACT_FILE, name)) {
      throw new Error(
        `sdd-layout: sdd.stages["${name}"] takes a reserved vocabulary name — "${name}" is fixed tier ` +
        'vocabulary (its file and presence flag are not declarable). Choose another stage name.',
      );
    }
  }

  // File collision — a declared artefact impersonating one of the fixed
  // lifecycle/verification files. Checked BEFORE the unknown-name refusal
  // below so the more specific "impersonation" message wins over the generic
  // "no file declared" one when both could apply.
  for (const [name, entry] of Object.entries(declared)) {
    const artefact = entry?.artefact;
    if (!artefact) continue;
    const collidesWith = Object.entries(ARTEFACT_FILE).find(
      ([lifecycleName, file]) => file === artefact && lifecycleName !== name,
    );
    if (collidesWith) {
      throw new Error(
        `sdd-layout: sdd.stages["${name}"].artefact "${artefact}" collides with an existing lifecycle file ` +
        `(already "${collidesWith[0]}"'s file) — a custom stage may not impersonate a gate artefact. That ` +
        'changes what the gates demand, which ADR-0019 Amendment 1 withholds.',
      );
    }
  }

  // Operational-name collision (#810 confirmation round) — the fixed-file loop
  // above guards ARTEFACT_FILE only, and resume.md lives outside it: a
  // machine-written convention whose mere EXISTENCE feature-resolution reads
  // as "actively worked", and whose content engram merges against
  // resume-schema's required fields. A scaffolded stub satisfies neither.
  // Same class as rounds 2 and 4, against the operational namespace.
  for (const [name, entry] of Object.entries(declared)) {
    const artefact = entry?.artefact;
    if (artefact && OPERATIONAL_ARTIFACTS.includes(artefact)) {
      throw new Error(
        `sdd-layout: sdd.stages["${name}"].artefact "${artefact}" collides with an OPERATIONAL ` +
        'artifact — machine-written, never a gate condition, and read by its own consumers ' +
        '(feature-resolution, engram checkpoints). A declared stage may not impersonate it.',
      );
    }
  }

  // Duplicate-artefact collision (#810 round 4) — two DECLARED stages naming
  // one file. The fixed-vocabulary loop above cannot see it (it compares
  // against ARTEFACT_FILE only), and downstream one exists() would satisfy
  // both demands at once — the walk collapses two declarations into one file.
  const declaredFiles = new Map();
  for (const [name, entry] of Object.entries(declared)) {
    const artefact = entry?.artefact;
    if (!artefact) continue;
    const owner = declaredFiles.get(artefact);
    if (owner !== undefined) {
      throw new Error(
        `sdd-layout: sdd.stages["${name}"].artefact "${artefact}" is already declared by stage ` +
        `"${owner}" — two stages may not share one file. One artefact is one demand; a shared file ` +
        'would let a single write satisfy both, and the phase-order walk could no longer tell the ' +
        'stages apart.',
      );
    }
    declaredFiles.set(artefact, name);
  }

  // D3 — per-call merge `{...ARTEFACT_FILE, ...declared artefacts}`, never a
  // mutation of the frozen default map. A declared stage's `artefact` is
  // optional: absent means "look it up in ARTEFACT_FILE", which is what the
  // four do by not naming one.
  const fileMap = { ...ARTEFACT_FILE };
  for (const [name, entry] of Object.entries(declared)) {
    if (entry?.artefact) fileMap[name] = entry.artefact;
  }

  const resolvedFiles = artefactFiles(names, fileMap);
  return { stages: names, files: Object.fromEntries(names.map((name, i) => [name, resolvedFiles[i]])) };
}

/** Machine-written, never required, staleness expected & discardable. NEVER a gate condition. */
export const OPERATIONAL_ARTIFACTS = Object.freeze(['resume.md']);

/** Root under which all in-flight change dirs live (POSIX-relative). */
export const CHANGES_ROOT = 'openspec/changes';

// Grandfather = past only. This list is sealed at B0; adding an entry requires
// ADR-level justification — a NEW change dir must never appear here.
/** EXACTLY the 12 legacy dirs measured at B0 (#584) that lack a flat spec.md. CLOSED AND FROZEN. */
export const LEGACY_GRANDFATHERED = Object.freeze([
  'installer-versionado', 'vcs-adapter', 'cli-i18n',
  'feature-working-memory', 'auto-adrs', 'governance',
  'managed-paths-namespace', 'issue-138-session-start',
  'issue-144-governance-v3', 'install-home-scaffold',
  'issue-193-ci-context-design', 'issue-196-ci-context-impl',
]);

/** `openspec/changes/<changeId>` (POSIX-relative). */
export function changeDir(changeId) {
  return `${CHANGES_ROOT}/${changeId}`;
}

/** The four scaffolded artifact paths under `changeDir(changeId)`. */
export function artifactPaths(changeId) {
  const dir = changeDir(changeId);
  return {
    proposal: `${dir}/proposal.md`,
    spec: `${dir}/spec.md`,
    design: `${dir}/design.md`,
    tasks: `${dir}/tasks.md`,
  };
}

/** `openspec/changes/archive/<iid>` — the accessor OWNS this location (design §5). */
export function archivePath(iid) {
  return `${CHANGES_ROOT}/archive/${iid}`;
}

const CHANGE_ID_RE = /^issue-(\d+)(?:-(.+))?$/;

/**
 * Parses `issue-<N>-<slug>` (or the bare `issue-<N>` violation shape).
 * @returns {{iid: string, slug: string|null}|null}
 */
export function parseChangeId(name) {
  const m = typeof name === 'string' ? name.match(CHANGE_ID_RE) : null;
  if (!m) return null;
  return { iid: m[1], slug: m[2] ?? null };
}

/** True when `changeId` is one of the sealed 12 legacy dirs. */
export function isGrandfathered(changeId) {
  return LEGACY_GRANDFATHERED.includes(changeId);
}

function defaultExists(relPath) {
  return existsSync(join(process.cwd(), relPath));
}

function defaultListDir(relPath) {
  return readdirSync(join(process.cwd(), relPath));
}

/**
 * True when `changeId` has a spec artifact under EITHER convention: flat
 * `spec.md` (canonical for new changes) OR nested `specs/*\/spec.md`
 * (LEGACY-ACCEPTED — readers tolerate it, the scaffold never produces it).
 * The ONE place the nested variant is tolerated (Pin 1).
 */
export function hasSpec(changeId, { exists = defaultExists, listDir = defaultListDir } = {}) {
  const dir = changeDir(changeId);
  if (exists(`${dir}/spec.md`)) return true;
  const specsDir = `${dir}/specs`;
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
 * The missing artifacts for `changeId`, against the set PASSED IN. Grandfathered dirs
 * short-circuit to `[]` — "the past is recorded, not edited." The spec slot
 * delegates to `hasSpec` so a nested spec still counts as present.
 * @returns {string[]}
 */
export function missingRequiredArtifacts(
  changeId,
  { artefacts, exists = defaultExists, listDir = defaultListDir } = {},
) {
  // #555: the required set is RECEIVED, never held here. `requiredArtifactsFor`
  // (governance-tiers.mjs) resolves it from the declared tier; this module keeps
  // no list of its own, so there is exactly one in the system and no second copy
  // to drift. `artefacts` is mandatory on purpose — a default would be that
  // second list wearing a different name.
  if (!Array.isArray(artefacts)) {
    throw new TypeError(
      'missingRequiredArtifacts: `artefacts` is required — pass requiredArtifactsFor(tier). ' +
      'A default here would reintroduce the two-set divergence #555 removed.',
    );
  }
  if (isGrandfathered(changeId)) return [];
  const dir = changeDir(changeId);
  const missing = [];
  for (const artifact of artefacts) {
    const present = artifact === 'spec.md' ? hasSpec(changeId, { exists, listDir }) : exists(`${dir}/${artifact}`);
    if (!present) missing.push(artifact);
  }
  return missing;
}

// ── brain-slice-scope/1 (issue #323 S5) ─────────────────────────────────────
//
// The maintainer's reframing on #752, made contract: `tasks.md` carries SCOPE
// (which requirements a slice CLAIMS — the reviewer cannot judge without it)
// and PLAN (the task list — the implementer's approach, rightly withheld from
// review). One file, so withholding the plan withheld the scope; that was the
// whole bug. The block separates them: a reviewer can someday be handed the
// BLOCKS without the file. Termination rides the same declaration — #713's
// `Terminal PR:` rule, normalized out of the external skill's throwaway patch.
//
// JSON, never JS — the promote-migration precedent: nothing in an artifact is
// ever eval'd. ABSENCE IS LEGAL (legacy is grandfathered by absence, not by
// list); a DECLARED block must be valid — the structure check refuses a
// malformed one repo-wide, because a contract someone wrote and nobody can
// parse is worse than none.

export const SLICE_SCOPE_TAG = 'brain-slice-scope/1';
const SLICE_SCOPE_RE = new RegExp('```' + SLICE_SCOPE_TAG + '\\n([\\s\\S]*?)```', 'g');

/**
 * @param {string} text A tasks.md body.
 * @returns {{scopes: Array<{slice: number, claims: string[], terminal_pr: string}>, refusal: string|null}}
 */
export function parseSliceScopes(text) {
  const scopes = [];
  for (const m of String(text ?? '').matchAll(SLICE_SCOPE_RE)) {
    let entry;
    try {
      entry = JSON.parse(m[1]);
    } catch (err) {
      return { scopes: [], refusal: `slice-scope: a ${SLICE_SCOPE_TAG} block is not JSON (${err.message}) — nothing in an artifact is ever eval'd.` };
    }
    if (typeof entry?.slice !== 'number') {
      return { scopes: [], refusal: 'slice-scope: `slice` must be a number — the block names WHICH slice claims what.' };
    }
    if (!Array.isArray(entry.claims) || entry.claims.some((c) => typeof c !== 'string' || c.length === 0)) {
      return { scopes: [], refusal: 'slice-scope: `claims` must be an array of requirement ids — the scope a reviewer judges against, and the over-claim question needs it exact.' };
    }
    if (typeof entry.terminal_pr !== 'string' || entry.terminal_pr.length === 0) {
      return { scopes: [], refusal: 'slice-scope: `terminal_pr` is required — a chain that stops halfway must differ from one that finished (#713), and the declaration is where the difference starts.' };
    }
    scopes.push({ slice: entry.slice, claims: entry.claims, terminal_pr: entry.terminal_pr });
  }
  return { scopes, refusal: null };
}
