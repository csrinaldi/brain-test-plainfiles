// verdict.test.mjs — Unit tests for the brain-review/1 verdict emitter
// (REQ-H1-4, REQ-H1-6; protocol §6, §7; design.md §5). Pure — no seams, no
// I/O, direct calls with finding fixtures.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildVerdict, renderVerdict } from './verdict.mjs';
import { parseVerdict } from './lib/parse-verdict.mjs';

const HEAD_SHA = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef';

// ── evidence gate ─────────────────────────────────────────────────────────

test('#490/round-8 E1 (widened round 13): an UNUSABLE anchor is omitted from the block — every value class, BOTH branches (REQ-405-2)', () => {
  // Round 7 pinned the poster's `line === null` guard and justified it with
  // "renderVerdict, which guards both, omits line: from the block". That twin
  // guard was itself pinned by nothing: dropping `!== null` from either branch
  // left all 2574 tests green, and under it the block advertises an anchor at
  // `line: null` that the poster then refuses to post — the inverse of the case
  // round 7 fixed, and a contradiction of the JSDoc two lines above it.
  //
  // The correction landed where it was noticed and not on the thing it cited.
  const v = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    protocol: 'brain-review/2',
    findings: [
      { id: 'blocking', severity: 'blocker', evidence: 'e', cites: 'c', file: 'a.mjs', line: null },
      { id: 'deferred', severity: 'blocker', evidence: 'e', cites: 'c',
        causal_disposition: 'pre-existing', file: 'b.mjs', line: null },
      // The `file` half, added in round 10. Rounds 7 and 8 each pinned the `line`
      // guard — in the poster, then here — and neither asked the same question of
      // `file`, so `if (f.file)` could become `if (f.file !== undefined)` with the
      // whole suite green. An empty `file:` in the block is the same defect the
      // `line` rule exists to prevent, one field over: the block advertising an
      // anchor that cannot attach.
      { id: 'null-line', severity: 'blocker', evidence: 'e', cites: 'c', file: 'a.mjs', line: null },
      { id: 'null-line-deferred', severity: 'blocker', evidence: 'e', cites: 'c',
        causal_disposition: 'base-only', file: 'b.mjs', line: null },
      // The empty path carries a PERFECTLY USABLE line, deliberately. With
      // `line: null` the line check excludes it and the path check is never
      // consulted — so dropping `Boolean(f?.file)` from the predicate survived
      // (round 13's own first repair was green under exactly that mutation). A
      // negative fixture has to fail for the reason under test and no other.
      { id: 'empty-path', severity: 'blocker', evidence: 'e', cites: 'c', file: '', line: 12 },
      { id: 'empty-path-deferred', severity: 'blocker', evidence: 'e', cites: 'c',
        causal_disposition: 'base-only', file: '', line: 12 },
      // Every value class `verdict.mjs`'s own JSDoc and the Tier-2 draft enumerate,
      // on BOTH branches. Round 12 fixed per-BRANCH blindness and left per-VALUE-CLASS
      // blindness: its new case drives one positive value per branch, and the
      // negative side was covered only by `null` (→0) and a poison string (→NaN).
      // Relaxing the predicate to `Number(f?.line) > 0` — which still rejects both
      // of those — let `2.5` and `-3` render on both branches with the suite green.
      { id: 'fractional', severity: 'blocker', evidence: 'e', cites: 'c', file: 'c.mjs', line: 2.5 },
      { id: 'fractional-deferred', severity: 'blocker', evidence: 'e', cites: 'c',
        causal_disposition: 'base-only', file: 'c.mjs', line: 2.5 },
      { id: 'negative', severity: 'blocker', evidence: 'e', cites: 'c', file: 'd.mjs', line: -3 },
      { id: 'negative-deferred', severity: 'blocker', evidence: 'e', cites: 'c',
        causal_disposition: 'base-only', file: 'd.mjs', line: -3 },
      { id: 'trailing-junk', severity: 'blocker', evidence: 'e', cites: 'c', file: 'e.mjs', line: '42abc' },
      { id: 'trailing-junk-deferred', severity: 'blocker', evidence: 'e', cites: 'c',
        causal_disposition: 'base-only', file: 'e.mjs', line: '42abc' },
    ],
  });
  assert.equal(v.findings.length, 6, 'every value class present in each branch — otherwise a class goes unchecked');
  assert.equal(v.follow_ups.length, 6);
  const body = renderVerdict(v);
  // BOTH-OR-NEITHER, tightened in round 11. The earlier version asserted that the
  // `file` half "still renders" when `line` is null — which left the block
  // advertising a half anchor the poster refuses, the very state this test's name
  // is about. Round 10 had tightened the POSTER's rule and not the renderer's, so
  // the two drifted; they now share one `hasUsableAnchor` predicate and a half
  // anchor emits neither field.
  assert.doesNotMatch(body, /^ {4}line:/m,
    `an unusable line must never be emitted, in either branch: ${body}`);
  assert.doesNotMatch(body, /^ {4}file:/m,
    `and neither may its partner — a half anchor is not an anchor, and a block that ` +
    `advertises one is the same defect read from the emitting end: ${body}`);
});

test('buildVerdict: a finding with no evidence is excluded from findings[] (inadmissible)', () => {
  const v = buildVerdict({
    headSha: HEAD_SHA,
    conclusion: 'REVISE',
    findings: [
      { id: 'f1', severity: 'correction', cites: 'ADR-0020' }, // no evidence
      { id: 'f2', severity: 'editorial', evidence: 'ran `npm test`' },
    ],
  });
  assert.deepEqual(v.findings.map(f => f.id), ['f2']);
});

// ── cites gate ────────────────────────────────────────────────────────────

test('buildVerdict: a blocker with no cites is downgraded to correction, not dropped', () => {
  const v = buildVerdict({
    headSha: HEAD_SHA,
    conclusion: 'REVISE',
    findings: [
      { id: 'f1', severity: 'blocker', evidence: 'ran `npm test`' }, // no cites
    ],
  });
  assert.equal(v.findings.length, 1);
  assert.equal(v.findings[0].severity, 'correction');
});

test('buildVerdict: a blocker WITH cites stays a blocker', () => {
  const v = buildVerdict({
    headSha: HEAD_SHA,
    conclusion: 'REVISE',
    findings: [
      { id: 'f1', severity: 'blocker', evidence: 'ran `npm test`', cites: 'REQ-H1-4' },
    ],
  });
  assert.equal(v.findings[0].severity, 'blocker');
});

// ── head_sha gate ─────────────────────────────────────────────────────────

test('buildVerdict: no head_sha throws — no headless verdict is representable', () => {
  assert.throws(() => buildVerdict({ conclusion: 'REVISE', findings: [] }), /head_sha/);
});

