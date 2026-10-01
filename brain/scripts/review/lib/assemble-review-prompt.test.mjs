// assemble-review-prompt.test.mjs — the prompt is checked BY THE READER, not by
// string-matching against a second copy of the contract (#682 slice 3, B.4).
//
// The central oracle here is not an assertion about the prompt's text. It is
// `readFindingsArtifact` — the real reader, unmocked — run over THE WHOLE
// PROMPT. The prompt embeds a worked example in the artifact's shape, so if the
// example shows the engine something the reader would refuse, silently drop a
// field from, or fail to find at all, this file goes red.
//
// That matters because the failure it guards is invisible in production: an
// engine told to emit the wrong shape writes a file, exits 0, and the reader
// reports findings the verdict then renders. Nothing throws. The review is
// simply quieter than it should be, and the only way to notice is to have
// checked the instruction against the parser before shipping either.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { assembleReviewPrompt, REFUSED_FIELDS } from './assemble-review-prompt.mjs';
import { firstPartyRole } from '../../roles/first-party/index.mjs';

const ROLE = firstPartyRole('cold-review');
import {
  readFindingsArtifact,
  artifactPathFor,
  CARRIED_FIELDS,
  ARTIFACT_TAG,
} from './findings-artifact.mjs';
import { FORCED_EVIDENCE_CLASS } from '../evaluators/inferential.mjs';
import { ALLOWED_EVIDENCE_CLASSES } from './schema-v2.mjs';

/** The severity vocabulary, read back out of the prompt rather than restated. */
const SEVERITY_VALUES = (prompt) => renderedVocabulary(prompt, 'severity');

const PR = 765;

test('the prompt itself parses as an artifact — the reader is the oracle', () => {
  const result = readFindingsArtifact(assembleReviewPrompt({ role: ROLE, prNumber: PR }));

  assert.equal(
    result.ok,
    true,
    `the worked example inside the prompt must parse through the real reader — ${result.reason ?? ''}`
  );
  assert.equal(result.findings.length, 2, 'the example shows both an anchored and an un-anchored finding');

  // This also covers the posted-family refusal without a second assertion: the
  // reader checks `protocol: brain-review/...` BEFORE it selects a block, so a
  // prompt carrying that shape at line start could not have reached ok:true.
});

test("the example's fields ARE the carried fields — no drift in either direction", () => {
  const [anchored] = readFindingsArtifact(assembleReviewPrompt({ role: ROLE, prNumber: PR })).findings;

  // Post-`sanitiseFinding`, so a field the example spells wrong has already been
  // dropped and shows up here as missing. Both directions are asserted on
  // purpose: a MISSING field means the engine is never shown how to emit it, and
  // an EXTRA one cannot survive the projection, so its absence proves the
  // example was written against the real list rather than beside it.
  assert.deepEqual(
    Object.keys(anchored).sort(),
    [...CARRIED_FIELDS].sort(),
    'the anchored example must exercise every carried field — when CARRIED_FIELDS grows, ' +
      'this dies until the example grows with it, which is the review the boundary wants to force'
  );
});

test('the un-anchored example carries no anchor — the two cases are distinct', () => {
  const [, unanchored] = readFindingsArtifact(assembleReviewPrompt({ role: ROLE, prNumber: PR })).findings;

  assert.equal(unanchored.file, undefined, 'the second example must not anchor');
  assert.equal(unanchored.line, undefined, 'the second example must not anchor');
  assert.ok(unanchored.evidence, 'and it is still a real finding, not a placeholder');
});

test('the field list handed to the engine is DERIVED from CARRIED_FIELDS', () => {
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });

  // Parsed back out of the prompt rather than asserted member-by-member. A
  // membership loop over CARRIED_FIELDS would compare the list to itself and
  // survive the mutation that matters — replacing the interpolation with a
  // literal that has since gone stale. Reading the rendered list back does not:
  // a stale literal parses to a set that is no longer CARRIED_FIELDS.
  const rendered = [...prompt.matchAll(/^ {2}- ([a-z_]+)$/gm)].map((m) => m[1]);

  assert.deepEqual(
    rendered,
    [...CARRIED_FIELDS],
    'the enumerated field list must be interpolated from CARRIED_FIELDS, in its order'
  );
});

