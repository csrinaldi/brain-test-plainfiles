// spec-cards.mjs — spec.md -> requirement/scenario cards (R881-8 Spec tab,
// D11). Pure, imported by the browser AND by node:test (D9). The grammar is
// new work (no existing reader — `readChanges()` reads `tasks.md` only):
//
//   ### R<issue>-<n>: <title>
//   #### Scenario: <name>
//   - **WHEN** <text>
//   - **THEN** <text>
//
// Never empty-on-failure: a missing `text` is a said failure (`{ok:false,
// reason}`), never an empty card list read as "no requirements". A
// requirement heading with no scenarios yet, or a scenario missing its
// THEN line, is kept as-is and marked — never dropped, never thrown.

const REQUIREMENT_RE = /^### (R\d+-\d+): (.+)$/;
const SCENARIO_RE = /^#### Scenario: (.+)$/;
const WHEN_RE = /^-\s+\*\*WHEN\*\*\s+(.+)$/;
const THEN_RE = /^-\s+\*\*THEN\*\*\s+(.+)$/;

/**
 * parseSpecCards({text, path}) -> {ok:true, value: Array<Card>} | {ok:false, reason}
 *
 * Card: {id, title, line, source:{path,line}, scenarios: Array<Scenario>}
 * Scenario: {name, line, when, then, complete, source:{path,line}}
 *
 * @param {{text: string|null, path: string}} input
 */
export function parseSpecCards({ text, path } = {}) {
  if (typeof text !== 'string') return { ok: false, reason: 'no spec.md text was given' };

  const lines = text.split(/\r\n|\n/);
  const cards = [];
  // A WHEN or THEN the grammar could not attach to a scenario. Dropping one
  // silently is how a requirement stops being tested without anybody noticing
  // (#1059): the line is in the file, the page never shows it, and the author
  // believes it is covered.
  const orphans = [];
  let currentCard = null;
  let currentScenario = null;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;

    const req = REQUIREMENT_RE.exec(line);
    if (req) {
      currentCard = { id: req[1], title: req[2], line: lineNo, source: { path, line: lineNo }, scenarios: [] };
      cards.push(currentCard);
      currentScenario = null;
      return;
    }

    const scen = SCENARIO_RE.exec(line);
    if (scen && currentCard) {
      currentScenario = { name: scen[1], line: lineNo, when: null, then: null, complete: false, source: { path, line: lineNo } };
      currentCard.scenarios.push(currentScenario);
      return;
    }

    const when = WHEN_RE.exec(line);
    if (when) {
      if (currentScenario) { currentScenario.when = when[1]; currentScenario.complete = currentScenario.then !== null; return; }
      orphans.push({ line: lineNo, text: line.trim(), source: { path, line: lineNo }, reason: 'this WHEN belongs to no scenario — a scenario opens with a `#### Scenario: <name>` heading' });
      return;
    }

    const then = THEN_RE.exec(line);
    if (then) {
      if (currentScenario) { currentScenario.then = then[1]; currentScenario.complete = currentScenario.when !== null; return; }
      orphans.push({ line: lineNo, text: line.trim(), source: { path, line: lineNo }, reason: 'this THEN belongs to no scenario — a scenario opens with a `#### Scenario: <name>` heading' });
    }
  });

  // A FILE WITH CONTENT AND NO CARDS IS NOT A FILE WITH NOTHING IN IT. The
  // page renders an empty card list as "this tab's source was read and has
  // nothing in it", which is the `evidence-reader-empty-on-failure`
  // anti-pattern: the reader could not understand the file and reported the
  // absence of requirements instead of the absence of understanding. #1059's
  // own spec.md used `##` where the grammar declares `###`, and its Spec tab
  // read as empty for a day while the SDD tab said the file was present.
  if (cards.length === 0 && text.trim() !== '') {
    return {
      ok: false,
      reason: `${path} has content but declares no requirement: a requirement heading is \`### R<issue>-<n>: <title>\`, and a scenario under it is \`#### Scenario: <name>\` with \`- **WHEN**\` and \`- **THEN**\` lines`,
    };
  }

  return { ok: true, value: cards, orphans };
}
