// run-cold-review-stage.mjs — the cold review, run as a stage (#682 slice 3, B.5).
//
// Resolve the engine → build the role → make the directory → CLEAR THE PREVIOUS
// ARTIFACT → spawn in the cold worktree → check that the artifact is there.
//
// The clearing step and the check are ONE mechanism, added at different times:
// the check landed in B.5 and the clearing in D.5, after #682's own cold review
// found that without it the check could not tell "the engine wrote this" from
// "a previous round left it here" (judgment:cold-1). Read them together — the
// check is what the clearing is for, and the clearing is what makes the check
// mean anything on the second review of a PR, which is the normal case.
//
// The check earns its place because the failure it catches is a fold rather
// than a crash:
//
//   An engine that exits 0 and writes nothing leaves no artifact. One layer down,
//   `makeArtifactGenerate` reads "no artifact" as `null`, the caller supplies no
//   `generate`, and the verdict says "enabled but no transport is configured" —
//   WORD FOR WORD what a repo that never routed the stage is told. So a silent
//   no-op engine and a repo that opted out render identically, and the operator
//   who configured the stage is told they did not.
//
//   That is #552's fold — "it broke" collapsed into "there was nothing to do" —
//   re-created one layer up by a producer instead of a runner. It is checked HERE
//   because here is the only layer that knows the stage was asked to run at all.
//
// IT TOUCHES GIT ZERO TIMES, and that is REQ-S3-3's second half. Committing the
// artifact would move the head the verdict binds itself to, and §10 would then
// make the verdict stale against its own commit — a review that invalidates
// itself by recording that it happened. The guarantee is structural (this module
// imports nothing that can commit) but "it performs no git operations" is a claim
// about an ABSENCE, and an absence asserted in a comment is not checked. So the
// test runs the whole thing inside a real git repository and reads
// `git status --porcelain` afterwards: exactly one entry, untracked, at the
// artifact's path, with HEAD and the index unmoved.
//
// THERE IS NO DEFAULT `runStage`, DELIBERATELY. Defaulting to the `claude`
// backend would mean a repo routing `sdd.map['cold-review'].engine` to anything
// else gets claude anyway — a silent degradation, which is precisely what B.6
// exists to forbid. Rather than ship that for one commit and forbid it in the
// next, the seam is required and the resolution lands in B.6 with its refusal.

