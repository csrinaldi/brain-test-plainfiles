// resume-view.mjs — parsed frontmatter -> the three ruling-3 fields
// (R881-8 Working memory tab, D12). Pure, imported by the browser AND by
// node:test (D9).
//
// `resume.md`'s frontmatter grammar is already parsed by
// `resume-frontmatter.mjs`'s `parseFrontmatter` (server-side, D11 —
// duplicating that grammar in `ui/lib` would be a second reader of one
// format); this module only SHAPES the already-parsed object into the
// three fields `resume-schema.mjs`'s `REQUIRED_FIELDS` names.
//
// `validateResume` is deliberately NOT used as a gate (D12): `resume.md` is
// an operational artefact where staleness is expected, never a gate
// condition (`AGENTS.md:388-395`). A missing field renders `{ok:false,
// reason}` beside the fields that ARE present — never an all-or-nothing
// failure over the whole tab.

const FIELDS = ['next_action', 'current_slice', 'blockers'];

/**
 * shapeResumeView({frontmatter, branch}) -> {next_action, current_slice, blockers}
 * — each a drawer field `{ok:true, value, source} | {ok:false, reason, source?}`.
 *
 * @param {{frontmatter: Record<string, unknown>|null, branch: string}} input
 */
export function shapeResumeView({ frontmatter, branch } = {}) {
  const source = { path: `${branch}:resume.md` };
  const out = {};
  for (const key of FIELDS) {
    const value = frontmatter?.[key];
    out[key] = value == null
      ? { ok: false, reason: `resume.md on ${branch} has no ${key}`, source }
      : { ok: true, value, source };
  }
  return out;
}
