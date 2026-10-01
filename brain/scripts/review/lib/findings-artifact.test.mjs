// findings-artifact.test.mjs — issue #682 slice 3, REQ-S3-3 / REQ-S3-4 / REQ-S3-6.
//
// The axis these tests vary is WHICH STATE THE CALLER ENDS UP IN. A reader that
// answers "nothing" for both "the file was not there" and "the engine found
// nothing" hands `cli.mjs` one answer for two facts, and the verdict then either
// declares a control it never applied or hides one it did. That is #552's fold,
// moved one layer up into the file contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { readFindingsArtifact, ARTIFACT_TAG, CARRIED_FIELDS, ALLOWED_SEVERITIES } from './findings-artifact.mjs';

const block = (json) => `# Cold review\n\n\`\`\`${ARTIFACT_TAG}\n${json}\n\`\`\`\n`;
const finding = (over = {}) => ({
  id: 'inferential:J1', severity: 'blocker', evidence: 'the semantics are inverted',
  cites: 'reviewer-protocol.md §6.1', file: 'a.mjs', line: 42, ...over,
});

// ── the four states, and the three that are FAILURES ─────────────────────────

test('#682 S3: a missing or empty artifact is a FAILURE, not an empty result', () => {
  for (const input of [undefined, null, '', '   \n\n  ']) {
    const r = readFindingsArtifact(input);
    assert.equal(r.ok, false, `${JSON.stringify(input)} must fail`);
    assert.match(r.reason, /missing or empty/);
  }
});

