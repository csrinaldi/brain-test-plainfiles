// base-comparison.mjs — the producer `causal_disposition: 'pre-existing'` never had
// (issue #408, M3 residual).
//
// Every layer of the `follow_ups` path shipped except a producer: `verdict.mjs` routes
// `pre-existing`/`base-only` out of the blocking set, `schema-v2.mjs` admits both,
// `reviewer-protocol.md` §Findings documents them, `parseVerdict` reads the block back.
// No evaluator ever emitted either value, so the routing branch was unreachable in
// production and `follow_ups` was always `[]`. #381 moved it from broken to EMPTY, not
// to working.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO MEASUREMENTS DECIDED THIS DESIGN, and the first one killed the obvious version.
//
// (1) THE OBVIOUS DESIGN IS INERT HERE. The natural comparator reads the base commit's
//     own check-run rollup and asks "was this gate already red?". Measured on
//     `csrinaldi/brain` at `1e05960`: `governance.yml` triggers on `pull_request` ONLY,
//     so a commit on `main` carries `m4-danger-paths`, `audit-and-revert` and
//     `relabel-retrigger` — and NOT ONE of the eight governance gates. A rollup-based
//     comparator would find no base entry for any required gate, classify nothing, and
//     stay green in every test while never firing in production. That is #335's class
//     exactly, and it is why this module RE-RUNS the check at base instead of reading a
//     status somebody else recorded.
//
// (2) SIX OF THE EIGHT REQUIRED JOBS CANNOT INHERIT A FAILURE — `diff-size` measures
//     `base...head`, `issue-link`/`decision-gate`/`phase-order` read this PR's body and
//     this change's artefacts, `actor-check`/`brain-writes-reviewed` read this PR's
//     approval and authorship. A defect in any of them is this change's doing by
//     definition; asking whether it "exists on base" is not a hard question, it is a
//     meaningless one.
//
//     TWO CAN. `local-checks` runs `repo:check`, `brain:nav` and the unit suite over
//     the TREE, and a tree can be broken before this branch touched it. And
//     `memory-gate` — corrected by a cold review of this file, which caught the
//     original claim of "seven" — reads `.memory/records/` from the CHECKED-OUT TREE
//     (`defaultReadRecords`, and `memory-presence.mjs`'s own note: *"it verifies that
//     the repo has AT LEAST ONE session summary captured, EVER"*), so a repo that never
//     captured one fails it identically at base and at head.
//
//     Only `local-checks` is in the set below, and that is a scope decision rather
//     than the measurement: `memory-gate` is not reproduced by RUNNING A COMMAND — it
//     needs the check's own reader pointed at the base worktree, a second mechanism —
//     and it is `detection` at `lite`, so it never blocks brain itself. Tracked
//     separately rather than smuggled in behind a table that says "commands".
//
// So the honest producer is narrow on purpose: one gate, re-derived at base, in a
// throwaway worktree. It answers #408's design question 1 — *"is the base...head diff
// sufficient, or does an honest claim need the finding re-run against a base checkout
// (as the reversion check does)?"* — with the second option, and the reason is (1).
// ─────────────────────────────────────────────────────────────────────────────
//
// WHAT THIS DELIBERATELY DOES NOT PRODUCE. `base-only` ("exists only on the base, not
// touched by this diff") has no honest producer among brain's checks: every finding
// brain emits is either about this PR or about a tree the PR is part of, so nothing it
// can observe is base-ONLY. The value stays documented, admitted by the schema and
// routed by `verdict.mjs` — and unproduced, stated rather than invented.
// `causal-admission.mjs`'s own rule applies to this module too: inventing the claim
// would be worse than omitting it. Both values route to the same branch, so the branch
// becomes reachable on `pre-existing` alone.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/**
 * Gates whose failure brain can HONESTLY re-derive at base.
 *
 * One entry, and that is measurement (2) above, not a placeholder. What makes
 * re-running feasible at all is that brain declares ZERO runtime and dev dependencies:
 * every command below runs in a bare `git worktree` with no install step.
 */
export const BASE_REPRODUCIBLE_GATES = Object.freeze(['local-checks']);

/** The marker `governance.yml` itself gates its `npm test` step on. */
const BRAIN_SOURCE_MARKER = '.brain-source';

/**
 * The commands that reproduce `gate` inside `worktreePath` — MIRRORING the workflow
 * step for step, including its condition.
 *
 * `governance.yml`'s `local-checks` job runs `repo:check` and `brain:nav`
 * unconditionally and the unit suite only `if: hashFiles('.brain-source') != ''` —
 * the marker is present in the brain SOURCE repo and absent in every consumer. So a
 * consumer's `local-checks` is two fast node scripts, and only brain's own repo pays
 * for the suite. Re-deriving that condition here rather than always running the suite
 * is not an optimisation: running a suite the gate never ran would answer a question
 * nobody asked, and a base probe that claims "the gate fails at base" must run what
 * the gate runs.
 *
 * The marker is read from the BASE worktree, not from cwd. Whether the repo is a brain
 * source checkout is a property of the tree being probed.
 *
 * @param {string} gate @param {string} worktreePath @param {(p: string) => boolean} exists
 * @returns {Array<[string, string[]]>}
 */
