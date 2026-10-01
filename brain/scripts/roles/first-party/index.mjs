// first-party/index.mjs — issue #814 T4: brain's first-party role content,
// keyed by stage. `null` for a stage brain claims no content for — this is a
// shelf of authored roles, not a registry obliged to answer everything (that
// obligation is an INHABITANT's, imposed by `role-port.mjs`).

import { ADVERSARY_COLD_REVIEW } from './adversary-cold-review.mjs';
import { VERIFIER_REVIEW } from './verifier-review.mjs';
import { ADVERSARY_CHALLENGER } from './adversary-challenger.mjs';

const BY_STAGE = Object.freeze({
  [ADVERSARY_COLD_REVIEW.stage]: ADVERSARY_COLD_REVIEW,
});

// #576 T2: the SECOND door — instances keyed by NAME, for roles that are not
// a stage (the reviewer, the challenger). One shelf, two read-only doors.
const BY_NAME = Object.freeze({
  [VERIFIER_REVIEW.name]: VERIFIER_REVIEW,
  [ADVERSARY_CHALLENGER.name]: ADVERSARY_CHALLENGER,
});

/**
 * @param {string} name
 * @returns {object|null}
 */
export function firstPartyInstance(name) {
  return Object.hasOwn(BY_NAME, name) ? BY_NAME[name] : null;
}

/**
 * @param {string} stage
 * @returns {{stage: string, archetype: string, text: string, _provenance: object}|null}
 */
export function firstPartyRole(stage) {
  return BY_STAGE[stage] ?? null;
}
