#!/usr/bin/env node
// cli.mjs — REQ-H1-5, REQ-H1-7, REQ-H1-8, REQ-H1-9, REQ-H1-10, REQ-H1-11:
// `brain:review` CLI. Wires identity → cold-boot → mode derivation (R6) →
// the tranche/checkpoint/ruling evaluator → verdict → the poster. `ruling`
// (H1-4, Option B — issue #266 comment 5009584044) NEVER auto-rules; a
// well-formed `## FORK` always escalates. `queue`/`board` dispatch land in
// H1-5 (design.md §9). Reviewer protocol version (`brain-review/1` vs `/2`)
// is resolved from `governance.tier` (`resolveTier`/`tierParams`,
// governance-tiers.mjs) once per run, per issue #391 T2.3 §3/§5 and issue
// #394 M3 — `regulated` defaults to `/2` and runs its findings through
// `lib/causal-admission.mjs` (evidence_class/causal_disposition annotation +
// the lazy refuter, issue #284) before `buildVerdict`; `lite`/`standard`
// default to `/1`, unchanged from pre-#394 behavior.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

import { loadBrainConfig } from '../lib/brain-config.mjs';
import { loadContext } from '../vcs/ci-context.mjs';
import { getVcs } from '../vcs/cli.mjs';
import { resolveTier, tierParams, resolveReviewProtocol } from '../vcs/governance-tiers.mjs';
import { makeArtifactGenerate } from './lib/findings-artifact.mjs';
import { gatherIdentity } from './identity.mjs';
import { gatherColdBoot } from './cold-boot.mjs';
import { buildVerdict, renderVerdict } from './verdict.mjs';
import { deriveMode } from './mode.mjs';
import { evaluateTranche, gatherTrancheInputs, PRODUCES as TRANCHE_PRODUCES } from './evaluators/tranche.mjs';
import { evaluateCheckpoint, gatherCheckpointInputs, PRODUCES as CHECKPOINT_PRODUCES } from './evaluators/checkpoint.mjs';
import { evaluateRuling, gatherRulingInputs, PRODUCES as RULING_PRODUCES } from './evaluators/ruling.mjs';
import { applyCausalAdmission } from './lib/causal-admission.mjs';
import { resolveJudgment } from './lib/resolve-challenger.mjs';
import { COLD_REVIEW_STAGE, resolveStageEngine } from '../lib/stage-engine.mjs';
import { resolveConvergence } from './lib/convergence.mjs';
import { runColdReviewStage } from './lib/run-cold-review-stage.mjs';
import { formatDuration, resolveStageTimeout } from './lib/stage-timeout.mjs';
import { makeRunStageSeam } from '../harness/stage-seam.mjs';
import { defaultRun } from '../axes/lib/agent-runtime.mjs';
import {
  evaluateInferential, gatherInferentialInputs, shouldRun as judgmentHalfRuns,
  PRODUCES as INFERENTIAL_PRODUCES,
} from './evaluators/inferential.mjs';
import { unionControls, checkControlsCoverFindings } from './lib/controls.mjs';
import { needsBaseProbe, probeBase, BASE_REPRODUCIBLE_GATES } from './lib/base-comparison.mjs';
import { verdictsAtHead } from './lib/parse-verdict.mjs';
import { postVerdict, wouldRepeatLastVerdict } from './poster.mjs';
import { gatherQueue } from './queue.mjs';
import { runBoard } from './board.mjs';

/**
 * `--pr <n>` OR a bare positional `<n>` — both, because `brain:approve` takes
 * the number positionally (`brain:approve -- 640`) and this verb did not, so
 * the same operator hitting both learned two opposite conventions. Measured:
 * `brain:review -- 665` parsed to `pr: null`, which travelled six layers down
 * into `git fetch origin null` and surfaced as a raw Node stack trace reading
 * `fatal: couldn't find remote ref null`. Nothing in it said "you omitted the
 * PR number", so a missing argument was indistinguishable from a broken remote.
 *
 * `error` is set — never thrown — for every input that cannot name a PR:
 * absent, non-numeric (`--pr abc` → NaN), a `--pr` with no value after it
 * (also NaN), zero/negative, or more than one positional. `main` refuses on it
 * before any network or git call.
 *
 * `queue`/`board` never reach here: `main` dispatches those off `rawArgv[0]`
 * and returns first, so a positional token at this point is a PR number or a
 * mistake, and both are answerable.
 *
 * @returns {{ pr: number|null, mode: string, dryRun: boolean, error: string|null }}
 */
/**
 * The `--mode` values this CLI dispatches, plus `auto` (derive from repo state).
 *
 * MUST match the dispatch chain in `main` — pinned by a test that drives every
 * entry and asserts none reaches the "not yet implemented" stub. Two lists that
 * can disagree is the shape this repo keeps closing (#130, #340, #555); this one
 * is small enough to pin rather than to derive.
 */
export const REVIEW_MODES = Object.freeze(['auto', 'tranche', 'checkpoint', 'ruling']);

