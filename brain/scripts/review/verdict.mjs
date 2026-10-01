// verdict.mjs — REQ-H1-4, REQ-H1-6: the `brain-review/1` verdict builder.
// Pure (no seams, design.md §5) — enforces the §6 hard rules + §7 rev>=3
// bound as BUILD-TIME invariants. The only place a block is constructed.

import {
  validateSchemaV2,
  ALLOWED_EVIDENCE_CLASSES,
  ALLOWED_CAUSAL_DISPOSITIONS,
} from './lib/schema-v2.mjs';
import { complementControls } from './lib/controls.mjs';

const YAML_SCALAR_SAFE_RE = /^[A-Za-z0-9._\-/:]+$/;

/**
 * Is this finding's anchor USABLE — a non-empty path and a line that exists in a
 * diff? Diff lines are 1-based, so `0`, `''`, `'abc'`, `2.5` and `-3` are all
 * anchors already known not to attach. `Number()` because `parseVerdict` returns
 * entry scalars as text: a round-tripped `line` arrives as `'42'`.
 *
 * Exported and shared with `poster.mjs`'s `deriveInlineComments` ON PURPOSE. The
 * renderer's rule and the poster's were byte-identical duplicates until round 10
 * of PR #490's review tightened the poster's alone — leaving the block advertising
 * `line: 0` anchors the poster then refused, which is the exact state the
 * round-8 test forbids, one field-value class over. Two copies of one rule drift;
 * one function cannot.
 *
 * @param {{file?: string, line?: unknown}} f
 * @returns {boolean}
 */
export function hasUsableAnchor(f) {
  const line = Number(f?.line);
  return Boolean(f?.file) && Number.isInteger(line) && line >= 1;
}

/**
 * Emits a value as a YAML scalar. `parse-verdict.mjs`'s `unyamlScalar` is its
 * exact inverse — change one and the other moves in the same commit.
 *
 * Line breaks are ESCAPED, not merely quoted (issue #481, ruled in scope for
 * #452). A quoted scalar containing a RAW newline puts its continuation lines
 * at column 0, which terminates the findings list. Measured through the real
 * chain: a two-finding verdict whose first `evidence:` carried multi-line
 * command stdout — exactly what `checkpoint.mjs` interpolates from
 * `brain-governance-status` — re-parsed to ONE finding, silently dropping a
 * blocker. `\r` is escaped for the same reason: CRLF content would otherwise
 * leave a stray carriage return inside a parsed value.
 *
 * Order matters — backslashes first, so the escapes introduced after are not
 * themselves re-escaped.
 */
function yamlScalar(val) {
  if (val === null || val === undefined) return 'null';
  const s = String(val);
  if (s === '' || !YAML_SCALAR_SAFE_RE.test(s)) {
    return `"${s
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\r/g, '\\r')
      .replace(/\u2028/g, '\\u2028')
      .replace(/\u2029/g, '\\u2029')}"`;
  }
  return s;
}

// Evidence gate (drops findings without `evidence:`) + cites gate (an
// uncited blocker downgrades to `correction` — never invents a citation, §5).
//
// ISSUE #483 ruling point 4 put this gate in scope, offering two exits: adopt
// the schema gate's annotate-and-surface shape, or justify the silent drop in
// writing. The DROP is justified and stays: protocol §5 rules a finding
// without a command the reviewer ran cold **inadmissible** — it is not a
// finding at all, which is a different thing from a finding whose causal claim
// cannot be read (that one is real, established, and merely unreadable — hence
// annotated instead). The SILENCE is not justified, and is what changes here:
// the count is returned so `buildVerdict` can surface it. "No findings" and
// "findings discarded" must not look identical to the reader — that is the
// `evidence-reader-empty-on-failure` shape, one function over.
function processFindings(findings = []) {
  const admissible = findings.filter(f => Boolean(f?.evidence));
  return {
    findings: admissible.map(f => (f.severity === 'blocker' && !f.cites ? { ...f, severity: 'correction' } : f)),
    inadmissible: findings.length - admissible.length,
  };
}