test('#682 S3: an artifact with no block of the tag is a FAILURE', () => {
  const r = readFindingsArtifact('# Cold review\n\nProse, and a fence of another kind:\n\n```js\nconst a = 1;\n```\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`no .*${ARTIFACT_TAG.replace('/', '\\/')} block`));
});

test('#682 S3: unparseable or wrongly-shaped JSON is a FAILURE, never an empty list', () => {
  const cases = [
    ['not JSON at all', block('{ this is not json }')],
    ['a JSON scalar', block('"a string"')],
    ['an object with no findings array', block('{"summary": "looks fine"}')],
    ['a list whose entries are not objects', block('["just a string"]')],
    ['a list carrying null', block('[null]')],
  ];
  for (const [label, text] of cases) {
    const r = readFindingsArtifact(text);
    assert.equal(r.ok, false, `${label} must fail`);
    assert.ok(r.reason, `${label} must say why`);
  }
});

test('#682 S3: two blocks of the tag REFUSE rather than pick one', () => {
  const two = block('[]') + '\n' + block(JSON.stringify([finding()]));
  const r = readFindingsArtifact(two);
  assert.equal(r.ok, false);
  assert.match(r.reason, /expected exactly 1/);
  // Picking the first would have silently dropped a blocker — the exact shape
  // this refusal exists to prevent.
});

test('#682 S3: an EMPTY findings list is a SUCCESS — the engine ran and found nothing', () => {
  for (const empty of ['[]', '{"findings": []}']) {
    const r = readFindingsArtifact(block(empty));
    assert.equal(r.ok, true, `${empty} must succeed`);
    assert.deepEqual(r.findings, []);
  }
});

test('#682 S3: "found nothing" and "could not read" are DISTINGUISHABLE — on EVERY failure path', () => {
  // The pin, and the first cut of it was BLIND ALONG THE PATH AXIS. It asserted
  // `findings === undefined` on ONE failure — the JSON-parse one — and read as
  // though it covered "a failure". A mutation that added `findings: []` to the
  // MISSING-FILE branch survived the whole file, green.
  //
  // So the oracle enumerates the paths instead of sampling one. Every branch
  // that returns `ok: false` is a refusal, and a refusal carrying an empty
  // findings array is the fold itself: `cli.mjs` would read it as "ran, found
  // nothing" and declare the inferential control applied over a file it never
  // read.
  const FAILURES = [
    ['missing', undefined],
    ['empty', '   \n '],
    ['no block of the tag', '# Cold review\n\nprose only\n'],
    ['two blocks', block('[]') + '\n' + block('[]')],
    ['unparseable JSON', block('{ nope }')],
    ['a JSON scalar', block('"a string"')],
    ['no findings array', block('{"summary": "fine"}')],
    ['a non-object entry', block('["a string"]')],
    ['the posted family shape', '```yaml\nprotocol: brain-review/2\n```\n' + block('[]')],
  ];

  const ranAndFoundNothing = readFindingsArtifact(block('[]'));
  assert.equal(ranAndFoundNothing.ok, true);
  assert.deepEqual(ranAndFoundNothing.findings, []);

  for (const [label, input] of FAILURES) {
    const r = readFindingsArtifact(input);
    assert.equal(r.ok, false, `${label} must be a refusal`);
    assert.equal(r.findings, undefined,
      `${label}: a refusal must carry NO findings key — an empty array there is indistinguishable ` +
      'from "the engine ran and found nothing", and the verdict would claim a control it never applied');
    assert.notDeepEqual(r, ranAndFoundNothing, `${label} must not equal the empty-but-successful result`);
  }
});

// ── the family rule, which is a live hazard and not a style ──────────────────

test('#682 S3: a `protocol: brain-review/N` line REFUSES, and says what it would corrupt', () => {
  const posted = '```yaml\nprotocol: brain-review/2\nverdict: APPROVE\n```\n' + block('[]');
  const r = readFindingsArtifact(posted);
  assert.equal(r.ok, false);
  assert.match(r.reason, /rev and the anti-loop lock/);
  // Refused even though a well-formed block of the tag is present further down:
  // the hazard is the file carrying the posted shape at all, not which block wins.
});

// ── REQ-682-6 — the fields that cross are the fields that render ─────────────

test('#682 S3: entries are projected onto CARRIED_FIELDS at the boundary', () => {
  const smuggled = finding({ deliberation_notes: 'my private reasoning', title: 'a framing' });
  const [out] = readFindingsArtifact(block(JSON.stringify([smuggled]))).findings;

  assert.equal(out.deliberation_notes, undefined, 'a field outside the set must not cross');
  assert.equal(out.title, undefined, 'title was removed from the set by a cold review — it must stay out');
  for (const k of Object.keys(out)) {
    assert.ok(CARRIED_FIELDS.includes(k), `"${k}" crossed and is not a carried field`);
  }
  assert.equal(out.id, smuggled.id, 'and the carried fields DO cross — the projection is not a delete-all');
});

// ── why JSON, pinned as behaviour rather than left in a comment ──────────────

test('#682 S3: multi-line evidence survives the round trip', () => {
  const long = 'I ran:\n\n    npm test\n\nand it printed 4149.';
  const [out] = readFindingsArtifact(block(JSON.stringify([finding({ evidence: long })]))).findings;
  assert.equal(out.evidence, long, 'evidence in a real cold review is paragraphs — it may not be truncated');
});

test('#682 S3: the payload is read at ANY indentation — the reason it is not YAML', () => {
  // Measured on the verdict's own list reader: 2-space indent → 1 entry,
  // 0-indent and 4-space → 0 entries, silently. A finding must never be
  // reachable-or-not by a whitespace choice, least of all in a file a model wrote.
  const entries = JSON.stringify([finding()]);
  for (const indent of ['', '  ', '    ', '\t']) {
    const json = entries.split('\n').map((l) => indent + l).join('\n');
    const r = readFindingsArtifact(block(json));
    assert.equal(r.ok, true, `indent ${JSON.stringify(indent)} must parse`);
    assert.equal(r.findings.length, 1, `indent ${JSON.stringify(indent)} must yield the finding`);
  }
});

test('#682 S3: `file` and `line` cross — they are what becomes an inline comment', () => {
  const [out] = readFindingsArtifact(block(JSON.stringify([finding()]))).findings;
  assert.equal(out.file, 'a.mjs');
  assert.equal(out.line, 42);
  // deriveInlineComments requires BOTH and a positive integer line; without them
  // a reasoned finding reaches the summary block and never the changed line.
});

// ── the file layer, against a REAL directory ─────────────────────────────────
//
// Injected-fs tests would not reach `artifactDeps`'s glue in cli.mjs, and glue
// nothing tests is where this ticket keeps finding its defects.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import { artifactPathFor, makeArtifactGenerate, REVIEWS_ROOT } from './findings-artifact.mjs';
import { artifactDeps } from '../cli.mjs';

/** A throwaway repo root carrying (or not) one PR's artifact. */
function repoWith(t, { pr = 762, body = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'brain-findings-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (body !== null) {
    const rel = artifactPathFor(pr);
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), body, 'utf8');
  }
  return root;
}

test('#682 S3: the path is keyed by PR, and a non-PR REFUSES before becoming a path segment', () => {
  assert.equal(artifactPathFor(762), join(REVIEWS_ROOT, 'pr-762', 'cold-review.md'));
  for (const bad of ['../../etc', 0, -1, 1.5, 'abc', null, undefined, '762; rm -rf /']) {
    assert.throws(() => artifactPathFor(bad), /is not a PR number/,
      `${JSON.stringify(bad)} must never reach the filesystem as a path segment`);
  }
});

