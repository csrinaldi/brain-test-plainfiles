// classify-divergence.mjs — Language-aware divergence classifier.
//
// Compares consumer text against upstream text to determine whether the
// difference is an identical copy, a Spanish translation, drift, or ambiguous.
//
// Pure: no node:fs, no node:child_process. Deterministic, testable.
//
// See design.md § "Divergence classifier" and tasks.md § "Phase 3".
//
// === Tuning record — Open Question #1 resolved ===
//
// MIN_HITS = 3
// Chosen after running classify-divergence.test.mjs against the catastro-flat
// fixture (brain/methodology/intro.md — Spanish translation of upstream EN doc).
//
// Measurement on the fixture:
//   - ES diacritics (ñ, á, é, í, ó, ú, ü, ¿, ¡) count ≥ 24 occurrences
//   - ES stopword token matches ≥ 15 occurrences
//   - Total ES score ≥ 39; EN score ≈ 0 (pure Spanish prose)
//
// Rationale:
//   MIN_HITS = 3 is conservative — a realistic Spanish translation clears it
//   with ample margin (×10+). A text with 1–2 Spanish loanwords embedded in
//   English never reaches MIN_HITS, so no false `translation` classification.
//   Ambiguous or code-only files (es=0, en=0) fall through to `flag-for-review`.
//
// ES_STOPWORDS: high-frequency Spanish function words with negligible occurrence
//   in English prose. Chosen to complement diacritic scoring.
// EN_STOPWORDS: high-frequency English function words with negligible occurrence
//   in Spanish prose. "can", "will", "are", "has" etc. trigger the `en` counter.

/** Minimum ES marker hits required to classify a text as ES-dominant. */
const MIN_HITS = 3;

/**
 * Matches individual ES diacritic characters and inverted punctuation.
 * Applied to the original (pre-lowercase) text so uppercase variants are caught.
 */
const ES_DIACRITICS_RE = /[ñáéíóúüÁÉÍÓÚÜÑ¿¡]/g;

/**
 * High-frequency Spanish function words unlikely to appear as standalone tokens
 * in English prose. Used for word-level ES scoring.
 * @type {Set<string>}
 */
const ES_STOPWORDS = new Set([
  'para', 'una', 'las', 'los', 'por', 'con', 'este', 'del',
  'como', 'pero', 'cuando', 'donde', 'que', 'sus', 'entre',
  'cada', 'sobre', 'también', 'más', 'esta', 'ese', 'hay',
  'está', 'muy', 'sin', 'ser', 'son', 'fue', 'han', 'todo',
  'ante', 'bajo', 'desde', 'hasta', 'hacia',
]);

/**
 * High-frequency English function words unlikely to appear as standalone tokens
 * in Spanish prose. Used for word-level EN scoring.
 * @type {Set<string>}
 */
const EN_STOPWORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from',
  'have', 'are', 'not', 'into', 'you', 'your', 'our',
  'can', 'will', 'its', 'any', 'all', 'been', 'has',
  'but', 'they', 'their', 'when', 'which', 'there',
]);

/**
 * Token regex: matches sequences of ASCII letters plus Latin Extended A/B
 * (the range that covers all ES diacritics — á é í ó ú ü ñ and their capitals).
 * Applied to lowercased text so token matching is case-insensitive.
 */
const WORD_RE = /[a-zÀ-ɏ]+/g;

/**
 * Computes ES and EN language scores for the given text.
 *
 * ES score = diacritic/inverted-punctuation character count
 *           + ES stopword token match count
 * EN score = EN stopword token match count
 *
 * verdict:
 *   'es'    — ES dominant: es ≥ MIN_HITS AND es > en
 *   'en'    — EN dominant: en > 0 AND es < MIN_HITS
 *   'mixed' — ambiguous or no markers (conservative; triggers flag-for-review)
 *
 * @param {string} text
 * @returns {{ es: number, en: number, verdict: 'es'|'en'|'mixed' }}
 */
function computeLanguageSignal(text) {
  const esChars = (text.match(ES_DIACRITICS_RE) || []).length;
  const lower = text.toLowerCase();
  const words = lower.match(WORD_RE) || [];
  const esWords = words.filter(w => ES_STOPWORDS.has(w)).length;
  const enWords = words.filter(w => EN_STOPWORDS.has(w)).length;

  const es = esChars + esWords;
  const en = enWords;

  let verdict;
  if (es >= MIN_HITS && es > en) {
    verdict = 'es';
  } else if (en > 0 && es < MIN_HITS) {
    verdict = 'en';
  } else {
    verdict = 'mixed';
  }

  return { es, en, verdict };
}

/**
 * Counts Markdown heading lines (lines starting with 1–6 # characters followed by a space).
 * Used by the structural mirroring check: a clean translation mirrors the upstream
 * heading hierarchy; consumer-added headings signal drift or restructuring that a
 * human must confirm before an adopt-upstream action overwrites the content.
 * @param {string} text
 * @returns {number}
 */
