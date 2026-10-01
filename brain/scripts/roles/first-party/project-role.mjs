// project-role.mjs — issue #576 T3: a first-party role rendered into an agent
// PLATFORM's native format. Byte-deterministic: no dates, no environment, no
// machine — the same inputs are the same bytes, which is what lets a committed
// golden be the drift guard (the compileAgentsMd precedent, applied to roles).
//
// TARGETS ARE PLATFORMS, NEVER FRAMEWORKS (D6): claude and antigravity RECEIVE
// projections; gentle-ai and plain DECLARE to the port. Asking to project into
// a framework is refused by name.
//
// `model` IS OMITTED from the claude frontmatter on purpose: the tier and
// chooses_model belong to ROUTING (sdd.map, the port's selection paths) — a
// projected file carrying a model id would be a second router in a file no
// resolver reads.
//
// The `brain-` filename prefix is the collision guard: `.claude/agents/` is
// operator-owned space, and a projection that could shadow a personal agent
// file would be a clobber wearing a feature's name.
//
// EMISSION IS NOT WIRED HERE. Which init writes these files, and any
// managed-paths declaration, is the maintainer's hand — recorded as a note in
// the role-port ADR's DRAFT (#576 T5; cited by number only once promoted — the
// adr-citations guard demands a citation that resolves TODAY), never silent.

export const PROJECTION_PLATFORMS = Object.freeze(['claude', 'antigravity']);

/**
 * @param {{name?: string, stage?: string, archetype: string, text: string}} role
 * @param {'claude'|'antigravity'} platform
 * @returns {{relPath: string, text: string}}
 */
export function projectRole(role, platform) {
  if (!PROJECTION_PLATFORMS.includes(platform)) {
    throw new Error(
      `project-role: '${platform}' is not a projection platform (${PROJECTION_PLATFORMS.join(', ')}). ` +
      'Frameworks (gentle-ai, plain) DECLARE roles to the port — they never receive projections (D6).',
    );
  }
  const key = role.name ?? role.stage;
  if (typeof key !== 'string' || key.length === 0 || typeof role.text !== 'string' || role.text.length === 0) {
    throw new Error('project-role: a role must carry a name (or stage) and text — nothing else projects.');
  }

  if (platform === 'claude') {
    const name = `brain-${key}`;
    const text = [
      '---',
      `name: ${name}`,
      `description: ${role.archetype} archetype instance, projected from brain/scripts/roles/first-party (do not edit — the drift guard compares bytes)`,
      '---',
      '',
      role.text,
      '',
    ].join('\n');
    return { relPath: `.claude/agents/${name}.md`, text };
  }

  // antigravity: one role's SECTION — compileAgentsMd assembles the document.
  const text = [`### ${key} (${role.archetype})`, '', role.text, ''].join('\n');
  return { relPath: 'AGENTS.md', text };
}

/** The section compileAgentsMd appends when roles are handed in. */
export function rolesSection(roles) {
  const parts = roles.map((role) => projectRole(role, 'antigravity').text);
  return ['## First-party roles', '', ...parts].join('\n');
}
