// agent-identity-agnostic.test.mjs — issue #454, ADR-0026 Amendment 3.
//
// A STRUCTURAL LOCK over the product/consumer boundary, in the shape this repo
// already uses for structural locks (brain-promote.locks.test.mjs, approve/locks).
//
// #454 exempts an agent identity from re-arming the approval. The cheap way to
// implement that is a login literal in `actor-check.mjs`, and it would work — for
// exactly as long as this repo's agent platform does not change. brain is
// platform-agnostic by construction: the VCS provider, the SDD harness and the
// memory backend are all adapters (ADR-0001/0004/0005/0008), and the golden rule
// (ADR-0003/ADR-0006) puts `brain.config.json` on the CONSUMER's side of the
// manifest, where `brain:upgrade` never reaches. A vendor name in the governance
// DECISION path would be the first place the PRODUCT knows who its user's agent is —
// see GUARDED_TREES for why that is the scope, and what refuted the wider one.
//
// This guard derives what it forbids FROM THE CONFIG — it does not name a platform
// either, so it keeps working unchanged for a consumer running any other agent, and
// it starts guarding the moment they declare one. A test that hardcoded today's
// vendor string would be the same mistake it exists to prevent.
//
// It asserts ABSENCE, which is the load-bearing direction: a guard that merely
// required "the exempt set is threaded" would be satisfied by a hardcoded literal.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The GOVERNANCE DECISION PATH — not every managed file.
 *
 * The first version of this guard scanned all of `brain/core/**` and
 * `brain/scripts/**` and reported 18 files. Reading them refuted it: nearly all are
 * ADAPTERS or their manifests — `axes/platform/adapters/claude.mjs` implements the harness
 * verb contract for one platform exactly as `axes/vcs/adapters/github.mjs` implements the
 * VCS contract for one forge, `managed-paths.mjs` lists that backend's emitted file,
 * `tranche.mjs` matches AI-attribution trailers by their literal text. **Naming a
 * platform is what an adapter is FOR**; a guard that forbade it would condemn the
 * very pattern that produces the agnosticism (ADR-0001/0004/0005/0008).
 *
 * What must stay vendor-blind is narrower and load-bearing: the path that DECIDES
 * governance outcomes. A login literal here would make the gate itself platform-bound,
 * and no adapter boundary would exist to swap.
 */
const GUARDED_TREES = ['brain/scripts/vcs', 'brain/scripts/governance'];

/** Tests and their fixtures legitimately name identities; they are not shipped doctrine
 *  and they are not what a consumer's upgrade overwrites into place. */
const isExempt = (relPath) => /\.test\.mjs$|__fixtures__|\/fixtures\//.test(relPath);

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else out.push(abs);
  }
  return out;
}

function declaredAgentActors() {
  const config = JSON.parse(readFileSync(join(repoRoot, 'brain.config.json'), 'utf8'));
  const v = config?.governance?.agentActors;
  return Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim() !== '') : [];
}

test('#454: no declared agent identity appears in the governance DECISION path — the platform name lives in consumer config only', () => {
  const actors = declaredAgentActors();

  // Not an early return: a config that declares nothing makes this test vacuous, and
  // a vacuous green is the shape this repo keeps paying for. Say so out loud instead.
  assert.ok(actors.length > 0,
    'brain.config.json declares no governance.agentActors — this guard would pass vacuously. '
    + 'Either declare the identity (this repo does) or delete the guard; do not leave it inert.');

  const offenders = [];
  for (const tree of GUARDED_TREES) {
    for (const abs of walk(join(repoRoot, tree))) {
      const rel = relative(repoRoot, abs);
      if (isExempt(rel)) continue;
      let text;
      try {
        text = readFileSync(abs, 'utf8');
      } catch {
        continue; // binary or unreadable — nothing to match
      }
      for (const actor of actors) {
        const re = new RegExp(`\\b${actor.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
        if (re.test(text)) offenders.push(`${rel} names "${actor}"`);
      }
    }
  }

  assert.deepEqual(offenders, [],
    'a governance decision file names the consumer\'s agent identity — the gate must not know which platform its user runs. '
    + 'Move the string to brain.config.json (governance.agentActors) and read it with `?? []`.\n'
    + offenders.join('\n'));
});

test('#454: governance.agentActors and governance.reviewActors name disjoint identities', () => {
  const config = JSON.parse(readFileSync(join(repoRoot, 'brain.config.json'), 'utf8'));
  const list = (k) => (Array.isArray(config?.governance?.[k]) ? config.governance[k] : []);
  const agents = list('agentActors').map(s => s.toLowerCase());
  const reviewers = list('reviewActors').map(s => s.toLowerCase());

  const overlap = agents.filter(a => reviewers.includes(a));

  // Not forbidden by the evaluator — deny-before-allow resolves it fail-CLOSED, and a
  // test above pins that. Forbidden HERE because the two keys mean different things,
  // and an identity in both makes `brain:approve`'s refusal say "a review identity may
  // never sign an approval" about a coding agent: a correct refusal with a false reason,
  // which is the defect class #510 closed in adrPresence.
  assert.deepEqual(overlap, [],
    `identities in BOTH governance.agentActors and governance.reviewActors: ${overlap.join(', ')} — `
    + 'the two keys name different roles, and conflating them makes the refusal messages lie.');
});
