// run-cold-review-stage.test.mjs — #682 slice 3, B.5.
//
// The centrepiece is `git status --porcelain` read inside a REAL repository
// after a real run. REQ-S3-3's second half is that the stage does not commit,
// and that is a claim about an ABSENCE: the module performs no git operations,
// which no assertion about its source can check and which a future edit could
// quietly undo. So the property is measured from outside, on a repository, by
// the tool that would notice.
//
// It is deliberately stronger than "did not commit". A stage that committed
// nothing but rewrote three tracked files would pass "HEAD is unchanged" and
// would still have corrupted the diff the verdict is about. The assertion is
// that the run's ONLY mutation is the artifact.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { removeTempTree } from '../../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';

import { runColdReviewStage } from './run-cold-review-stage.mjs';
import { artifactPathFor, ARTIFACT_TAG } from './findings-artifact.mjs';
import { COLD_REVIEW_STAGE } from '../../lib/stage-engine.mjs';
import { TIMEOUT_IN_FORCE_TODAY } from './stage-timeout.mjs';

/**
 * A forge CLI reporting NO session. Injected into every call, because
 * `runColdReviewStage` refuses without it (judgment:cold-2, fourth cold review):
 * the seam used to default to the real runner, so a test that forgot spawned the
 * machine's own `gh` and its result depended on whether the developer was logged
 * in — measured, ten failures on a machine with a keyring session, green here
 * only because this container has no `gh` at all.
 */
const LOGGED_OUT = () => ({ status: 1, stderr: 'not logged into any hosts' });

const PR = 765;
const ROUTED = { sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'claude', model: 'claude-opus-5' } } } };

function git(dir, ...args) {
  const r = spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
  return (r.stdout ?? '').trim();
}

/**
 * A repo with one commit. Identity is set explicitly: `git init` inherits none,
 * and a fresh CI runner has none to auto-detect, so a fixture that commits
 * without it passes locally and fails off the author's machine (house pattern).
 */
function makeRepo(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cold-review-stage-'));
  t.after(() => removeTempTree(dir));
  spawnSync('git', ['init', '--initial-branch=main', dir], { encoding: 'utf8' });
  for (const [k, v] of [['user.email', 'test@test.com'], ['user.name', 'Test'], ['commit.gpgsign', 'false']]) {
    git(dir, 'config', k, v);
  }
  writeFileSync(join(dir, 'tracked.txt'), 'original\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'base');
  return dir;
}

/**
 * A COLD WORKTREE: a separate directory the engine runs in (judgment:cold-3).
 *
 * Separate on purpose. When the engine's cwd and the artifact's root are the
 * same path, "the engine writes where the reader looks" is true by accident and
 * no test can tell the two apart — which is how the stage shipped reading the
 * operator's tree while the verdict bound itself to the PR head.
 */
function makeWorktree(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cold-review-worktree-'));
  t.after(() => removeTempTree(dir));
  return dir;
}

/** A seam that behaves like an engine which did its job. */
function writingEngine(root, prNumber = PR) {
  return async () => {
    writeFileSync(
      join(root, artifactPathFor(prNumber)),
      `# cold review\n\n\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`
    );
    return { ok: true };
  };
}

test('the run leaves exactly ONE change, untracked, at the artifact path', async (t) => {
  const root = makeRepo(t);
  const headBefore = git(root, 'rev-parse', 'HEAD');

  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t), deps: { forgeProbe: LOGGED_OUT, runStage: writingEngine(root) },
  });

  // F.9 added `elapsedMs` — a clock reading, not what this test is about.
  const { elapsedMs, ...shape } = result;
  assert.deepEqual(shape, { routed: true, ok: true, artifactPath: artifactPathFor(PR) });

  // No commit: the head the verdict binds itself to has not moved. §10 would
  // make the verdict stale against its own commit if it had.
  assert.equal(git(root, 'rev-parse', 'HEAD'), headBefore, 'HEAD must not move');

  // Nothing staged, and nothing tracked modified. Either would mean the run
  // edited the very diff it is reviewing.
  assert.equal(git(root, 'diff', '--cached', '--name-only'), '', 'the index must be untouched');
  assert.equal(git(root, 'diff', '--name-only'), '', 'no tracked file may be modified');

  // The whole worktree delta, as one string. Asserted as an EXACT match rather
  // than "the artifact is in there": a run that also dropped a scratch file, a
  // log, or a rewritten config would satisfy a containment check.
  //
  // `-uall` is load-bearing, not tidiness. Plain `--porcelain` COLLAPSES a wholly
  // untracked directory to a single `?? openspec/` line — measured, it is what
  // the first cut of this assertion got back. Under that form a second file
  // dropped beside the artifact is invisible, and the exact-match assertion above
  // would have passed while the run scattered whatever it liked inside the new
  // directory. The listing has to name files for "exactly one mutation" to mean
  // anything.
  assert.equal(
    git(root, 'status', '--porcelain', '-uall'),
    `?? ${artifactPathFor(PR)}`,
    'the artifact must be the run\'s only mutation, and it must be untracked'
  );
});