function countHeadings(text) {
  return (text.match(/^#{1,6}\s/gm) || []).length;
}

/**
 * Classifies the divergence between a consumer file and its upstream equivalent.
 *
 * Classification rules (applied in order):
 *   1. Identical bytes → 'identical'  (languageSignal: null)
 *   2. ES dominant (es ≥ MIN_HITS && es > en) AND consumerHeadings ≤ upstreamHeadings
 *      → 'translation'  (spec condition 4: structural mirroring enforced via heading count)
 *   2b. ES dominant but consumerHeadings > upstreamHeadings → 'flag-for-review'
 *       (consumer added sections not present in upstream; mislabeling 'translation' would
 *       cause adopt-upstream to silently overwrite custom content — conservative guard)
 *   3. EN dominant (en > 0 && es < MIN_HITS) AND consumerHeadings ≤ upstreamHeadings
 *      → 'drift'  (spec condition 4: structural mirroring guard applies to EN too)
 *   3b. EN dominant but consumerHeadings > upstreamHeadings → 'flag-for-review'
 *       (consumer added sections to an EN generic file; adopt-upstream would silently
 *       overwrite custom content — same conservative guard as the ES path)
 *   4. Ambiguous / no markers / mixed → 'flag-for-review' (conservative default)
 *
 * NOTE: 'flag-for-review' is an internal signal. build-plan.mjs maps it to
 *       divergenceKind: 'drift' + proposedAction: 'flag-review' in the final plan.
 *
 * Spec condition 4 (structural mirroring) is enforced for BOTH language paths:
 * the consumer heading count must not exceed the upstream count for either
 * 'translation' (ES path) or 'drift' (EN path) to be assigned. This prevents
 * adopt-upstream from silently overwriting consumer-added sections regardless
 * of the file language.
 *
 * @param {string} consumerText  Full text content of the consumer file.
 * @param {string} upstreamText  Full text content of the upstream brain file.
 * @returns {{
 *   divergenceKind: 'identical'|'translation'|'drift'|'flag-for-review',
 *   languageSignal: { es: number, en: number, verdict: 'es'|'en'|'mixed' }|null,
 *   reason: string
 * }}
 */
export function classifyDivergence(consumerText, upstreamText) {
  if (consumerText === upstreamText) {
    return {
      divergenceKind: 'identical',
      languageSignal: null,
      reason: 'consumer and upstream bytes are identical',
    };
  }

  const signal = computeLanguageSignal(consumerText);

  if (signal.verdict === 'es') {
    // Spec condition 4: structural mirroring guard.
    // A clean ES translation mirrors or is a subset of upstream's heading structure.
    // If consumer has MORE headings than upstream, the file likely has consumer-added
    // sections; mislabeling it 'translation' would cause adopt-upstream to overwrite
    // custom content. Tolerance: strict — consumer must not exceed upstream count;
    // even one extra heading signals restructuring or consumer drift.
    const consumerHeadings = countHeadings(consumerText);
    const upstreamHeadings = countHeadings(upstreamText);
    if (consumerHeadings > upstreamHeadings) {
      return {
        divergenceKind: 'flag-for-review',
        languageSignal: signal,
        reason: `ES-dominant but structure diverges from upstream — consumer has ${consumerHeadings} headings vs upstream ${upstreamHeadings}; possible restructured translation or drift; human must confirm before adopt-upstream`,
      };
    }
    return {
      divergenceKind: 'translation',
      languageSignal: signal,
      reason: `consumer text is ES-dominant (es=${signal.es}, en=${signal.en}, MIN_HITS=${MIN_HITS}); upstream is EN by policy (ADR-0009); heading structure mirrors upstream (consumer: ${consumerHeadings}, upstream: ${upstreamHeadings})`,
    };
  }

  if (signal.verdict === 'en') {
    // Spec condition 4: structural mirroring guard — applies to EN just as to ES.
    // An EN generic file where the consumer has added headings beyond the upstream
    // count has consumer-specific content; silently scheduling it for adopt-upstream
    // would overwrite those additions. Flag for human review instead.
    const consumerHeadings = countHeadings(consumerText);
    const upstreamHeadings = countHeadings(upstreamText);
    if (consumerHeadings > upstreamHeadings) {
      return {
        divergenceKind: 'flag-for-review',
        languageSignal: signal,
        reason: `EN generic file with consumer-added headings (consumer: ${consumerHeadings}, upstream: ${upstreamHeadings}) — structure diverges from upstream; flagged for human review before adopt-upstream`,
      };
    }
    return {
      divergenceKind: 'drift',
      languageSignal: signal,
      reason: `consumer text is EN with differing bytes (en=${signal.en}, es=${signal.es}); classified as drift`,
    };
  }

  // verdict === 'mixed': ambiguous signal — conservative default is flag-for-review.
  // Silent reclassification as 'translation' is PROHIBITED (spec requirement).
  return {
    divergenceKind: 'flag-for-review',
    languageSignal: signal,
    reason: `ambiguous language signal (es=${signal.es}, en=${signal.en}); flagged for human review`,
  };
}

// Export tuning constants for use in tests (allows assertions against pinned values).
export { MIN_HITS, ES_STOPWORDS, EN_STOPWORDS };