/** Reads one `· `<name>` … one of: a | b | c` line back out of the prompt. */
function renderedVocabulary(prompt, name) {
  const line = prompt.split('\n').find((l) => l.startsWith(`  \u00b7 \`${name}\``));
  assert.ok(line, `the prompt must render a vocabulary line for \`${name}\``);
  const [, values] = line.match(/ one of: (.+)$/) ?? [];
  assert.ok(values, `\`${name}\`'s line must end in its value set`);
  return values.split(' | ');
}

test('cold-4: the prompt names the FORCED evidence class, not the menu', () => {
  // This test used to require the whole `ALLOWED_EVIDENCE_CLASSES` vocabulary in
  // the prompt, and that was the right rule applied to the wrong field
  // (judgment:cold-4, third cold review). `evaluateInferential` overwrites
  // `evidence_class` unconditionally, so rendering the menu offered the engine a
  // choice that was discarded — and discarded UPWARDS: an honest `insufficient`,
  // which `controls.mjs` defines as NOT_A_CONTROL, came out as a control class
  // the verdict then declared applied.
  //
  // The derivation rule still holds; only its source moved. The prompt reads
  // `FORCED_EVIDENCE_CLASS` from the evaluator that decides it, so a literal here
  // could not drift from the value actually written.
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });
  assert.match(prompt, new RegExp(`ALWAYS \\\`${FORCED_EVIDENCE_CLASS}\\\``));
  assert.ok(
    ALLOWED_EVIDENCE_CLASSES.includes(FORCED_EVIDENCE_CLASS),
    'the forced value must still be a class the reader accepts',
  );
});

test('cold-4: the prompt does NOT offer a class the evaluator would overwrite', () => {
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });
  for (const cls of ALLOWED_EVIDENCE_CLASSES.filter((c) => c !== FORCED_EVIDENCE_CLASS)) {
    assert.ok(
      !prompt.includes(`\`${cls}\``),
      `the prompt offers \`${cls}\`, which evaluateInferential rewrites — offering a choice ` +
      'that is discarded is the shape assemble-review-prompt.mjs\'s own header forbids',
    );
  }
});

// ── #682 cold review, judgment:cold-9 ────────────────────────────────────────
//
// The prompt documented `causal_disposition` as a field the engine may state.
// It is not in CARRIED_FIELDS, so `sanitiseFinding` dropped every stated one at
// the boundary — the exact defect this module's header claims derivation
// prevents, committed by this module.
//
// THE OLD ORACLES COULD NOT SEE IT, and the reason is one direction:
// `RENDERED_ALWAYS` checks that every CARRIED field renders, and the
// field-list test reads back the enumerated `  - name` block. Neither looks at
// the PROSE bullets, and neither asks the converse question — is every field
// this prompt names actually one the reader carries? A field named there and
// nowhere in CARRIED_FIELDS is invisible to both. This test asks the converse.

test('#682 cold-9: every field the prompt names is carried, a vocabulary value, or REFUSED', () => {
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });

  // THE FIRST CUT OF THIS TEST WAS BLIND ALONG THE POSITION AXIS, and the
  // second cold review measured it: it matched `^ {2}· \`name\`` — the field
  // name in LEADING position — which is every bullet EXCEPT the refusal this
  // very fix added. It saw 5 of 6. So a new bullet reading
  // "· When it matters, state \`risk_score\`" asked the engine for a field
  // `sanitiseFinding` drops, and no oracle in this file could see it: cold-9's
  // exact defect, reintroduced under another name. The `named.length > 0`
  // vacuity guard did not help — the other five kept it satisfied.
  //
  // Position is not the invariant. Every backticked identifier in the field
  // spec must be ACCOUNTED FOR: carried by the reader, a value from a rendered
  // vocabulary, or refused out loud. Anything else is the prompt naming a
  // field nothing downstream honours.
  const start = prompt.indexOf('  · ');
  const end = prompt.indexOf('## The empty case');
  assert.ok(start > 0 && end > start, 'the field-spec section must still be findable — otherwise this test is vacuous');

  const tokens = [...new Set([...prompt.slice(start, end).matchAll(/`([a-z_]+)`/g)].map((m) => m[1]))];
  assert.ok(tokens.length >= CARRIED_FIELDS.length, 'the section must still name the carried fields');

  const vocabulary = [
    ...SEVERITY_VALUES(prompt),
    ...ALLOWED_EVIDENCE_CLASSES,
  ];
  const accounted = new Set([...CARRIED_FIELDS, ...vocabulary, ...REFUSED_FIELDS]);
  const strays = tokens.filter((t) => !accounted.has(t));

  assert.deepEqual(
    strays, [],
    `the prompt names ${JSON.stringify(strays)} — neither carried by the reader, nor a vocabulary ` +
    'value, nor declared in REFUSED_FIELDS. Asking an engine for a field sanitiseFinding drops is ' +
    'the defect this module exists to prevent; refusing one is fine, but the refusal must be declared.'
  );
});