// ── rev semantics + bound (REQ-H1-6, protocol §7) ─────────────────────────
// The EMITTED `rev` is 1-INDEXED: the first review is rev 1 (harmonized with the
// human-mediated practice — #290 A/B harmonization item 1). The bounded-revision
// LOCK is UNCHANGED — it counts PRIOR blocks (`priorRevCount >= 3`), so the 4th
// review (emitted as rev 4) forces STOP; exactly three REVISEs (rev 1, 2, 3) are
// allowed before the escalation.

test('buildVerdict: the first review is rev 1 (1-indexed), not rev 0', () => {
  const v = buildVerdict({ headSha: HEAD_SHA, conclusion: 'REVISE', priorRevCount: 0, findings: [] });
  assert.equal(v.rev, 1);
  assert.equal(v.verdict, 'REVISE');
});

test('buildVerdict: the third REVISE (2 priors) is rev 3 and still REVISE — the lock has not fired', () => {
  const v = buildVerdict({ headSha: HEAD_SHA, conclusion: 'REVISE', priorRevCount: 2, findings: [] });
  assert.equal(v.rev, 3);
  assert.equal(v.verdict, 'REVISE');
  assert.equal(v.escalate, null);
});

test('buildVerdict: the 4th review (3 priors) is rev 4 and forces STOP + escalate:human — lock is priorRevCount >= 3, unchanged', () => {
  const v = buildVerdict({ headSha: HEAD_SHA, conclusion: 'REVISE', priorRevCount: 3, findings: [] });
  assert.equal(v.verdict, 'STOP');
  assert.equal(v.escalate, 'human');
  assert.equal(v.rev, 4);
});

test('buildVerdict: rev >= 3 does NOT force STOP on a non-REVISE conclusion (STOP stays STOP); rev stays 1-indexed', () => {
  const v = buildVerdict({ headSha: HEAD_SHA, conclusion: 'STOP', priorRevCount: 5, findings: [], escalate: 'human' });
  assert.equal(v.verdict, 'STOP');
  assert.equal(v.escalate, 'human');
  assert.equal(v.rev, 6);
});

// ── renderVerdict — fenced brain-review/1 YAML ───────────────────────────

test('renderVerdict: emits a fenced yaml block naming protocol, verdict, and head_sha', () => {
  const v = buildVerdict({ headSha: HEAD_SHA, conclusion: 'REVISE', findings: [] });
  const block = renderVerdict(v);
  assert.match(block, /```yaml\n/);
  assert.match(block, /protocol: brain-review\/1/);
  assert.match(block, new RegExp(`head_sha: ${HEAD_SHA}`));
  assert.match(block, /verdict: REVISE/);
  assert.match(block, /rev: 1/); // first review, 1-indexed (default priorRevCount 0)
  assert.match(block, /```\s*$/);
});

// ── Causal Admission Rules (REQ-H2-3) ──────────────────────────────────────

test('buildVerdict: pre-existing or base-only findings do NOT trigger REVISE and are routed to follow_ups[]', () => {
  // #750: `conclusionCauses: ['blocker']` is a REQUIRED, deliberate addition —
  // this fixture's concern is routing (pre-existing/base-only → follow_ups),
  // not the cause-gated softening, and without a declared cause the new
  // fail-closed default would flip this to REVISE and read as an unrelated
  // regression. Same treatment as the :923-area fixture, for the same reason.
  const v = buildVerdict({
    headSha: HEAD_SHA,
    conclusion: 'REVISE',
    protocol: 'brain-review/2',
    conclusionCauses: ['blocker'],
    findings: [
      {
        id: 'f1',
        severity: 'blocker',
        evidence: 'ran tests',
        cites: 'REQ-1',
        causal_disposition: 'pre-existing',
        evidence_class: 'deterministic',
      },
      {
        id: 'f2',
        severity: 'blocker',
        evidence: 'ran tests',
        cites: 'REQ-2',
        causal_disposition: 'base-only',
        evidence_class: 'deterministic',
      },
    ],
  });

  assert.equal(v.verdict, 'APPROVE');
  assert.equal(v.findings.length, 0);
  assert.deepEqual(v.follow_ups, [
    { id: 'f1', severity: 'blocker', evidence: 'ran tests', cites: 'REQ-1', causal_disposition: 'pre-existing', evidence_class: 'deterministic' },
    { id: 'f2', severity: 'blocker', evidence: 'ran tests', cites: 'REQ-2', causal_disposition: 'base-only', evidence_class: 'deterministic' },
  ]);
});

test('buildVerdict: causal_disposition "unknown" forces escalate: human and verdict STOP', () => {
  const v = buildVerdict({
    headSha: HEAD_SHA,
    conclusion: 'REVISE',
    protocol: 'brain-review/2',
    findings: [
      {
        id: 'f1',
        severity: 'blocker',
        evidence: 'ran tests',
        cites: 'REQ-1',
        causal_disposition: 'unknown',
        evidence_class: 'inferential',
      },
    ],
  });

  assert.equal(v.verdict, 'STOP');
  assert.equal(v.escalate, 'human');
});

// ── #481 (ruled IN SCOPE for #452 by the maintainer): newlines must be ESCAPED
//
// `yamlScalar` quoted but did not escape newlines, and checkpoint.mjs interpolates
// multi-line command stdout into `evidence:`. The continuation lines land at column 0,
// terminate the findings list, and everything after them — including blockers — is
// dropped on re-parse. Measured before this fix, through the real chain:
//
//   BUILT findings: 2 (governance-status-output, tier2-touch)
//   PARSED findings: 1        the BLOCKER did not survive the round trip
//
// The reader half (#452) makes that loss HONEST — the parser now answers `null`
// (uncomputable) instead of a confident truncated list. It cannot make it not a loss:
// the posted artifact, which a human also reads, already shipped without the blocker.
// This is the emitter half.

test('#481: a multi-line evidence value is escaped, so the block stays one-line-per-field', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [{ id: 'multi', severity: 'blocker', evidence: 'line one\nline two', cites: 'x.md' }],
  });
  const block = renderVerdict(built).split('```')[1];
  const evidenceLines = block.split('\n').filter(l => l.includes('evidence:'));
  assert.equal(evidenceLines.length, 1, 'exactly one evidence line');
  assert.match(evidenceLines[0], /evidence: "line one\\nline two"/,
    'the newline must be emitted as an escape, not as a raw line break that ends the list');
});

test('#481: every finding survives the round trip when one carries multi-line evidence', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [
      { id: 'multi', severity: 'blocker', evidence: 'line one\nline two\nline three', cites: 'x.md' },
      { id: 'tier2-touch', severity: 'blocker', evidence: 'brain/core/x.md', cites: 'y.md' },
    ],
  });
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.deepEqual((parsed.findings ?? []).map(f => f.id), ['multi', 'tier2-touch'],
    'a finding after a multi-line one must not be swallowed — this dropped a BLOCKER before the fix');
  assert.equal(parsed.findings[0].evidence, 'line one\nline two\nline three',
    'and the evidence must come back byte-identical: an escape that does not decode is a different loss');
});