test('the stage creates its directory — the engine is not asked to', async (t) => {
  const root = makeRepo(t);
  const dir = dirname(join(root, artifactPathFor(PR)));
  assert.equal(existsSync(dir), false, 'precondition: the directory does not exist yet');

  let sawDir = false;
  await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async () => {
        // Read from INSIDE the engine's turn: the directory has to exist when
        // the engine runs, not merely by the time the caller looks.
        sawDir = existsSync(dir);
        writeFileSync(join(root, artifactPathFor(PR)), `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
        return { ok: true };
      },
    },
  });

  assert.ok(sawDir, 'the directory must exist before the engine is spawned');
});

test('a second round is not an error — the directory already being there is normal', async (t) => {
  const root = makeRepo(t);
  const deps = { runStage: writingEngine(root), forgeProbe: LOGGED_OUT };

  const wt = makeWorktree(t);
  const first = await runColdReviewStage({ config: ROUTED, prNumber: PR, root, worktreePath: wt, deps });
  const second = await runColdReviewStage({ config: ROUTED, prNumber: PR, root, worktreePath: wt, deps });

  assert.equal(first.ok, true);
  assert.equal(second.ok, true, 'reviews have rounds; the filesystem is not what distinguishes them');
});

test('unrouted does not run, and is NOT reported as a failure', async (t) => {
  const root = makeRepo(t);
  let spawned = false;

  const result = await runColdReviewStage({
    config: { sdd: { map: {} } }, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });

  assert.deepEqual(result, { routed: false });
  assert.equal(spawned, false, 'nothing may be spawned for a stage nobody routed');

  // ASKED OF THE FILESYSTEM, NOT OF GIT. The first cut asserted `git status` was
  // empty and claimed it proved no directory was created — measured, moving the
  // `mkdir` ahead of the routing guard left that assertion GREEN, because git
  // does not track empty directories and an empty `openspec/reviews/pr-765/` is
  // invisible to `status` at any `-u` level. Git is the right tool for "did it
  // commit" and the wrong one for "did it create a directory".
  assert.equal(
    existsSync(dirname(join(root, artifactPathFor(PR)))), false,
    'an unrouted stage must not create the directory — a repo that opted out gets no ' +
      'artefacts of a run that did not happen'
  );
  assert.equal(git(root, 'status', '--porcelain', '-uall'), '', 'and nothing git can see, either');
});

test('a clean exit with NO artifact is a failure, not "found nothing"', async (t) => {
  const root = makeRepo(t);

  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => ({ ok: true }) },   // exits 0, writes nothing
  });

  // The fold this check exists to prevent: with no artifact,
  // `makeArtifactGenerate` returns null and the verdict says "enabled but no
  // transport is configured" — the SAME words a repo that never routed the stage
  // gets. Without this branch, a silent no-op engine tells the operator who
  // configured it that they did not.
  assert.equal(result.routed, true, 'the stage WAS routed — that fact must survive the failure');
  assert.equal(result.ok, false);
  assert.match(result.reason, /wrote no artifact/);
  assert.match(result.reason, /never routed the stage/, 'and must name the state it refuses to be confused with');
});

test('an engine that failed is reported with its own reason', async (t) => {
  const root = makeRepo(t);

  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => ({ ok: false, reason: 'the engine exited with status 137' }) },
  });

  const { elapsedMs, ...shape } = result;
  assert.deepEqual(shape, { routed: true, ok: false, reason: 'the engine exited with status 137' });
});

test('a seam that answers nothing at all is still a failure', async (t) => {
  const root = makeRepo(t);

  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t), deps: { forgeProbe: LOGGED_OUT, runStage: async () => undefined },
  });

  assert.equal(result.ok, false, 'an undefined answer must not read as success');
  assert.match(result.reason, /no result/);
});

test('the engine is handed the RESOLVED engine and model, and the stage name', async (t) => {
  const root = makeRepo(t);
  const worktree = makeWorktree(t);

  async function seamSees(config) {
    let seen = null;
    await runColdReviewStage({
      config, prNumber: PR, root, worktreePath: worktree, baseRef: 'aaa', headRef: 'bbb',
      deps: { forgeProbe: LOGGED_OUT,
        runStage: async (args) => {
          seen = args;
          writeFileSync(join(root, artifactPathFor(PR)), `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
          return { ok: true };
        },
      },
    });
    return seen;
  }

  // TWO ROUTINGS, and neither is the obvious default. The first cut ran only the
  // `{engine: 'claude', model: 'claude-opus-5'}` fixture and asserted those two
  // strings — measured, replacing `routing.engine`/`routing.model` with those
  // exact literals left it GREEN. An oracle whose fixture equals the hardcode it
  // is meant to catch is not an oracle. Driving two distinct routings kills the
  // hardcode whichever value it picks.
  const a = await seamSees({ sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'antigravity', model: 'zz-9' } } } });
  const b = await seamSees({ sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'plain', model: null } } } });

  assert.equal(a.engine, 'antigravity', 'the resolved engine must reach the seam — B.6 dispatches on it');
  assert.equal(a.model, 'zz-9', 'the model rides through opaquely — brain never interprets it (#323)');
  assert.equal(b.engine, 'plain');
  assert.equal(b.model, null, 'an absent model stays absent rather than acquiring a default');

  assert.equal(a.stage, COLD_REVIEW_STAGE);

  // judgment:cold-3. THIS LINE USED TO ASSERT `root`, WHICH IS THE DEFECT — a
  // test can pin the wrong behaviour just as firmly as the right one, and this
  // one did, for the whole slice. The engine reads the COLD checkout, so what
  // it sees is the code the verdict binds itself to rather than whatever branch
  // the operator has out.
  assert.equal(
    a.cwd, worktree,
    'the engine must run in the cold worktree — running in the operator tree reviews an arbitrary ' +
    'branch while the verdict claims the head, and silently, because the diff range still resolves'
  );

  assert.ok(a.prompt.includes('git diff aaa...bbb'), 'the refs reach the role');

  // And the WRITE target is the other half: absolute, into `root`, because the
  // reader looks there. Relative, it would land in the throwaway worktree and
  // the presence check would call a perfectly written artifact missing.
  assert.ok(
    a.prompt.includes(join(root, artifactPathFor(PR))),
    'the path the engine is told to write must be absolute into the operator tree, not relative to its cwd'
  );
});