/**
 * The reason a finding's causal claim cannot be read, or `null` if it can.
 *
 * The gate fires on a claim that FAILS validation, never on a claim that was
 * not made. That distinction is load-bearing and is what the scope is built
 * around: protocol §6.2 states the two causal fields are "optional in the
 * sense that a `/1` verdict simply omits them", and rendering is "when
 * present". Treating an absent field as invalid would mark every legacy
 * finding — and every `/2` finding built without passing through
 * `annotateDeterministicFindings` — as schema-invalid, which is a presence
 * requirement neither the protocol nor the #483 ruling asks for.
 *
 * So:
 * - Neither field present → no claim to read. Routes as it always has.
 * - BOTH present → `validateSchemaV2`'s exact contract, called directly. This
 *   is the shape `annotateDeterministicFindings` always produces, i.e. every
 *   real `/2` finding, which is what makes the wiring (issue #483's actual
 *   deliverable) real rather than nominal.
 * - Exactly one present → a PARTIAL claim. Validated against the same exported
 *   allow-list `validateSchemaV2` uses, because `buildVerdict`'s routing loop
 *   is protocol-agnostic: it routes on `causal_disposition` whatever the
 *   protocol string says, so a lone typo'd disposition steers a real routing
 *   decision and ruling point 2 binds that decision to a validated value.
 */
function causalClaimFault(f) {
  const hasClass = f?.evidence_class !== undefined;
  const hasDisposition = f?.causal_disposition !== undefined;

  if (!hasClass && !hasDisposition) return null;

  if (hasClass && hasDisposition) {
    const result = validateSchemaV2(f);
    return result.valid ? null : result.reason;
  }

  if (hasClass && !ALLOWED_EVIDENCE_CLASSES.includes(f.evidence_class)) {
    return `invalid evidence_class: ${f.evidence_class}. Allowed: ${ALLOWED_EVIDENCE_CLASSES.join(', ')}`;
  }
  if (hasDisposition && !ALLOWED_CAUSAL_DISPOSITIONS.includes(f.causal_disposition)) {
    return `invalid causal_disposition: ${f.causal_disposition}. Allowed: ${ALLOWED_CAUSAL_DISPOSITIONS.join(', ')}`;
  }
  return null;
}

// Schema gate (issue #483, maintainer ruling option 3 — downgrade + annotate).
// A finding whose causal claim fails validation is NEVER dropped and NEVER
// silently reclassified: it carries `schema_invalid` (the validator's own
// reason, so the human reading the block is told WHAT failed, not merely that
// something did) and the routing loop below refuses to read its disposition.
function applySchemaGate(findings) {
  return findings.map((f) => {
    const fault = causalClaimFault(f);
    return fault ? { ...f, schema_invalid: fault } : f;
  });
}

/** Pure builder. Throws when `headSha` is absent (protocol §6 — no headless
 * verdict). `priorRevCount` = count of prior blocks; at `rev >= 3` a REVISE
 * conclusion becomes `STOP` + `escalate:human` (protocol §7, REQ-H1-6). */
