// report.mjs — the degradation contract `brain:status` reports through
// (issue #280, slice 1).
//
// THE PRINCIPLE THIS IMPLEMENTS. #280's own words: *"state is re-derived from
// disk and server, never remembered."* A human comes back to a session that
// died mid-slice and needs the last real state of an issue. The answer lives in
// five places, some of which may be unreachable at the moment they ask.
//
// So the unit is the FIELD, not the report. Every field renders its value or
// says why it could not, and one unreachable server leaves every disk fact
// intact. An all-or-nothing report gives the operator nothing at exactly the
// moment they have least — which is the failure this command exists to remove,
// not to reproduce one level up.
//
// This is `ci-context.mjs`'s null-per-field discipline applied to session
// recovery, and it is deliberately the same shape: a caller that cannot compute
// a fact says so IN BAND, rather than throwing and taking the rest with it.
//
// ── WHY `uncomputable` REFUSES AN EMPTY REASON ──────────────────────────────
//
// "uncomputable" alone is the silence this whole command exists to remove: the
// operator learns that something failed and not what, which is worse than a
// missing line because it looks like an answer. The repo has the same rule one
// layer down — `producer-forge-reach.mjs` refuses a probe that reached no
// verdict rather than reporting one it never made.
//
// ── WHY `field(null)` THROWS ────────────────────────────────────────────────
//
// A field rendering `null` teaches nothing and reads as a value. The two facts
// a reader needs to tell apart are "this is genuinely absent" and "I could not
// look", and a nullable value cannot carry that difference. Meanwhile `''`, `0`
// and `false` ARE values: "no dirty files" is a fact, and collapsing it into
// absence is how a clean tree and an unreadable one come to look the same.

/** Marks a computed value. Throws on `null`/`undefined` — see the header. */
export function field(value) {
  if (value === null || value === undefined) {
    throw new Error(
      'status/report: field() received null or undefined. A fact that could not be ' +
      'computed is uncomputable(reason), not an empty value — the two are different ' +
      'and a reader must be able to tell them apart.',
    );
  }
  return { ok: true, value };
}

/** Marks a fact that could not be computed, and why. The reason is required. */
export function uncomputable(reason) {
  if (typeof reason !== 'string' || reason.trim() === '') {
    throw new Error(
      'status/report: uncomputable() requires a reason. "uncomputable" with no cause ' +
      'is the silence this command exists to remove: it reads as an answer and carries none.',
    );
  }
  return { ok: false, reason: reason.trim() };
}

/** @returns {boolean} */
export function isUncomputable(f) {
  return Boolean(f) && f.ok === false;
}

const LABEL_WIDTH = 22;

/**
 * renderReport() — sections in, one screen out. PURE.
 *
 * No clock, no cwd, no environment: two calls on the same input are
 * byte-identical, because the first thing an operator does after a crash is run
 * it twice and diff. A report that varies on its own cannot be read that way.
 *
 * @param {Array<{title: string, fields: Array<[string, object]>}>} sections
 * @returns {string}
 */
export function renderReport(sections = []) {
  const out = [];
  for (const section of sections) {
    out.push(section.title);
    out.push('─'.repeat(section.title.length));
    if (!section.fields || section.fields.length === 0) {
      out.push('  nothing to report');
    }
    for (const [label, f] of section.fields ?? []) {
      if (!f || typeof f !== 'object' || !('ok' in f)) {
        throw new Error(
          `status/report: field "${label}" is not a field() or uncomputable() — ` +
          'refusing to render it rather than printing its shape at the operator.',
        );
      }
      const rendered = f.ok ? String(f.value) : `uncomputable (${f.reason})`;
      out.push(`  ${label.padEnd(LABEL_WIDTH)}${rendered}`);
    }
    out.push('');
  }
  return out.join('\n');
}