export function parseArgs(argv) {
  const args = { pr: null, mode: 'auto', dryRun: false, error: null };
  let engineVal = null;
  let modelVal = null;

  // Every PR number the argv names, from EITHER syntax, collected in one list.
  //
  // Collecting them together rather than tracking "did a flag win over a
  // positional" is what makes the ambiguity rule single: more than one number
  // is refused, whichever way each was written. The first cut of this function
  // refused `665 666` and then silently preferred the flag in `665 --pr 666` —
  // the same silently-chosen winner it had just rejected, in another syntax.
  const given = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--pr') given.push(argv[++i] ?? '(nothing)');
    else if (argv[i] === '--mode') args.mode = argv[++i];
    else if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--engine') {
      const next = argv[++i];
      if (next === undefined || next.startsWith('-')) {
        args.error = '"--engine" was given with no value after it';
        return args;
      }
      engineVal = next;
    }
    else if (argv[i] === '--model') {
      const next = argv[++i];
      if (next === undefined || next.startsWith('-')) {
        args.error = '"--model" was given with no value after it';
        return args;
      }
      modelVal = next;
    }
    else if (argv[i].startsWith('-')) {
      // An unrecognised option is REFUSED, never ignored — the strict half of
      // `brain:approve`'s parser, which this verb had cited as its model while
      // copying only the positional half.
      //
      // Silently discarding these was the worst thing in the first cut of this
      // change: `--dry-run=true`, `--dryrun` and `-n` all parsed clean with
      // `dryRun: false`, so an operator asking for a REHEARSAL got a real run
      // that POSTED a verdict to the pull request. The safety flag disarmed
      // itself and said nothing. Same defect as this ticket's, one axis over:
      // an unrecognised input must not be quietly dropped.
      // `--flag=value` is the near-miss worth naming, and the hint has to know
      // which flags take a value: suggesting `--dry-run true` for
      // `--dry-run=true` would send the operator to a second refusal, since
      // `--dry-run` is a boolean and `true` would parse as a PR number.
      const eq = argv[i].indexOf('=');
      const stem = eq > 0 ? argv[i].slice(0, eq) : null;
      if (stem === '--pr' || stem === '--mode' || stem === '--engine' || stem === '--model') {
        args.error = `unknown option "${argv[i]}" — a value is a separate argument, so write "${stem} ${argv[i].slice(eq + 1)}"`;
      } else if (stem === '--dry-run') {
        args.error = `unknown option "${argv[i]}" — "--dry-run" is a flag and takes no value`;
      } else {
        args.error = `unknown option "${argv[i]}"`;
      }
      return args;
    }
    else given.push(argv[i]);
  }

  if (engineVal !== null) args.engine = engineVal;
  if (modelVal !== null) args.model = modelVal;

  // `--mode`, validated HERE rather than at the dispatch chain (self-review G3).
  //
  // An unusable mode used to pass this parser clean and refuse only after
  // cold-boot had cloned and fetched — a full network round trip spent on an
  // argv that could never finish. REQ-669-2 says nothing may be fetched for a
  // run that cannot name its PR; the same holds for one that cannot name its
  // mode, and the requirement was only ever scoped narrowly.
  //
  // It also refused with `mode "undefined" is not yet implemented`, which names
  // the coercion instead of the input and mis-describes a typo as an unbuilt
  // feature — both of which REQ-669-3 forbids one flag over.
  if (!REVIEW_MODES.includes(args.mode)) {
    args.error = args.mode === undefined
      ? '"--mode" was given with no value after it'
      : `"${args.mode}" is not a review mode — expected one of: ${REVIEW_MODES.join(', ')}`;
    return args;
  }

  if (given.length > 1) {
    args.error = `expected one PR number, got ${given.length}: ${given.join(', ')}`;
    return args;
  }
  if (given.length === 0) {
    args.error = 'no PR number given';
    return args;
  }

  // The RAW token is carried, never re-derived from argv afterwards. Re-deriving
  // it with `indexOf('--pr')` reported the FIRST `--pr`'s value while `pr` held
  // the last one's, so `--pr 665 --pr abc` blamed "665" — a number that is
  // perfectly valid. Naming the wrong input is the very defect this ticket
  // exists to remove, and it had been rebuilt inside the fix for it.
  // Digits only, then a range check. `Number()` alone accepts spellings no
  // human typed on purpose and turns them into a DIFFERENT, valid-looking PR:
  // `0x10` became 16, `1e3` became 1000, and `" 665 "` was silently trimmed.
  // A reviewer pointed at the wrong pull request is worse than one that refuses.
  const [typed] = given;
  args.pr = /^\d+$/.test(typed) ? Number(typed) : NaN;
  if (!Number.isInteger(args.pr) || args.pr <= 0) {
    // "NaN" names the coercion, not the mistake — report what was typed.
    args.error = `"${typed}" is not a PR number`;
  }
  return args;
}

/** `queue` subcommand (H1-5b, task 13.3): dispatches to queue.mjs's
 * gatherQueue, prints the review queue + the escalation inbox. Read-only. */
async function runQueueCommand(deps, log) {
  const project = deps.project ?? loadBrainConfig().project?.slug;
  const { reviewQueue, escalations } = await gatherQueue({
    project,
    provider: deps.provider,
    deps: deps.queueDeps ?? {},
  });

  log(`brain:review:queue — ${reviewQueue.length} PR(s) awaiting review (oldest first, by number):`);
  for (const pr of reviewQueue) log(`  #${pr.number} ${pr.title}`);

  log(`brain:review:queue — ${escalations.length} pending escalation(s) (needs-decision):`);
  for (const pr of escalations) log(`  #${pr.number} ${pr.title}`);

  return 0;
}

/** `board` subcommand (H1-5c, task 13.3b): dispatches to board.mjs's
 * runBoard, reconciles the seq:* and reviewed:* label namespaces across
 * every open PR. */
async function runBoardCommand(deps, log) {
  const project = deps.project ?? loadBrainConfig().project?.slug;
  const results = await runBoard({ project, provider: deps.provider, deps: deps.boardDeps ?? {} });

  for (const r of results) {
    if (r.toAdd.length > 0 || r.toRemove.length > 0) {
      log(`brain:review:board — #${r.number}: +[${r.toAdd.join(', ')}] -[${r.toRemove.join(', ')}]`);
    }
    // #477 — the report the ruling requires. An unreadable verdict normally has
    // NOTHING to add or remove (freezing the namespace is what stops the writes),
    // so it was the one case that printed nothing at all: the operator read
    // "reconciled N open PR(s)" and never learned a verdict was garbage. Emitted
    // separately from the line above, and unconditionally, because "no label
    // movement" and "no readable verdict" are different facts.
    if (r.unreadable?.length > 0) {
      // The freeze clause is CONDITIONAL. It used to be appended to every
      // report, so a verdict with an unreadable `findings` and a readable
      // `sequencing` printed its label moves and then claimed seq:* had been
      // left untouched — a report overstating its own caution, which fails in
      // the same reassuring direction as the defect this change exists to close.
      const froze = r.unreadable.includes('sequencing') ? ' — seq:* left untouched' : '';
      log(`brain:review:board — #${r.number}: UNREADABLE verdict fields [${r.unreadable.join(', ')}]` +
        `${froze} (protocol §10: never conclude on uncomputable evidence)`);
    }
  }
  log(`brain:review:board — reconciled ${results.length} open PR(s).`);

  return 0;
}