test('#481: carriage returns are escaped too — CRLF evidence must not break the line structure', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [
      { id: 'crlf', severity: 'blocker', evidence: 'a\r\nb', cites: 'x.md' },
      { id: 'after', severity: 'blocker', evidence: 'still here', cites: 'y.md' },
    ],
  });
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.deepEqual((parsed.findings ?? []).map(f => f.id), ['crlf', 'after']);
  assert.equal(parsed.findings[0].evidence, 'a\r\nb');
});

test('#481: single-line values are NOT newly quoted or escaped — the control', () => {
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [{ id: 'plain', severity: 'blocker', evidence: 'brain/core/x.md:7', cites: 'y.md' }],
  });
  const block = renderVerdict(built).split('```')[1];
  assert.match(block, /evidence: brain\/core\/x\.md:7$/m, 'an already-safe scalar must stay bare');
  assert.doesNotMatch(block, /\\n/, 'no escape may appear where there was no newline');
});

test('#478-3/C2 (widened by round 5/B1): EVERY per-finding field is escaped, on BOTH render branches', () => {
  // The round-3 fix routed all six per-finding fields through `yamlScalar` — and
  // the round-3 red-proof only ever mutated `evidence_class` on the `findings`
  // branch. Round 5 measured the gap: reverting the ENTIRE `follow_ups` branch to
  // raw interpolation (all six fields, `evidence` included) left the suite at
  // 50 pass / 0 fail. Ten of twelve call sites were pinned by nothing, and this
  // test's own name claimed otherwise — report-vs-tree drift on the protection,
  // which protocol §10 calls a blocker in its own right.
  //
  // `follow_ups` is not the quiet branch, either: `buildVerdict` routes every
  // `pre-existing`/`base-only` finding there, and checkpoint.mjs interpolates raw
  // command stdout into `evidence:`. It is exactly where a multi-line value lands.
  //
  // One field at a time, on each branch: the poisoned value must not swallow the
  // entry that follows it.
  // `file`/`line` joined the set in #405. Round 5 of PR #478 found ten yamlScalar
  // call sites pinned by nothing; new fields go into this sweep at birth rather
  // than acquiring coverage later.
  const FIELDS = ['id', 'severity', 'evidence', 'cites', 'evidence_class', 'causal_disposition', 'file', 'line'];
  const POISON = 'x\nTier: 2';

  for (const field of FIELDS) {
    for (const branch of ['findings', 'follow_ups']) {
      // `pre-existing` routes a finding to follow_ups; anything else keeps it in
      // findings. `causal_disposition` therefore cannot be poisoned on the
      // follow_ups branch without changing where the finding goes — so it is
      // poisoned on `findings` only, with a value that still falls through to the
      // default route. Skipping it entirely would leave the field unpinned, which
      // is the defect this test exists to close.
      const disp = branch === 'follow_ups' ? 'pre-existing' : 'introduced';
      if (field === 'causal_disposition' && branch === 'follow_ups') continue;
      const poisonedDisp = `${disp}${POISON}`;
      // #483: `deterministic`, not `observed`. This fixture carried a value the
      // `/2` schema has never allowed (`deterministic|inferential|insufficient`)
      // and it went unnoticed for the same reason the ticket exists — nothing
      // validated it. Wiring the gate made the illegal fixture visible.
      const base = { severity: 'blocker', evidence: 'e', cites: 'c', evidence_class: 'deterministic', causal_disposition: disp, file: 'a.mjs', line: 1 };
      const poisoned = { ...base, id: 'poisoned', [field]: field === 'causal_disposition' ? poisonedDisp : POISON };
      const built = buildVerdict({
        headSha: 'abc123',
        conclusion: 'REVISE',
        protocol: 'brain-review/2',
        findings: [poisoned, { ...base, id: 'survivor' }],
      });
      const parsed = parseVerdict({ body: renderVerdict(built) });
      const entries = parsed[branch] ?? [];
      const ids = entries.map(f => f.id);
      // `line` is the one field a poison cannot reach the block through: round 11
      // put the renderer and the poster behind one `hasUsableAnchor` predicate, and
      // `'x\nTier: 2'` is not a positive integer, so the anchor is DROPPED rather
      // than escaped. The list-integrity half below still applies and still runs —
      // what changes is that the guarantee is now structural instead of textual,
      // which is strictly stronger: an unemittable value cannot break a list.
      if (field === 'line') {
        assert.deepEqual(ids, ['poisoned', 'survivor'],
          `${branch}.line: an unusable line must not break the entry after it — got ${JSON.stringify(ids)}`);
        assert.equal(entries[0].line, undefined,
          `${branch}.line: an unusable line must be DROPPED, not emitted — the block would otherwise ` +
          `advertise an anchor the poster refuses to post: ${JSON.stringify(entries[0])}`);
        assert.equal(entries[0].file, undefined,
          `${branch}.file: and its partner goes with it — a half anchor is not an anchor (REQ-405-2)`);
        continue;
      }
      // `evidence_class` on the follow_ups branch joins `line` as structurally
      // unreachable (#483). A poisoned class is by construction not one of the
      // three allowed values, so the schema gate marks it and routes it to
      // `findings[]` — it can no longer arrive here to break the list. That is
      // the same "structural instead of textual, strictly stronger" shape the
      // `line` case above documents: the follow_ups branch can now only ever
      // render a value from the allow-list, every one of which is YAML-safe.
      // What is pinned here instead is the re-routing itself.
      if (field === 'evidence_class' && branch === 'follow_ups') {
        assert.deepEqual(ids, ['survivor'],
          `${branch}.evidence_class: the poisoned entry must be re-routed by the schema gate, ` +
          `leaving the entry after it intact — got ${JSON.stringify(ids)}`);
        const blocking = (parsed.findings ?? []).map(f => f.id);
        assert.ok(blocking.includes('poisoned'),
          `and it must land in findings[], never be dropped — got ${JSON.stringify(blocking)}`);
        continue;
      }
      // When `id` itself carries the poison, the poisoned entry's id IS that value.
      const expected = [field === 'id' ? POISON : 'poisoned', 'survivor'];
      assert.deepEqual(ids, expected,
        `${branch}.${field}: a line break in this field swallowed the entry after it — ` +
        `got ${JSON.stringify(ids)}. Every yamlScalar call site on both branches must be load-bearing.`);
      // and the poisoned value itself must survive byte-identical, not merely fail
      // to break the list — an escape that mangles is a different loss.
      assert.equal(entries[0][field], field === 'causal_disposition' ? poisonedDisp : POISON,
        `${branch}.${field}: the value round-tripped changed`);
    }
  }
});