export function commandsFor(gate, worktreePath, exists = existsSync) {
  if (gate !== 'local-checks') return [];
  const cmds = [
    ['node', ['./brain/scripts/check-refs.mjs']],
    ['node', ['./brain/scripts/check-brain-nav.mjs']],
  ];
  if (exists(join(worktreePath, BRAIN_SOURCE_MARKER))) {
    cmds.push(['node', ['--test', 'brain/scripts/**/*.test.mjs', 'test/**/*.e2e.test.mjs']]);
  }
  return cmds;
}

/** `gate:local-checks` → `local-checks`; anything else → null. */
export function gateNameOf(finding) {
  const m = /^gate:(.+)$/.exec(finding?.id ?? '');
  return m ? m[1] : null;
}

/**
 * Is this finding one a base re-run could speak to AND one that currently blocks?
 *
 * BOTH halves are load-bearing. The gate half is measurement (2) above. The blocker
 * half is the laziness rule (#408 design question 3): re-running the suite at base is
 * the most expensive thing the reviewer can do, and it is only worth doing when the
 * answer changes a verdict. An editorial finding routed to `follow_ups` reads slightly
 * better and blocks exactly as much as before — nothing.
 */
export function needsBaseProbe(findings = []) {
  return findings.some(f => f?.severity === 'blocker' && BASE_REPRODUCIBLE_GATES.includes(gateNameOf(f)));
}

/**
 * Re-runs the reproducible gates at `baseSha`, in a detached throwaway worktree.
 *
 * COLDBOOT-CWD ISOLATION (protocol §8), copied deliberately from
 * `checkpoint.mjs`'s `defaultRunReversion`: never `git checkout` in the operator's cwd,
 * always a separate detached worktree, always torn down in `finally`. That function is
 * the precedent for "run something at base" in this codebase and the reason #408 asks
 * whether an honest claim needs a base checkout — reusing its shape rather than
 * inventing a second isolation discipline.
 *
 * NEVER THROWS, and a failure is `null` — UNCOMPUTABLE, not "nothing was already
 * broken". The caller must keep such findings blocking; see `classifyAgainstBase`.
 *
 * `NODE_TEST_CONTEXT` is stripped from the child env for the reason
 * `defaultRunReversion` records: when this code itself runs under `node --test`, the
 * inherited variable trips node's recursive-test guard, the child silently SKIPS every
 * file and exits 0 — which here would read as "the suite passes at base", the exact
 * inversion of the claim being made.
 *
 * @param {{ baseSha: string|null, gates: string[], cwd?: string, tmp?: string, _exec?: Function }} args
 * @returns {{ failed: string[], unreproducible: string[], command: string }|null}
 */