export function buildVerdict({
  headSha,
  conclusion,
  // #750 — fail-closed default. `['blocker']` would be the CONVENIENT
  // default and is exactly wrong: an evaluator (or legacy caller) that
  // declares nothing must not be softened, silence fails closed by
  // construction, not by luck.
  conclusionCauses = [],
  protocol = 'brain-review/1',
  controls = [],
  judgmentAxis = null,
  priorRevCount = 0,
  findings = [],
  gates = {},
  conditions = [],
  pin,
  sequencing,
  escalate = null,
  rulingAtHead = false,
} = {}) {
  if (!headSha) throw new Error('brain-review/1: head_sha is mandatory — refusing to build a headless verdict.');

  const { findings: admitted, inadmissible } = processFindings(findings);
  const processed = applySchemaGate(admitted);
  const candidateFindings = [];
  const followUps = [];
  let unknownCausality = false;

  for (const f of processed) {
    // #483 ruling point 2: routing happens only on values that passed
    // validation. An unreadable disposition is not routed on its merits at
    // all — it lands in `findings` and forces the escalation, because protocol
    // §6.2 already rules that "any finding whose causality could not be
    // determined forces verdict: STOP and escalate: human ... never silently
    // admitted ... nor silently dropped". A disposition the validator cannot
    // read IS causality that could not be determined; the near-miss spelling
    // of `unknown` is the case that makes this concrete — it loses the whole
    // escalation without this branch.
    if (f.schema_invalid) {
      unknownCausality = true;
      candidateFindings.push(f);
      continue;
    }
    const disp = f.causal_disposition;
    if (disp === 'unknown') {
      unknownCausality = true;
      candidateFindings.push(f);
    } else if (disp === 'pre-existing' || disp === 'base-only') {
      followUps.push(f);
    } else {
      candidateFindings.push(f);
    }
  }

  // #682 — THE CONCLUSION IS RAISED BEFORE ANYTHING READS IT, and the ordering
  // is the whole of the fix. Round 2 measured what the first cut cost:
  //
  //   · §7's bound was DISARMED. `boundHit` reads `conclusion`, so raising
  //     afterwards meant a fourth REVISE never hit the bound: a corroborated
  //     reasoned blocker at `priorRevCount: 4` rendered `REVISE / escalate:
  //     null` where the pre-fix placement rendered `STOP / escalate: human`.
  //     §7 says no infinite revise loop is possible BY CONSTRUCTION — the
  //     construction was this order.
  //
  // It cannot move to `cli.mjs` either, which was the other candidate: the
  // blocking set does not exist there. Routing by `causal_disposition`, the
  // cites gate that downgrades an uncited blocker, and the inadmissible drop
  // all happen below, so a raise upstream would fire on findings these gates
  // then remove.
  //
  // So: here, and FIRST. `candidateFindings` is the set after routing, and
  // `blockerRemains` is the house rule (`REVISE iff a blocker exists`,
  // tranche.mjs) evaluated on the state a reader of this verdict will see.
  const blockerRemains = candidateFindings.some((f) => f.severity === 'blocker');
  const raisedConclusion = (blockerRemains && conclusion !== 'REVISE' && conclusion !== 'STOP')
    ? 'REVISE'
    : conclusion;

  // #506 — `priorRevCount` is now the count AT THIS HEAD (see verdictsAtHead), so
  // the bound measures what §7 means: iterations on one disagreement, not how many
  // times the reviewer was invoked over a long-lived PR's life.
  //
  // `rulingAtHead` is the exit. A human summoned by the escalation posts a
  // `brain-decision/1` block via `brain:approve`, bound to this head; that clears
  // the count-based escalation. It deliberately does NOT clear `unknownCausality`:
  // that escalation says "the reviewer cannot determine whether this finding is
  // caused by the diff", which a ruling on iteration count does not answer. Two
  // escalations, two questions, and only one of them is about going around in circles.
  const boundHit = priorRevCount >= 3 && raisedConclusion === 'REVISE' && !rulingAtHead;
  const shouldEscalate = boundHit || unknownCausality;
  const finalEscalate = shouldEscalate ? 'human' : escalate;

  // CHAIN REVIEW — a verdict may not APPROVE while it ESCALATES.
  //
  // Measured on the shipped chain: a reasoned blocker with no `cites` is a
  // BLOCKER when `evaluateRefuter` picks its batch (`severity === 'blocker'`,
  // inside `applyCausalAdmission`) and a CORRECTION by the time the conclusion
  // is computed, because the evidence drop and the uncited downgrade run later,
  // in this function. So `blockerRemains` never raises — while the challenge's
  // `escalate: 'human'` and its "N inferential blocker(s) were NOT challenged"
  // condition both survive into an APPROVE.
  //
  // Two links disagreeing about what a blocker IS. No per-PR review could see
  // it: the batch selection ships in one slice and the conclusion derivation in
  // another.
  //
  // The rule is coherence, not a patch for that one route: escalation means a
  // person must look, APPROVE means nothing blocks, and a reader cannot hold
  // both. `unknownCausality` and `boundHit` already force STOP for the same
  // reason; the refuter's escalation had no such rule and needed one.
  const escalates = finalEscalate === 'human';

  // #750 — the length check is HALF the rule, not padding.
  // `[].every(c => c === 'blocker')` is vacuously `true` in JavaScript, so
  // without `conclusionCauses.length > 0` a caller that declares NO cause
  // would soften exactly like one that declared 'blocker' — the same
  // silent-approve trap #483 came to fix, wearing a new field's name.
  const causeIsBlockerOnly = conclusionCauses.length > 0 && conclusionCauses.every((c) => c === 'blocker');

  let finalVerdict = raisedConclusion;
  if (boundHit || unknownCausality) {
    finalVerdict = 'STOP';
  } else if (escalates && raisedConclusion === 'APPROVE') {
    // The coherence rule stated above. It sits BEFORE the softening on purpose:
    // an escalating verdict must not be softened into an APPROVE either.
    finalVerdict = 'REVISE';
  } else if (protocol === 'brain-review/2' && processed.length > 0 && candidateFindings.length === 0 && raisedConclusion === 'REVISE' && !escalates && causeIsBlockerOnly) {
    // #483: `processed.length`, not `findings.length`. The softening means
    // "every finding that exists was routed OUT of the blocking set by the
    // admission rule". Measured against the raw input, a verdict whose
    // findings were all DROPPED as inadmissible satisfies it vacuously and
    // softens REVISE to APPROVE on the strength of findings nobody ever read —
    // fail-open, from the same silent drop this ticket came to fix.
    //
    // #682 round 1 widened this to `!blockerRemains` and round 2 REVERTED it,
    // because the widening was both unnecessary and harmful. `checkpoint.mjs`
    // derives REVISE from three causes and only one is "a blocker exists"; the
    // third is §10's uncomputable-evidence rule. Under the widening, a verdict
    // carrying `conditions: ["evidence uncomputable: …"]` rendered APPROVE —
    // the verdict approving while declaring it could not compute its evidence,
    // which is §10 exactly inverted.
    //
    // And it was unnecessary: the case it was written for (a REFUTED claim
    // leaving REVISE) came from the PRE-challenge flip in `cli.mjs`, which is
    // gone. With the raise computed from the post-challenge set, a refuted
    // claim never raises in the first place, so there is nothing to soften.
    finalVerdict = 'APPROVE';
  }

  // #483 point 4: the inadmissible drop is protocol §5 and stays, but it is
  // reported. Appended, never mutated in place — the caller owns its list.
  const finalConditions = inadmissible > 0
    ? [...conditions, `${inadmissible} finding(s) dropped: no evidence (inadmissible, protocol §5)`]
    : conditions;

  return {
    protocol,
    controls,
    judgmentAxis,
    verdict: finalVerdict,
    head_sha: headSha,
    rev: priorRevCount + 1,
    gates: { required: gates.required ?? [], detection: gates.detection ?? [] },
    findings: candidateFindings,
    follow_ups: followUps,
    conditions: finalConditions,
    pin,
    sequencing,
    escalate: finalEscalate,
  };
}

