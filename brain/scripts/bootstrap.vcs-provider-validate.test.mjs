// bootstrap.vcs-provider-validate.test.mjs — issue #1112, finding 2.
//
// bootstrap.sh's interactive VCS-provider prompt used to accept ANY typed
// string and write it verbatim into `vcs.provider` in the TRACKED
// brain.config.json — an operator who answered the prompt with a pasted PAT
// (instead of "github"/"gitlab") got the token committed to a tracked file.
// `governance.memorySecretPatterns` in that same file already lists the PAT
// shape (`ghp_[A-Za-z0-9]{20,}`) a few lines below, unchecked against.
//
// The fix restricts the accepted values to "github"/"gitlab" (ADR-0008's own
// set) or empty (keep the derived default), re-prompting on anything else.
// Restricting to that fixed enum is strictly stronger than scanning against
// memorySecretPatterns for this one write path: no PAT-shaped string can
// ever be one of the two literals.
//
// Same idiom as the other bootstrap.*.test.mjs files: the fragment is LIFTED
// OUT OF bootstrap.sh between two sentinel comments and executed, so there is
// no second copy of the validation logic to drift from the real one (#340).
// The fragment is extracted WITHOUT its outer `[ -t 0 ]` TTY guard so it can
// be driven by piped stdin here.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { removeTempTree } from './__fixtures__/tmp-tree.mjs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BOOTSTRAP = join(dirname(fileURLToPath(import.meta.url)), 'bootstrap.sh');
const LINES = readFileSync(BOOTSTRAP, 'utf8').split('\n');

function vcsProviderValidateFragment() {
  const start = LINES.findIndex((l) => l.includes('BEGIN vcs-provider-validate'));
  assert.ok(start >= 0, 'bootstrap.sh must have a BEGIN vcs-provider-validate marker');
  const end = LINES.findIndex((l, i) => i > start && l.includes('END vcs-provider-validate'));
  assert.ok(end > start, 'bootstrap.sh must have a matching END vcs-provider-validate marker');
  return LINES.slice(start + 1, end).join('\n');
}

// Extracted ONCE, outside any try/catch: a missing-marker AssertionError must
// fail the whole suite loudly, never be swallowed as if it were an ordinary
// shell-exit failure from inside a test's runFragment() call.
const FRAGMENT = vcsProviderValidateFragment();

/**
 * Runs the extracted fragment with VCS_PROVIDER preset, feeding `stdinLines`
 * (one `read -r -p` answer per line) and a real brain.config.json in a temp
 * cwd. Returns the final parsed config and stderr (for the rejection message).
 */
function runFragment({ derivedProvider, stdinLines, initialProvider }) {
  const dir = mkdtempSync(join(tmpdir(), 'brain-1112-vcsprovider-'));
  try {
    writeFileSync(
      join(dir, 'brain.config.json'),
      JSON.stringify({ vcs: { provider: initialProvider ?? derivedProvider } }, null, 2) + '\n',
    );
    const script = [
      'set -euo pipefail',
      `cd "${dir}"`,
      `VCS_PROVIDER="${derivedProvider}"`,
      FRAGMENT,
    ].join('\n');

    const result = spawnSync('bash', ['-c', script], {
      input: stdinLines.join('\n') + '\n',
      encoding: 'utf8',
    });
    const config = JSON.parse(readFileSync(join(dir, 'brain.config.json'), 'utf8'));
    return { config, stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
  } finally {
    removeTempTree(dir);
  }
}

test('#1112 an invalid provider (e.g. a pasted token) is rejected and never written to brain.config.json', () => {
  const { config } = runFragment({
    derivedProvider: 'github',
    stdinLines: ['ghp_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'github'],
  });
  assert.equal(config.vcs.provider, 'github', 'the invalid answer must never land in the tracked config');
});

test('#1112 the rejection is reported, not silent', () => {
  const { stderr } = runFragment({
    derivedProvider: 'github',
    stdinLines: ['not-a-provider', 'gitlab'],
  });
  assert.match(stderr, /Unknown provider/);
  assert.match(stderr, /not-a-provider/);
});

test('#1112 a valid provider on the first answer still works (no regression)', () => {
  const { config } = runFragment({
    derivedProvider: 'gitlab',
    stdinLines: ['github'],
  });
  assert.equal(config.vcs.provider, 'github');
});

test('#1112 an empty answer keeps the derived provider and writes nothing', () => {
  const { config } = runFragment({
    derivedProvider: 'github',
    initialProvider: 'github',
    stdinLines: [''],
  });
  assert.equal(config.vcs.provider, 'github');
});

test('#1112 re-prompts as many times as needed before accepting a valid value', () => {
  const { config, stderr } = runFragment({
    derivedProvider: 'github',
    stdinLines: ['x', 'y', 'z', 'gitlab'],
  });
  assert.equal(config.vcs.provider, 'gitlab');
  const rejections = (stderr.match(/Unknown provider/g) || []).length;
  assert.equal(rejections, 3, `expected exactly 3 rejections before the valid answer; stderr:\n${stderr}`);
});
