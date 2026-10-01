// ruling.mjs — REQ-H1-11: the ruling evaluator. Option (B) (owner ruling,
// issue #266 comment 5009584044): the reviewer NEVER auto-rules. It is a
// structure validator + conservative escalator, never an ADR-writer.
//
// The protocol §5 elimination path ("enumerate authorities, eliminate
// options citing each, rule ONLY if exactly one survives") does NOT exist in
// this deterministic evaluator. A structurally valid `## FORK` (>=2 options,
// each with cost+consequence, plus a recommendation) ALWAYS escalates —
// `STOP` + `escalate: 'human'` — regardless of how many options an
// elimination pass would leave standing. Rationale (binding, from the
// ruling): auto-ruling on unrefuted inferential eliminations is authority
// laundering (finding H14-FORK-LAUNDERING) — in H1 the human is at the
// keyboard, so escalation costs ~0. The elimination-annotation format
// (option -> excluding authority) and any citation resolver that would let a
// future evaluator actually RULE (protocol §5 option (A)) are OUT OF SCOPE,
// gated on issue #266 #284.
//
// Mirrors the tranche/checkpoint DI-seam house style (D1): a pure
// `evaluateRuling(inputs)` core + `gatherRulingInputs(deps)`. There is no
// server round trip here — the ## FORK section lives in the PR body cold
// boot already fetched — so `gatherRulingInputs` is a thin pass-through,
// kept for shape parity with tranche/checkpoint and so #284 can extend it
// without reshaping the call site.

