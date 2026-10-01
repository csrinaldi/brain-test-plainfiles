// readme-version.test.mjs — the README's documented install tag must match the
// current package version, so it never silently drifts on release (#84).
//
// Enforce, don't remember: a version bump that forgets to update README.md fails
// `npm test` → the floor catches the drift before it ships. This is the
// governance principle (ADR-0014) applied to our own docs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

// Brain-source-only: README.md is not a managed path (brain/core/managed-paths.mjs),
// so a consumer's README is its own and carries the consumer's install docs, not
// brain's version tag. Skip outside the brain source repo (detected via the
// .brain-source marker) — this drift guard protects brain's own release, not the
// consumer's.
const skip = existsSync(join(root, '.brain-source'))
  ? false
  : 'brain-source-only artifact (README.md not vendored into consumers)';

test('README references the current package version tag (no drift on release)', { skip }, () => {
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const tag = `#v${version}`;
  assert.ok(
    readme.includes(tag),
    `README.md must reference the current install tag "${tag}" — it drifted from ` +
      `package.json (version ${version}). Update the install/upgrade examples in ` +
      `README.md as part of the release.`,
  );
});
