// staged-records-check.integration.test.mjs — issue #701, the I/O half of
// the gate against a real git repo (mirrors
// lib/upstream-records.integration.test.mjs's pattern).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { removeTempTree } from '../__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { buildRecord, serializeRecord } from './lib/format.mjs';
import { appendRecord } from './lib/store.mjs';
import { runStagedRecordsCheck, main } from './staged-records-check.mjs';
// Aliased: every test callback below binds `t` to node:test's TestContext.
import { t as msg } from '../i18n/t.mjs';

/**
 * The catalog line for `key`, in the SAME locale `main()` resolves.
 *
 * `t()` reads its locale from `brain.config.json` at the MODULE's own location
 * (`lib/brain-config.mjs`), not from this test's tmpdir root — so hard-coded
 * English prose here is an assertion about the maintainer's checkout, not about
 * the code. `docs.language: "es"` is a first-class ADR-0009 setting: flipping it
 * and running this file alone gave `# pass 5  # fail 2` of the 7 tests that then
 * existed, and made the negative assertions vacuous in the same run. Resolving
 * the expectation through the catalog holds in every locale.
 *
 * `{error}` is blanked — it is a tmpdir path plus a Node-version-dependent
 * `JSON.parse` message, built in code and never translated, so it is asserted
 * separately by pattern.
 */
const catalogLine = (key, params = {}) => msg(key, { error: '', ...params });

function git(cwd, args, { allowFailure = false } = {}) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFailure) {
    throw new Error(`git ${args.join(' ')} failed:\n${r.stdout}\n${r.stderr}`);
  }
  return r;
}

const BASE = {
  ts: '2026-07-04T12:00:00Z', actor: '@crinaldi', actorKind: 'human', type: 'decision', project: 'brain',
};

/**
 * A worktree, branched BEFORE the trunk record exists (`.gitignore`-only
 * init, matching `upstream-records.integration.test.mjs`'s shape — the
 * branch point is precisely NOT where the record lands), fetched AFTER the
 * trunk record is pushed so `origin/main` sees it locally.
 */