test('#478-3/E6: U+2028 / U+2029 are line terminators too — the JSDoc says line breaks, so it must mean all of them', () => {
  for (const sep of [' ', ' ']) {
    const built = buildVerdict({
      headSha: 'abc123',
      conclusion: 'REVISE',
      findings: [{ id: 'sep', severity: 'blocker', evidence: `a${sep}b`, cites: 'c' }],
    });
    const parsed = parseVerdict({ body: renderVerdict(built) });
    assert.equal(parsed.findings?.[0]?.evidence, `a${sep}b`,
      `U+${sep.codePointAt(0).toString(16)} destroyed the round trip`);
  }
});

// ── #405 REQ-405-2/-3: an OPTIONAL anchor on a finding ─────────────────────
//
// M3's exit is "a developer sees inline code review in the PR". A finding that
// reports `src/a.mjs:42` inside a YAML block is a report, not a review — the
// developer still has to go find the line.
//
// `file` and `line` are the anchor. BOTH OPTIONAL, and absent ⇒ no inline
// comment (REQ-405-2): that default is what keeps this additive, so every
// evaluator shipping today keeps working unchanged and gains inline coverage
// only when it starts emitting anchors.
//
// They are NOT derived from `evidence` (design D2): evidence is a quoted command
// AND its output (protocol §10), so it is full of colons, paths and numbers that
// are not anchors. A regex over it would silently mis-anchor.

test('#405 REQ-405-3: each rendered entry carries its OWN anchor, in BOTH branches (REQ-405-1)', () => {
  // The renderer emitting `inline[0]`'s pair for every entry was green in both
  // branches (round-16 cold review). Every content assertion in the tree drove a
  // single anchored finding, and the poisoned/survivor sweep checks `[0]` and
  // never `[1]` — so "the anchor round-trips" was pinned while "the anchors do
  // not smear into each other" was not.
  //
  // Two per branch, deliberately: with one, `entries[0]` is trivially its own
  // anchor and the mutation is invisible.
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    protocol: 'brain-review/2',
    findings: [
      { id: 'f1', severity: 'blocker', evidence: 'e', cites: 'c', file: 'a.mjs', line: 11 },
      { id: 'f2', severity: 'blocker', evidence: 'e', cites: 'c', file: 'b.mjs', line: 22 },
      { id: 'u1', severity: 'blocker', evidence: 'e', cites: 'c',
        causal_disposition: 'pre-existing', file: 'c.mjs', line: 33 },
      { id: 'u2', severity: 'blocker', evidence: 'e', cites: 'c',
        causal_disposition: 'base-only', file: 'd.mjs', line: 44 },
    ],
  });
  assert.equal(built.findings.length, 2, 'two per branch, or the smear is invisible');
  assert.equal(built.follow_ups.length, 2);

  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.deepEqual(
    parsed.findings.map(f => ({ id: f.id, file: f.file, line: f.line })),
    [{ id: 'f1', file: 'a.mjs', line: '11' }, { id: 'f2', file: 'b.mjs', line: '22' }],
    'findings: each entry keeps its own pair');
  assert.deepEqual(
    parsed.follow_ups.map(f => ({ id: f.id, file: f.file, line: f.line })),
    [{ id: 'u1', file: 'c.mjs', line: '33' }, { id: 'u2', file: 'd.mjs', line: '44' }],
    'follow_ups: and so does the branch nobody drives twice');
});

test('#405 REQ-405-2: the anchor is NOT gated on protocol — /1 renders it and the poster posts it', async () => {
  // Twelve anchored render fixtures in this tree, and every one of them set
  // `protocol: 'brain-review/2'`. Round 13 varied the `line` VALUE across five
  // classes and both branches and held `protocol` constant across all of them —
  // so the input dimension the predicate never sees was the one left open
  // (round-14 cold review, C2).
  //
  // Adding `proto === 'brain-review/2' &&` to the render guard left the suite
  // green, and reintroduced exactly the drift round 11 restructured the code to
  // make impossible: the block advertises no anchor while the poster posts one.
  //
  //     MUTATED, protocol: brain-review/1
  //       block:   - id: budget          (no file:, no line:)
  //       poster:  [{"path":"big.txt","line":3, …}]
  //
  // `brain-review/1` is the default at `lite` AND `standard` — the majority
  // protocol, and the one this repo itself runs on.
  //
  // The invariant is not "the block emits it" or "the poster sends it" separately;
  // it is that the two AGREE. That is what `hasUsableAnchor` is shared for, and a
  // single predicate stops drift by field value while leaving drift introduced at
  // the CALL SITE by a dimension the predicate never receives.
  const { deriveInlineComments } = await import('./poster.mjs');
  for (const protocol of ['brain-review/1', 'brain-review/2']) {
    const built = buildVerdict({
      headSha: 'abc123',
      conclusion: 'REVISE',
      protocol,
      findings: [
        { id: 'blocking', severity: 'blocker', evidence: 'e', cites: 'c', file: 'a.mjs', line: 7 },
        { id: 'deferred', severity: 'blocker', evidence: 'e', cites: 'c',
          causal_disposition: 'pre-existing', file: 'b.mjs', line: 9 },
      ],
    });
    assert.equal(built.findings.length, 1, `${protocol}: one finding per branch, or a branch goes unchecked`);
    assert.equal(built.follow_ups.length, 1);

    const body = renderVerdict(built);
    assert.equal(body.split('\n')[1], `protocol: ${protocol}`,
      `${protocol}: the fixture really is on this protocol — otherwise the /1 half proves nothing`);
    assert.match(body, /^ {4}file: a\.mjs$/m, `${protocol}: the findings branch emits the anchor`);
    assert.match(body, /^ {4}line: 7$/m);
    assert.match(body, /^ {4}file: b\.mjs$/m, `${protocol}: and so does the follow_ups branch`);
    assert.match(body, /^ {4}line: 9$/m);

    // The agreement, which is the actual invariant.
    assert.deepEqual(
      deriveInlineComments(built.findings).map(c => ({ path: c.path, line: c.line })),
      [{ path: 'a.mjs', line: 7 }],
      `${protocol}: the poster derives exactly the anchor the block advertises`);
  }
});