test('#682 cold-9: nothing is both carried and refused', () => {
  // REFUSED_FIELDS is what makes the test above non-vacuous, so it needs its
  // own reader: listing a CARRIED field there would silently widen `accounted`
  // and let a real stray through under its cover.
  const both = REFUSED_FIELDS.filter((f) => CARRIED_FIELDS.includes(f));
  assert.deepEqual(
    both, [],
    `${JSON.stringify(both)} is declared refused AND carried — the prompt would be telling the engine ` +
    'not to state a field the reader honours'
  );
  assert.ok(REFUSED_FIELDS.length > 0, 'an empty refusal list makes the accounting test weaker, not stronger');
});

test('#682 cold-9: the prompt tells the engine NOT to state a disposition, and says why', () => {
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });

  // Silence is not enough. Removing the bullet leaves a prompt that says
  // nothing about the field, and an engine that carries the habit from another
  // protocol still emits it — the finding is then dropped without either side
  // knowing. The prompt has to REFUSE it out loud.
  assert.match(
    prompt, /You do NOT state `causal_disposition`/,
    'the field must be refused explicitly, not merely left undocumented'
  );
  assert.match(
    prompt, /grading its own admissibility/,
    'and the reason must travel with the refusal — a rule without its reason is one a future edit deletes'
  );
  // The reason must be the TRUE one. The first cut said the disposition is
  // "MEASURED against the base, not claimed"; the second cold review measured
  // that `classifyAgainstBase` only inspects `^gate:` ids and returns a
  // `judgment:*` finding untouched, so nothing re-measures it and the sentence
  // promised a safety net that does not exist.
  assert.doesNotMatch(
    prompt, /MEASURED against the base/,
    'the refusal must not claim a downstream measurement — classifyAgainstBase never inspects a producer finding'
  );

  // The converse, and it is the load-bearing half: whatever the prose says, the
  // field must not be in the carried set. If a later change adds it there, this
  // prompt's refusal becomes a lie and a producer can de-block its own findings
  // by declaring them pre-existing (verdict.mjs routes them into follow_ups,
  // and annotateDeterministicFindings spreads `...f` last, so the producer wins).
  assert.ok(
    !CARRIED_FIELDS.includes('causal_disposition'),
    'causal_disposition entered CARRIED_FIELDS — a producer can now grade its own admissibility'
  );
});

test('severity has no constant, so the PROTOCOL DOCUMENT is its reader', () => {
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });

  // The one vocabulary the prompt states as a literal, because no
  // `ALLOWED_SEVERITIES` exists to derive it from. Rather than leave it
  // unchecked — or invent a constant no validator reads, which is the defect
  // this module exists to avoid — it is compared against the place the
  // vocabulary is actually written down.
  const protocol = readFileSync(
    new URL('../../../core/methodology/reviewer-protocol.md', import.meta.url),
    'utf8'
  );
  const declared = [...protocol.matchAll(/^\s*severity: (blocker.*)$/gm)].map((m) => m[1].trim());
  assert.ok(declared.length > 0, 'reviewer-protocol.md must declare the severity vocabulary');
  assert.ok(
    declared.every((d) => d === declared[0]),
    'and must declare it consistently — a document disagreeing with itself has no answer to give'
  );

  assert.deepEqual(
    renderedVocabulary(prompt, 'severity'),
    declared[0].split(' | '),
    'the prompt\'s severity set must match reviewer-protocol.md\'s'
  );
});

test('the prompt carries no posted-verdict shape — proved, not asserted in a comment', () => {
  // The round-trip test's comment claims this is covered "without a second
  // assertion", because the reader checks the posted family before selecting a
  // block. A coverage claim in a comment is the exact defect class this ticket
  // keeps finding, so it is executed here instead: inject the shape and require
  // the round-trip to refuse.
  const poisoned = assembleReviewPrompt({ role: ROLE, prNumber: PR }).replace(
    '## What you may use',
    'protocol: brain-review/2\n\n## What you may use'
  );
  const result = readFindingsArtifact(poisoned);

  assert.equal(result.ok, false, 'a prompt carrying the posted family must not read as an artifact');
  assert.match(result.reason, /anti-loop lock/, 'and must say why');
});