test('there is NO default runStage — a missing seam refuses instead of picking a backend', async (t) => {
  const root = makeRepo(t);

  await assert.rejects(
    () => runColdReviewStage({ config: ROUTED, prNumber: PR, root }),
    /no default on purpose/,
    'defaulting to one backend would hand it every engine a repo routes to'
  );
});

test('an unreadable routing entry throws rather than running unrouted', async (t) => {
  const root = makeRepo(t);

  await assert.rejects(
    () => runColdReviewStage({
      config: { sdd: { map: { [COLD_REVIEW_STAGE]: {} } } },
      prNumber: PR, root, deps: { forgeProbe: LOGGED_OUT, runStage: async () => ({ ok: true }) },
    }),
    /names no engine/,
    'an operator who wrote the key asked for something; silence would ignore it'
  );
});

test('a PR number that is not one is refused BEFORE anything is created', async (t) => {
  const root = makeRepo(t);
  let spawned = false;

  await assert.rejects(
    () => runColdReviewStage({
      config: ROUTED, prNumber: '../../etc', root,
      deps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
    }),
    /is not a PR number/
  );

  assert.equal(spawned, false, 'nothing spawned');

  // The filesystem again, for the same reason: a directory made for a rejected
  // path segment is exactly the kind of empty directory git cannot report.
  assert.equal(
    existsSync(join(root, 'openspec', 'reviews')), false,
    'nothing created — the guard must run before the mkdir, or a rejected number has ' +
      'already made a directory somewhere by the time it is refused'
  );
});

// ── #682 C.5's verdict, judgment:cold-3 ──────────────────────────────────────

test('#682 cold-3: no worktree is a REFUSAL, not a quiet fallback to the operator tree', async (t) => {
  const root = makeRepo(t);
  let spawned = false;

  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root,       // no worktreePath
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => { spawned = true; return { ok: true }; } },
  });

  assert.equal(spawned, false, 'nothing may be spawned without the checkout the ADR names');
  assert.equal(result.routed, true, 'routed stays true — the repo DID route this, and the caller needs to tell ' +
    'a failure apart from a repo with no transport');
  assert.equal(result.ok, false);
  assert.match(result.reason, /cold/i, 'the reason must name what is missing, not merely that something is');

  // The fallback this refusal replaces is the defect itself: reviewing `root`
  // would produce a well-formed verdict over the wrong tree, and the diff range
  // would still resolve, so nothing downstream could notice.
  assert.doesNotMatch(result.reason, /^the engine/, 'this is not the engine failing — it never ran');
});