function worldWithTrunkRecord(t) {
  const remote = mkdtempSync(join(tmpdir(), 'brain-701-gate-remote-'));
  const trunk = mkdtempSync(join(tmpdir(), 'brain-701-gate-trunk-'));
  const worktree = mkdtempSync(join(tmpdir(), 'brain-701-gate-worktree-'));
  t.after(() => {
    removeTempTree(remote);
    removeTempTree(trunk);
    removeTempTree(worktree);
  });

  git(remote, ['init', '-q', '--bare', '-b', 'main']);
  git(trunk, ['init', '-q', '-b', 'main']);
  git(trunk, ['config', 'user.email', 'test@example.invalid']);
  git(trunk, ['config', 'user.name', 'brain-test']);
  writeFileSync(join(trunk, '.gitignore'), '');
  git(trunk, ['add', '.gitignore']);
  git(trunk, ['commit', '-q', '-m', 'init']);
  git(trunk, ['remote', 'add', 'origin', remote]);
  git(trunk, ['push', '-q', '-u', 'origin', 'main']);

  git(worktree, ['clone', '-q', remote, '.']);
  git(worktree, ['config', 'user.email', 'test@example.invalid']);
  git(worktree, ['config', 'user.name', 'brain-test']);
  git(worktree, ['checkout', '-q', '-b', 'feature/701']);

  const record = buildRecord({ ...BASE, content: 'Already durable on the trunk.' });
  const recordsDir = join(trunk, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  appendRecord(record, { recordsDir });
  git(trunk, ['add', '.memory/records']);
  git(trunk, ['commit', '-q', '-m', 'trunk record']);
  git(trunk, ['push', '-q', 'origin', 'main']);
  git(worktree, ['fetch', '-q', 'origin']);

  return { worktree, record };
}

test('issue #701 gate: staging a byte-identical re-export of the trunk record REFUSES', (t) => {
  const { worktree, record } = worldWithTrunkRecord(t);
  const recordsDir = join(worktree, '.memory', 'records');
  const path = join(recordsDir, `2026-07-${record.id}.jsonl`);
  // The exact accident this ticket is about: `share` (pre-#701, or the fix's
  // own residual on an unavailable ref) materializes the SAME bytes as an
  // untracked file, and the operator `git add`s it.
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(path, serializeRecord(record) + '\n', 'utf8');
  git(worktree, ['add', '.memory/records']);

  // #714: `runStagedRecordsCheck` defaults `env` to `process.env`. An exported
  // `BRAIN_MEMORY_UPSTREAM_REF` is level 1 and would override the ref this
  // dedup check needs resolved (origin/main), turning the suite's verdict into
  // a function of the developer's shell — see the `env: {}` note below.
  const result = runStagedRecordsCheck({ root: worktree, env: {} });
  assert.equal(result.level, 'fail');
  assert.deepEqual(result.offending, [`.memory/records/2026-07-${record.id}.jsonl`]);
});

test('issue #701 gate: a genuinely new staged record ALLOWS', (t) => {
  const { worktree } = worldWithTrunkRecord(t);
  const recordsDir = join(worktree, '.memory', 'records');
  const newRecord = buildRecord({ ...BASE, content: 'Brand new, never seen upstream.' });
  mkdirSync(recordsDir, { recursive: true });
  appendRecord(newRecord, { recordsDir });
  git(worktree, ['add', '.memory/records']);

  const result = runStagedRecordsCheck({ root: worktree });
  assert.equal(result.level, 'pass');
});

test('issue #701 gate: nothing staged under .memory/records/ ALLOWS', (t) => {
  const { worktree } = worldWithTrunkRecord(t);
  const result = runStagedRecordsCheck({ root: worktree });
  assert.equal(result.level, 'pass');
  assert.deepEqual(result.offending, []);
});

test('issue #701 gate main(): a refusal exits 1 and prints the lossless remedy', async (t) => {
  const { worktree, record } = worldWithTrunkRecord(t);
  const recordsDir = join(worktree, '.memory', 'records');
  const path = join(recordsDir, `2026-07-${record.id}.jsonl`);
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(path, serializeRecord(record) + '\n', 'utf8');
  git(worktree, ['add', '.memory/records']);

  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  let code;
  try {
    // #714: see the `env: {}` note further below — `main()` forwards to
    // `runStagedRecordsCheck`, whose default `env` is `process.env`.
    code = await main({ root: worktree, env: {} });
  } finally {
    console.log = originalLog;
  }
  assert.equal(code, 1);
  assert.ok(logs.some((l) => l.includes('git restore --staged')), `expected the remedy to be printed; got:\n${logs.join('\n')}`);
});

// ── the configError channel, at the ONE layer a human actually reads ─────────
//
// Every other layer of this channel was pinned — `resolveUpstreamRef` carrying
// it, `upstreamRecordEntries` carrying it on both arms, `evaluateStagedRecords`
// forwarding it, `engram.mjs` accounting for it — and the PRINT was not. Cold
// review round 2 of #701 measured that directly: neutering `if
// (result.configError)` in `main()` left the whole suite green at 4001 pass / 0
// fail. The whole point of the channel is that the operator is TOLD, so the
// telling is what needs a detector.
//
// `env: {}` is deliberate and load-bearing. `runStagedRecordsCheck` defaults
// `env` to `process.env`, and an ambient `BRAIN_MEMORY_UPSTREAM_REF` is level 1
// — it wins over the config, so the config is never read and `configError` never
// arises. Without this the tests below pass or fail on the shell they inherit.

/** Runs `main()` with `console.log` captured. Restored on every path. */
async function mainCapturingLogs(deps) {
  const logs = [];
  const originalLog = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    return { code: await main(deps), logs };
  } finally {
    console.log = originalLog;
  }
}

const CORRUPT_CONFIG = '<<<<<<< HEAD\n{ "memory": { "upstreamRef": "origin/feature" } }\n';

test('issue #701 gate main(): an unreadable brain.config.json is PRINTED, and the gate still refuses', async (t) => {
  const { worktree, record } = worldWithTrunkRecord(t);
  // Mid-merge: conflict markers in the config. This is the reachable case —
  // conflict markers mean you are mid-merge, which is exactly when the dedup
  // gate earns its keep.
  writeFileSync(join(worktree, 'brain.config.json'), CORRUPT_CONFIG, 'utf8');
  const recordsDir = join(worktree, '.memory', 'records');
  const path = join(recordsDir, `2026-07-${record.id}.jsonl`);
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(path, serializeRecord(record) + '\n', 'utf8');
  git(worktree, ['add', '.memory/records']);

  const { code, logs } = await mainCapturingLogs({ root: worktree, env: {} });
  const printed = logs.join('\n');

  assert.ok(
    /brain\.config\.json .* could not be parsed/.test(printed),
    `the operator must be TOLD the config was skipped; got:\n${printed}`,
  );
  // The POSITIVE branch of the two-key split. `origin/HEAD` — not `origin/main`
  // — is the ref that answered: this worktree is a CLONE, so level 3 is set and
  // answers before level 4 is ever tried. That makes naming it true here, and
  // this is the only case where naming a ref is true. Without an assertion on
  // the clause that DIFFERS, both catalog keys satisfy the `{error}` check above
  // and the discriminator could be dropped with the suite still green.
  assert.ok(
    printed.includes(await catalogLine('memory.stagedRecordsCheck.configUnreadable', { ref: 'origin/HEAD' })),
    `a ref that DID answer must be named, or the operator cannot tell which base was used; got:\n${printed}`,
  );
  assert.equal(
    printed.includes(await catalogLine('memory.stagedRecordsCheck.configUnreadableNoRef')), false,
    `a ref answered, so the "nothing resolved" wording would be the opposite falsehood; got:\n${printed}`,
  );
  // The config failure does not disable the gate: origin/HEAD still answered.
  assert.equal(code, 1, 'a broken config must not turn a refusal into a pass — that is the defect the fall-through exists to avoid');
});

