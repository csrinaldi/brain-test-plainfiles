// mask-non-code.mjs — blank out comments and string/template bodies.
//
// Extracted from test-spawn-hygiene.test.mjs (#1127) so the two source-scanning
// drift guards (that one and swallow-guard.test.mjs) share ONE masker instead of
// each carrying a copy that could disagree about what "code" is.

/** True when a `/` at the end of `out` opens a regex literal rather than dividing:
 * it follows an operator/opener, or one of the keywords that precede an expression. */
function startsRegex(out) {
  const t = out.trimEnd();
  if (t === '') return true;
  if (/[(,=:[!&|?{};+\-*%<>~^]$/.test(t)) return true;
  return /\b(?:return|typeof|case|in|of|void|delete|throw)$/.test(t);
}

/** Replaces every //, /* *‍/ and string/template body with blanks (same
 * length, newlines preserved) so the call-site search never matches
 * callee-shaped text living inside a comment, a string or a regex literal. */
export function maskNonCode(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      let j = i;
      while (j < n && src[j] !== '\n') { out += ' '; j += 1; }
      i = j;
      continue;
    }
    if (c === '/' && c2 === '*') {
      out += '  ';
      let j = i + 2;
      while (j < n && !(src[j] === '*' && src[j + 1] === '/')) {
        out += src[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      out += '  ';
      i = j + 2;
      continue;
    }
    if (c === '/' && startsRegex(out)) {
      // A regex literal: its body may hold quotes and braces that are not code.
      let j = i + 1;
      let inClass = false;
      out += ' ';
      while (j < n && src[j] !== '\n' && (inClass || src[j] !== '/')) {
        if (src[j] === '\\') { out += '  '; j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        out += ' ';
        j += 1;
      }
      out += ' ';
      i = j + 1;
      continue;
    }
    if (c === '\'' || c === '"' || c === '`') {
      const quote = c;
      out += ' ';
      let j = i + 1;
      while (j < n && src[j] !== quote) {
        if (src[j] === '\\') { out += '  '; j += 2; continue; }
        out += src[j] === '\n' ? '\n' : ' ';
        j += 1;
      }
      out += ' ';
      i = j + 1;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}