test('#405 REQ-405-3: file/line survive the REAL render → parse round trip, on BOTH branches', () => {
  // PER BRANCH, and that word is the round-12 correction. Round 11 pinned the
  // both-or-neither rule with a mutation that changed both render branches at
  // once, so the ASYMMETRY was never probed: deleting the `line:` push from the
  // follow_ups branch alone left the whole suite green, and the block then emitted
  // a follow-up with `file:` and no `line:` — a rendered half anchor, the exact
  // state three artefacts and round 11's own commit message declare impossible
  // "in both branches".
  //
  // The `Number()` coercion is asserted here too (round 12, C2). It is what makes
  // the block's `line:` agree with the wire's, and nothing pinned it: dropping it
  // let `line: '  42  '` render as `"  42  "` while the poster sent `42`, and
  // `line: true` render as `true` — which re-parses to `'true'` and is then not a
  // usable anchor at all. Block-vs-wire divergence is what `hasUsableAnchor`
  // exists to eliminate, and it was one deletion away.
  for (const [branch, disposition] of [['findings', 'introduced'], ['follow_ups', 'pre-existing']]) {
    const built = buildVerdict({
      headSha: 'abc123',
      conclusion: 'REVISE',
      protocol: 'brain-review/2',
      findings: [{
        id: 'anchored', severity: 'blocker', evidence: 'e', cites: 'c',
        causal_disposition: disposition,
        file: 'brain/scripts/a.mjs', line: '  42  ',   // the messy form the coercion is for
      }],
    });
    const body = renderVerdict(built);
    const parsed = parseVerdict({ body });
    const entry = (parsed[branch] ?? [])[0];
    assert.ok(entry, `${branch}: the finding must be routed to this branch — otherwise the case is vacuous`);
    assert.equal(entry.file, 'brain/scripts/a.mjs', `${branch}: the path survives`);
    assert.equal(entry.line, '42',
      `${branch}: the line survives AS A CANONICAL INTEGER — it comes back as the scalar text the block ` +
      `carries, and the block must carry what the wire carries. Got ${JSON.stringify(entry.line)}.`);
    // and the pair is emitted together, which is what "both or neither" means at
    // the emitting end.
    assert.match(body, /^ {4}file: brain\/scripts\/a\.mjs$/m, `${branch}: file emitted`);
    assert.match(body, /^ {4}line: 42$/m, `${branch}: line emitted, coerced`);
  }
});

test('#405 REQ-405-2: a finding WITHOUT an anchor is unchanged — the additive guarantee', () => {
  // Every evaluator shipping today emits no file/line. Their output must render
  // and parse exactly as it does now: no empty keys, no nulls, no new fields.
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    findings: [{ id: 'legacy', severity: 'blocker', evidence: 'src/a.mjs:42', cites: 'ADR-0020' }],
  });
  const block = renderVerdict(built).split('```')[1];
  assert.doesNotMatch(block, /^\s*file:/m, 'no file key may appear for an anchorless finding');
  assert.doesNotMatch(block, /^\s*line:/m, 'no line key may appear for an anchorless finding');
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.deepEqual(parsed.findings[0], { id: 'legacy', severity: 'blocker', evidence: 'src/a.mjs:42', cites: 'ADR-0020' });
});

test('#405 REQ-405-3: the anchor is escaped like every other scalar — a path with a line break cannot truncate the list', () => {
  // file/line are entry scalars, so they inherit the #481/#452 escaping pair.
  // Inherit is a claim until it is exercised — round 5 of PR #478 found ten
  // yamlScalar call sites pinned by nothing, so each NEW one gets its own case.
  const built = buildVerdict({
    headSha: 'abc123',
    conclusion: 'REVISE',
    protocol: 'brain-review/2',
    findings: [
      { id: 'poisoned', severity: 'blocker', evidence: 'e', cites: 'c', file: 'a.mjs\nTier: 2', line: 1 },
      { id: 'survivor', severity: 'blocker', evidence: 'e2', cites: 'c2', file: 'b.mjs', line: 2 },
    ],
  });
  const parsed = parseVerdict({ body: renderVerdict(built) });
  assert.deepEqual((parsed.findings ?? []).map(f => f.id), ['poisoned', 'survivor']);
  assert.equal(parsed.findings[0].file, 'a.mjs\nTier: 2', 'and the value round-trips byte-identical');
});

// ── schema-v2 gate (issue #483, maintainer ruling option 3) ───────────────
//
// `validateSchemaV2` existed, was tested, and was called NOWHERE in
// production — the #335 class: green in test, absent where it matters. These
// tests drive each routing decision `buildVerdict` makes on an UNVALIDATED
// `causal_disposition` and assert the ruled semantics: downgrade + annotate,
// never drop, never silently reclassify.

test('#483: a typo\'d causal_disposition is NOT routed to follow_ups — it is marked and stays blocking', () => {
  const v = buildVerdict({
    headSha: HEAD_SHA,
    protocol: 'brain-review/2',
    conclusion: 'REVISE',
    findings: [{
      id: 'typo', severity: 'correction', evidence: 'ran `node --test`',
      evidence_class: 'deterministic',
      causal_disposition: 'pre-exisiting', // sic — one letter from `pre-existing`
    }],
  });
  assert.deepEqual(v.follow_ups.map(f => f.id), [],
    'a value the validator rejects must not reach the admission rule at all');
  assert.deepEqual(v.findings.map(f => f.id), ['typo']);
  assert.match(v.findings[0].schema_invalid, /causal_disposition/,
    'and it carries the marker naming what failed');
});

test('#483: a near-miss `unknown` does NOT lose the escalation it would have forced', () => {
  // The sharpest of the three harms: `unknown` is the trigger for STOP +
  // escalate:human. A spelling near-miss routes to the `else` branch today and
  // the escalation vanishes silently. Protocol §6.2 already rules this case —
  // "any finding whose causality could not be determined forces verdict: STOP
  // and escalate: human" — and a disposition the validator cannot read IS
  // causality that could not be determined.
  const v = buildVerdict({
    headSha: HEAD_SHA,
    protocol: 'brain-review/2',
    conclusion: 'REVISE',
    findings: [{
      id: 'nearmiss', severity: 'blocker', evidence: 'ran `node --test`', cites: 'ADR-0020',
      evidence_class: 'deterministic',
      causal_disposition: 'unkown', // sic
    }],
  });
  assert.equal(v.verdict, 'STOP');
  assert.equal(v.escalate, 'human');
  assert.deepEqual(v.findings.map(f => f.id), ['nearmiss']);
});

test('#483: an invented evidence_class is marked, not admitted unchallenged', () => {
  const v = buildVerdict({
    headSha: HEAD_SHA,
    protocol: 'brain-review/2',
    conclusion: 'REVISE',
    findings: [{
      id: 'invented', severity: 'correction', evidence: 'ran `node --test`',
      evidence_class: 'proven', // not one of deterministic|inferential|insufficient
      causal_disposition: 'introduced',
    }],
  });
  assert.match(v.findings[0].schema_invalid, /evidence_class/);
  assert.equal(v.verdict, 'STOP', 'an unreadable finding is surfaced, never resolved');
});

test('#483: the marker is RENDERED in the posted block — a marker only the code can see does not satisfy the ruling', () => {
  const block = renderVerdict(buildVerdict({
    headSha: HEAD_SHA,
    protocol: 'brain-review/2',
    conclusion: 'REVISE',
    findings: [{
      id: 'shown', severity: 'correction', evidence: 'ran `node --test`',
      evidence_class: 'deterministic', causal_disposition: 'bogus',
    }],
  }));
  assert.match(block, /schema_invalid:/, `marker absent from the block:\n${block}`);
});