test('issue #701 gate main(): with NO ref resolved, the printed line does NOT claim a derived ref', async (t) => {
  // The second half of the sentence-scale doubling. `ref` used to be the string
  // `'origin/main'` on this result — a name `resolveUpstreamRef` returned from
  // its last line, when NOTHING resolved — and naming it as the base "derived
  // instead" told the operator a ref had answered, one line before the note said
  // none had. It is `null` now, and that is what picks the key.
  const { worktree } = worldWithTrunkRecord(t);
  git(worktree, ['remote', 'remove', 'origin']); // takes origin/HEAD + origin/main with it
  writeFileSync(join(worktree, 'brain.config.json'), CORRUPT_CONFIG, 'utf8');

  const { logs } = await mainCapturingLogs({ root: worktree, env: {} });
  const printed = logs.join('\n');

  assert.ok(
    /could not be parsed/.test(printed),
    `the config failure is reported whether or not a ref answered; got:\n${printed}`,
  );
  assert.ok(
    printed.includes(await catalogLine('memory.stagedRecordsCheck.configUnreadableNoRef')),
    `the line must say nothing resolved; got:\n${printed}`,
  );
  assert.equal(
    printed.includes(await catalogLine('memory.stagedRecordsCheck.configUnreadable', { ref: 'origin/main' })), false,
    `no ref answered, so none may be named as the one used instead; got:\n${printed}`,
  );
});

test('issue #701 gate main(): the unavailable note never claims records were WRITTEN — this gate writes nothing', async (t) => {
  // The shared `reason` string ended in "— writing every candidate this run
  // (pre-#701 behaviour)", which is the EXPORTER's degradation. At this gate it
  // was flatly false, and the catalog wrapper that follows it in the same
  // printed line says the opposite: "Nothing was refused; this run could not ask
  // the question." Asserted on the code-built clause, not on catalog prose, so
  // it holds in every locale.
  const { worktree } = worldWithTrunkRecord(t);
  git(worktree, ['remote', 'remove', 'origin']);

  const { logs } = await mainCapturingLogs({ root: worktree, env: {} });
  const printed = logs.join('\n');

  assert.ok(/no upstream ref resolved/.test(printed), `the note must still be printed; got:\n${printed}`);
  assert.equal(
    /writing every candidate/.test(printed), false,
    `this gate writes nothing, so it must never say it wrote anything; got:\n${printed}`,
  );
});

test('issue #701 gate main(): a READABLE config prints no config line at all', async (t) => {
  // The negative side of the detector: without it, a print site that fired
  // unconditionally would satisfy every assertion above.
  const { worktree } = worldWithTrunkRecord(t);
  writeFileSync(join(worktree, 'brain.config.json'), JSON.stringify({ project: { slug: 'brain' } }), 'utf8');

  const { code, logs } = await mainCapturingLogs({ root: worktree, env: {} });

  assert.equal(code, 0);
  assert.equal(
    /brain\.config\.json/.test(logs.join('\n')), false,
    'nothing failed to be read, so nothing may be reported — the channel is evidence, not a banner',
  );
});

// ---------------------------------------------------------------------------
// Issue #821 — the I/O half of the merge distinction, against real git.
//
// The unit tests hand `evaluateStagedRecords` a `merge` object. These two run
// the actual `MERGE_HEAD` lookup, because the defect was never in the
// evaluator: the gate simply never asked git whether a merge was underway.
//
// `--no-ff` is load-bearing. `feature/701` branches before the trunk record, so
// a plain `git merge origin/main` FAST-FORWARDS, and a fast-forward writes no
// `MERGE_HEAD` — the test would then pass for the wrong reason.
// ---------------------------------------------------------------------------