test('the empty case the prompt describes is one the reader accepts', () => {
  // TWO SEPARATE CLAIMS, because the first cut asserted only the second and its
  // message claimed both. Measured: inverting the instruction to "if you find
  // nothing, omit the file" left this test GREEN — it was replacing the example
  // block with `[]` itself, so it never read the sentence it said it executed.
  // The engine would have been told to signal "found nothing" by producing the
  // one state that reads as "never ran".
  //
  //   1. THE INSTRUCTION says to write the file. A string match, and nothing
  //      more — it cannot prove the engine obeys, only that the sentence has not
  //      been deleted or inverted.
  //   2. THE SHAPE it describes parses as the distinct empty state. Executed
  //      against the real reader.
  //
  // Neither half substitutes for the other: an instruction nobody can parse and
  // a parseable shape nobody is told to write both fail REQ-S3-4 silently.
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });

  assert.ok(
    prompt.includes('write the file with an empty array'),
    'the role must tell the engine to WRITE the empty artifact — an omitted file reads as "never ran"'
  );
  const emptied = prompt.replace(/(```brain-findings\/1\n)[\s\S]*?(\n```)/, '$1[]$2');
  assert.notEqual(emptied, prompt, 'the example block must be replaceable — otherwise this tests nothing');

  const result = readFindingsArtifact(emptied);
  assert.equal(result.ok, true, `the empty artifact must READ, not fail — ${result.reason ?? ''}`);
  assert.deepEqual(result.findings, [], 'and must be empty rather than absent');
});

test('the artifact path is the one the reader will look at', () => {
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });

  // The single highest-cost silent failure available here: an engine that writes
  // a perfect artifact to a path nobody reads produces "missing", which renders
  // identically to "the stage never ran".
  assert.ok(
    prompt.includes(artifactPathFor(PR)),
    'the prompt must name artifactPathFor(prNumber) — a hardcoded path sends the run to a file nobody reads'
  );
});

test('a PR number that is not one is refused, not defaulted', () => {
  for (const bad of [0, -1, 'main', '../../etc', null, undefined, 1.5]) {
    assert.throws(
      () => assembleReviewPrompt({ role: ROLE, prNumber: bad }),
      /is not a PR number/,
      `refuses ${JSON.stringify(bad)}`
    );
  }
});

test('base and head refs render a real command, and their absence renders a different one', () => {
  const withRefs = assembleReviewPrompt({ role: ROLE, prNumber: PR, baseRef: 'abc123', headRef: 'def456' });
  const without = assembleReviewPrompt({ role: ROLE, prNumber: PR });

  assert.ok(withRefs.includes('git diff abc123...def456'), 'named refs become the command');
  assert.ok(!without.includes('git diff abc123'), 'and are absent when not given');
  assert.notEqual(
    withRefs,
    without,
    'the two states must not render identically — a prompt that ignores the refs it was ' +
      'handed points the engine at whatever the working tree happens to be'
  );

  // Half-specified is the generic form, not a broken command: `git diff abc123...`
  // resolves to something, which is worse than not naming a command at all.
  const halfBase = assembleReviewPrompt({ role: ROLE, prNumber: PR, baseRef: 'abc123' });
  const halfHead = assembleReviewPrompt({ role: ROLE, prNumber: PR, headRef: 'def456' });
  assert.equal(halfBase, without, 'a base with no head falls back rather than emitting a partial range');
  assert.equal(halfHead, without, 'a head with no base falls back rather than emitting a partial range');
});

test('the engine is told it holds no credential', () => {
  // A PRESENCE CHECK on an instruction, and nothing more — it does not prove the
  // engine obeys. The guarantee that nothing posts is architectural and lives in
  // `runStage`, which holds no VCS credential at all (B.3). This assertion exists
  // so the instruction is not silently deleted from the role while that stays true.
  assert.ok(
    assembleReviewPrompt({ role: ROLE, prNumber: PR }).includes('You hold no credential'),
    'the role must state that it cannot publish'
  );
});


// ── #682 C.5's verdict, judgment:cold-7 ──────────────────────────────────────