test('#483: the REVISE-to-APPROVE softening cannot fire while a schema-invalid finding is present', () => {
  // The softening exists for "every finding was routed out of the blocking
  // set". A finding the validator could not read was never routed anywhere on
  // its merits, so it must not count as routed-out.
  const v = buildVerdict({
    headSha: HEAD_SHA,
    protocol: 'brain-review/2',
    conclusion: 'REVISE',
    findings: [
      { id: 'ok', severity: 'correction', evidence: 'e', evidence_class: 'deterministic', causal_disposition: 'pre-existing' },
      { id: 'bad', severity: 'correction', evidence: 'e', evidence_class: 'deterministic', causal_disposition: 'typo' },
    ],
  });
  assert.notEqual(v.verdict, 'APPROVE');
  assert.deepEqual(v.findings.map(f => f.id), ['bad']);
  assert.deepEqual(v.follow_ups.map(f => f.id), ['ok'], 'the valid one still routes normally');
});

test('#483 blast radius: a valid /2 finding is untouched, and a /1 finding carrying neither field is not marked', () => {
  const valid = buildVerdict({
    headSha: HEAD_SHA, protocol: 'brain-review/2', conclusion: 'REVISE',
    findings: [{ id: 'v', severity: 'correction', evidence: 'e', evidence_class: 'inferential', causal_disposition: 'base-only' }],
  });
  assert.deepEqual(valid.follow_ups.map(f => f.id), ['v'], 'valid values still route by the admission rule');
  assert.equal(valid.findings.length, 0);
  assert.equal(valid.follow_ups[0].schema_invalid, undefined);

  // A /1 verdict "simply omits them" (protocol §6.2). Validating those would
  // mark every legacy finding invalid — the gate must not fire there.
  const legacy = buildVerdict({
    headSha: HEAD_SHA, conclusion: 'REVISE',
    findings: [{ id: 'l', severity: 'correction', evidence: 'e' }],
  });
  assert.deepEqual(legacy.findings.map(f => f.id), ['l']);
  assert.equal(legacy.findings[0].schema_invalid, undefined);
  assert.equal(legacy.verdict, 'REVISE', 'and no escalation is invented for it');
});

test('#483 point 4: the evidence gate still drops (protocol §5: inadmissible) but no longer drops SILENTLY', () => {
  // The ruling put this gate in scope: adopt annotate-and-surface, or justify
  // the silent drop in writing. The drop is justified — protocol §5 line 195
  // rules a finding without a cold-run command INADMISSIBLE, i.e. not a
  // finding at all, which is a different thing from a finding whose causal
  // claim cannot be read. What is NOT justified is the silence: "no findings"
  // and "findings discarded" must not look identical to the reader.
  const v = buildVerdict({
    headSha: HEAD_SHA,
    conclusion: 'REVISE',
    findings: [
      { id: 'noev', severity: 'correction', cites: 'ADR-0020' },
      { id: 'ok', severity: 'editorial', evidence: 'ran `npm test`' },
    ],
  });
  assert.deepEqual(v.findings.map(f => f.id), ['ok'], 'still dropped');
  assert.ok(v.conditions.some(c => /inadmissible/.test(c) && /1/.test(c)),
    `the drop must be visible in conditions, got: ${JSON.stringify(v.conditions)}`);
});

test('#483: REVISE does NOT soften to APPROVE when every finding was dropped as inadmissible (fail-open)', () => {
  // Found by the #483 mutation sweep, not by design: reverting the softening's
  // guard from `processed.length` to `findings.length` left all tests green.
  //
  // Under the raw-input measure the softening reads "findings existed, and none
  // of them is in the blocking set" — which is vacuously true when the evidence
  // gate dropped every one of them. A verdict then APPROVES on the strength of
  // findings nobody ever read: the same silent drop this ticket came to fix,
  // one step further downstream and pointing the wrong way (fail-open).
  const v = buildVerdict({
    headSha: HEAD_SHA,
    protocol: 'brain-review/2',
    conclusion: 'REVISE',
    findings: [
      { id: 'noev1', severity: 'blocker', cites: 'ADR-0020' },  // no evidence
      { id: 'noev2', severity: 'correction', cites: 'ADR-0020' }, // no evidence
    ],
  });
  assert.equal(v.verdict, 'REVISE',
    'an inadmissible finding is not a finding "routed out of the blocking set" — nothing was read, so nothing softens');
  assert.deepEqual(v.findings, []);
  assert.deepEqual(v.follow_ups, []);
  assert.ok(v.conditions.some(c => /inadmissible/.test(c) && /2/.test(c)),
    `and the reader is told two findings vanished: ${JSON.stringify(v.conditions)}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// #683 — the verdict declares which control classes ran
// ═══════════════════════════════════════════════════════════════════════════

const buildRendered = (over = {}) => renderVerdict(buildVerdict({
  headSha: 'abc123', conclusion: 'APPROVE', gates: { required: [], detection: [] },
  findings: [], ...over,
}));

test('#683: the declaration is emitted even when EMPTY — an absent key is the silence this replaces', () => {
  const body = buildRendered({ controls: [] });
  assert.match(body, /^controls: \[\]$/m,
    '`controls: []` reads as "nothing declared that it ran", which is true and loud; omitting the key is neither');
});

test('#683: the declaration round-trips — bare words would not', () => {
  // JSON-encoded on purpose: `yamlScalar('deterministic')` renders it BARE, and a
  // bare word is not JSON, so the parser would answer UNREADABLE and the field
  // could not survive a render→parse cycle. Measured, not reasoned about.
  const body = buildRendered({ controls: ['deterministic', 'inferential'] });
  assert.match(body, /^controls: \["deterministic", "inferential"\]$/m);
  const parsed = parseVerdict({ body });
  assert.deepEqual(parsed.controls, ['deterministic', 'inferential']);
  assert.equal(parsed.malformed, undefined);
});

test('#683: a control class outside the vocabulary is UNREADABLE, never a value', () => {
  // A verdict claiming a control that does not exist would be BELIEVED — strictly
  // worse than the silence this field replaces, so it is refused at the reader too.
  const body = [
    '```yaml', 'protocol: brain-review/2', 'verdict: APPROVE', 'head_sha: abc123', 'rev: 1',
    'controls: ["telepathy"]', 'escalate: null', '```',
  ].join('\n');
  const parsed = parseVerdict({ body });
  assert.equal(parsed.controls, undefined);
  assert.deepEqual(parsed.malformed, ['controls']);
});

