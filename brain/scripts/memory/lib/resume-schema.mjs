// resume-schema.mjs — backend-agnostic schema for resume.md frontmatter.
//
// Pure functions: no filesystem access, no engram dependency, no child processes.
// Used by:
//   - brain/scripts/axes/memory/adapters/engram.mjs (featureCheckpoint validation step)
//   - Slice 1 contract tests (resume-schema.test.mjs)
//
// Contract (REQ-S1-1):
//   REQUIRED_FIELDS — the three fields every valid resume.md frontmatter must have.
//   validateResume(frontmatter) — throws with the offending field name on violation;
//                                  callers wrap in try/catch to degrade gracefully.

/**
 * The three fields that MUST be present in every resume.md frontmatter.
 * Exported so callers can enumerate them without coupling to the implementation.
 *
 * @type {string[]}
 */
export const REQUIRED_FIELDS = ['next_action', 'current_slice', 'blockers'];

/**
 * Validates a parsed resume.md frontmatter object.
 *
 * Checks:
 *   1. Each field in REQUIRED_FIELDS is present (not undefined or null).
 *   2. `blockers` is an Array (even if empty).
 *
 * Throws an Error whose message includes the name of the offending field.
 * This function is intentionally pure: no IO, no side effects.
 *
 * @param {Record<string, unknown>} frontmatter  Parsed YAML frontmatter object.
 * @throws {Error}  Error message includes the name of the offending field.
 */
export function validateResume(frontmatter) {
  for (const field of REQUIRED_FIELDS) {
    if (frontmatter[field] == null) {
      throw new Error(
        `resume.md frontmatter missing required field: '${field}'`,
      );
    }
  }

  if (!Array.isArray(frontmatter.blockers)) {
    throw new Error(
      `resume.md frontmatter field 'blockers' must be an array (got ${typeof frontmatter.blockers})`,
    );
  }
}