function defaultGetChangedFiles({ cwd = process.cwd() } = {}) {
  return (baseSha, headSha) =>
    execFileSync('git', ['diff', '--name-only', `${baseSha}...${headSha}`], { cwd, encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
}

/** `deps`: `argv`, `log`, `error`, `project`, `provider`, `identityDeps` (→
 * identity.mjs), `coldBootDeps` (→ cold-boot.mjs), `baseSha` (skips
 * `ci-context.mjs`'s CI-env resolution when injected), `loadCiContext`,
 * `getChangedFiles`, `trancheDeps` (→ evaluators/tranche.mjs), `checkpointDeps`
 * (→ evaluators/checkpoint.mjs — fed cli's one resolved `baseSha`; a
 * `checkpointDeps.baseSha` is a test-side override only, see checkpoint.mjs's
 * docstring), `rulingDeps` (→ evaluators/ruling.mjs), `tier` (test-side
 * override of `resolveTier(config)` — selects the `brain-review/1` vs `/2`
 * protocol via `tierParams(tier).reviewProtocol`, issue #391 T2.3/#394 M3),
 * `refuterRunner` (→ lib/causal-admission.mjs's `applyCausalAdmission`, only
 * consulted at `protocol === 'brain-review/2'`), `probeBase` (→
 * lib/base-comparison.mjs — a SYNCHRONOUS override of the base re-run; returning a
 * promise from it degrades silently to "probed, nothing failed", so the seam's
 * contract is sync and its callers are tested), `posterDeps` (→
 * poster.mjs), `writeVerbs` (a spy/real VCS used as the poster's default
 * `getVcs` when `posterDeps.getVcs` is not separately injected), `queueDeps`
 * (→ queue.mjs, `queue` subcommand only), `boardDeps` (→ board.mjs, `board`
 * subcommand only). */
/**
 * The production `inferentialDeps` — the stage's artifact, or nothing.
 *
 * Split out so the `??` above never touches the filesystem when a caller
 * injected its own deps: a test that supplies a generator must not depend on
 * what happens to be in `openspec/reviews/`.
 *
 * `root` is a parameter and not a closure over `process.cwd()` so this glue can
 * be pinned against a real directory. A seam only its callers can reach is a
 * seam nothing tests.
 */
export function artifactDeps(prNumber, root = process.cwd()) {
  const generate = makeArtifactGenerate({ prNumber, root });
  return generate ? { generate } : {};
}

export async function main(deps = {}) {
  const log = deps.log ?? console.log;
  const error = deps.error ?? console.error;
  const rawArgv = deps.argv ?? process.argv.slice(2);

  // Positional subcommand dispatch (H1-5b, task 13.3, design.md §9): the
  // FIRST token, when it is `queue` or `board`, selects an entirely
  // different read path — neither reaches identity/cold-boot/the evaluators
  // below. Anything else (including no subcommand, or a leading `--flag`)
  // falls through to the existing single-PR review flow unchanged.
  if (rawArgv[0] === 'queue') return runQueueCommand(deps, log);
  if (rawArgv[0] === 'board') return runBoardCommand(deps, log);

  const args = parseArgs(rawArgv);
  // Refuse BEFORE any git or network call. Without this the unusable value
  // reached `git fetch origin <value>` and threw an unhandled execFileSync
  // error — a stack trace whose top line was about a remote ref, for a mistake
  // made in the argv.
  if (args.error) {
    error(`brain:review: refusing to run — ${args.error}.`);
    error('  Usage: npm run brain:review -- <pr-number>   (or --pr <pr-number>)');
    error('         npm run brain:review -- queue | board');
    return 2;
  }

  // `deps.config` is a TEST-only override, the same convention `deps.tier`
  // already declares below. #682's judgment half is resolved FROM config, and
  // without a seam the only way to exercise it end to end was to mutate the
  // repo's real `brain.config.json` — which is how the cold review had to prove
  // the composition defects this file now guards against.
  let config = deps.config ?? loadBrainConfig();
  const hasEngineOverride = args.engine !== null && args.engine !== undefined;
  const hasModelOverride = args.model !== null && args.model !== undefined;
  if (hasEngineOverride || hasModelOverride) {
    const prevColdReview = config?.sdd?.map?.['cold-review'] ?? {};
    config = {
      ...config,
      sdd: {
        ...config?.sdd,
        map: {
          ...config?.sdd?.map,
          'cold-review': {
            ...prevColdReview,
            ...(hasEngineOverride ? { engine: args.engine } : {}),
            ...(hasModelOverride
              ? { model: args.model }
              : (hasEngineOverride && args.engine !== prevColdReview.engine ? { model: undefined } : {})),
          },
        },
      },
    };
  }
  const project = deps.project ?? config.project?.slug;
  // Reviewer protocol version (issue #391 T2.3 §3, issue #394 M3): the TIER sets
  // the default, and since #442 `reviewer.protocol` in brain.config.json may
  // override it — the D5 middle path, which exists because brain cannot declare
  // `regulated` (at that tier `actor-check` is unsatisfiable at n=1, the #329
  // contradiction) and `/2` still had to be dogfooded rather than only tested.
  // `deps.tier` remains a TEST-only override (mirrors trancheDeps.tier's own
  // convention), never a production seam; the config override is the production one.
  // `resolveTier`/`resolveReviewProtocol` are pure (governance-tiers.mjs) — this is
  // still the ONE call site (design.md §2.2) that produces the `protocol`
  // `buildVerdict` receives below.
  //
  // BOTH resolutions can THROW on an explicit unknown value, and the refusal is
  // caught here rather than allowed to escape as a stack trace: a typo in the config
  // must refuse the run with a readable reason and post NOTHING (#382/#413's shape).
  // Falling back to a default would hand the operator a `/1` verdict while they
  // believed they had `/2` — silently dropping causal admission.
  let tier;
  let protocol;
  try {
    tier = deps.tier ?? resolveTier(config);
    protocol = deps.protocol ?? resolveReviewProtocol(config);
  } catch (err) {
    error(`brain:review: refusing to run — ${err.message}`);
    return 1;
  }

  const identity = await gatherIdentity({ deps: deps.identityDeps ?? {} });
  if (!identity.ok) {
    if (identity.missingVar) {
      error(`brain:review: refusing to run — env var "${identity.missingVar}" is not set.`);
      error(`  Get a token: ${identity.patSetupUrl}`);
      error(`  Setup doc: ${identity.setupDocPath}`);
    } else if (identity.ambientIdentity) {
      // #604 half 1: the negative control resolved. An invalid token produced
      // an identity, so credentials are injected upstream and `whoami({token})`
      // reports the ENVIRONMENT's login rather than the token's. Refused here
      // rather than as a `mismatch`, which is the shape that cost three token
      // rotations — the message must name the environment, not the token.
      error(`brain:review: refusing to run — this environment resolved a deliberately INVALID token to "${identity.ambientIdentity}".`);
      error('  Credentials are being injected upstream (a proxy, or an ambient CLI session), so a');
      error(`  token-scoped identity read cannot establish who ${identity.tokenEnv} belongs to (issue #604).`);
      error('  Rotating the token cannot fix this — the token is never what answers.');
      error('  Run brain:review where credentials are not injected: the maintainer machine, or CI with the PAT as a secret.');
    } else if (identity.controlLockout) {
      // #604 self-review F1: the control sends one invalid credential per run,
      // and a burst of those is exactly what providers throttle — GitHub with
      // `403 Maximum number of login attempts exceeded`, which then rejects
      // VALID credentials too. Folded into `controlError` this read as "could
      // not establish whether this environment honours the token", sending the
      // operator after a proxy that is not there: the same mis-diagnosis that
      // cost three token rotations, caused by the fix for it.
      error(`brain:review: refusing to run — the provider is temporarily refusing authentication attempts: ${identity.controlLockout}`);
      error('  This check sends one deliberately-invalid credential per run, and repeated invalid');
      error('  attempts are what trigger that lockout — so it may have caused this itself (issue #604).');
      error('  Wait for the window to expire and re-run. Do NOT rotate the token, and do not read');
      error('  this as a credential-injecting environment — neither is what happened.');
    } else if (identity.controlError) {
      // #604: the control could not reach a verdict. Scoring that as "clean"
      // would be the reader-empty-on-failure defect the control exists to avoid.
      error(`brain:review: refusing to run — could not establish whether this environment honours the reviewer token: ${identity.controlError}`);
      error('  The negative control did not reach a verdict, and "could not establish" is not "established clean" (issue #604).');
    } else if (identity.mismatch) {
      // #413: the token's REAL login disagrees with the configured handle —
      // proceeding would run the §10 abstention and the anti-loop lock
      // against a claimed identity, which is exactly the forgery the ticket
      // reproduces (author token + bot handle → self-review passes).
      error(`brain:review: refusing to run — the reviewer token belongs to "${identity.mismatch.actual}", but reviewer.handle claims "${identity.mismatch.claimed}".`);
      error('  §10 abstention and the anti-loop lock would compare a claimed identity, not a real one (issue #413).');
      error(`  Point ${identity.tokenEnv} at the reviewer identity's token, or fix reviewer.handle.`);
    } else {
      // #413: whoami rejected — identity uncomputable. Same discipline as
      // §10's "uncomputable evidence": never proceed unverified.
      error(`brain:review: refusing to run — could not verify the reviewer identity against the token: ${identity.verifyError}`);
      error('  Never proceed on an unverified identity (§10 fail-closed, issue #413).');
    }
    return 1;
  }

  // §10 Self-review — FAIL CLOSED on an unset handle (issue #382).
  //
  // This was deliberately fail-open (a loud warning) while `reviewer.handle`
  // still shipped empty: pre-task-7.3 the reviewer ran under the operator's
  // own identity, so a strict guard would have abstained from everything.
  // Task 7.3 landed (#367 registered the reviewer identity; the config now
  // carries a handle), which retires that premise — an empty handle is now a
  // misconfiguration, not the expected state.
  //
  // Fail closed rather than abstain-silently: without a handle BOTH §10
  // self-review abstention and the anti-loop lock (poster.mjs compares
  // `lastVerdict.author` to the reviewer handle) are inert, so proceeding
  // would post an unbounded verdict under an unverifiable identity. Refusing
  // at boot mirrors the missing-token refusal above — same shape, same exit.
  if (!identity.handle) {
    error('brain:review: refusing to run — reviewer.handle is not configured.');
    error('  Without it the §10 self-review abstention and the anti-loop lock are both inert.');
    error('  Set reviewer.handle in brain.config.json to the reviewer identity (see ADR-0020).');
    return 1;
  }

  // #501: every server call this run makes — read AND write — goes through a port
  // BOUND to the token `gatherIdentity` just verified. The SAME value, threaded;
  // never a second read of the env var, because a second read is a second chance
  // to differ from the one that was checked.
  //
  // Before this the token reached `whoami` and nothing else. The reviewer verified
  // as `csrinaldibot` and posted as whoever `gh` was logged in as (measured on PR
  // #500, review 4887057484), so the two-key split was checked and not enforced —
  // and `poster.mjs`'s anti-loop lock then compared the verdict's author against a
  // handle that never reached the wire.
  //
  // Reads are bound too, deliberately: a port reading under one credential and
  // writing under another can report on a repository it is not writing to.
  const boundGetVcs = (opts = {}) => getVcs({ ...opts, identity: identity.token });

  const boot = await gatherColdBoot({
    project,
    number: args.pr,
    provider: deps.provider,
    reviewerHandle: identity.handle,
    deps: deps.coldBootDeps ?? { getVcs: boundGetVcs },
  });

  if (boot.abstain) {
    log(`brain:review: abstaining — ${boot.reason}`);
    return 0;
  }

  // #477 — the consumer of `doctrine.unreadableVerdicts`. Without this the field
  // was a name with no reader: an unreadable prior verdict behaved at runtime
  // exactly as before, which is the "flag nobody reads" outcome the ruling
  // refused. This run derives its rev count and its anti-loop decision from that
  // thread, so the operator reading this output is the one who needs to know a
  // member of it could not be read. Reported, never acted on automatically —
  // the verdict still counts as an iteration (see cold-boot.mjs).
  for (const v of boot.doctrine.unreadableVerdicts ?? []) {
    log(`brain:review: UNREADABLE prior verdict at head ${v.head_sha} by ${v.author ?? 'unknown'} — ` +
      `fields [${v.malformed.join(', ')}] could not be read; it still counts toward the §7 rev bound`);
  }

  // Mode is derived from repo state, NEVER declared (R6) — an explicit
  // --mode pins it for a manual run; changedFiles feeds both the derivation
  // (checkpoint-report.md detection) and the tranche evaluator's budget/
  // Tier-2 checks, resolved ONCE and shared (design.md §2, §4).
  const loadCiContext = deps.loadCiContext ?? loadContext;
  const ctx = deps.baseSha !== undefined ? null : await loadCiContext();
  // Precedence: an explicit injected deps.baseSha (tests) wins; then
  // ci-context.mjs's CI-env BASE_SHA; then the port's prView.baseRefOid
  // (ADR-0022 Decision 2) — the provider-agnostic default that ALSO serves
  // local runs, where ci-context is unset. `null` here is genuinely
  // uncomputable (no CI env, no port value) and still folds to tranche.mjs's
  // protocol §10 fail-closed rule — this widens the *reach* of the evidence,
  // never relaxes the rule. Closes H1-2C-BASE for the tranche path.
  const baseSha = deps.baseSha !== undefined ? deps.baseSha : ctx?.baseSha ?? boot.prView.baseRefOid ?? null;
  const getChangedFiles = deps.getChangedFiles ?? defaultGetChangedFiles();
  const changedFiles = baseSha ? getChangedFiles(baseSha, boot.headSha) : [];

  const mode = args.mode !== 'auto' ? args.mode : deriveMode({ labels: boot.prView.labels ?? [], changedFiles });

  let evalResult;
  // REQ-682-3 — the axis that actually ran, as a VALUE, for the wire.
  let judgmentAxis = null;
  const judgmentConditions = [];
  // #683 — the verdict declares WHICH CLASSES OF CONTROL ran, and it is derived
  // from the evaluator that actually ran rather than from the findings it
  // produced. A clean mechanical run has NO findings, so a findings-derived list
  // would be empty and "no control ran" would render identically to "controls ran
  // and found nothing" — the very defect the field exists to remove, on exactly
  // the verdicts where it would be least visible.
  let controls = [];
  if (mode === 'tranche') {
    const trancheInputs = await gatherTrancheInputs({
      project,
      number: args.pr,
      provider: deps.provider,
      headSha: boot.headSha,
      baseSha,
      changedFiles,
      prBody: boot.prView.body,
      // #1072: the labels from the SAME prView that gave the body above, so
      // the reviewer honors `size:exception` on the same reading of the PR the
      // `diff-size` gate honors it on — and with no second forge call.
      // `?? null`, NOT `?? []` (#1073 cold review): a refusal is null and never
      // an empty array, because `[]` claims the PR carries no exception when
      // nothing was read. Every consumer of this value treats a non-array as
      // "not read" and fails closed on it.
      labels: boot.prView.labels ?? null,
      // #631: the bound port, FIRST, so a caller's override wins on the seams it
      // names and cannot silently drop the credential binding by omission.
      //
      // This was `deps.trancheDeps ?? {}` on main, and the gather then fell
      // through to `tranche.mjs`'s module-level `getVcs` — which `vcs/cli.mjs`
      // binds to the generic `VCS_TOKEN`, i.e. the OPERATOR. Measured on PR #598:
      // 18 required checks all green, and two consecutive runs read zero gates and
      // abstained, because the operator's graphql quota was exhausted while the
      // reviewer token had 4990 of 5000 left. This is #501's class one level up —
      // there the WRITE went out under the wrong credential, here the READ did.
      deps: { getVcs: boundGetVcs, ...(deps.trancheDeps ?? {}) },
    });
    evalResult = evaluateTranche(trancheInputs);
    controls = unionControls([TRANCHE_PRODUCES]);
  } else if (mode === 'checkpoint') {
    const checkpointInputs = await gatherCheckpointInputs({
      project,
      number: args.pr,
      provider: deps.provider,
      headSha: boot.headSha,
      changedFiles,
      prBody: boot.prView.body,
      // `?? null`, NOT `?? []` (#1073 cold review): a refusal is null and never
      // an empty array, because `[]` claims the PR carries no exception when
      // nothing was read. Every consumer of this value treats a non-array as
      // "not read" and fails closed on it.
      labels: boot.prView.labels ?? null,
      tier,   // #555: the artifact set is tier-resolved; cli.mjs already has it
      worktreePath: boot.worktreePath,
      doctrineRecords: boot.doctrine.records,
      // The resolved baseSha (ci-context → port prView.baseRefOid, ADR-0022) feeds
      // the checkpoint seam — takes §10.4 reversion live; checkpointDeps overrides.
      // #631: bound like every other gather in this region. `checkpoint.mjs` does
      // not import `getVcs` today, and that is exactly why the binding is passed
      // rather than reasoned about: "this evaluator happens not to need it" is a
      // fact about today's code that no test held, and the day it stops being true
      // is the day a read silently goes out under the operator's credential.
      deps: { getVcs: boundGetVcs, baseSha, ...(deps.checkpointDeps ?? {}) },
    });
    evalResult = evaluateCheckpoint(checkpointInputs);
    controls = unionControls([CHECKPOINT_PRODUCES]);
  } else if (mode === 'ruling') {
    // ruling (H1-4, REQ-H1-11, Option (B) — issue #266 comment 5009584044):
    // the evaluator NEVER auto-rules; a well-formed ## FORK always
    // escalates to a human (STOP + escalate:'human'), a malformed one
    // REVISEs. No server round trip — the PR body is already cold-booted.
    const rulingInputs = await gatherRulingInputs({
      project,
      number: args.pr,
      prBody: boot.prView.body,
      // #631: bound for the same reason as the checkpoint gather above — not
      // because `ruling.mjs` reads the port today, but so that it cannot start to
      // without the credential following it.
      deps: { getVcs: boundGetVcs, ...(deps.rulingDeps ?? {}) },
    });
    evalResult = evaluateRuling(rulingInputs);
    controls = unionControls([RULING_PRODUCES]);
  } else {
    // Any other derived/explicit mode is not (yet) implemented. Explicit
    // stub — never a silent no-op or a guessed verdict.
    error(`brain:review: mode "${mode}" is not yet implemented — refusing to guess a verdict.`);
    return 1;
  }

  // #682 — the judgment half is ADDITIVE, not a fourth mode, and it runs behind
  // ONE gate. `resolveJudgment` decides once, for the producer AND the
  // challenger, so the two can no longer disagree — which they did at `standard`
  // (producer on, protocol `/1`, `applyCausalAdmission` skipped entirely), and
  // that disagreement re-created the state #552 ruled against.
  let judgment;
  try {
    judgment = resolveJudgment({ config, protocol });
  } catch (err) {
    error(`brain:review: ${err.message}`);
    return 1;
  }

  // REQ-682-5's bound, resolved HERE rather than inside the branch that uses it
  // (judgment:cold-6, second half). It used to live in the `else` that runs when
  // a transport IS configured, so a repo with no transport never validated the
  // key at all: `maxRounds: "3"` — a string `resolveConvergence` is documented
  // to refuse — RESOLVED WITH EXIT 0, measured. The refusal arrived on the day
  // someone routed the stage, not on the day they wrote the key, which is the
  // wrong day: config is wrong when it is WRITTEN.
  //
  // Wrapped, for the same reason `resolveJudgment` above is: an uncaught throw
  // from inside `main()` reaches `process.exit(await main())` as a raw
  // ERR_UNHANDLED_REJECTION — a Node stack, no `brain:review:` line, and no
  // verdict. It still fails closed, so what is lost is the operator-actionable
  // message, which is the whole of what a refusal is for.
  let maxRounds;
  try {
    ({ maxRounds } = resolveConvergence(config));
  } catch (err) {
    error(`brain:review: ${err.message}`);
    return 1;
  }

  // THE STAGE CEILING RESOLVES HERE FOR THE SAME TWO REASONS, and it shipped in
  // the wrong place one commit earlier (judgment:cold-2, third cold review).
  //
  // It was evaluated inside `runStage`'s ARGUMENT LIST — after `mkdir`, and
  // after `remove` had deleted the previous artifact. `run-cold-review-stage`
  // states the rule in capitals fifty lines above that call: every precondition
  // refuses before any mutation. Measured: a string value threw, and the run had
  // already destroyed the file it could not replace.
  //
  // And it sat BELOW the routing check, so an unrouted repo never validated the
  // key — the identical defect judgment:cold-6 moved `resolveConvergence` up
  // here to fix, with the identical argument: config is wrong when it is
  // WRITTEN, not on the day someone finally routes the stage. Fixing one key and
  // leaving its neighbour is how a lesson stays local to the line that taught it.
  let stageTimeoutMs;
  try {
    ({ timeoutMs: stageTimeoutMs } = resolveStageTimeout(config));
  } catch (err) {
    error(`brain:review: ${err.message}`);
    return 1;
  }

  // #682 round-1 review — `judgment.reason` had NO CONSUMER. It was computed on
  // every off path and read nowhere, so a repo that deliberately turned the
  // judgment half ON and got nothing was told nothing: `resolveJudgment` knew
  // exactly why and the verdict never said it.
  //
  // Reported ONLY when the repo asked for the half and did not get it. A tier
  // that never enables it is not withholding anything from anyone, and a
  // constant on every verdict is the wallpaper #690 refused.
  // Round-2 review — the first cut read `config.reviewer.inferential.enabled`
  // and so could not see a tier that enables the half. `standard` ships
  // `{inferentialEnabled: true, reviewProtocol: 'brain-review/1'}`: it ASKS for
  // the judgment half and the protocol gate refuses it, and that is the exact
  // tier #741 F2 named. Measured before the fix: `lite` (tier disables) and
  // `standard` (tier enables, protocol refuses) rendered BYTE-IDENTICAL — the
  // same fold the sibling condition below exists to unfold, re-created by
  // reading half of the resolution.
  //
  // `resolveJudgment` already computes it, so the answer comes from the ONE
  // resolution rather than a second reading of the config.
  if (!judgment.run && judgment.enabled && judgment.reason) {
    judgmentConditions.push(`the judgment half did not run — ${judgment.reason}`);
  }

  if (judgment.run) {
    // Slice A's transport (#682, ADR-0033): the judgment half's producer is the
    // cold-review STAGE, and its output is a file — `openspec/reviews/pr-NNN/`.
    // Reading it is all the transport this slice has; slice B spawns the engine
    // that writes it.
    //
    // `deps.inferentialDeps` still wins, so a test injects a generator without
    // touching the filesystem — and so the seam the unit tests already drive
    // keeps working unchanged.
    //
    // NO artifact means no `generate`, which means the half does not run and the
    // verdict says "enabled but no transport is configured". That is deliberate:
    // a repo that never ran the stage has not failed, and rendering it as a
    // failure would put every repo on earth into a refusal.
    const root = deps.root ?? process.cwd();

    // ── C.2a — THE STAGE RUNS HERE, AND THE ORDERING IS THE WHOLE WIRING ─────
    //
    // Everything below reads a FILE. Until this call existed, that file only
    // appeared if a human wrote it by hand: `findings-artifact.mjs` read it,
    // `run-cold-review-stage.mjs` could have written it, `stage-seam.mjs` could
    // have reached an engine — and NOTHING IN PRODUCTION CALLED EITHER. The
    // slice had a producer, a transport and a reader that never touched.
    //
    // That is the defect class this ticket spent eight mutations chasing, at
    // slice scale: a capability that exists, is tested, and is unreachable from
    // the verb. It reads as "built" in every place except the one that runs.
    //
    // The stage must run BEFORE `artifactDeps`, because `makeArtifactGenerate`
    // answers `null` for a file that is absent AT THE MOMENT IT IS ASKED. Run it
    // after, and the first review on any PR reports "no transport is configured"
    // about a stage that had just written its artifact.
    //
    // AN INJECTED `inferentialDeps` REPLACES THE STAGE ENTIRELY, and that is what
    // the seam means: a caller supplying its own generator has supplied the thing
    // the stage exists to produce. Spawning an engine anyway would burn a model
    // call whose output nothing reads.
    //
    // IT RUNS UNDER `--dry-run` TOO. `--dry-run` governs POSTING, not producing:
    // a dry run that skipped the stage would render a different verdict from the
    // real one, which defeats the only reason to ask for a preview. The cost is
    // real and it is opt-in — `sdd.map` ships empty (migration 0.10.0), so no
    // repo spawns anything until it routes the stage on purpose.
    //
    // THE STAGE RUNS ONCE, OUTSIDE the produce loop `maxRounds` bounds. So a
    // higher bound re-reads one static artifact and converges on round 2, exactly
    // as `convergence.mjs` records. Moving the stage inside the loop would make
    // the bound buy real work and would multiply the model cost per review;
    // ADR-0033 decided the transport, not that.
    // WRAPPED, for the reason `resolveJudgment` is (judgment:cold-6). The throw
    // that reaches here is `resolveStageEngine`'s, on an `sdd.map` entry that
    // names no engine — an operator's typo. Uncaught, it left `main()` as a raw
    // ERR_UNHANDLED_REJECTION: a Node stack, no `brain:review:` line, and no
    // verdict. Measured: the injected `error` channel received NOTHING. The run
    // failed closed either way, so what was lost is the message that tells the
    // operator which key to fix — which is the whole point of failing closed
    // out loud rather than merely failing.
    // judgment:cold-2 — DECIDE BEFORE PAYING, not after. Every input the
    // anti-loop lock reads is already in hand here: `boot.doctrine.priorVerdicts`,
    // `identity.handle` and `boot.headSha`. The lock itself lives in
    // `poster.mjs` and is not reached until hundreds of lines below, so a second
    // `brain:review` on an unchanged head used to pay a full engine run —
    // `STAGE_TIMEOUT_MS` is ten minutes — and then post nothing.
    //
    // THE PREDICATE IS IMPORTED, NEVER RESTATED. A copy here would be the defect
    // this file already fixed on the SHA half (`verdictsAtHead`, shared "so the
    // two guards can no longer disagree silently"): a cheap early check that
    // drifts from the real lock skips runs the lock would have posted, and
    // nothing on the run would say so.
    //
    // A DRY RUN IS EXEMPT, and that is not a special case — it is the same rule.
    // The lock exists to stop the reviewer answering itself ON THE PULL REQUEST;
    // a rehearsal posts nothing, so there is no loop to break and skipping would
    // take the rehearsal away from an operator who asked for exactly it.
    // IT SKIPS THE SPAWN, NOT THE RUN — and the first version skipped the run
    // (judgment:cold-3, third cold review). Returning 0 here jumped over the
    // verdict body, so the same anti-loop rule produced two different
    // operator-facing outputs depending on `reviewer.inferential.enabled`, a key
    // with nothing to do with the lock: with the half on, one line; with it off,
    // the whole rendered block. The comment beside it claimed "the operator's
    // outcome is identical", which was measurably false — the defect class this
    // ticket exists to remove, in the fix for another instance of it.
    //
    // The verdict body is the ONLY place a non-posting run reports what it
    // found. A run that declines to repeat itself still ran its deterministic
    // gates, and an operator is entitled to read them.
    // #829: whether THIS run would apply the judgment half — known before the
    // spawn from the same inputs the stage reads: the half is enabled, and
    // either a generator is injected or `sdd.map` routes the stage. A malformed
    // routing entry counts as would-apply so the stage's own wrapped throw
    // reports it — the lock must never eat an operator's error message.
    let wouldApplyInferential = false;
    if (judgment.run) {
      if (deps.inferentialDeps) {
        wouldApplyInferential = true;
      } else {
        try {
          wouldApplyInferential = resolveStageEngine(config, COLD_REVIEW_STAGE) !== null;
        } catch {
          wouldApplyInferential = true;
        }
      }
    }

    const antiLoop = !args.dryRun && wouldRepeatLastVerdict({
      priorVerdicts: boot.doctrine.priorVerdicts,
      reviewerHandle: identity.handle,
      headSha: boot.headSha,
      // A half-verdict does not lock out the half this run would add (#829).
      nextAppliesInferential: wouldApplyInferential,
    });
    if (antiLoop) {
      // NAMED AS ITS OWN CONDITION, never folded into "no transport is
      // configured". Protocol §10's `conditions` is the field for "the evidence
      // behind this verdict is weaker than it looks", and a judgment half that
      // was deliberately not run is exactly that. Rendering it as an unrouted
      // repo would tell an operator who configured an engine that they did not.
      judgmentConditions.push(
        'the judgment half was not run: this reviewer\'s last verdict at this head is its own, so ' +
        'the anti-loop lock will post nothing and an engine run would be paid for output nobody reads.'
      );
    }

    let stageResult;
    try {
      stageResult = (deps.inferentialDeps || antiLoop)
        ? { routed: false }
        : await (deps.runColdReviewStage ?? runColdReviewStage)({
          config,
          prNumber: args.pr,
          baseRef: baseSha,
          headRef: boot.headSha,
          root,
          // judgment:cold-3: the coordinate cold-boot computes so the reviewer
          // never reads ambient state was passed to gatherInferentialInputs and
          // to nothing else. The engine gets it now.
          worktreePath: boot.worktreePath,
          timeoutMs: stageTimeoutMs,
          // MERGED, NOT REPLACED (judgment:cold-2, fourth cold review). This read
          // `deps.stageDeps ?? {…}`, so a caller wanting to vary ONE seam had to
          // rebuild the others — and the two tests that deliberately drive the
          // REAL `runStage` seam could not stub the forge probe without losing
          // the very seam they exist to exercise. They therefore spawned the
          // machine's actual `gh`, and passed or failed on whether the developer
          // happened to be logged in.
          //
          // Production is unchanged: `deps.stageDeps` is undefined there, so this
          // is the default seam either way.
          // The REAL runners, supplied here and overridable by a caller — the
          // forge probe alongside the stage seam, because `runColdReviewStage`
          // now refuses both rather than defaulting (judgment:cold-2).
          deps: { runStage: makeRunStageSeam(), forgeProbe: defaultRun, ...(deps.stageDeps ?? {}) },
        });
    } catch (err) {
      error(`brain:review: ${err.message}`);
      return 1;
    }

    // A ROUTED STAGE THAT FAILED IS NOT A REPO WITHOUT A TRANSPORT. Refused here
    // rather than fallen through, because falling through reaches
    // `artifactDeps`, finds no file, and renders "enabled but no transport is
    // configured" — telling an operator who configured an engine that they did
    // not. Same words, opposite fact. `routed` is what keeps the two apart, and
    // it survives the failure precisely so this branch can read it.
    // F.9 — WHAT THE ENGINE COST, REPORTED WHETHER OR NOT IT SUCCEEDED. The
    // shipped ceiling was ten minutes and no run had ever said how long it
    // actually took, so when the first real cold review died at it nobody could
    // tell whether the number was close or absurd. A measurement the run takes
    // and discards is not a measurement anyone has — judgment:cold-3, in the
    // value that decides whether a review can finish at all.
    if (stageResult.routed && typeof stageResult.elapsedMs === 'number') {
      log(`brain:review: the cold-review engine ran for ${formatDuration(stageResult.elapsedMs)}.`);
    }

    if (stageResult.routed && !stageResult.ok) {
      error(`brain:review: the cold-review stage failed — ${stageResult.reason}. ` +
        'Refusing to post a verdict that would declare the inferential control applied.');
      return 1;
    }

    const inferentialDeps = deps.inferentialDeps ?? artifactDeps(args.pr, root);

    // #682 round-1 review, finding G — AN ENABLED HALF WITH NO TRANSPORT IS NOT
    // THE SAME STATE AS A DISABLED ONE, and until now they rendered
    // BYTE-IDENTICALLY. Measured: `enabled: false` and `enabled: true` with no
    // generator produced identical log streams, not merely identical blocks.
    //
    // The slice-2 defence was that #690's complement distinguishes them. It does
    // not: NEITHER case declares `inferential`, so the complement says the same
    // thing in both. That is #552's fold, re-created one layer up by an
    // unreachable capability rather than by a missing runner.
    //
    // A repo that turned the judgment half ON is told, on the wire, that it did
    // not run and why. `conditions` is the field protocol §10 already uses for
    // "the evidence behind this verdict is weaker than it looks".
    //
    // Round-2 review — `shouldRun` declared itself "that decision, kept next to
    // [gatherInferentialInputs] so the two cannot drift" and had NO production
    // caller: the decision was reached HERE instead, twice, through
    // `judgment.run` and then through `generated === null`. Three declarations
    // of one question, and the one that documented itself as authoritative was
    // the one nothing read. It is read now, so the docstring is true and there
    // is one place to change when slice 3 supplies the transport.
    // ANTI-LOOP IS TESTED FIRST, AND THE TWO MUST NOT FOLD. A repo that skipped
    // the engine because it would post nothing HAS a transport; saying "no
    // transport is configured" would tell an operator who configured an engine
    // that they did not — the same words, the opposite fact, which is the pair
    // `routed` exists to keep apart one layer down. The first cut of
    // judgment:cold-3's fix reached this branch through `{routed: false}` and
    // emitted BOTH sentences; a test caught it.
    if (antiLoop) {
      // The condition was already pushed at the guard. Nothing further to say:
      // an engine that did not run produced no findings, and that is not the
      // same as a repo with nowhere to run one.
    } else if (!judgmentHalfRuns({ enabled: judgment.run, generate: inferentialDeps.generate })) {
      judgmentConditions.push(
        'the judgment half is enabled but no transport is configured — no reasoned finding ' +
        'was produced, and the inferential control was NOT applied to this verdict.'
      );
    } else {
      // `maxRounds` is resolved above, on every run. It is NOT §7's `rev >= 3`,
      // which is read from `priorRevCount` further down and counts posted
      // revisions on this PR rather than produce rounds inside this run;
      // `convergence.mjs` holds the argument for why the two must not be one
      // number read twice.

      const inferentialInputs = await gatherInferentialInputs({
        worktreePath: boot.worktreePath,
        baseSha,
        headSha: boot.headSha,
        changedFiles,
        prBody: boot.prView.body,
        maxRounds,
        // #631: bound AT THE CALL SITE, not where `inferentialDeps` is built —
        // the binding has to be visible beside the gather it protects, which is
        // the property the derived test in cli.test.mjs checks.
        deps: { getVcs: boundGetVcs, ...inferentialDeps },
      });

      // #682 acceptance criterion 6. A generator that failed is NOT a generator
      // that found nothing: posting a verdict that declares the judgment control
      // applied, over an empty list, is the uncomputable-evidence APPROVE
      // protocol §10 forbids. Fail closed, name the cause, post nothing.
      if (inferentialInputs.failed) {
        error(`brain:review: the judgment half could not run — ${inferentialInputs.reason}. ` +
          'Refusing to post a verdict that would declare the inferential control applied.');
        return 1;
      }

      // judgment:cold-3 — `rounds` IS MEASURED, SO IT REACHES A READER. Until
      // here it was computed by `gatherInferentialInputs`, declared in its
      // `@returns` shape, and read by nothing outside the tests. That is the
      // same defect the comment above records `shouldRun` having had, in the
      // value this slice's own bound produces: a number the run measures and
      // throws away.
      //
      // AND IT IS THE NUMBER `convergence.mjs` PROMISED THE OPERATOR. Its
      // argument for keeping `maxRounds` as a key at all is that "an operator
      // setting `maxRounds: 5` today gets one round of work and should know that
      // from here rather than from a bill" — but *here* was a source comment,
      // which is not a place a run reports to. The gap between what was
      // configured and what actually ran is the whole point, so it is stated
      // rather than left for the reader to subtract.
      log(`brain:review: judgment half converged in ${inferentialInputs.rounds} produce round(s).`);
      if (maxRounds > inferentialInputs.rounds) {
        log(
          `brain:review: reviewer.convergence.maxRounds is ${maxRounds}, and ${inferentialInputs.rounds} ` +
          'round(s) ran — the loop converged early. Raising the bound buys nothing until a transport ' +
          're-runs the stage between rounds.'
        );
      }

      // `generated` is an array here and cannot be null: the branch is guarded
      // by a generator existing, and the only other way out of `gather` is
      // `failed`, refused above. The `!== null` test this replaced was the
      // third reading of the one decision `judgmentHalfRuns` now owns.
      const judged = evaluateInferential(inferentialInputs);
      evalResult = {
        ...evalResult,
        findings: [...evalResult.findings, ...judged.findings],
      };
      controls = unionControls([controls, INFERENTIAL_PRODUCES]);
      judgmentAxis = judgment.axis;
    }
  }

  // brain-review/2 causal admission (issue #394 M3, completing #284): ONLY at
  // `protocol === 'brain-review/2'` (regulated tier's default, see above) do
  // findings get evidence_class/causal_disposition annotated and the refuter
  // run over them — a `brain-review/1` verdict (lite/standard's default)
  // renders neither field, exactly as before this wiring landed (renderVerdict
  // only emits `evidence_class`/`causal_disposition` `if (f.evidence_class)` /
  // `if (f.causal_disposition)` — never gated on protocol itself, so leaving
  // `/1` findings unannotated is what keeps `/1` output byte-for-byte
  // unchanged). See lib/causal-admission.mjs for why 'deterministic' /
  // 'introduced' are the safe defaults for tranche/checkpoint/ruling's
  // mechanically-derived findings.
  let { findings, escalate } = evalResult;
  let baseConditions = [];
  if (protocol === 'brain-review/2') {
    // #408 — the base probe is LAZY and it is expensive on purpose. It re-runs
    // `local-checks` in a worktree at base, which is the slowest thing the reviewer
    // can do, and it only happens when a gate it can speak to is ALREADY a blocker:
    // the PR is stopped and a human is about to be summoned, so paying ~a minute to
    // tell them "this is not your change's doing" is the cheap side of the trade. A
    // green PR never pays it, and neither does a PR blocked for any other reason.
    let baseProbe = null;
    let probeAttempted = false;
    if (needsBaseProbe(evalResult.findings)) {
      probeAttempted = true;
      const runProbe = deps.probeBase ?? probeBase;
      baseProbe = runProbe({
        baseSha,
        gates: BASE_REPRODUCIBLE_GATES,
      });
    }
    // #682 REQ-682-1/REQ-682-2: the challenger is CONSTRUCTED here, from config
    // and tier, at the injection point #552 already left. `deps.refuterRunner`
    // still wins so every existing test is unaffected — no test injects it
    // today, and the ones that reason about the null runner do so in prose.
    //
    // An unrecognised axis REFUSES the run rather than defaulting: an unknown
    // axis is an unknown evidentiary strength, and posting a verdict whose
    // self-description could be false is the thing #683 forbids. Same shape as
    // the controls-coverage refusal immediately below — error, post nothing,
    // exit non-zero.
    // The SAME resolution the producer read. `'refuterRunner' in deps` rather
    // than `??`: a test that deliberately passes `null` to exercise the
    // no-runner path must keep getting null, which `??` would have overridden.
    const challenger = 'refuterRunner' in deps ? deps.refuterRunner : judgment.challenger;

    // #682 round-1 review, finding H — the CALL was outside every try block.
    // `main` has exactly two (the config/tier resolution and the challenger
    // CONSTRUCTION), and the entry point is `process.exit(await main())` with no
    // outer catch, so a throw from inside the challenger surfaced as a raw
    // ERR_UNHANDLED_REJECTION: a Node stack, no `brain:review:` line, and NO
    // VERDICT POSTED. That is quieter than the fail-closed REVISE the same input
    // produced before the challenger existed — a regression of #552's fix
    // wearing the shape of a louder failure.
    try {
      ({ findings, escalate, conditions: baseConditions } = await applyCausalAdmission({
        findings: evalResult.findings,
        escalate: evalResult.escalate,
        runner: challenger,
        baseProbe,
        probeAttempted,
      }));
    } catch (err) {
      error(`brain:review: the challenger failed — ${err.message}. ` +
        'Refusing to post a verdict whose reasoned findings were never challenged.');
      return 1;
    }
  }

  // #683 — the declaration must not be able to become a lie. If an evaluator
  // emits a class it did not declare, this run REFUSES and posts nothing: a
  // verdict whose self-description is false is the exact artefact this field
  // exists to prevent, and silence is strictly better than a believed false
  // claim. Unreachable while every evaluator is deterministic, which is why it
  // is wired now rather than after a producer makes it reachable.
  const covered = checkControlsCoverFindings(controls, findings);
  if (!covered.ok) {
    error(`brain:review: ${covered.error}`);
    return 1;
  }

  const verdict = buildVerdict({
    headSha: boot.headSha,
    conclusion: evalResult.conclusion,
    // #750 — a plain pass-through, no `?? []`: buildVerdict's own
    // destructuring default is the ONE fail-closed home for an absent cause.
    // A second default here would be a second, untested place the same rule
    // could rot.
    conclusionCauses: evalResult.conclusionCauses,
    protocol,
    // #506 — at THIS head, not over the PR's lifetime. One definition, shared with
    // the anti-loop lock in poster.mjs.
    priorRevCount: verdictsAtHead(boot.doctrine.priorVerdicts, boot.headSha).length,
    rulingAtHead: (boot.doctrine.priorDecisions ?? []).some(d => d?.head_sha === boot.headSha),
    gates: evalResult.gates,
    controls,
    // REQ-682-3 — the axis that actually challenged the reasoned findings.
    // `null` when the judgment half did not run, and `renderVerdict` emits the
    // line only when a reasoned finding exists (#690's wallpaper rule).
    judgmentAxis,
    findings,
    // #408 — the base probe's own inability to run is a condition of THIS verdict,
    // appended to the evaluator's rather than replacing it: two different things
    // could not be computed and a reader needs to see both.
    conditions: [...evalResult.conditions, ...baseConditions, ...judgmentConditions],
    // undefined for tranche/checkpoint (they never set these) — buildVerdict's
    // own defaults (`pin` undefined, `escalate` null) apply unchanged, so this
    // is a no-op for those two modes.
    pin: evalResult.pin,
    escalate,
  });

  const rendered = renderVerdict(verdict);
  log(rendered);

  if (args.dryRun) {
    log('brain:review: --dry-run — no write verb invoked.');
    return 0;
  }

  // The poster gets the SAME bound port the cold boot read through (#501) — the
  // verdict is written under the identity that was verified, so the anti-loop
  // lock's `lastVerdict.author === reviewerHandle` becomes a true statement by
  // construction rather than by the two happening to be configured alike.
  const posterDeps =
    deps.posterDeps ??
    (deps.writeVerbs ? { getVcs: async () => deps.writeVerbs } : { getVcs: boundGetVcs });
  const postResult = await postVerdict({
    headSha: boot.headSha,
    project,
    number: args.pr,
    provider: deps.provider,
    mode,
    renderedBody: rendered,
    reviewerHandle: identity.handle,
    // #829: the fact as BUILT, not re-derived — this verdict applied the
    // judgment half iff its own controls say so.
    nextAppliesInferential: controls.includes('inferential'),
    priorVerdicts: boot.doctrine.priorVerdicts,
    // #405: the BUILT verdict's `findings`, and DELIBERATELY not its `follow_ups`.
    //
    // Two exclusions, and they have different reasons. Evidence-less findings are
    // dropped by `buildVerdict` and never appear in the block at all, so anchoring
    // one would put text on the diff that the posted verdict does not support.
    //
    // `follow_ups` is the harder case, because those findings ARE in the block —
    // the round-4 cold review found this comment claiming otherwise. They are
    // excluded on their own merit: a follow-up is `pre-existing` or `base-only`,
    // which is precisely the claim that it is NOT this change's doing. Anchoring
    // one would put a comment on a line in THIS author's diff about a defect the
    // verdict itself says they did not introduce — the causal-admission rule
    // (reviewer-protocol §6.2) inverted at the point where a human reads it.
    // They stay in the summary block, where the annotation that makes them
    // non-blocking travels with them.
    findings: verdict.findings,
    escalate: verdict.escalate,
    deps: posterDeps,
  });

  if (postResult.skipped) log(`brain:review: ${postResult.skipped} — nothing posted.`);

  // #766: a REFUSED post is not a skip. `skipped` is a decision this module made
  // and printed on stdout at exit 0, which is right for anti-loop and anti-stale;
  // a forge that rejected the write is a FAILED RUN, and it exits non-zero beside
  // the stage-failure and generator-failure refusals above. Without this branch a
  // scheduled reviewer whose credential expires reports success indefinitely, and
  // the absence of verdicts reads as "no PRs needed review".
  if (postResult.error) {
    error(`brain:review: the verdict was NOT posted — ${postResult.error}. ` +
      'The run computed a verdict the forge refused to accept; nothing is on the pull request.');
    return 1;
  }

  // REQ-405-4: the count has to reach a READER, not just the caller. An anchor
  // that is dropped, counted, and then never printed is the same silence the
  // requirement exists to break — the run would look identical to one that had
  // nothing to anchor in the first place.
  if (postResult.inlineDropped) {
    log(`brain:review: ${postResult.inlineDropped} inline comment(s) could not be anchored — the finding text is in the summary block above.`);
  }

  return 0;
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] ?? '').href;
if (isMain) {
  process.exit(await main());
}
