// ticket-args.test.mjs — issue #782. The default is the thing under test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseTicketArgs, WORKTREE_FLAG, IN_PLACE_FLAG, OFF_TRACKER_FLAG,
} from './ticket-args.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '../../..');

// ── The default IS the fix (#782) ─────────────────────────────────────────

test('no flags: an isolated worktree, because that is what the contract says', () => {
  // `harness-contract.md:28` — "Always an isolated worktree; NEVER a branch in
  // the main checkout when parallel work is possible." The verb defaulted to
  // the branch that row calls NEVER, so the rule asked an operator to remember
  // a flag in order to satisfy an "always".
  const r = parseTicketArgs(['316']);
  assert.equal(r.ok, true);
  assert.equal(r.useWorktree, true, 'the DEFAULT is the worktree — this is the whole ticket');
  assert.equal(r.id, '316');
  assert.equal(r.baseBranch, 'main');
});

test(`${IN_PLACE_FLAG}: the opt-out is explicit, named, and still available`, () => {
  // `harness-contract.md` allows in-place for "strictly solo, serial work".
  // Removing it would break that; leaving it as the DEFAULT is what broke this.
  const r = parseTicketArgs(['316', IN_PLACE_FLAG]);
  assert.equal(r.ok, true);
  assert.equal(r.useWorktree, false);
});

test(`${WORKTREE_FLAG}: still accepted, and now a no-op`, () => {
  // Every doc, skill and muscle memory in the ecosystem spells it. Refusing it
  // would turn a fix into a breaking change for no gain.
  const r = parseTicketArgs(['316', WORKTREE_FLAG]);
  assert.equal(r.ok, true);
  assert.equal(r.useWorktree, true);
});

test('both flags together: REFUSED, never silently resolved', () => {
  // Picking a winner here would mean an operator who asked for two things gets
  // one of them and is not told which.
  const r = parseTicketArgs(['316', WORKTREE_FLAG, IN_PLACE_FLAG]);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'contradictory-modes');
});

// ── Everything the old inline parse did, preserved ────────────────────────

test('--base takes the next argument', () => {
  const r = parseTicketArgs(['316', '--base', 'feature/v2.0.0']);
  assert.equal(r.ok, true);
  assert.equal(r.baseBranch, 'feature/v2.0.0');
});

test('--base with nothing after it is refused', () => {
  const r = parseTicketArgs(['316', '--base']);
  assert.equal(r.ok, false);
  assert.equal(r.error, 'base-requires-arg');
});

test('a NUMERIC base is not mistaken for the id', () => {
  // The original comment: "id = first numeric argument that is NOT the value of
  // --base". A tracker branch can legitimately be all digits.
  const r = parseTicketArgs(['--base', '2024', '316']);
  assert.equal(r.ok, true);
  assert.equal(r.id, '316');
  assert.equal(r.baseBranch, '2024');
});

test('no id at all is refused', () => {
  assert.equal(parseTicketArgs([]).error, 'usage');
  assert.equal(parseTicketArgs([IN_PLACE_FLAG]).error, 'usage');
});

test('the id may appear after the flags', () => {
  const r = parseTicketArgs([IN_PLACE_FLAG, '--base', 'main', '316']);
  assert.equal(r.ok, true);
  assert.equal(r.id, '316');
  assert.equal(r.useWorktree, false);
});

// ── "nobody asked" and "the caller asked for main" are different facts (#967) ──

test('--base absent and --base main differ in a field, and both still resolve to main', () => {
  // R967-6 S1. `baseBranch` defaults to 'main' (`:60-61`), so the value alone
  // cannot tell the two apart — and the verb has to, because an explicit `main`
  // against an epic that declares a tracker is refused while an absent `--base`
  // is resolved. The distinction is a NEW field: every assertion above still
  // reads `baseBranch` and still reads 'main', which is the whole point of
  // adding one rather than making the default null (design Q1).
  const absent = parseTicketArgs(['881']);
  const explicit = parseTicketArgs(['881', '--base', 'main']);

  assert.equal(absent.baseExplicit, false);
  assert.equal(explicit.baseExplicit, true);
  assert.equal(absent.baseBranch, 'main', 'the default survives — it is the tested default of #782');
  assert.equal(explicit.baseBranch, 'main');
});

test(`${OFF_TRACKER_FLAG}: the named opt-out off an epic's tracker`, () => {
  // R967-6 S3. The flag an operator is pointed at by the refusal: it is not a
  // mode, it is a statement that this branch deliberately does not start from
  // the tracker its epic declares.
  assert.equal(parseTicketArgs(['881']).offTracker, false);
  const off = parseTicketArgs(['881', OFF_TRACKER_FLAG]);
  assert.equal(off.ok, true);
  assert.equal(off.offTracker, true);
  assert.equal(off.baseBranch, 'main');
});

test(`the id rule is unaffected by ${OFF_TRACKER_FLAG} — it takes no value`, () => {
  // The rule at `:66` skips `--base`'s value only. A flag that consumes nothing
  // cannot swallow the id, and this is the test that says so rather than the
  // reader having to re-derive it.
  const r = parseTicketArgs([OFF_TRACKER_FLAG, '--base', '2024', '881']);
  assert.equal(r.ok, true);
  assert.equal(r.id, '881');
  assert.equal(r.baseBranch, '2024');
  assert.equal(r.offTracker, true);
  assert.equal(r.baseExplicit, true);
});

// ── The contract row is the oracle, and drift from it fails here ──────────

test('harness-contract.md still declares the worktree mandatory', () => {
  // ACCEPTANCE 2 OF #782, executable. The defect was a doctrine row and an
  // implementation that disagreed, and nothing compared them. This is the
  // comparison: if the row is ever softened, this test says so — and if the
  // implementation is softened, the test above says so.
  const contract = readFileSync(
    join(REPO, 'brain/core/methodology/harness-contract.md'), 'utf8',
  );
  const row = contract.split('\n').find((l) => l.includes('brain:ticket:start'));
  assert.ok(row, 'harness-contract.md must carry a brain:ticket:start row');
  assert.match(
    row,
    /ISOLATED WORKTREE/i,
    'the contract row is the oracle for this verb — if it stops demanding a worktree, the default must be revisited, not drifted from',
  );
});

test('the contract row no longer spells the flag as required', () => {
  // Once the default flips, a row that still writes `--worktree` in the command
  // teaches every reader to pass a flag that does nothing. The row and the verb
  // agree or this fails.
  const contract = readFileSync(
    join(REPO, 'brain/core/methodology/harness-contract.md'), 'utf8',
  );
  const row = contract.split('\n').find((l) => l.includes('brain:ticket:start'));
  assert.doesNotMatch(
    row,
    /brain:ticket:start -- <id> --worktree/,
    'the row must not prescribe a flag that is now the default (#782)',
  );
});