test('#682 cold-3: the engine writes into the operator tree and leaves the worktree untouched', async (t) => {
  const root = makeRepo(t);
  const worktree = makeWorktree(t);
  let cwdSeen = null;
  let told = null;

  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: worktree,
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async ({ cwd, prompt }) => {
        cwdSeen = cwd;
        // An engine follows the path it is GIVEN. Writing what the prompt names
        // is the whole behaviour under test: if that path were relative, this
        // resolves inside the worktree and the presence check below fails.
        told = prompt.split('\n').find((l) => l.startsWith('Write exactly one file'))
          .match(/`([^`]+)`/)[1];
        writeFileSync(told, `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
        return { ok: true };
      },
    },
  });

  assert.equal(cwdSeen, worktree, 'the engine reads the cold checkout');
  assert.equal(result.ok, true, `the reader must find what the engine wrote — it was told ${told}`);
  assert.ok(existsSync(join(root, artifactPathFor(PR))), 'the artifact belongs where artifactDeps looks');
  assert.equal(
    existsSync(join(worktree, artifactPathFor(PR))), false,
    'and NOT in the throwaway checkout, which is deleted with it — findings written there are findings lost'
  );
});

test('a candidate mutation after the engine starts refuses publication and NAMES the path that changed', async (t) => {
  const root = makeRepo(t);
  const candidate = makeWorktree(t);
  writeFileSync(join(candidate, 'candidate.txt'), 'before\n');

  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: candidate,
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => {
      writeFileSync(join(candidate, 'candidate.txt'), 'after\n');
      writeFileSync(join(root, artifactPathFor(PR)), `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
      return { ok: true };
    } },
  });

  assert.equal(result.routed, true);
  assert.equal(result.ok, false);
  // #1010 — the refusal used to say only "the candidate changed", which is
  // correct but leaves an operator re-running under a watcher to find out
  // WHAT. `compareCandidateSnapshots` already carries added/removed/changed
  // path lists; the reason now names them.
  assert.equal(
    result.reason,
    'the cold-review candidate changed during execution; refusing publication — 1 path(s) changed: ~candidate.txt',
  );
});

test('a candidate mutation with many changed paths bounds the refusal to the first 10 and a count (#1010)', async (t) => {
  const root = makeRepo(t);
  const candidate = makeWorktree(t);

  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: candidate,
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => {
      // 12 new files — one more than the 10-path bound — so the refusal must
      // show exactly 10 and say "(+2 more)" rather than spam an unreadable
      // wall of paths (the shape a mutated `npm test` run — #1010 — would
      // otherwise produce, since it can touch hundreds of paths).
      for (let i = 0; i < 12; i += 1) {
        writeFileSync(join(candidate, `new-${String(i).padStart(2, '0')}.txt`), 'x\n');
      }
      writeFileSync(join(root, artifactPathFor(PR)), `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
      return { ok: true };
    } },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /^the cold-review candidate changed during execution; refusing publication — 12 path\(s\) changed: /);
  assert.match(result.reason, /\(\+2 more\)$/, 'only the first 10 paths are named, with a count of what was elided');
  assert.equal((result.reason.match(/\+new-/g) ?? []).length, 10, 'exactly 10 paths are named');
});

// ── #682 C.5's verdict, judgment:cold-1 ──────────────────────────────────────

test('#682 cold-1: a STALE artifact does not pass for one this run wrote', async (t) => {
  const root = makeRepo(t);
  const abs = join(root, artifactPathFor(PR));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `\`\`\`${ARTIFACT_TAG}\n[{"id":"OLD","severity":"blocker","evidence":"found at the PREVIOUS head"}]\n\`\`\`\n`);

  // An engine that exits 0 and writes NOTHING — the exact case the presence
  // check exists to catch, and the case it could not see while a previous
  // round's file was lying there. Re-review is normal, so this was the state on
  // every review after the first.
  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => ({ ok: true }) },
  });

  assert.equal(result.ok, false, 'a run that produced nothing must not inherit the last one\'s findings');
  assert.match(result.reason, /wrote no artifact/, 'and it is reported as the engine producing nothing');
  assert.equal(
    existsSync(abs), false,
    'the stale file must be GONE — leaving it lets the next reader treat an older head\'s findings as this head\'s'
  );
});

