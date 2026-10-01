// agents-clobber.mjs — REQ-397-6: tell a consumer whose AGENTS.md an EARLIER
// upgrade already replaced.
//
// Signed decision 2 (04/08/2026): protecting only from here on would leave the
// existing damage permanently invisible, and the repos carrying it are exactly
// the adopters M4 exists for. So the first run after #397 lands has to say so.
//
// ── Why this mechanism, and not git history ──────────────────────────────────
//
// The spec deliberately left the mechanism open and named git history as one
// option. Measured before choosing: brain's own AGENTS.md changed 16 times
// across 17 tags. A history-based rule — "this file once differed and now
// matches brain's" — is therefore TRUE for almost every consumer who upgraded
// more than once, because brain's own version changed underneath them. It would
// fire for nearly everyone, which is the one outcome REQ-397-6 Scenario 2
// forbids: a detector that fires for every consumer is noise, and noise is how a
// real warning gets ignored.
//
// AGENTS.md is GENERATED, and that is the leverage. Its inputs are on disk, so
// "was this built from the consumer's own inputs" is answerable exactly, with no
// new state and no history walk.
//
// ── The rule ─────────────────────────────────────────────────────────────────
//
//   1. No AGENTS.md on disk            → nothing to have lost.
//   2. consumerHome === brainHome      → they never customised. Scenario 2,
//                                        literally: nothing of their own to lose,
//                                        even though their AGENTS.md IS brain's.
//                                        Byte-identity alone is not evidence.
//   3. onDisk === brainAgents          → they customised, yet what is on disk is
//                                        brain's compiled artifact. Only a copy
//                                        puts it there. CLOBBERED.
//   4. anything else                   → their own, or merely stale. Both are
//                                        silent: stale is not loss, and the
//                                        upgrade regenerates it anyway.
//
// Any input being unreadable yields 'unknown' and NO report. Every value here is
// read from a tree that may be missing, partial, or from a much older brain, and
// a detector that guesses under uncertainty is exactly the noise rule 2 exists
// to prevent.
//
// ── The limit, recorded rather than discovered ───────────────────────────────
//
// Rule 3 compares against the INCOMING package's AGENTS.md. A consumer clobbered
// by an OLDER release carries that older artifact and is MISSED. Closing that
// needs a manifest of every hash brain has historically shipped — a new Tier-2
// artifact and its own decision. Recorded in docs/KNOWN-LIMITATIONS.md and
// tracked separately; not silently claimed here.
//
// Pure and fs-free by construction: the caller reads the four inputs, so every
// branch above is directly testable without a filesystem.

/**
 * Decides whether a consumer's AGENTS.md was replaced by an earlier upgrade.
 *
 * NEVER throws.
 *
 * @param {object} [opts]
 * @param {string|null} [opts.onDisk]        Consumer's current AGENTS.md content.
 * @param {string|null} [opts.consumerHome]  Consumer's brain/HOME.md content.
 * @param {string|null} [opts.brainHome]     Brain's brain/HOME.md, from the package.
 * @param {string|null} [opts.brainAgents]   Brain's own AGENTS.md, from the package.
 * @returns {{ clobbered: boolean, reason: 'absent'|'not-customised'|'identical-to-brain'|'differs-from-brain'|'unknown' }}
 */
export function detectAgentsClobber({ onDisk, consumerHome, brainHome, brainAgents } = {}) {
  try {
    if (onDisk == null) return { clobbered: false, reason: 'absent' };

    // Cannot compare → cannot accuse.
    if (consumerHome == null || brainHome == null || brainAgents == null) {
      return { clobbered: false, reason: 'unknown' };
    }

    // REQ-397-6 Scenario 2, literally.
    if (consumerHome === brainHome) return { clobbered: false, reason: 'not-customised' };

    if (onDisk === brainAgents) return { clobbered: true, reason: 'identical-to-brain' };

    return { clobbered: false, reason: 'differs-from-brain' };
  } catch {
    // A detector must never be the reason an upgrade fails.
    return { clobbered: false, reason: 'unknown' };
  }
}