import { join, dirname, isAbsolute, relative, resolve } from 'node:path';
import { mkdirSync, existsSync, rmSync, mkdtempSync, renameSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { COLD_REVIEW_STAGE, resolveStageEngine } from '../../lib/stage-engine.mjs';
import { credentialEnvNames, withoutCredentials } from '../../lib/credential-env.mjs';
import { assertProducerCannotReachForge, withForgeConfigDir } from '../../harness/producer-forge-reach.mjs';
import { assembleReviewPrompt } from './assemble-review-prompt.mjs';
import { firstPartyRole } from '../../roles/first-party/index.mjs';
import { artifactPathFor, readFindingsArtifact } from './findings-artifact.mjs';
import { compareCandidateSnapshots, snapshotCandidate } from './candidate-snapshot.mjs';

/**
 * describeCandidateChange(changes) — names WHAT changed for the "candidate
 * changed during execution" refusal (#1010). Before this, the refusal said
 * only that the candidate changed, leaving an operator to re-run under a
 * watcher (the exact measurement #1010's issue comments performed by hand)
 * to find out what. `changes` is `compareCandidateSnapshots(...).changes` —
 * `{added, removed, changed}` path arrays. Bounded to the first 10 (sorted,
 * `+`/`-`/`~` prefixed) plus a count of the rest: a mutated `npm test` run
 * can touch hundreds of paths, and an unbounded list is as unreadable as no
 * list at all.
 *
 * @param {{added: string[], removed: string[], changed: string[]}} changes
 * @returns {string}
 */
function describeCandidateChange(changes) {
  const all = [
    ...changes.added.map((path) => `+${path}`),
    ...changes.removed.map((path) => `-${path}`),
    ...changes.changed.map((path) => `~${path}`),
  ].sort();
  const shown = all.slice(0, 10);
  const suffix = all.length > shown.length ? ` (+${all.length - shown.length} more)` : '';
  return `${all.length} path(s) changed: ${shown.join(', ')}${suffix}`;
}

/**
 * runColdReviewStage() — runs the cold review for one PR.
 *
 * @param {{config: object, prNumber: number|string, baseRef?: string|null,
 *          headRef?: string|null, root?: string,
 *          deps?: {runStage: Function, mkdir?: Function, exists?: Function,
 *                  remove?: Function, env?: object, forgeProbe?: Function}}} args
 * @returns {Promise<{routed: false} | {routed: true, ok: false, reason: string}
 *                  | {routed: true, ok: true, artifactPath: string}>}
 * @throws {Error} when `sdd.map` names the stage unreadably (resolveStageEngine),
 *   when the PR number is not one, or when no `runStage` seam was supplied
 */
export async function runColdReviewStage({
  config,
  prNumber,
  baseRef = null,
  headRef = null,
  root = process.cwd(),
  worktreePath = null,
  timeoutMs = undefined,
  deps = {},
} = {}) {
  const { runStage } = deps;
  if (typeof runStage !== 'function') {
    throw new Error(
      'run-cold-review-stage: no runStage seam was supplied. There is no default on purpose — ' +
      'defaulting to one backend would hand it every engine a repo routes to, which is the ' +
      'silent degradation B.6 forbids.'
    );
  }
  const mkdir = deps.mkdir ?? ((abs) => mkdirSync(abs, { recursive: true }));
  const exists = deps.exists ?? ((abs) => existsSync(abs));
  // `force` so an absent file is not an error — the common case is a first run.
  // Everything else (a directory at the path, a permission failure) throws, and
  // the caller below turns that into a refusal rather than a silent pass.
  const remove = deps.remove ?? ((abs) => rmSync(abs, { force: true }));

  // The environment the PRODUCER would be spawned with, and the seam the forge
  // probe runs through. Both are injectable for the same reason every other
  // seam here is: the oracle for "this run refuses when a forge CLI is logged
  // in" cannot be the machine the suite happens to run on. `deps.env` defaults
  // to brain's own, which is what `runStage` will scrub and hand the child.
  const env = deps.env ?? process.env;
  // NO DEFAULT, ON PURPOSE — the same ruling `runStage` above already carries,
  // and for a sharper reason (judgment:cold-2, fourth cold review). This read
  // `deps.forgeProbe ? {_run: deps.forgeProbe} : {}`, so a caller that omitted
  // it spawned the machine's REAL `gh`/`glab`. Every test that forgot therefore
  // passed or failed on whether the developer happened to be logged in:
  // measured, with a stub `gh` exiting 0, `npm test` — a required gate — went
  // from green to ten failures, and the suite had been green here only because
  // this container has no `gh` installed at all.
  //
  // A TEST WHOSE ORACLE IS THE HOST is the defect class this ticket has spent
  // fourteen findings removing, and `producer-forge-reach.test.mjs` carries a
  // comment warning about it one layer down — written in the commit that
  // introduced it here. Refusing loudly is what makes the omission impossible to
  // commit again; `cli.mjs` supplies the real runner exactly as it supplies the
  // real `runStage` seam.
  if (typeof deps.forgeProbe !== 'function') {
    throw new Error(
      'run-cold-review-stage: no forgeProbe seam was supplied. There is no default on purpose — ' +
      'defaulting to the real runner makes every caller that forgets spawn the machine\'s own ' +
      'forge CLI, and a test that does so is measuring the developer, not the code.'
    );
  }
  const probeDeps = { _run: deps.forgeProbe };

  // #775 — the per-run forge config directory, and its disposal. Seams for the
  // same reason the rest are: a test must be able to observe the lifecycle
  // without writing to the machine's temp space, and the default must be the
  // real thing so a caller that forgets gets a real directory rather than none.
  const makeForgeConfigDir = deps.makeForgeConfigDir ?? (() => mkdtempSync(join(tmpdir(), 'brain-forge-')));
  const removeForgeConfigDir = deps.removeForgeConfigDir ?? ((dir) => rmSync(dir, { recursive: true, force: true }));

  // Throws on an entry that exists and cannot be read; `null` when the repo
  // routed nothing. Unrouted is NOT a failure — the caller renders it as the
  // no-transport state that ships today.
  const routing = resolveStageEngine(config, COLD_REVIEW_STAGE);
  if (routing === null) return { routed: false };

  // Before the prompt, because `artifactPathFor` is the boundary that refuses a
  // PR number that is not one, and the prompt is built from its answer.
  const artifactPath = artifactPathFor(prNumber);
  const artifactAbsolutePath = join(root, artifactPath);
  const isWithin = (parent, child) => {
    const rel = relative(resolve(parent), resolve(child));
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
  };
  // Codex and Gemini return their artifact as a final message. The host creates its only
  // writable destination beside the normal artifact, never in the candidate.
  const output = (routing.engine === 'codex' || routing.engine === 'gemini')
    ? {
        mode: 'final-message',
        tempPath: join(dirname(artifactAbsolutePath), `.${routing.engine}-final-${prNumber}-${crypto.randomUUID()}.tmp`),
        artifactPath: artifactAbsolutePath,
      }
    : undefined;
  if (output && isWithin(worktreePath, output.artifactPath)) {
    return { routed: true, ok: false, reason: `the ${routing.engine} final-message output resolves inside the cold-review candidate; refusing before clearing any artifact` };
  }

  // THE ENGINE READS THE COLD WORKTREE, AND REFUSING IS THE POINT (judgment:cold-3).
  //
  // ADR-0033 states the producer's load-bearing property as "the subagent reads
  // a cold worktree and writes a file", and design.md D6 says the generator
  // reads the diff from that worktree. It used to get `root` — the operator's
  // checked-out tree, an arbitrary branch with arbitrary uncommitted changes —
  // while the verdict bound itself to `headRef`. The divergence was SILENT
  // because `git diff BASE...HEAD` still resolves there: the range was right and
  // the file contents were whatever was on disk.
  //
  // Falling back to `root` when no worktree is supplied would re-create exactly
  // that, so this refuses instead. Same move as `assertRoutableStage`: a
  // property an ADR names is only as good as the thing that keeps it true.
  //
  // IT SITS ABOVE THE MUTATIONS, and that ordering is judgment:cold-3's fix.
  // It used to sit below them, so a run refused HERE had already deleted the
  // previous artifact — measured: the file was gone, the engine was never
  // reached, and the refusal named a missing worktree while saying nothing
  // about the file it had just destroyed. A true diagnosis with a silent
  // side effect is worse than a false one, because nothing prompts the reader
  // to go looking.
  //
  // THE RULE THIS ENCODES: every precondition refuses before any mutation.
  // Not "mention the deletion in the reason" — a run that cannot spawn has no
  // business clearing the output of the one that could.
  if (typeof worktreePath !== 'string' || worktreePath.trim() === '') {
    return {
      routed: true,
      ok: false,
      reason:
        'the cold-review stage was given no worktree to read. ADR-0033 makes reading a COLD ' +
        'checkout the producer\'s load-bearing property, and running in the operator\'s tree ' +
        'instead would review an arbitrary branch while the verdict binds itself to the head — ' +
        'silently, because the diff range still resolves. Refusing rather than reviewing the wrong tree.',
    };
  }
  let candidateBefore;
  try {
    candidateBefore = snapshotCandidate(worktreePath);
  } catch (err) {
    return { routed: true, ok: false, reason: `the cold-review candidate cannot be snapshotted — ${err?.message ?? String(err)}` };
  }

  // A PRECONDITION, SO IT RUNS BEFORE ANY MUTATION (judgment:cold-4, fourth cold
  // review). It sat below `mkdir` and below the `remove` that clears the previous
  // artifact, so a run that REFUSED had already destroyed the output of the run
  // that could — breaking the rule stated in capitals above, in the commit that
  // added it.
  //
  // THE SCRUB IS NOT THE WHOLE PROPERTY, AND THIS IS WHERE THAT STOPS BEING
  // ASSERTED (judgment:cold-1 of the third cold review). `credentialEnv` takes
  // brain's poster credential out of the child's ENVIRONMENT — kernel-enforced,
  // real. A forge CLI keeps its own store OUTSIDE the repository, so neither
  // that scrub nor the detached worktree touches it: measured, with every name
  // `credentialEnvNames()` returns unset, `gh auth status` still reported a logged-in account.
  //
  // So the property is MEASURED here rather than declared. The probe asks the
  // one question that does not depend on the deployment — "from this
  // environment, does a forge CLI still authenticate?" — and a `yes`, or a
  // probe that reaches no verdict at all, refuses the run. See
  // `producer-forge-reach.mjs` for the three location-based designs this
  // replaces and why each was wrong.
  //
  // IT REFUSES BEFORE THE SPAWN, not after. A ten-minute engine run whose
  // output must then be discarded is the same waste F.2 records at the routing
  // layer, and worse here: the artifact would already exist on disk.
  // #775 — THE SHADOW IS CREATED BEFORE THE PROBE, AND THE PROBE IS RUN AGAINST
  // IT. That ordering is the whole guarantee: a probe run against an unshadowed
  // environment answers about an environment the child never receives, and a
  // probe that lies is worse than no probe. The same path is handed to
  // `runStage` below, so the thing measured and the thing spawned are one env.
  //
  // WHAT IT BUYS AND WHAT IT DOES NOT is in `withForgeConfigDir`'s header,
  // measured on a logged-in machine. The short of it: the keyring secret is
  // untouched — the CLI simply can no longer find the host mapping that would
  // make it ask.
  //
  // PER-RUN AND DISPOSABLE, because `gh` WRITES a `config.yml` into whatever
  // directory it is given. A reused path is a place a session could accumulate,
  // which would turn this fix into the channel it closes.
  const forgeConfigDir = makeForgeConfigDir();
  try {
    const reach = assertProducerCannotReachForge(
      withForgeConfigDir(
        withoutCredentials(env, credentialEnvNames({ extra: [config?.reviewer?.tokenEnv] })),
        forgeConfigDir,
      ),
      probeDeps,
    );
    if (!reach.ok) {
      return {
        routed: true,
        ok: false,
        reason:
          `the producer can still reach the forge, so ADR-0033's load-bearing property does not ` +
          `hold for this run — ${reach.reason}. The per-run config-dir shadow (#775) did not ` +
          `close it on this deployment, so the remaining remedy is the one ` +
          `docs/reviewer-setup.md prescribes: \`gh auth logout\` (or \`glab auth logout\`) on the ` +
          `machine that runs the cold review, and authenticate by environment instead.`,
      };
    }


    // The engine is told to write a file; nothing guarantees its tooling creates
    // parents. Recursive, so an existing directory from a previous round is not an
    // error — re-running a review is normal, and #495's rev counter is what makes
    // rounds distinguishable, not the filesystem.
    //
    // IT TRAVELLED WITHOUT ITS CODE (judgment:cold-4, fifth cold review). The
    // reordering that lifted the forge probe above the mutations carried this
    // comment up with it, leaving it forty-two lines and one whole guard above the
    // call it describes — where its first sentence explained an operation that had
    // not happened yet, and read as a preamble to the probe.
    mkdir(dirname(join(root, artifactPath)));

    // THE ARTIFACT IS REMOVED BEFORE THE SPAWN, AND THAT IS WHAT MAKES THE CHECK
    // BELOW MEAN ANYTHING (judgment:cold-1).
    //
    // The presence check was a bare `exists`, so it could not tell "the engine
    // wrote this" from "a previous round left it here". Re-review is the NORMAL
    // case — §7 counts revisions precisely because it happens, and the mkdir
    // above is recursive for the same reason — so on every review after the
    // first, an engine that exited 0 and wrote nothing passed, and the verdict
    // for the NEW head declared the judgment control applied over findings
    // produced against an older one. The guard only ever held on a fresh repo,
    // which is exactly the shape its own test used.
    //
    // Deleting is the cheap half of the fix and the honest one: after this line,
    // a file at that path was written by THIS run, with no clock, no mtime and no
    // resolution to trust. The cost is that a failed run leaves no artifact to
    // inspect — accepted, because the artifact is already ruled ephemeral (it is
    // `.gitignore`d, and the verdict posted on the PR is the durable record).
    //
    // THE INVARIANT IS SCOPED TO ROUTED RUNS, AND THAT IS DELIBERATE — the first
    // cut of this note said "a file at that path was written by THIS run" flat,
    // which claims more than the code delivers (judgment:cold-3). The clearing
    // sits BELOW the routing check, so on an unrouted run nothing is cleared.
    //
    // Clearing there would be a defect, not a fix. On the unrouted path the file
    // is not a previous round's OUTPUT — it is the operator's own INPUT. That is
    // slice A's shipped shape: the artifact was the transport before any engine
    // existed to write it, and the highest-level test of the whole wire
    // (`regulated-review.e2e` A.4) writes the file by hand with no `sdd.map`
    // entry at all and expects the verdict to read it. A `remove()` above the
    // routing check would delete the operator's input and report that the
    // judgment half found nothing.
    //
    // WHAT IS GENUINELY AMBIGUOUS, said rather than papered over: a repo that
    // ROUTED the stage, got an artifact, and then UN-ROUTED it leaves a previous
    // round's engine output on disk, where the next run reads it as operator
    // input. Nothing on disk separates the two — same path, same shape, and D.5
    // already established there is no clock to trust. Closing it needs
    // provenance recorded INSIDE the artifact by whoever wrote it, which is a
    // ruling about the format rather than an ordering fix, and is not this
    // slice's. Named here so the next reader finds a known gap instead of
    // re-deriving it from a comment that overstated its own coverage.
    //
    // A REMOVAL THAT FAILS IS A REFUSAL. Continuing would run the engine with the
    // stale file still there and land back in the state this exists to prevent —
    // and the operator would be told the engine wrote nothing, which would be a
    // lie about a file the engine never got the chance to replace.
    try {
      remove(join(root, artifactPath));
    } catch (err) {
      return {
        routed: true,
        ok: false,
        reason:
          `the stage could not clear the previous artifact at ${artifactPath} — ${err?.message ?? String(err)}. ` +
          'Refusing rather than running: with a stale file in place, an engine that wrote nothing would ' +
          'look exactly like one that did its job, and the verdict would declare a control it applied ' +
          'to findings from an older head.',
      };
    }

    const result = await runStage({
      stage: COLD_REVIEW_STAGE,
      // The artifact path renders ABSOLUTE, into `root`: the engine READS the cold
      // worktree and WRITES where the reader looks. A relative path would land the
      // findings inside the throwaway checkout, and the presence check below would
      // then report "wrote no artifact" about a file written perfectly.
      // #814 D5: the role is SERVED (brain's first-party Adversary instance),
      // the protocol is assembled beside the reader. Direction of imports:
      // review → roles/first-party, never back.
      prompt: assembleReviewPrompt({ role: firstPartyRole(COLD_REVIEW_STAGE), prNumber, baseRef, headRef, artifactRoot: root, outputMode: output ? 'final-message' : 'file' }),
      model: routing.model,
      engine: routing.engine,
      cwd: worktreePath,
      // THE PRODUCER MUST NOT INHERIT BRAIN'S POSTING CREDENTIAL (judgment:cold-2).
      // The backend scrubs the default set on its own — this only WIDENS it with
      // the name this repo actually configured, which is the one thing this layer
      // knows and the harness cannot learn: `loadBrainConfig` resolves from the
      // module's location, so in a consumer it would read node_modules' config.
      // A repo that renamed `reviewer.tokenEnv` would otherwise hand the engine
      // the very credential ADR-0033 says it does not hold.
      credentialEnv: credentialEnvNames({ extra: [config?.reviewer?.tokenEnv] }),
      // #775 — the same directory the probe was measured against, never a second
      // one. Two paths here would mean the probe answered about an environment
      // the producer does not get, which is the failure this parameter exists to
      // make impossible rather than merely unlikely.
      forgeConfigDir,
      // F.9 — the ceiling the CALLER resolved. Resolved in `main()` rather than
      // here (judgment:cold-2): evaluating it in this argument list put a refusal
      // after `mkdir` and after `remove` had deleted the previous artifact, and
      // below the routing check, so an unrouted repo never validated the key.
      timeoutMs,
      output,
    });

    if (!result?.ok) {
      return {
        routed: true,
        ok: false,
        elapsedMs: result?.elapsedMs ?? null,
        reason: result?.reason ?? 'the engine returned no result',
      };
    }

    let candidateAfter;
    try {
      candidateAfter = snapshotCandidate(worktreePath);
    } catch (err) {
      return { routed: true, ok: false, reason: `the cold-review candidate cannot be re-snapshotted — ${err?.message ?? String(err)}` };
    }
    const candidateComparison = compareCandidateSnapshots(candidateBefore, candidateAfter);
    if (!candidateComparison.equal) {
      return {
        routed: true,
        ok: false,
        reason: `the cold-review candidate changed during execution; refusing publication — ${describeCandidateChange(candidateComparison.changes)}`,
      };
    }

    if (output) {
      try {
        renameSync(output.tempPath, output.artifactPath);
      } catch (err) {
        return { routed: true, ok: false, reason: `the Codex final message could not be atomically materialized — ${err?.message ?? String(err)}` };
      }
      const parsed = readFindingsArtifact(readFileSync(output.artifactPath, 'utf8'));
      if (!parsed.ok) {
        return { routed: true, ok: false, reason: `the Codex final message could not be read by the existing findings reader — ${parsed.reason}` };
      }
    }

    // See the header: a clean exit with no artifact is the state that would
    // otherwise render as "you never configured this".
    if (!exists(join(root, artifactPath))) {
      return {
        routed: true,
        ok: false,
        reason:
          `the engine exited cleanly but wrote no artifact at ${artifactPath} — that is a ` +
          'transport that ran and produced nothing, and it must not render as a repo that ' +
          'never routed the stage.',
      };
    }

    return { routed: true, ok: true, artifactPath, elapsedMs: result?.elapsedMs ?? null };
  } finally {
    // EVERY exit, including the refusals that return early and a throw from the
    // engine. The directory is brain's own leftover, and a cleanup reachable
    // only on the happy path is the shape that leaves one behind on exactly the
    // runs an operator is already debugging.
    removeForgeConfigDir(forgeConfigDir);
  }
}