test('#682 cold-1: the clearing happens BEFORE the engine runs, not after', async (t) => {
  const root = makeRepo(t);
  const abs = join(root, artifactPathFor(PR));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, 'stale\n');

  let staleWasGone = null;
  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async () => {
        // Asked from INSIDE the engine's turn. Clearing after the spawn would
        // delete what the engine just wrote, so the ordering is not a detail:
        // it is the difference between the fix and a new defect.
        staleWasGone = !existsSync(abs);
        writeFileSync(abs, `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
        return { ok: true };
      },
    },
  });

  assert.equal(staleWasGone, true, 'the engine must start from a clean slate');
  assert.equal(result.ok, true, 'and what it wrote must survive — clearing after the spawn would eat it');
});

test('#682 cold-1: a clearing that FAILS refuses, with its own reason', async (t) => {
  const root = makeRepo(t);

  const failed = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT,
      remove: () => { throw new Error('EACCES: permission denied'); },
      runStage: async () => { throw new Error('the engine must never run'); },
    },
  });

  assert.equal(failed.routed, true);
  assert.equal(failed.ok, false);
  assert.match(failed.reason, /could not clear/, 'the operator must be told what actually stopped the run');
  assert.match(failed.reason, /EACCES/, 'carrying the underlying cause, not a summary of it');

  // PAIRWISE DISTINCT, the way C.3 requires. "I could not clear the old file"
  // and "the engine wrote nothing" are different facts with different fixes,
  // and folding them would tell the operator the engine failed when it never ran.
  const wroteNothing = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => ({ ok: true }) },
  });
  assert.notEqual(failed.reason, wroteNothing.reason);
  assert.doesNotMatch(wroteNothing.reason, /could not clear/);
});

// ── The configured credential name — judgment:cold-2 ─────────────────────────
//
// The backend scrubs a fail-closed default on its own, and this layer's only
// job is to WIDEN it with the name the repo actually configured. It has to
// happen here: `loadBrainConfig` resolves `CONFIG_PATH` from the MODULE's
// location, so in a consumer the harness would read node_modules' config
// instead of the repo's — and a repo that renamed `reviewer.tokenEnv` would
// hand the engine the very credential ADR-0033 says the producer never holds.

test('#682 cold-2: the repo\'s configured reviewer.tokenEnv reaches the spawn', async (t) => {
  const dir = makeRepo(t);
  let seen = null;

  await runColdReviewStage({
    config: { ...ROUTED, reviewer: { handle: 'bot', tokenEnv: 'REPO_SPECIFIC_REVIEWER_TOKEN' } },
    prNumber: PR,
    root: dir,
    worktreePath: dir,
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async (args) => {
        seen = args;
        writeFileSync(join(dir, artifactPathFor(PR)), `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
        return { ok: true };
      },
    },
  });

  assert.ok(
    Array.isArray(seen.credentialEnv) && seen.credentialEnv.includes('REPO_SPECIFIC_REVIEWER_TOKEN'),
    'the configured credential name never reached the spawn — the producer inherits it'
  );
  // Widening, never narrowing: the defaults have to survive alongside it.
  assert.ok(seen.credentialEnv.includes('BRAIN_REVIEWER_TOKEN'));
  assert.ok(seen.credentialEnv.includes('GH_TOKEN'));
});