export function probeBase({ baseSha, gates = [], cwd = process.cwd(), tmp = tmpdir(), _exec, _exists = existsSync, _mkdtemp = mkdtempSync, _rm = rmSync } = {}) {
  if (!baseSha || gates.length === 0) return null;
  const exec = _exec ?? ((file, args, opts) => execFileSync(file, args, opts));
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  // A PER-RUN path, not one derived from the base sha. Keying it on the sha looked
  // tidy and was a race: two PRs branched off the same `main` tip — the common case,
  // not an exotic one — share the path, and the second run's teardown deletes the
  // first run's LIVE worktree. Its next command then fails, which (before the
  // `err.status` discipline below) read as "the gate is red at base" and deferred a
  // real blocker on a perfectly healthy base. Found by a cold review of this file.
  const worktreePath = _mkdtemp(join(tmp, 'brain-review-base-'));

  try {
    exec('git', ['worktree', 'add', '--detach', worktreePath, baseSha], { cwd, encoding: 'utf8' });

    const failed = [];
    const unreproducible = [];
    const ran = [];
    for (const gate of gates) {
      const commands = commandsFor(gate, worktreePath, _exists);
      if (commands.length === 0) continue;

      // THE SCRIPT MUST EXIST AT BASE. A gate whose command is missing from the base
      // tree was not "red at base" — it could not be RUN there, which is a different
      // fact and the opposite verdict. Real case: a PR that vendors brain for the
      // first time, or renames a check script; its base has no `brain/scripts/`, every
      // command fails to spawn, and the naive reading defers every blocker it has.
      const missing = commands.filter(([, args]) => !_exists(join(worktreePath, args[args.length - 1])) && !args.includes('--test'));
      if (missing.length > 0) { unreproducible.push(gate); continue; }

      let outcome = 'green';
      for (const [file, args] of commands) {
        ran.push(`${file} ${args.join(' ')}`);
        try {
          // `maxBuffer` explicit: the default is 1 MiB and this branch's own suite
          // already emits ~776 KB on a GREEN run. Crossing it throws ENOBUFS and
          // SIGTERMs the child — which, without the discipline below, would read as
          // "the suite fails at base". `stdio` captures rather than inherits, so a
          // base run's stack traces do not surface in brain:review's own stderr.
          exec(file, args, { cwd: worktreePath, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
          // THE DISTINCTION THIS WHOLE MODULE RESTS ON, and it was missing until a
          // cold review found it. `execFileSync` throws for two unrelated reasons:
          //   · a numeric non-zero `status` — the command RAN and the gate is red;
          //   · everything else (`status` null/undefined: ENOENT, ENOBUFS, a signal)
          //     — the command never produced a verdict at all.
          // Collapsing them makes a reader's own failure into the gate's approval:
          // `pre-existing` → `follow_ups[]` → REVISE softens to APPROVE. That is
          // `evidence-reader-empty-on-failure` inverted, one layer below where anyone
          // is looking, and it is a FALSE PASS — the direction this module claims it
          // can never take.
          outcome = Number.isInteger(err?.status) && err.status !== 0 ? 'red' : 'unreproducible';
          break;
        }
      }
      if (outcome === 'red') failed.push(gate);
      else if (outcome === 'unreproducible') unreproducible.push(gate);
    }
    return { failed, unreproducible, command: `git worktree add --detach <base> && ${ran.join(' && ')}` };
  } catch {
    // A git/fs failure is uncomputable evidence, never a crash and never a verdict.
    return null;
  } finally {
    try {
      exec('git', ['worktree', 'remove', '--force', worktreePath], { cwd, encoding: 'utf8' });
    } catch {
      // Belt behind the belt (#842): when the remove itself fails — a crashed
      // add, a path git no longer recognizes — the mkdtemp'd dir still dies.
      // And the REGISTRATION dies with it (#843 round 2): a bare rm leaves a
      // stale .git/worktrees/ entry in the operator's real repo — the exact
      // invariant this PR's own cold-boot test pins.
      try { _rm(worktreePath, { recursive: true, force: true }); } catch { /* best effort */ }
      try { exec('git', ['worktree', 'prune'], { cwd, encoding: 'utf8' }); } catch { /* best effort */ }
    }
  }
}

/**
 * Re-classifies findings the base probe can speak to. Pure.
 *
 * THREE OUTCOMES, and the middle one is the whole point:
 *   · the gate is red at base too  → `causal_disposition: 'pre-existing'`, and
 *     `verdict.mjs` routes it to `follow_ups[]` instead of blocking on it.
 *   · the gate is GREEN at base    → this change broke it. Left as `introduced`.
 *   · the probe could not run      → left as `introduced`, and the inability is
 *     reported as a condition.
 *
 * THE UNCOMPUTABLE CASE IS NOT `unknown`, deliberately. `unknown` forces `STOP` +
 * `escalate: human` on every affected finding (protocol §Findings), so a base probe
 * that failed for infrastructure reasons would summon a human for every gate finding
 * on every PR — the "escalation storm" #394 exists to prevent. Leaving the finding
 * `introduced` keeps it BLOCKING, which is the safe direction: a failed base check
 * costs a false block, never a false pass.
 *
 * The evidence is EXTENDED, never replaced. A reader has to be able to see both the
 * original gate quote and the base observation that reclassified it; a finding that
 * says only "it is pre-existing" is a claim without the thing it is a claim about.
 *
 * @param {{ findings?: Array<object>, baseProbe?: {failed: string[], unreproducible?: string[], command: string}|null, probeAttempted?: boolean }} args
 * @returns {{ findings: Array<object>, conditions: string[] }}
 */
export function classifyAgainstBase({ findings = [], baseProbe = null, probeAttempted = false } = {}) {
  if (!baseProbe) {
    // Nothing was asked (no base-comparable blocker) → silence, not a condition:
    // reporting "could not compare" on a review that never needed to would be noise.
    if (!probeAttempted) return { findings, conditions: [] };
    return {
      findings,
      conditions: [
        'evidence uncomputable: base comparison (worktree at base unavailable) — '
        + 'gate findings stay blocking rather than being deferred unverified',
      ],
    };
  }

  const failed = new Set(baseProbe.failed ?? []);
  const unreproducible = new Set(baseProbe.unreproducible ?? []);
  const out = findings.map((f) => {
    const gate = gateNameOf(f);
    if (!gate || !failed.has(gate)) return f;
    return {
      ...f,
      causal_disposition: 'pre-existing',
      // "ALSO red at base", not "the SAME failure". What the probe observed is that a
      // gate WITH THIS NAME is red at base — a base broken for reason A under a head
      // broken for reason B looks identical to it. The weaker word is the true one,
      // and the evidence carries the command so a reader can go further than the probe
      // could.
      evidence: `${f.evidence} — ${gate} is ALSO red at base: ${baseProbe.command}`,
    };
  });

  // A gate that could not be REPRODUCED at base is not a gate that passed there. Its
  // finding keeps blocking (the safe direction) and the inability is named, per gate,
  // so the reason is actionable rather than a shrug.
  const conditions = [...unreproducible]
    .filter(g => findings.some(f => gateNameOf(f) === g))
    .map(g => `evidence uncomputable: ${g} could not be re-run at base (command absent, or it never produced an exit status)`);

  return { findings: out, conditions };
}
