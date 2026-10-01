// schema-v2.mjs — Schema validator for brain-review/2 findings (REQ-H2-2).

export const ALLOWED_EVIDENCE_CLASSES = Object.freeze([
  'deterministic',
  'inferential',
  'insufficient',
]);

export const ALLOWED_CAUSAL_DISPOSITIONS = Object.freeze([
  'introduced',
  'behavior-activated',
  'worsened',
  'pre-existing',
  'base-only',
  'unknown',
]);

/**
 * Validates a single finding against brain-review/2 schema rules.
 * @param {object} finding
 * @returns {{ valid: boolean, reason?: string, finding?: object }}
 */
export function validateSchemaV2(finding) {
  if (!finding || typeof finding !== 'object') {
    return { valid: false, reason: 'finding must be an object' };
  }

  const { evidence_class, causal_disposition } = finding;

  if (!evidence_class || !ALLOWED_EVIDENCE_CLASSES.includes(evidence_class)) {
    return {
      valid: false,
      reason: `invalid evidence_class: ${evidence_class}. Allowed: ${ALLOWED_EVIDENCE_CLASSES.join(', ')}`,
    };
  }

  if (!causal_disposition || !ALLOWED_CAUSAL_DISPOSITIONS.includes(causal_disposition)) {
    return {
      valid: false,
      reason: `invalid causal_disposition: ${causal_disposition}. Allowed: ${ALLOWED_CAUSAL_DISPOSITIONS.join(', ')}`,
    };
  }

  return { valid: true, finding };
}