test('#683: the declaration survives brain-review/1 — the tier that needs it MOST', () => {
  // `/1` is what `lite` and `standard` post by default, and its findings carry no
  // `evidence_class` at all. The statement is about the RUN, not about a finding,
  // so it is true at both protocols and uses the one vocabulary.
  const body = buildRendered({ protocol: 'brain-review/1', controls: ['deterministic'] });
  assert.match(body, /^protocol: brain-review\/1$/m);
  assert.match(body, /^controls: \["deterministic"\]$/m);
  assert.deepEqual(parseVerdict({ body }).controls, ['deterministic']);
});

test('#683: a verdict with findings and one without declare the SAME controls', () => {
  // The property the design exists for, at the render layer.
  const green = buildRendered({ controls: ['deterministic'] });
  const red = buildRendered({
    controls: ['deterministic'], conclusion: 'REVISE',
    findings: [{ id: 'budget', severity: 'blocker', evidence: 'over', cites: 'x' }],
  });
  const declared = (b) => b.split('\n').find((l) => l.startsWith('controls:'));
  assert.equal(declared(green), declared(red));
});

test('#690: the verdict states what did NOT run, so absence carries no meaning', () => {
  const body = buildRendered({ controls: ['deterministic'] });
  assert.match(body, /^controls: \["deterministic"\]$/m);
  assert.match(body, /^controls_not_applied: \["inferential"\]$/m);
  const parsed = parseVerdict({ body });
  assert.deepEqual(parsed.controls, ['deterministic']);
  assert.deepEqual(parsed.controls_not_applied, ['inferential']);
  assert.equal(parsed.malformed, undefined);
});

test('#690: the complement is rendered even when EMPTY — same rule as controls itself', () => {
  const body = buildRendered({ controls: ['deterministic', 'inferential'] });
  assert.match(body, /^controls_not_applied: \[\]$/m,
    'omitting it once everything ran would make its absence mean "nothing was skipped" — silence again');
});

test('#690: an unknown member of the complement is UNREADABLE, exactly as it is for controls', () => {
  const body = [
    '```yaml', 'protocol: brain-review/2', 'verdict: APPROVE', 'head_sha: abc123', 'rev: 1',
    'controls: ["deterministic"]', 'controls_not_applied: ["telepathy"]', 'escalate: null', '```',
  ].join('\n');
  const parsed = parseVerdict({ body });
  assert.deepEqual(parsed.controls, ['deterministic'], 'the readable half still reads');
  assert.equal(parsed.controls_not_applied, undefined);
  assert.deepEqual(parsed.malformed, ['controls_not_applied']);
});

test('#682: the raise happens BEFORE §7 reads the conclusion', () => {
  // Round 2's regression, pinned. `boundHit` reads the conclusion, so raising
  // afterwards meant a fourth REVISE never hit §7's bound.
  const blocker = [{
    id: 'judgment:J1', severity: 'blocker', evidence_class: 'inferential',
    causal_disposition: 'introduced', evidence: 'e', cites: 'c',
  }];
  const v = buildVerdict({
    headSha: 'a'.repeat(40), conclusion: 'APPROVE', protocol: 'brain-review/2',
    gates: { required: [], detection: [] }, findings: blocker, priorRevCount: 4,
  });
  assert.equal(v.verdict, 'STOP', '§7 forbids a fourth REVISE — the raise must be visible to the bound');
  assert.equal(v.escalate, 'human');
});

test('#682: the softening does not APPROVE over uncomputable evidence when a blocker survives routing', () => {
  // NAMED PRECISELY, because the first version of this test was called "never
  // APPROVEs over uncomputable evidence" and its fixture used
  // `causal_disposition: 'introduced'` — the one disposition that keeps
  // `candidateFindings` non-empty, i.e. the single case the softening cannot
  // reach. A pin asserting "never" while testing the one input that cannot
  // falsify it is worse than no pin: it reads as closure.
  //
  // What this actually pins is the case #682 round 1 broke and round 2 fixed:
  // widening the guard to `!blockerRemains` let an uncomputable REVISE soften.
  const v = buildVerdict({
    headSha: 'a'.repeat(40), conclusion: 'REVISE', protocol: 'brain-review/2',
    gates: { required: [], detection: [] },
    findings: [{
      id: 'c1', severity: 'correction', evidence_class: 'deterministic',
      causal_disposition: 'introduced', evidence: 'e', cites: 'c',
    }],
    conditions: ['evidence uncomputable: TDD-RED reversion (base sha unresolvable)'],
  });
  assert.equal(v.verdict, 'REVISE');
});

test('#750: a routed-out blocker no longer softens an uncomputable REVISE — the §10 gap named "KNOWN GAP" is CLOSED', () => {
  // This REPLACES the KNOWN GAP pin (do not delete it, per that pin's own
  // instruction) with the closure it named. Same fixture: `causal_disposition:
  // 'pre-existing'` still empties `candidateFindings`, so #483's softening
  // still WANTS to fire — but the evaluator that produced this verdict also
  // said its budget/reversion evidence was uncomputable, and #750's sixth
  // conjunct now reads that declaration. §10 says never APPROVE on
  // uncomputable evidence; this route no longer does.
  const v = buildVerdict({
    headSha: 'a'.repeat(40), conclusion: 'REVISE', protocol: 'brain-review/2',
    gates: { required: [], detection: [] },
    findings: [{
      id: 'g1', severity: 'blocker', evidence_class: 'deterministic',
      causal_disposition: 'pre-existing', evidence: 'e', cites: 'c',
    }],
    conditions: ['evidence uncomputable: TDD-RED reversion (base sha unresolvable)'],
    conclusionCauses: ['blocker', 'uncomputable'],
  });
  assert.equal(v.verdict, 'REVISE',
    'an evaluator that declared uncomputable evidence among its causes must never be softened to APPROVE');
});

// ── #750: the softening's sixth conjunct reads the declared cause ──────────

function softenableFixture(conclusionCauses) {
  return {
    headSha: 'a'.repeat(40), conclusion: 'REVISE', protocol: 'brain-review/2',
    gates: { required: [], detection: [] },
    findings: [{
      id: 'g1', severity: 'blocker', evidence_class: 'deterministic',
      causal_disposition: 'pre-existing', evidence: 'e', cites: 'c',
    }],
    ...(conclusionCauses !== undefined ? { conclusionCauses } : {}),
  };
}

test('#750: conclusionCauses explicitly [] — fail-closed, the softening does not fire even though [].every(...) is vacuously true', () => {
  // `[].every(c => c === 'blocker')` is `true` in JavaScript. The length
  // check is not defensive padding — deleting it flips this fixture to
  // APPROVE on an evaluator that declared NO cause at all.
  const v = buildVerdict(softenableFixture([]));
  assert.equal(v.verdict, 'REVISE');
});

test('#750: conclusionCauses is mixed (\'blocker\' AND \'uncomputable\') — the softening requires EVERY cause to be blocker, not some', () => {
  const v = buildVerdict(softenableFixture(['blocker', 'uncomputable']));
  assert.equal(v.verdict, 'REVISE',
    'every(c => c === "blocker") must stay every — some() would soften on a mixed cause list');
});

