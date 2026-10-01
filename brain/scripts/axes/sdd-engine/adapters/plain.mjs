import { artifactPaths, LIFECYCLE_STAGES } from '../../../lib/sdd-layout.mjs';
// plain.mjs — the `plain` SDD_HARNESS backend: a real, dispatchable second
// inhabitant of `init` (issue #250, B0, REQ-B0-5). No `cli.mjs` change is
// required — the dispatcher is already backend-agnostic (design §4). Emits
// the manual-flow manifest (the nine docs/workflow-guide.md §B npm-verb
// steps). Zero AI provider, zero network call, zero tool beyond the repo's
// own npm verbs.

/** The nine docs/workflow-guide.md §B manual-flow steps (design §4, cross-checked #584 §5). */
const MANUAL_FLOW_STEPS = [
  'npm run brain:env:init — one-time bootstrap.',
  'npm run brain:session:start — open the session (read-only, local).',
  'npm run brain:ticket:start -- <id> — take the issue, create the branch.',
  'npm run brain:project:feature -- --issue <id> — scaffold the change dir.',
  'Edit the four artifacts by hand, in order: proposal.md → spec.md → design.md → tasks.md.',
  "Implement the code, checking off tasks.md items as you go.",
  'npm run brain:repo:check + npm test + npm run brain:change:verify — the gates.',
  'npm run brain:memory:save --issue <id> — capture durable memory; the enabled memory lane ships it.',
  'Commit + open the PR with Closes #<id>.',
];

/**
 * No agent runtime to version-check (issue #123): `plain` is the zero-AI
 * backend by definition, so day-start reports "nothing declared" rather than
 * probing for a binary that is not part of this flow.
 */
export const AGENT_RUNTIME = null;

/**
 * plain backend init: emit the manual-flow manifest. Zero AI provider, zero
 * network, zero tool beyond the repo's own npm verbs.
 * @param {{ _emit?: (line: string) => void }} [opts] Injectable sink (default console.log).
 */
export async function init({ _emit = console.log } = {}) {
  _emit('SDD_HARNESS=plain — manual flow (no AI). Run these npm verbs in sequence:');
  MANUAL_FLOW_STEPS.forEach((step, i) => _emit(`  ${i + 1}. ${step}`));
}

/**
 * `plain`'s role declaration (issue #312 slice A, design D2) — the inhabitant
 * surface `axes/sdd-engine/role-port.mjs`'s `resolveRoles` calls. Answers EVERY stage it
 * is asked about, including a custom one `plain.mjs` never heard of: a human
 * executes any stage, which is a real property of this backend (`AGENT_RUNTIME
 * = null` above, one manual flow), not a gap a static map would leave.
 *
 * The three values are CHECKED, not a stub — a stub is a shape with EMPTY
 * values, and each of these would change the day `plain` gained a runtime:
 * `agent: 'human'` (the human executing `MANUAL_FLOW_STEPS`, not a null this
 * object already uses for "no model runs"), `model_tier: null` (a checked
 * value meaning "a human executes this", never a fourth tier), `chooses_model:
 * false` (strictly boolean, never absent — `plain` does not choose a model
 * because no agent runs here to choose one).
 *
 * @param {string[]} stages The resolved stage set to declare a role for.
 * @returns {Record<string, {stage: string, agent: string, model_tier: null, chooses_model: false, instructions: null}>}
 */
export function declareRoles(stages) {
  return Object.fromEntries(stages.map((stage) => [stage, {
    // `instructions: null` — checked (#814 T3): a human executes; there is no
    // prompt to declare. The same reasoning as `model_tier: null` above.
    stage, agent: 'human', model_tier: null, chooses_model: false, instructions: null,
  }]));
}

/**
 * The S2 evidence guard, shared verbatim by both engine wirings (#323 S4 D3):
 * a lifecycle payload without BOUND routed evidence refuses at the engine
 * layer too — the same demand the transport guard makes, one layer earlier.
 */
function assertBoundEvidence(stage, routed, changeId) {
  // Round 5: the two INPUTS themselves. An unnamed stage is a caller that lost
  // its argument (stage-engine's own history, mirrored at last), and a
  // lifecycle run without a changeId would target 'openspec/changes/undefined/…'
  // — silent wrong behavior, the inverse of a refusal.
  if (typeof stage !== 'string' || stage.trim() === '') {
    throw new Error(`run-stage: ${JSON.stringify(stage)} is not a stage name — a caller that lost its argument, refused before it targets anything.`);
  }
  if (LIFECYCLE_STAGES.includes(stage) && (typeof changeId !== 'string' || changeId.trim() === '')) {
    throw new Error(`run-stage: lifecycle stage "${stage}" needs a changeId — without one the target would be a path literally containing "undefined".`);
  }
  // Round 2 of #836's cold review: the guard mirrors assertRoutableStage's
  // OPTION-A split exactly — only LIFECYCLE stages owe evidence; a custom
  // stage (cold-review, the flagship) arrives evidence-free by the very rule
  // this change shipped, and demanding it here produced a FALSE refusal on a
  // reachable config. Reproduced before fixing.
  if (!LIFECYCLE_STAGES.includes(stage)) {
    if (routed && routed.routed === true && routed.stage !== stage) {
      throw new Error(
        `run-stage: routed evidence was computed for "${routed.stage}" and handed to "${stage}" — bound, never bearer.`
      );
    }
    return;
  }
  if (!(routed && routed.routed === true)) {
    throw new Error(
      `run-stage: lifecycle stage "${stage}" arrived without routed evidence — call ` +
      'assertRoutedStage({config, stage}) and hand its result through (#323 S2, condition 4).'
    );
  }
  if (routed.stage !== stage) {
    throw new Error(
      `run-stage: routed evidence was computed for "${routed.stage}" and handed to "${stage}" — bound, never bearer.`
    );
  }
}

/**
 * plain's run-stage (#323 S4 D1): the MANUAL HANDOFF. The human is the
 * runtime — `AGENT_RUNTIME = null` above is a fact, and this wiring says it
 * instead of simulating around it. `{ok: true, manual: true}`: the seam stops
 * refusing an engine the operator legitimately named, and what they get is
 * the resolved role, the single accessor's target, and the steps.
 *
 * @param {{stage: string, routed: object, changeId: string}} payload
 * @returns {Promise<{ok: true, manual: true, target: string, steps: string[]}>}
 */
export async function runStage({ stage, routed, changeId } = {}) {
  assertBoundEvidence(stage, routed, changeId);
  // Round 6: the accessor only knows the four lifecycle artefacts — for a
  // custom stage `target` is null (checked), never an "undefined" handed to a
  // human inside a step. gentle-ai got this ternary in round 2; the sibling
  // kept the accident four rounds longer.
  const target = artifactPaths(changeId)[stage] ?? null;
  return {
    ok: true,
    manual: true,
    target,
    steps: [
      `Stage "${stage}" is routed to plain: a human executes it (model_tier: null is a checked value).`,
      target
        ? `Write the artefact at ${target} — the single accessor's answer; no engine may relocate it.`
        : `The "${stage}" stage writes to its own declared root — follow its chain's conventions; it is not one of the four lifecycle artefacts.`,
      `Run npm run brain:repo:check before committing, as every producer does.`,
    ],
  };
}