test('#821 gate: the merge commit CARRYING the trunk record in ALLOWS', (t) => {
  const { worktree, record } = worldWithTrunkRecord(t);

  git(worktree, ['merge', '--no-ff', '--no-commit', 'origin/main'], { allowFailure: true });

  const staged = git(worktree, ['diff', '--cached', '--name-only']).stdout;
  assert.match(staged, new RegExp(`2026-07-${record.id}\\.jsonl`), 'precondition: the merge stages the trunk record');
  assert.notEqual(git(worktree, ['rev-parse', '--verify', 'MERGE_HEAD'], { allowFailure: true }).status, 1,
    'precondition: a merge is really in progress — a fast-forward would prove nothing');

  const result = runStagedRecordsCheck({ root: worktree });

  assert.equal(result.level, 'pass', 'refusing here makes the operator drop a record the merge is carrying');
  assert.deepEqual(result.offending, []);
});

test('#821 gate: mid-merge, a re-export the merge is NOT carrying is still REFUSED', (t) => {
  // The guarantee `staged-records-check.test.mjs:227` asks for, end to end: the
  // gate stays live mid-merge. Only the blobs THIS merge introduces are exempt.
  const { worktree, record } = worldWithTrunkRecord(t);

  git(worktree, ['checkout', '-q', '-b', 'sidebranch']);
  writeFileSync(join(worktree, 'side.txt'), 'unrelated\n', 'utf8');
  git(worktree, ['add', 'side.txt']);
  git(worktree, ['commit', '-q', '-m', 'unrelated work']);
  git(worktree, ['checkout', '-q', 'feature/701']);
  git(worktree, ['merge', '--no-ff', '--no-commit', 'sidebranch'], { allowFailure: true });

  // `share` re-materializes the trunk record DURING that merge. The merge did
  // not bring it — `sidebranch` has no records at all.
  const recordsDir = join(worktree, '.memory', 'records');
  mkdirSync(recordsDir, { recursive: true });
  writeFileSync(join(recordsDir, `2026-07-${record.id}.jsonl`), serializeRecord(record) + '\n', 'utf8');
  git(worktree, ['add', '.memory/records']);

  // #714: same leak as the byte-identical-refusal test above — neutralise it.
  const result = runStagedRecordsCheck({ root: worktree, env: {} });

  assert.equal(result.level, 'fail', 'the gate must keep its keep mid-merge');
  assert.deepEqual(result.offending, [`.memory/records/2026-07-${record.id}.jsonl`]);
});

// ---------------------------------------------------------------------------
// Issue #821, cold review round 1 — an OCTOPUS merge.
//
// The first version of `mergeIntroducedRecords` resolved the merge with
// `git rev-parse --verify --quiet MERGE_HEAD` and its docstring claimed
// `--verify` refuses a multi-parent MERGE_HEAD. That claim is FALSE.
// Measured on git 2.53.0: an octopus MERGE_HEAD holds one sha per line and
// `--verify --quiet` exits 0 printing ONLY THE FIRST, so the `ls-tree` that
// followed saw one parent's tree and the other parents' records were invisible
// to the exemption. A record arriving through the second parent was then
// refused — the exact data-loss path #821 exists to close, reached through a
// door the fix did not look at.
// ---------------------------------------------------------------------------

test('#821 gate: an OCTOPUS merge carrying the record in through a LATER parent ALLOWS', (t) => {
  const { worktree, record } = worldWithTrunkRecord(t);

  git(worktree, ['checkout', '-q', '-b', 'sidebranch']);
  writeFileSync(join(worktree, 'side.txt'), 'unrelated\n', 'utf8');
  git(worktree, ['add', 'side.txt']);
  git(worktree, ['commit', '-q', '-m', 'unrelated work']);
  git(worktree, ['checkout', '-q', 'feature/701']);

  // sidebranch FIRST, origin/main SECOND: the record arrives through the parent
  // a single-sha read of MERGE_HEAD never reaches.
  git(worktree, ['merge', '--no-ff', '--no-commit', 'sidebranch', 'origin/main'], { allowFailure: true });

  const parents = git(worktree, ['rev-parse', '--git-path', 'MERGE_HEAD']).stdout.trim();
  assert.ok(parents, 'precondition: MERGE_HEAD exists');
  const staged = git(worktree, ['diff', '--cached', '--name-only']).stdout;
  assert.match(staged, new RegExp(`2026-07-${record.id}\\.jsonl`), 'precondition: the octopus merge stages the trunk record');

  const result = runStagedRecordsCheck({ root: worktree });

  assert.equal(result.level, 'pass', 'a later octopus parent carries records in exactly as the first one does');
  assert.deepEqual(result.offending, []);
});
