// resume-frontmatter.mjs — minimal YAML-like frontmatter parser/serializer for resume.md.
//
// Constraints (feature-working-memory-contract.md):
//   - Flat string scalars (feature, checkpointed_at, current_slice, next_action, …)
//   - String arrays (blockers, in_flight_decisions)
//   - Prose body after the closing ---
//   - Node built-ins ONLY — no YAML library dependency
//
// Guarantees:
//   - NEVER throws on malformed / empty / null input (returns { frontmatter: null, body })
//   - Round-trip stable: parse → serialize → parse produces identical result
//   - Preserves the prose body verbatim
//   - Quoted and unquoted scalars handled; escaped \\" inside double-quoted values handled

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a resume.md source string into a frontmatter object and a prose body.
 *
 * @param {string|null|undefined} source  Full file content.
 * @returns {{ frontmatter: Record<string,string|string[]>|null, body: string }}
 *   frontmatter is null when the source has no valid YAML frontmatter block.
 *   body is the text after the closing ---, or the full source when no block found.
 */
export function parseFrontmatter(source) {
  try {
    if (typeof source !== 'string' || source.length === 0) {
      return { frontmatter: null, body: source ?? '' };
    }

    const lines = source.split('\n');

    // The document must open with '---'
    if (lines[0] !== '---') {
      return { frontmatter: null, body: source };
    }

    // Find the closing '---'
    let closeIdx = -1;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i] === '---') {
        closeIdx = i;
        break;
      }
    }
    if (closeIdx === -1) {
      // No closing marker — not a valid frontmatter block.
      return { frontmatter: null, body: source };
    }

    const fmLines = lines.slice(1, closeIdx);
    // Body is everything after the closing '---', joined back to a string.
    const body = lines.slice(closeIdx + 1).join('\n');

    const frontmatter = /** @type {Record<string,string|string[]>} */ ({});
    let currentKey = /** @type {string|null} */ null;
    let currentArray = /** @type {string[]|null} */ null;

    for (const line of fmLines) {
      // Array item: lines starting with exactly '  - '
      if (line.startsWith('  - ') && currentKey !== null && currentArray !== null) {
        currentArray.push(_unquote(line.slice(4)));
        continue;
      }

      // If we were accumulating an array and hit a non-item line, flush it.
      if (currentArray !== null) {
        frontmatter[currentKey] = currentArray;
        currentArray = null;
        currentKey = null;
      }

      // Match: key: value  OR  key:  (array-start, empty value)
      const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*):(.*)$/);
      if (!m) continue;

      const key = m[1];
      const rest = m[2]; // everything after the colon

      if (rest === '' || rest === null) {
        // No value after the colon → start of a YAML sequence.
        currentKey = key;
        currentArray = [];
      } else {
        // Scalar: strip leading space, then unquote.
        const val = rest.startsWith(' ') ? rest.slice(1) : rest;
        frontmatter[key] = _unquote(val.trim());
        currentKey = null;
      }
    }

    // Flush any trailing array.
    if (currentArray !== null && currentKey !== null) {
      frontmatter[currentKey] = currentArray;
    }

    return { frontmatter, body };
  } catch { /* swallow-ok: the documented graceful fallback for a hand-edited resume.md: no frontmatter, the body is kept */
    // Never throw — return graceful fallback.
    return { frontmatter: null, body: source ?? '' };
  }
}

/**
 * Serialize a frontmatter object (plus an optional prose body) into a resume.md string.
 *
 * Output is stable: re-parsing it with parseFrontmatter yields an identical object
 * when the original input was produced by this serializer.
 *
 * @param {Record<string,string|string[]>} frontmatter  Frontmatter fields.
 * @param {string} [body='']  Prose body to append after the closing ---.
 * @returns {string}
 */
export function serializeFrontmatter(frontmatter, body = '') {
  const lines = ['---'];

  for (const [key, val] of Object.entries(frontmatter)) {
    if (Array.isArray(val)) {
      lines.push(`${key}:`);
      for (const item of val) {
        lines.push(`  - ${_quoteIfNeeded(String(item))}`);
      }
    } else {
      lines.push(`${key}: ${_quoteIfNeeded(String(val))}`);
    }
  }

  lines.push('---');
  // Join the frontmatter block with a trailing newline, then append body.
  return lines.join('\n') + '\n' + (body ?? '');
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Strip outer double- or single-quotes from a scalar value, and unescape \\"
 * inside double-quoted strings.  Returns the raw string unchanged if unquoted.
 *
 * @param {string} raw
 * @returns {string}
 */
function _unquote(raw) {
  const s = raw.trim();
  if (s.length >= 2) {
    if (s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (s.startsWith("'") && s.endsWith("'")) {
      return s.slice(1, -1);
    }
  }
  return s;
}

/**
 * Decide whether val needs double-quoting for safe round-trip serialization.
 *
 * Bareword characters (safe without quoting):
 *   A-Z  a-z  0-9  .  _  -  /  :
 * Anything outside this set (spaces, em-dashes, parens, brackets, hash, …)
 * causes the value to be wrapped in "…" with internal " escaped as \".
 *
 * ISO-8601 timestamps (e.g., 2026-06-26T20:55:00Z) and hostname/branch paths
 * (e.g., host-A/feat/s1) are valid barewords and are NOT quoted.
 *
 * @param {string} val
 * @returns {string}
 */
function _quoteIfNeeded(val) {
  if (val === '') return '""';
  // All characters are "safe" bareword chars → no quoting needed.
  if (/^[A-Za-z0-9._\-/:]+$/.test(val)) return val;
  // Anything else: wrap in double quotes, escaping inner backslashes and quotes.
  return `"${val.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
