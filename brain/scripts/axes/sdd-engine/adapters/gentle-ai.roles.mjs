// gentle-ai.roles.mjs — issue #814 T2 (proposal D2, D4): gentle-ai's role
// declaration, as RECORDED, brain-owned data.
//
// WHY A RECORDING AND NOT A READ OF THE INSTALLED FILES. The roles this
// declares live, at runtime, in Claude Code's own agent files
// (`~/.claude/agents/sdd-*.md`) — the AGENT_PLATFORM axis, another tool's
// on-disk shape, present only where the tool is installed. #814's body names
// the three costs of reading them: it works only on the machine that has them,
// it couples brain to a layout the tool may change silently, and a file layout
// can never say "no" — absence is ambiguous. So the adapter is a declaration
// brain owns, with the provenance that makes a re-recording auditable. When
// upstream changes its roles, THIS FILE is re-recorded by hand (D2 — no drift
// guard, the cost accepted and stated here).
//
// The tier translation is the recording's one act of interpretation, and it is
// the maintainer's own assignment table, not this module's judgment:
// sonnet → 'balanced', opus → 'deep', haiku → 'cheap'. Concrete ids stay out —
// `model_tier` is abstract (#323), and `chooses_model: false` on every stage
// is D4: brain fixes the model via `sdd.map` (the 2026-08-05 ruling).

/**
 * The recorded declaration. `_provenance` follows the discipline
 * `axes/sdd-engine/fixtures/stage-set-custom.json` already enforces via
 * `assertProvenance`: recorded XOR derived, an endpoint, a date.
 */
export const GENTLE_AI_ROLES = Object.freeze({
  _provenance: Object.freeze({
    recorded: true,
    endpoint: '~/.claude/agents/sdd-{propose,spec,design,tasks}.md (agent-teams-lite) + the maintainer\'s Model Assignments table',
    date: '2026-09-02',
  }),
  proposal: Object.freeze({
    agent: 'sdd-propose',
    model_tier: 'deep', // recorded: model: opus — "Architectural decisions"
    chooses_model: false,
    instructions: 'Create a change proposal with intent, scope, and approach. Use when exploration is complete and the idea is ready to be formalized into a proposal document.',
  }),
  spec: Object.freeze({
    agent: 'sdd-spec',
    model_tier: 'balanced', // recorded: model: sonnet — "Structured writing"
    chooses_model: false,
    instructions: 'Write specifications with requirements and scenarios. Use when a proposal is approved and the change needs formal requirements (delta specs) captured before implementation.',
  }),
  design: Object.freeze({
    agent: 'sdd-design',
    model_tier: 'deep', // recorded: model: opus — "Architecture decisions"
    chooses_model: false,
    instructions: 'Create the technical design document with architecture decisions and approach. Use when a proposal is approved and the implementation approach needs to be chosen before tasks are broken down.',
  }),
  tasks: Object.freeze({
    agent: 'sdd-tasks',
    model_tier: 'balanced', // recorded: model: sonnet — "Mechanical breakdown"
    chooses_model: false,
    instructions: 'Break down a change into an implementation task checklist. Use when spec and design are both ready and the change needs to be sliced into actionable, ordered work items.',
  }),
});

/**
 * The framework's default producer role, for a stage the recording never saw.
 * A custom stage declared in `sdd.stages` MUST be answered (#312's contract:
 * a resolved stage with no declaration is refused), and the honest answer is
 * the framework's general delegation default — `default | sonnet` in the
 * recorded table — MARKED `derived: true` on the role itself, so an answer
 * the recording cannot vouch for is never read as one it can.
 */
export function derivedRole(stage) {
  return {
    stage,
    agent: 'general-purpose',
    model_tier: 'balanced', // the table's `default` row: sonnet
    chooses_model: false,
    derived: true,
    instructions: `Execute the "${stage}" stage as a general-purpose producer under the SDD flow: read the stage's upstream artifacts, produce the stage's declared artifact, and save it to the active artifact store. This role is DERIVED from gentle-ai's default delegation row — the recording of 2026-09-02 never saw this stage.`,
  };
}