test('#750: conclusionCauses OMITTED entirely (legacy caller shape) — the fail-closed default is [], not [\'blocker\']', () => {
  // This re-adds the un-updated fixture from before #750 under a new name: an
  // evaluator (or a legacy caller) that declares nothing gets the fail-closed
  // default, not the convenient one. Companion pin to the :923 case below,
  // which is the SAME shape but WITH `conclusionCauses: ['blocker']` — one
  // statement each, both on the record.
  const v = buildVerdict(softenableFixture(undefined));
  assert.equal(v.verdict, 'REVISE',
    'an evaluator that declares no cause is not softened — silence fails closed, not open');
});

// ── #750 cold review C2: three spec scenarios the earlier batch left unpinned ──

test('#750 REQ-750-5: renderVerdict never emits conclusionCauses — it is builder-internal plumbing, not part of the verdict shape', () => {
  const vBlocker = buildVerdict(softenableFixture(['blocker']));
  assert.ok(!('conclusionCauses' in vBlocker),
    'buildVerdict\'s returned object must not carry conclusionCauses');
  const renderedBlocker = renderVerdict(vBlocker);
  assert.ok(!renderedBlocker.includes('conclusionCauses'),
    'the rendered block must not mention conclusionCauses');

  const vUncomputable = buildVerdict(softenableFixture(['uncomputable']));
  assert.ok(!('conclusionCauses' in vUncomputable));
  const renderedUncomputable = renderVerdict(vUncomputable);
  assert.ok(!renderedUncomputable.includes('conclusionCauses'));
});

test('#750 REQ-750-5: parse-verdict has no reader for conclusionCauses — it is never round-tripped', () => {
  const v = buildVerdict(softenableFixture(['blocker']));
  const rendered = renderVerdict(v);
  const parsed = parseVerdict({ body: rendered });
  assert.ok(!('conclusionCauses' in parsed),
    'parseVerdict must not produce a conclusionCauses key — there is no reader for it on the wire');
});

test('#682: the raise reads the BLOCKING set, not the processed list', () => {
  // The load-bearing line of the whole "it cannot move to cli.mjs" argument, and
  // a mutation to it survived the full suite at 4124/4124. `processed` is the
  // list BEFORE routing; `candidateFindings` is the blocking set after it. A
  // `base-only` finding is in the first and not the second, so reading the wrong
  // one raises a conclusion over a finding that was deliberately routed out.
  const routedOut = [{
    id: 'g1', severity: 'blocker', evidence_class: 'deterministic',
    causal_disposition: 'base-only', evidence: 'e', cites: 'c',
  }];
  const v = buildVerdict({
    headSha: 'a'.repeat(40), conclusion: 'APPROVE', protocol: 'brain-review/2',
    gates: { required: [], detection: [] }, findings: routedOut, priorRevCount: 4,
  });
  assert.equal(v.verdict, 'APPROVE',
    'a base-only blocker is not in the blocking set — raising on it re-blocks what routing excluded');
  assert.equal(v.escalate, null, 'and it must not trip §7 either');
});

test('#682 A1: a corroborated reasoned blocker raises the conclusion', () => {
  const v = buildVerdict({
    headSha: 'a'.repeat(40), conclusion: 'APPROVE', protocol: 'brain-review/2',
    gates: { required: [], detection: [] },
    findings: [{
      id: 'judgment:J1', severity: 'blocker', evidence_class: 'inferential',
      causal_disposition: 'introduced', evidence: 'e', cites: 'c',
      refuter_outcome: 'corroborated', refuter_rationale: 'r',
    }],
  });
  assert.equal(v.verdict, 'REVISE', 'a blocker that does not block is not a blocker');
});

test('#682: the original #483 softening still fires — routed-out findings, empty blocking set', () => {
  // Reverting the widening must not break what the branch was written for.
  //
  // #750: `conclusionCauses: ['blocker']` is a REQUIRED, deliberate edit to
  // this verbatim pin — without it, #750's sixth conjunct (fail-closed
  // default `[]`) flips this case to REVISE and it would read as an
  // unexplained regression. The pin immediately above ("OMITTED entirely")
  // is this edit's justification: both statements are now on the record —
  // "an evaluator that says 'blocker' still gets #483's softening" (here) and
  // "an evaluator that says nothing does not" (there).
  const v = buildVerdict({
    headSha: 'a'.repeat(40), conclusion: 'REVISE', protocol: 'brain-review/2',
    gates: { required: [], detection: [] },
    findings: [{
      id: 'g1', severity: 'blocker', evidence_class: 'deterministic',
      causal_disposition: 'pre-existing', evidence: 'e', cites: 'c',
    }],
    conclusionCauses: ['blocker'],
  });
  assert.equal(v.verdict, 'APPROVE', 'every finding routed OUT of the blocking set — #483');
});

test('CHAIN: a verdict may not APPROVE while it ESCALATES', () => {
  // Found only by reviewing the CHAIN, not the links. A reasoned blocker with no
  // `cites` is a BLOCKER when `evaluateRefuter` picks its batch and a
  // `correction` by the time the conclusion is computed — the evidence drop and
  // the uncited downgrade run later, inside buildVerdict. So the raise never
  // fires while the challenge's `escalate: human` and its "were NOT challenged"
  // condition survive into an APPROVE.
  //
  // Two links disagreeing about what a blocker IS. The rule pinned here is
  // coherence, not a patch for that route: escalation means a person must look,
  // APPROVE means nothing blocks, and a reader cannot hold both.
  const v = buildVerdict({
    headSha: 'a'.repeat(40), conclusion: 'APPROVE', protocol: 'brain-review/2',
    gates: { required: [], detection: [] },
    findings: [{
      id: 'judgment:J1', severity: 'correction', evidence_class: 'inferential',
      causal_disposition: 'introduced', evidence: 'e', cites: 'c',
      refuter_outcome: 'unchallenged',
    }],
    conditions: ['1 inferential blocker(s) were NOT challenged'],
    escalate: 'human',
  });
  assert.notEqual(v.verdict, 'APPROVE',
    'a verdict that summons a human cannot also say nothing blocks');
  assert.equal(v.escalate, 'human');
});

test('CHAIN: an escalating verdict is not softened into APPROVE either', () => {
  // The rule sits BEFORE #483's softening on purpose.
  const v = buildVerdict({
    headSha: 'a'.repeat(40), conclusion: 'REVISE', protocol: 'brain-review/2',
    gates: { required: [], detection: [] },
    findings: [{
      id: 'g1', severity: 'blocker', evidence_class: 'deterministic',
      causal_disposition: 'pre-existing', evidence: 'e', cites: 'c',
    }],
    escalate: 'human',
  });
  assert.notEqual(v.verdict, 'APPROVE');
});