test('#682 cold-2: a repo with NO reviewer block still gets the default set', async (t) => {
  const dir = makeRepo(t);
  let seen = null;

  await runColdReviewStage({
    config: ROUTED,
    prNumber: PR,
    root: dir,
    worktreePath: dir,
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async (args) => {
        seen = args;
        writeFileSync(join(dir, artifactPathFor(PR)), `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
        return { ok: true };
      },
    },
  });

  // `config?.reviewer?.tokenEnv` is `undefined` here. It must be dropped rather
  // than ride in as a name, or the scrub set carries a junk entry forever.
  assert.ok(seen.credentialEnv.includes('BRAIN_REVIEWER_TOKEN'));
  for (const n of seen.credentialEnv) {
    assert.ok(typeof n === 'string' && n.trim() !== '', `junk name in the scrub set: ${JSON.stringify(n)}`);
  }
});

// ── Preconditions before mutations — judgment:cold-3 ─────────────────────────
//
// The worktree refusal used to sit BELOW the clearing, so a run that could
// never spawn had already deleted the previous artifact. Measured before the
// fix: the file was gone, the engine was never reached, and the reason named a
// missing worktree while saying nothing about the file it had just destroyed.

test('#682 cold-3: a run refused for want of a worktree destroys NOTHING', async (t) => {
  const dir = makeRepo(t);
  const abs = join(dir, artifactPathFor(PR));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);

  const result = await runColdReviewStage({
    config: ROUTED,
    prNumber: PR,
    root: dir,
    worktreePath: null,
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async () => { throw new Error('the engine must not be reached on a refused run'); },
    },
  });

  assert.equal(result.routed, true);
  assert.equal(result.ok, false);
  assert.match(result.reason, /no worktree/);
  assert.ok(
    existsSync(abs),
    'the refusal deleted the previous artifact on its way out — a run that cannot spawn has no ' +
    'business clearing the output of the one that could, and the reason says nothing about it'
  );
});

test('#682 cold-3: a refused run creates NOTHING either — not just destroys nothing', async (t) => {
  // THIS ASSERTION EXISTS BECAUSE A MUTATION SURVIVED. The fix above was stated
  // as "every precondition refuses before ANY mutation", and only the
  // destructive half had an oracle: hoisting the `mkdir` back above the
  // worktree refusal left the whole suite green. A rule whose second clause
  // nothing reads is the defect this ticket keeps finding, committed inside the
  // fix for one instance of it.
  //
  // The directory is the cheap mutation — an empty `openspec/reviews/pr-N/`
  // harms nobody. That is exactly why it needs the assertion rather than
  // trust: nothing downstream would ever complain, so the ordering would rot
  // silently and the next reader would take the comment at its word.
  const dir = makeRepo(t);
  const artifactDir = dirname(join(dir, artifactPathFor(PR)));

  const result = await runColdReviewStage({
    config: ROUTED,
    prNumber: PR,
    root: dir,
    worktreePath: '   ',
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => { throw new Error('the engine must not be reached on a refused run'); } },
  });

  assert.equal(result.ok, false);
  assert.ok(
    !existsSync(artifactDir),
    'the refused run left a directory behind — "before any mutation" has to mean the mkdir too, ' +
    'or the phrase is a slogan with half an oracle'
  );
});

test('#682 cold-3: an UNROUTED run leaves the artifact alone — it is the operator\'s input', async (t) => {
  // Not an oversight that the clearing sits below the routing check: on this
  // path the file is slice A's transport, written by hand before any engine
  // existed to write it, and `regulated-review.e2e` A.4 depends on exactly
  // this. A future "fix" that hoisted `remove()` above the routing check would
  // delete the operator's input and report that the half found nothing — so
  // the deliberate scoping is pinned rather than left to a comment.
  const dir = makeRepo(t);
  const abs = join(dir, artifactPathFor(PR));
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);

  const result = await runColdReviewStage({
    config: { sdd: { map: {} } },
    prNumber: PR,
    root: dir,
    worktreePath: dir,
    deps: { forgeProbe: LOGGED_OUT, runStage: async () => { throw new Error('nothing may be spawned when nothing is routed'); } },
  });

  assert.deepEqual(result, { routed: false });
  assert.ok(existsSync(abs), 'an unrouted run deleted a file it was never asked to produce');
});


// ── judgment:cold-1 (third cold review) — the forge-reach refusal ──────────
//
// THESE INJECT THE PROBE, and that is the point rather than a convenience. On a
// machine where no forge CLI is installed the check passes for free, so a suite
// that relied on the ambient one would go green everywhere while enforcing
// nothing on the machines that matter — a test whose oracle is the host, which
// is the defect class this whole ticket has been removing.

test('cold-1: a logged-in forge CLI REFUSES the run, and the engine is never spawned', async (t) => {
  const root = makeRepo(t);
  let spawned = false;
  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async () => { spawned = true; return { ok: true }; },
      forgeProbe: () => ({ status: 0, stdout: 'Logged in to github.com account someone' }),
    },
  });
  assert.equal(result.routed, true);
  assert.equal(result.ok, false);
  assert.equal(spawned, false, 'refusing AFTER a ten-minute spawn would waste the run it exists to prevent');
  assert.match(result.reason, /can still reach the forge/);
});

test('cold-1: the refusal names ADR-0033\'s property, so the operator knows WHY it refused', async (t) => {
  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root: makeRepo(t), worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async () => ({ ok: true }),
      forgeProbe: () => ({ status: 0 }),
    },
  });
  assert.match(result.reason, /ADR-0033/);
});

test('cold-1: a probe that reaches NO verdict refuses too — fail closed', async (t) => {
  let spawned = false;
  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root: makeRepo(t), worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async () => { spawned = true; return { ok: true }; },
      forgeProbe: () => ({ error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }),
    },
  });
  assert.equal(result.ok, false, '"could not look" is not "nothing is there"');
  assert.equal(spawned, false);
});

test('cold-1: a logged-OUT forge CLI lets the run proceed', async (t) => {
  const root = makeRepo(t);
  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: {
      runStage: writingEngine(root),
      forgeProbe: () => ({ status: 1, stderr: 'not logged into any hosts' }),
    },
  });
  assert.equal(result.ok, true, 'the check must not refuse a run whose producer genuinely holds nothing');
});

test('cold-1: the probe sees the SCRUBBED env, never brain\'s own', async (t) => {
  // A probe run against brain's environment would measure brain and clear the
  // producer — a true answer to the wrong question.
  let seenEnv = null;
  const root = makeRepo(t);
  await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT,
      runStage: writingEngine(root),
      env: { PATH: '/usr/bin', GH_TOKEN: 'secret', BRAIN_REVIEWER_TOKEN: 'secret2' },
      forgeProbe: (_c, _a, opts) => { seenEnv = opts.env; return { status: 1 }; },
    },
  });
  assert.equal(seenEnv.PATH, '/usr/bin', 'the engine still needs its PATH');
  assert.equal(seenEnv.GH_TOKEN, undefined, 'the forge credential must be gone before the probe asks');
  assert.equal(seenEnv.BRAIN_REVIEWER_TOKEN, undefined);
});


// ── F.9 / judgment:cold-2 — the runner FORWARDS the ceiling it is given ───
//
// It used to RESOLVE it, from `config`, inside `runStage`'s argument list. That
// put the refusal after `mkdir` and after `remove` had deleted the previous
// artifact — breaking the rule this file states in capitals fifty lines above,
// every precondition refuses before any mutation — and below the routing check,
// so an unrouted repo never validated the key at all. Resolution moved to
// `main()`, beside `resolveConvergence`, for the reason judgment:cold-6 moved
// that one: config is wrong when it is WRITTEN.

test('cold-2/F.9: the ceiling the caller resolved reaches runStage', async (t) => {
  const root = makeRepo(t);
  let seen = null;
  await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    timeoutMs: 2_400_000,
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async (args) => { seen = args.timeoutMs; return writingEngine(root)(args); },
      forgeProbe: () => ({ status: 1 }),
    },
  });
  assert.equal(seen, 2_400_000, 'a ceiling the caller resolved and this layer dropped is not a ceiling');
});

test('cold-2/F.9: an absent ceiling stays absent — this layer invents none', async (t) => {
  // `undefined` leaves the backend's own default in force, which is already
  // fail-closed. A default invented here would be a second declaration of the
  // same policy with nothing comparing the two.
  const root = makeRepo(t);
  let seen = 'unset';
  await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: { forgeProbe: LOGGED_OUT,
      runStage: async (args) => { seen = args.timeoutMs; return writingEngine(root)(args); },
      forgeProbe: () => ({ status: 1 }),
    },
  });
  assert.equal(seen, undefined);
});

test('cold-2/F.9: this layer no longer READS the config key — it cannot refuse after mutating', async (t) => {
  // The measured failure: a string value threw from inside the argument list,
  // and the run had already destroyed the artifact it could not replace.
  const root = makeRepo(t);
  const artifact = join(root, artifactPathFor(PR));
  mkdirSync(dirname(artifact), { recursive: true });
  writeFileSync(artifact, 'previous\n');

  await runColdReviewStage({
    config: { ...ROUTED, reviewer: { stageTimeoutMs: 'nonsense' } },
    prNumber: PR, root, worktreePath: makeWorktree(t),
    timeoutMs: 2_400_000,
    deps: { runStage: writingEngine(root), forgeProbe: () => ({ status: 1 }) },
  });
  assert.ok(existsSync(artifact), 'the run completed — an unread key cannot throw mid-mutation');
});

// ── #775 — the forge config shadow, and the probe that still reads it ──────

test('the probe measures the SAME environment the producer is spawned with', async (t) => {
  // The whole point of the shadow. A probe run against an unshadowed env would
  // answer about an environment the child never receives — a probe that lies is
  // worse than none, which is the defect class this module exists to remove.
  const root = makeWorktree(t);
  let probedEnv = null;
  let spawnedDir = null;
  await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: {
      forgeProbe: (_bin, _args, opts) => { probedEnv = opts.env; return { status: 1, stderr: 'no hosts' }; },
      runStage: async (a) => { spawnedDir = a.forgeConfigDir; return { ok: true }; },
    },
  });
  assert.equal(typeof spawnedDir, 'string');
  assert.notEqual(spawnedDir.trim(), '');
  assert.equal(probedEnv.GH_CONFIG_DIR, spawnedDir, 'the probe saw a different config dir than the spawn');
  assert.equal(probedEnv.GLAB_CONFIG_DIR, spawnedDir);
});

test('the probe still REFUSES when the shadow does not close the channel', async (t) => {
  // The shadow changes what is measured, never whether it is. A forge CLI that
  // authenticates anyway — a deployment where the host mapping is not in the
  // config dir — refuses exactly as before, and the run never spawns.
  const root = makeWorktree(t);
  let spawned = false;
  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: {
      forgeProbe: () => ({ status: 0, stdout: 'Logged in to github.com' }),
      runStage: async () => { spawned = true; return { ok: true }; },
    },
  });
  assert.equal(result.ok, false);
  assert.equal(spawned, false, 'nothing may spawn when the producer can still reach the forge');
  assert.match(result.reason, /can still reach the forge/);
});

test('the refusal names the remedy, not only the property', async (t) => {
  const root = makeWorktree(t);
  const result = await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: {
      forgeProbe: () => ({ status: 0, stdout: 'Logged in to github.com' }),
      runStage: async () => ({ ok: true }),
    },
  });
  assert.match(result.reason, /gh auth logout/, 'a refusal that names no remedy costs the operator the session');
});

test('the per-run directory is removed — on success AND on refusal', async (t) => {
  const root = makeWorktree(t);
  const made = [];
  const removed = [];
  const deps = (probe) => ({
    forgeProbe: probe,
    runStage: async (a) => { made.push(a.forgeConfigDir); return { ok: true }; },
    makeForgeConfigDir: () => { const d = `/tmp/brain-forge-${made.length + removed.length}`; return d; },
    removeForgeConfigDir: (d) => removed.push(d),
  });

  await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t), deps: deps(LOGGED_OUT),
  });
  assert.equal(removed.length, 1, 'a successful run must not leave the directory behind');

  await runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: deps(() => ({ status: 0, stdout: 'Logged in' })),
  });
  assert.equal(removed.length, 2, 'a REFUSED run must clean up too — that is the path that returns early');
});

test('a second run does not inherit the first run\'s directory', async (t) => {
  const root = makeWorktree(t);
  const seen = [];
  const run = () => runColdReviewStage({
    config: ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: {
      forgeProbe: LOGGED_OUT,
      runStage: async (a) => { seen.push(a.forgeConfigDir); return { ok: true }; },
    },
  });
  await run();
  await run();
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1], 'a reused directory is a place a session could accumulate');
});

// ── #978 PR2: Codex final-message transport ─────────────────────────────────

const CODEX_ROUTED = { sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'codex', model: 'gpt-5.5' } } } };

test('Codex receives a host-owned final-message descriptor and only a valid atomically materialized artifact succeeds', async (t) => {
  const root = makeRepo(t);
  const worktree = makeWorktree(t);
  let seen;

  const result = await runColdReviewStage({
    config: CODEX_ROUTED, prNumber: PR, root, worktreePath: worktree,
    deps: {
      forgeProbe: LOGGED_OUT,
      runStage: async (args) => {
        seen = args;
        writeFileSync(args.output.tempPath, `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.output.mode, 'final-message');
  assert.equal(seen.output.artifactPath, join(root, artifactPathFor(PR)));
  assert.notEqual(seen.output.tempPath, seen.output.artifactPath);
  assert.ok(seen.prompt.includes('Return exactly the artifact bytes as your final message'));
  assert.equal(existsSync(seen.output.tempPath), false, 'the temporary Codex message is consumed by the host rename');
  assert.equal(existsSync(seen.output.artifactPath), true, 'the host-owned final artifact is available to the unchanged reader');
});

test('a Codex candidate mutation refuses before its temporary message is published', async (t) => {
  const root = makeRepo(t);
  const worktree = makeWorktree(t);
  let output;

  const result = await runColdReviewStage({
    config: CODEX_ROUTED, prNumber: PR, root, worktreePath: worktree,
    deps: {
      forgeProbe: LOGGED_OUT,
      runStage: async (args) => {
        output = args.output;
        writeFileSync(output.tempPath, `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
        writeFileSync(join(worktree, 'mutation.txt'), 'forbidden\n');
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /candidate changed/i);
  assert.equal(existsSync(output.artifactPath), false, 'a candidate mutation cannot reach the artifact reader');
});

test('a malformed Codex final message is refused by the existing findings reader', async (t) => {
  const root = makeRepo(t);
  const result = await runColdReviewStage({
    config: CODEX_ROUTED, prNumber: PR, root, worktreePath: makeWorktree(t),
    deps: {
      forgeProbe: LOGGED_OUT,
      runStage: async ({ output }) => {
        writeFileSync(output.tempPath, 'not a brain findings artifact\n');
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, false);
  assert.match(result.reason, /could not be read/i);
});

// ── Gemini final-message transport ──────────────────────────────────────────

const GEMINI_ROUTED = { sdd: { map: { [COLD_REVIEW_STAGE]: { engine: 'gemini', model: 'gemini-2.5-pro' } } } };

test('Gemini receives a host-owned final-message descriptor and materializes the artifact atomically', async (t) => {
  const root = makeRepo(t);
  const worktree = makeWorktree(t);
  let seen;

  const result = await runColdReviewStage({
    config: GEMINI_ROUTED, prNumber: PR, root, worktreePath: worktree,
    deps: {
      forgeProbe: LOGGED_OUT,
      runStage: async (args) => {
        seen = args;
        writeFileSync(args.output.tempPath, `\`\`\`${ARTIFACT_TAG}\n[]\n\`\`\`\n`);
        return { ok: true };
      },
    },
  });

  assert.equal(result.ok, true);
  assert.equal(seen.output.mode, 'final-message');
  assert.equal(seen.output.artifactPath, join(root, artifactPathFor(PR)));
  assert.notEqual(seen.output.tempPath, seen.output.artifactPath);
  assert.ok(seen.prompt.includes('Return exactly the artifact bytes as your final message'));
  assert.equal(existsSync(seen.output.tempPath), false, 'the temporary Gemini message is consumed by the host rename');
  assert.equal(existsSync(seen.output.artifactPath), true, 'the host-owned final artifact is available to the reader');
});