test('#682 S3: NO artifact is not a failure — it is the transport that was never configured', (t) => {
  const root = repoWith(t, { body: null });
  assert.equal(makeArtifactGenerate({ prNumber: 762, root }), null);
  assert.deepEqual(artifactDeps(762, root), {},
    'no generate key at all — shouldRun is then false and the verdict says "no transport configured"');
});

test('#682 S3: an artifact present yields a generate that returns its findings', async (t) => {
  const root = repoWith(t, {
    body: block(JSON.stringify([finding({ id: 'inferential:A' }), finding({ id: 'inferential:B' })])),
  });
  const wired = artifactDeps(762, root);
  assert.equal(typeof wired.generate, 'function', 'the glue must produce a generate, not just a reader');

  const out = await wired.generate({ worktreePath: '/w', baseSha: 'a', headSha: 'b', changedFiles: [], prBody: '' });
  assert.equal(out.length, 2);
  assert.deepEqual(out.map((f) => f.id), ['inferential:A', 'inferential:B']);
});

test('#682 S3: an artifact that exists and cannot be read THROWS — it never reads as empty', async (t) => {
  const root = repoWith(t, { body: block('{ not json }') });
  const { generate } = artifactDeps(762, root);
  await assert.rejects(() => generate({}), /could not be read/,
    'a transport that ran and broke must fail closed — gatherInferentialInputs maps the throw ' +
    'to {failed: true} and cli.mjs refuses to post');
});

test('#682 S3: an artifact whose list is EMPTY resolves — the stage ran and found nothing', async (t) => {
  const root = repoWith(t, { body: block('[]') });
  const { generate } = artifactDeps(762, root);
  assert.deepEqual(await generate({}), [],
    'distinct from both "no artifact" (no generate at all) and "unreadable" (a throw)');
});


// ── judgment:cold-2 (fifth cold review) — severity is a VALUE, and it decides ──

const fence = (f) => '```brain-findings/1\n' + JSON.stringify([f]) + '\n```\n';
const base = { id: 'x', evidence: 'e', cites: 'c' };

test('cold-2: every declared severity is accepted', () => {
  for (const severity of ALLOWED_SEVERITIES) {
    const r = readFindingsArtifact(fence({ ...base, severity }));
    assert.equal(r.ok, true, `${severity} must be accepted`);
    assert.equal(r.findings[0].severity, severity);
  }
});

test('cold-2: a NEAR-MISS for blocker refuses the artifact', () => {
  // MEASURED as the defect: `critical` passed the reader, survived the
  // evaluator, and buildVerdict returned null where `blocker` returns REVISE.
  // It also escaped the challenger — refuter.mjs selects on severity ===
  // 'blocker' — so the finding was neither blocked nor refuted, and nothing
  // reported that the vocabulary had been violated.
  const r = readFindingsArtifact(fence({ ...base, severity: 'critical' }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /critical/);
  assert.match(r.reason, /blocker \| correction \| editorial/);
});

test('cold-2: case matters — the vocabulary is not folded', () => {
  // Folding case here would be brain deciding what the producer meant, which is
  // the grading this boundary refuses to do on its behalf.
  assert.equal(readFindingsArtifact(fence({ ...base, severity: 'BLOCKER' })).ok, false);
});

test('cold-2: a MISSING severity refuses rather than rendering null on the wire', () => {
  // It used to render `severity: null`, a value reviewer-protocol.md does not
  // define, in a verdict that still claimed the inferential control applied.
  const r = readFindingsArtifact(fence({ ...base }));
  assert.equal(r.ok, false);
  assert.match(r.reason, /null/);
});

test('cold-2: ONE bad entry refuses the WHOLE artifact', () => {
  // Dropping the bad entry and keeping the rest would silently lose a finding —
  // the producer said something and the reader would decide it said nothing.
  const two = '```brain-findings/1\n' +
    JSON.stringify([{ ...base, severity: 'blocker' }, { ...base, id: 'y', severity: 'nope' }]) +
    '\n```\n';
  assert.equal(readFindingsArtifact(two).ok, false);
});

test('cold-2: the refusal explains why brain does not simply correct the value', () => {
  const r = readFindingsArtifact(fence({ ...base, severity: 'critical' }));
  assert.match(r.reason, /brain cannot know the right value|decides whether a finding blocks/);
});

test('cold-2: the vocabulary is frozen and matches what the prompt offers', () => {
  assert.ok(Object.isFrozen(ALLOWED_SEVERITIES));
  assert.equal(new Set(ALLOWED_SEVERITIES).size, ALLOWED_SEVERITIES.length);
});