const FORK_HEADING_RE = /^##\s+FORK\b/i;
// "### Option <id>" (heading form) or "- Option <id>" / "* Option <id>"
// (list-equivalent form) — both are accepted per the minimal contract.
const OPTION_START_RE = /^(?:###\s+Option\s+(.+?)|[-*]\s+\**Option\s+(.+?)\**:?)\s*$/i;
const COST_RE = /^\s*[-*]?\s*cost:\s*(.+)$/im;
const CONSEQUENCE_RE = /^\s*[-*]?\s*consequence:\s*(.+)$/im;
const RECOMMENDATION_RE = /^\s*[-*]?\s*Recommendation:\s*(.+)$/gim;

/**
 * Parses the PR body's `## FORK` section against the minimal contract
 * (REQ-H1-11): a `## FORK` heading, >=2 `### Option <id>` (or list-
 * equivalent) blocks each carrying `cost:` + `consequence:`, and exactly one
 * `Recommendation:` line. Returns `{ valid:false, reason }` on any
 * malformation, or `{ valid:true, fork, options, recommendation }`.
 *
 * @param {string} prBody
 * @returns {{valid:boolean, reason?:string, fork?:string, options?:Array<{id:string,cost:string,consequence:string}>, recommendation?:string}}
 */
export function parseFork(prBody = '') {
  const body = prBody ?? '';
  const lines = body.split('\n');
  const headingIdx = lines.findIndex((l) => FORK_HEADING_RE.test(l.trim()));
  if (headingIdx === -1) {
    return { valid: false, reason: 'PR body has no "## FORK" section' };
  }

  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^##\s+\S/.test(lines[i])) { endIdx = i; break; }
  }
  const sectionLines = lines.slice(headingIdx + 1, endIdx);
  const section = sectionLines.join('\n');

  const headingLine = lines[headingIdx];
  const inlineTitle = headingLine.replace(/^##\s+FORK\s*:?\s*/i, '').trim();

  const starts = [];
  for (let i = 0; i < sectionLines.length; i++) {
    const m = OPTION_START_RE.exec(sectionLines[i]);
    if (m) starts.push({ line: i, id: (m[1] ?? m[2]).trim() });
  }

  if (starts.length < 2) {
    return { valid: false, reason: `"## FORK" carries ${starts.length} option(s) — needs >=2` };
  }

  const options = starts.map((s, idx) => {
    const blockEnd = idx + 1 < starts.length ? starts[idx + 1].line : sectionLines.length;
    const blockText = sectionLines.slice(s.line + 1, blockEnd).join('\n');
    const costMatch = COST_RE.exec(blockText);
    const consequenceMatch = CONSEQUENCE_RE.exec(blockText);
    return {
      id: s.id,
      cost: costMatch ? costMatch[1].trim() : null,
      consequence: consequenceMatch ? consequenceMatch[1].trim() : null,
    };
  });

  const missing = options.filter((o) => !o.cost || !o.consequence);
  if (missing.length > 0) {
    return { valid: false, reason: `option(s) missing cost/consequence: ${missing.map((o) => o.id).join(', ')}` };
  }

  const recMatches = [...section.matchAll(RECOMMENDATION_RE)];
  if (recMatches.length !== 1) {
    return { valid: false, reason: `found ${recMatches.length} "Recommendation:" line(s) — need exactly 1` };
  }

  return {
    valid: true,
    fork: inlineTitle || 'FORK',
    options,
    recommendation: recMatches[0][1].trim(),
  };
}

/**
 * The control classes this evaluator is capable of producing (#683).
 *
 * Every check it runs is mechanical — a fetched gate-status rollup, a
 * `git diff --numstat`, a regex over a body, an `existsSync`, a base-sha
 * reversion — so `deterministic` is the whole of it, for the reason
 * `lib/causal-admission.mjs` already states about the same three evaluators.
 *
 * Declared HERE rather than inferred at the call site: this is the file that
 * would change if the answer ever changed, and a declaration that lives next to
 * the code it describes is the one that gets updated with it.
 */
export const PRODUCES = Object.freeze(['deterministic']);

/**
 * Pure core (design.md §5 style). NEVER returns a ruled conclusion — only
 * `REVISE` (malformed fork) or `STOP` (valid fork, always escalated).
 *
 * @param {{prBody?: string}} input
 * @returns {{ conclusion: 'REVISE'|'STOP', gates: {required:string[],detection:string[]}, findings: object[], conditions: string[], pin: object|undefined, escalate: 'human'|null }}
 */
export function evaluateRuling({ prBody = '' } = {}) {
  const parsed = parseFork(prBody);

  if (!parsed.valid) {
    return {
      conclusion: 'REVISE',
      gates: { required: [], detection: [] },
      findings: [{
        id: 'fork-malformed',
        severity: 'blocker',
        evidence: `a fork without options is a request to design — ${parsed.reason}`,
        cites: 'reviewer-protocol.md §5',
      }],
      conditions: [],
      pin: undefined,
      escalate: null,
      // #750: shape only — neither ruling path is reachable by verdict.mjs's
      // softening (STOP never softens; a malformed REVISE has nothing routed
      // out of it). Declared anyway (#683's reasoning): a partial declaration
      // invites meaning from the omission.
      conclusionCauses: ['blocker'],
    };
  }

  return {
    conclusion: 'STOP',
    gates: { required: [], detection: [] },
    findings: [{
      id: 'fork-escalate',
      severity: 'editorial',
      evidence: `"## FORK" carries ${parsed.options.length} options (${parsed.options.map((o) => o.id).join(', ')}) — a new decision, not a ruling; escalating to human`,
      cites: 'reviewer-protocol.md §5',
    }],
    conditions: [],
    conclusionCauses: [],
    pin: {
      fork: parsed.fork,
      options: parsed.options.map((o) => ({ id: o.id, cost: o.cost, consequence: o.consequence })),
      recommendation: parsed.recommendation,
    },
    escalate: 'human',
  };
}

/**
 * Gathers `evaluateRuling`'s inputs. Trivial pass-through in H1-4 (Option B):
 * the deterministic evaluator only needs the PR body's `## FORK` section,
 * already fetched at cold boot — no server round trip. Mirrors the
 * `gather*Inputs(deps={})` DI-seam shape (D1) for parity with
 * tranche.mjs/checkpoint.mjs and to leave room for #284 (the
 * elimination-citation resolver) without reshaping the cli.mjs call site.
 *
 * @param {{ project?: string, number?: number, prBody?: string, deps?: object }} args
 */
export async function gatherRulingInputs({ project, number, prBody = '', deps = {} } = {}) {
  return { prBody };
}