test('#682 cold-7: the prompt warns about the two-block refusal, and the reader really refuses', () => {
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });

  // THE ONE INSTRUCTION THIS FILE CANNOT INTERPOLATE. Everything else here is
  // derived from a constant the reader uses; this constraint lives in the
  // reader's CONTROL FLOW (`found.length > 1`), so there is nothing to
  // interpolate from and it has to be written by hand — which is exactly the
  // kind of sentence that goes stale unnoticed.
  //
  // So the oracle is not "the prompt contains a string". It MEASURES the
  // reader's behaviour and requires the prompt to describe it: feed the real
  // reader an artifact with two tagged blocks and confirm it refuses, then
  // require the prompt to warn about that. If the reader ever starts tolerating
  // two blocks, the first half fails and the warning gets deleted deliberately
  // rather than becoming quietly false.
  const twoBlocks = [
    `\`\`\`${ARTIFACT_TAG}`, '[]', '```', '',
    `\`\`\`${ARTIFACT_TAG}`, '[]', '```', '',
  ].join('\n');
  const read = readFindingsArtifact(twoBlocks);

  assert.equal(read.ok, false, 'the reader must still refuse two tagged blocks — the warning below describes THIS');
  assert.match(read.reason, /expected exactly 1/);

  assert.match(
    prompt, /EXACTLY ONE fenced block/,
    'the prompt must say exactly one, not merely "one" — an engine that echoes the worked example ' +
    'produces two and burns an unrecoverable model call on a refusal it was never warned about'
  );
  assert.match(
    prompt, /do not echo the worked example/i,
    'and it must name the specific way it happens, because the example is right there in the prompt'
  );
});

// ── #814 T4: the role is an argument, and its absence is refused ────────────

test('#814 T4: no role handed in → refused, naming where roles are served from', () => {
  assert.throws(
    () => assembleReviewPrompt({ prNumber: 7 }),
    /roles\/first-party/,
    'a prompt with no role half sends an engine to work as nobody in particular',
  );
});

test('#814 T4: the served role text opens the assembled prompt VERBATIM', () => {
  const prompt = assembleReviewPrompt({ role: ROLE, prNumber: 7 });
  assert.ok(prompt.startsWith(ROLE.text), 'content first, protocol after — the split is visible in the output');
  assert.match(prompt, /## What you must produce/, 'and the protocol half is still there');
});

test('output mode switches only the delivery instruction, not the reviewer role or artifact schema', () => {
  const filePrompt = assembleReviewPrompt({ role: ROLE, prNumber: PR });
  const finalMessagePrompt = assembleReviewPrompt({ role: ROLE, prNumber: PR, outputMode: 'final-message' });

  assert.match(filePrompt, /Write exactly one file/, 'the omitted mode remains compatible with file-writing backends');
  assert.match(finalMessagePrompt, /Return exactly the artifact bytes as your final message/, 'a host-owned output transport receives bytes, not a candidate path');
  assert.ok(finalMessagePrompt.includes(`\`\`\`${ARTIFACT_TAG}`), 'the exact existing artifact schema remains in the returned-message mode');
  assert.ok(finalMessagePrompt.startsWith(ROLE.text), 'the first-party reviewer role remains verbatim');
});

// ── #1010 unit 6 — the engine must not touch the candidate tree itself ──────
//
// Measured on PR #1019's own cold review, with the #1010 fixes already in
// place: the stage correctly refused — "the cold-review candidate changed
// during execution; refusing publication — 1 path(s) changed: +scratch" —
// because the engine created a `scratch` file inside the candidate on its
// own initiative. The DETACHED CHECKOUT paragraph told it where it was, but
// never told it the tree must not be touched.

test('#1010: the DETACHED CHECKOUT paragraph forbids any write under the working directory, and only fires when there IS one to protect', () => {
  const rooted = assembleReviewPrompt({ role: ROLE, prNumber: PR, artifactRoot: '/tmp/brain-review-op' });
  assert.match(rooted, /DETACHED CHECKOUT/, 'sanity: the paragraph under test is present');
  assert.match(rooted, /snapshotted/i, 'the prompt must say the tree is snapshotted before and after the run');
  assert.match(rooted, /refuses publication/i, 'and that ANY changed path refuses the WHOLE review, not just the changed file');
  assert.match(rooted, /no scratch files/i, 'the rule must be concrete about what "touch nothing" means, not merely abstract');
  assert.match(rooted, /OS temp dir/i, 'the prompt must give the engine a legal place for scratch space instead of the candidate');

  const plain = assembleReviewPrompt({ role: ROLE, prNumber: PR });
  assert.doesNotMatch(plain, /DETACHED CHECKOUT/, 'no artifactRoot means no detached-checkout paragraph at all');
  assert.doesNotMatch(plain, /snapshotted/i, 'and so no dangling reference to a snapshot rule with nothing above it to anchor it');
});
