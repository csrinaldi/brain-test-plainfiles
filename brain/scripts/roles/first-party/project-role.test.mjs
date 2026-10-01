// project-role.test.mjs — issue #576 T3: projection is byte-deterministic,
// namespaced, and guarded. The goldens are COMMITTED files: the guard is
// projection-vs-golden, so a hand edit on either side fails naming the truth.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { projectRole, PROJECTION_PLATFORMS } from './project-role.mjs';
import { VERIFIER_REVIEW } from './verifier-review.mjs';
import { ADVERSARY_COLD_REVIEW } from './adversary-cold-review.mjs';
import { compileAgentsMd, SOURCE_DOCS } from '../../axes/platform/adapters/antigravity.mjs';

test('#576 T3: same input, same bytes — twice, on both platforms', () => {
  for (const platform of PROJECTION_PLATFORMS) {
    const a = projectRole(VERIFIER_REVIEW, platform);
    const b = projectRole(VERIFIER_REVIEW, platform);
    assert.deepEqual(a, b, `${platform}: no dates, no environment`);
  }
});

test('#576 T3: claude projection is namespaced brain-* — the collision guard for operator-owned agents', () => {
  const { relPath, text } = projectRole(VERIFIER_REVIEW, 'claude');
  assert.equal(relPath, '.claude/agents/brain-verifier-review.md');
  assert.match(text, /^---\nname: brain-verifier-review\n/, 'frontmatter opens the file');
  assert.ok(!/^model:/m.test(text), 'model is OMITTED — tier and chooses_model belong to routing, not the projected file');
  assert.ok(text.includes(VERIFIER_REVIEW.text), 'the role text travels verbatim');
});

test('#576 T3: an unknown platform is refused — frameworks DECLARE, they are never projection targets (D6)', () => {
  assert.throws(() => projectRole(VERIFIER_REVIEW, 'gentle-ai'), /platform/);
});

test('#576 T3: compileAgentsMd without roles produces TODAY\'s bytes — backward identity, proven not promised', () => {
  const docs = {};
  for (const rel of SOURCE_DOCS) docs[rel] = readFileSync(new URL(`../../../../${rel}`, import.meta.url), 'utf8');
  const before = compileAgentsMd(docs);
  const withEmpty = compileAgentsMd(docs, {});
  assert.equal(withEmpty, before, 'the second parameter omitted or empty must not move a byte');
});

test('#576 T3: compileAgentsMd with roles appends the section, deterministically', () => {
  const docs = {};
  for (const rel of SOURCE_DOCS) docs[rel] = readFileSync(new URL(`../../../../${rel}`, import.meta.url), 'utf8');
  const a = compileAgentsMd(docs, { roles: [VERIFIER_REVIEW] });
  const b = compileAgentsMd(docs, { roles: [VERIFIER_REVIEW] });
  assert.equal(a, b);
  assert.ok(a.startsWith(compileAgentsMd(docs)), 'the base document is untouched — the section APPENDS');
  assert.match(a, /## First-party roles/);
  assert.ok(a.includes(VERIFIER_REVIEW.text));
});

test('#576 T3: the committed goldens ARE the projections — the drift guard, both directions', () => {
  const claude = projectRole(VERIFIER_REVIEW, 'claude');
  assert.equal(
    readFileSync(new URL('./__fixtures__/goldens/brain-verifier-review.claude.md', import.meta.url), 'utf8'),
    claude.text,
    'hand-editing the golden OR the source must fail here, naming the truth',
  );
  const adversary = projectRole(ADVERSARY_COLD_REVIEW, 'claude');
  assert.equal(
    readFileSync(new URL('./__fixtures__/goldens/brain-adversary-cold-review.claude.md', import.meta.url), 'utf8'),
    adversary.text,
  );
});