// Renders a built verdict as the fenced brain-review/1 or brain-review/2 YAML block (§6).
// Hand-rolled — zero npm deps and this schema is fixed, not generic YAML.
export function renderVerdict(v) {
  const proto = v.protocol ?? 'brain-review/1';
  const lines = [
    '```yaml',
    `protocol: ${proto}`,
    `verdict: ${v.verdict}`,
    `head_sha: ${v.head_sha}`,
    `rev: ${v.rev}`,
    'gates:',
    `  required: [${v.gates.required.map(yamlScalar).join(', ')}]`,
    `  detection: [${v.gates.detection.map(yamlScalar).join(', ')}]`,
  ];

  if (v.findings.length === 0) {
    lines.push('findings: []');
  } else {
    lines.push('findings:');
    for (const f of v.findings) {
      lines.push(`  - id: ${yamlScalar(f.id)}`);
      lines.push(`    severity: ${yamlScalar(f.severity)}`);
      lines.push(`    evidence: ${yamlScalar(f.evidence)}`);
      if (f.cites) lines.push(`    cites: ${yamlScalar(f.cites)}`);
      if (f.evidence_class) lines.push(`    evidence_class: ${yamlScalar(f.evidence_class)}`);
      if (f.causal_disposition) lines.push(`    causal_disposition: ${yamlScalar(f.causal_disposition)}`);
      // #483 ruling point 3: the marker is rendered, or it does not exist. A
      // marker only the code can see leaves the human reading the block with
      // the same unqualified `causal_disposition:` line the gate exists to
      // distrust. Rendered HERE only, and deliberately not in the follow_ups
      // loop below: a schema-invalid finding is routed to `findings[]` by the
      // gate itself and can never reach `follow_ups[]`, so emitting it there
      // would be render code no input can reach.
      if (f.schema_invalid) lines.push(`    schema_invalid: ${yamlScalar(f.schema_invalid)}`);
      // #552, applying #483 ruling point 3 to the marker it missed: a marker only
      // the code can see does not exist. Measured before this landed — a reasoned
      // blocker the refuter had CORROBORATED and one no refuter ever saw rendered
      // BYTE-IDENTICALLY, because `refuter_outcome` was set on the finding and
      // never emitted. The severity downgrade on `refuted` was visible; the reason
      // for it was not, which is the same defect one field over.
      //
      // Emitted in BOTH loops, unlike `schema_invalid` above, and that asymmetry is
      // measured rather than assumed: `classifyAgainstBase` runs BEFORE the refuter
      // and only sets `causal_disposition`, so a finding can be an inferential
      // blocker, be reclassified `pre-existing`, be refuted, and then be routed to
      // `follow_ups[]` by buildVerdict. Rendering it in one loop only would drop the
      // marker exactly where the finding was weakest.
      if (f.refuter_outcome) lines.push(`    refuter_outcome: ${yamlScalar(f.refuter_outcome)}`);
      if (f.refuted) lines.push(`    refuted: ${yamlScalar(f.refuted)}`);
      if (f.refuter_rationale) lines.push(`    refuter_rationale: ${yamlScalar(f.refuter_rationale)}`);
      // The inline-comment anchor (issue #405, REQ-405-2). BOTH optional, and
      // emitted only when the pair is USABLE — see `hasUsableAnchor`. Not "when
      // present": a finding carrying `line: 0` or `line: 'abc'` has them and gets
      // neither, because a block that advertises an anchor the poster refuses is
      // the same defect read from the emitting end. A finding without them renders
      // exactly as it does today — that is what keeps the feature additive for every
      // evaluator shipping now. Through yamlScalar like every other scalar (`line` after the coercion, so the block carries the same integer the wire does).
      if (hasUsableAnchor(f)) {
        lines.push(`    file: ${yamlScalar(f.file)}`);
        lines.push(`    line: ${yamlScalar(Number(f.line))}`);
      }
    }
  }

  if (v.follow_ups && v.follow_ups.length > 0) {
    lines.push('follow_ups:');
    for (const f of v.follow_ups) {
      lines.push(`  - id: ${yamlScalar(f.id)}`);
      lines.push(`    severity: ${yamlScalar(f.severity)}`);
      lines.push(`    evidence: ${yamlScalar(f.evidence)}`);
      if (f.cites) lines.push(`    cites: ${yamlScalar(f.cites)}`);
      if (f.evidence_class) lines.push(`    evidence_class: ${yamlScalar(f.evidence_class)}`);
      if (f.causal_disposition) lines.push(`    causal_disposition: ${yamlScalar(f.causal_disposition)}`);
      // #552 — same marker, same reason. See the findings loop above for why this
      // one is NOT the `schema_invalid` case: a refuted finding CAN reach here.
      if (f.refuter_outcome) lines.push(`    refuter_outcome: ${yamlScalar(f.refuter_outcome)}`);
      if (f.refuted) lines.push(`    refuted: ${yamlScalar(f.refuted)}`);
      if (f.refuter_rationale) lines.push(`    refuter_rationale: ${yamlScalar(f.refuter_rationale)}`);
      // The inline-comment anchor (issue #405, REQ-405-2). BOTH optional, and
      // emitted only when the pair is USABLE — see `hasUsableAnchor`. Not "when
      // present": a finding carrying `line: 0` or `line: 'abc'` has them and gets
      // neither, because a block that advertises an anchor the poster refuses is
      // the same defect read from the emitting end. A finding without them renders
      // exactly as it does today — that is what keeps the feature additive for every
      // evaluator shipping now. Through yamlScalar like every other scalar (`line` after the coercion, so the block carries the same integer the wire does).
      if (hasUsableAnchor(f)) {
        lines.push(`    file: ${yamlScalar(f.file)}`);
        lines.push(`    line: ${yamlScalar(Number(f.line))}`);
      }
    }
  }

  lines.push(`conditions: [${(v.conditions ?? []).map(yamlScalar).join(', ')}]`);
  // #683 — WHICH CLASSES OF CONTROL RAN, always emitted, `[]` included.
  //
  // Never omitted when empty: an absent key is the silence this field exists to
  // break, and `controls: []` reads as "nothing declared that it ran" — loud,
  // and true of a verdict built without a declaration.
  //
  // JSON-encoded rather than through `yamlScalar`, and that is not cosmetic:
  // `yamlScalar('deterministic')` renders it BARE, and a bare word is not JSON,
  // so `parseEntryList`'s inline branch would answer UNREADABLE and the field
  // could not round-trip. Measured, not assumed — the same shape `pin` and
  // `sequencing` already use for the same reason.
  lines.push(`controls: [${(v.controls ?? []).map((c) => JSON.stringify(c)).join(', ')}]`);
  // #690 — the other half, and the half that closes #575 Ruling 3's word "only".
  //
  // The line above says what ran. On its own it needs the reader to know the
  // vocabulary is closed, know which member is missing, and notice the absence —
  // absence carrying the meaning, which is what this whole field exists to stop.
  //
  // DERIVED from the same closed list, never a second one: a hand-maintained
  // "did not run" list drifts from CONTROL_CLASSES the first time either changes.
  // It shrinks to [] by itself the day #682's evaluator runs.
  lines.push(`controls_not_applied: [${complementControls(v.controls ?? []).map((c) => JSON.stringify(c)).join(', ')}]`);

  // REQ-682-3 — the axis that challenged the reasoned findings, on the wire.
  //
  // Emitted ONLY when a reasoned finding exists, for #690's reason: a constant
  // that fires on every verdict turns its channel into wallpaper, and an axis
  // that challenged nothing is not evidence about this verdict.
  //
  // Without it two verdicts render byte-identically when one was challenged by
  // the same model and the other by a different family — two evidentiary
  // strengths, one rendering, produced by a configuration option. That is #683's
  // rule one field over: a same-model-challenged verdict must not read like a
  // cross-family-challenged one.
  if (v.judgmentAxis && (v.findings ?? []).some((f) => f.evidence_class === 'inferential')) {
    lines.push(`challenger_axis: ${yamlScalar(v.judgmentAxis)}`);
  }
  if (v.pin) lines.push(`pin: ${yamlScalar(JSON.stringify(v.pin))}`);
  if (v.sequencing) lines.push(`sequencing: ${yamlScalar(JSON.stringify(v.sequencing))}`);
  lines.push(`escalate: ${v.escalate ?? 'null'}`, '```');

  return lines.join('\n');
}
