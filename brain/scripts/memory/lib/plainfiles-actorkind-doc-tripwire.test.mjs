// plainfiles-actorkind-doc-tripwire.test.mjs — Hardening 2 (owner ruling, obs
// #578): the concrete, event-detectable tripwire. A tracked doc that
// instructs a human to run `memory save` / `MEMORY_BACKEND=plainfiles
// memory save` WITHOUT an adjacent reference to the actorKind decision must
// fail this scan; with the reference, it passes. A third assertion runs the
// guard against the REAL tracked docs (default `git ls-files` seam) — this
// MUST currently report clean.
//
// The guard lives HERE (inline, the test file's companion lib — tasks.md
// 3.4's explicitly sanctioned alternative to a separate lib/ module) since
// it is pure test-support tooling with no production call site: this is a
// coverage/CI gate, not runtime code any backend imports.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

import { CHANGES_ROOT } from '../../lib/sdd-layout.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

// The literal invocation this tripwire cares about, either form.
const SAVE_INVOCATION = "(memory\\s+save\\b|MEMORY_BACKEND=plainfiles\\s+memory\\s+save\\b)";

// Matches an imperative instruction (en + es) near the literal invocation —
// broadened past run/execute/ejecutar (fresh-context review MINOR 1) to also
// catch invoke/type/use/paste and the Spanish corré/usá/pegá family. The
// word-end lookahead (not a trailing \b) is deliberate: \b fails after an
// accented vowel (é/á are not \w), which would silently un-match "corré".
const VERBS = "run|ejecut\\w*|execute|invoke|type|use|us[aá]\\w*|paste|peg[aá]\\w*|corr[eé]\\w*";
const WORD_END = "(?![\\wáéíóúñ])";
const INSTRUCTION_RE = new RegExp(`\\b(?:${VERBS})${WORD_END}[\\s\\S]{0,60}?${SAVE_INVOCATION}`, "i");

// A BARE fenced code block containing the literal invocation, with no
// imperative prose required nearby — a fenced command is itself an implicit
// "run this" instruction (fresh-context review MINOR 1).
const FENCE_RE = new RegExp("```[\\s\\S]*?" + SAVE_INVOCATION + "[\\s\\S]*?```", "i");

// A reference to the actorKind decision the ruling requires alongside any such instruction.
// #738 (provenance at capture) is accepted alongside obs #578: the doc edits
// this change makes (memory-format.md's `git config --local brain.actor`
// remedy, near a `memory save` invocation) must carry a decision anchor too.
const DECISION_REFERENCE_RE = /(sdd\/issue-246-c3\/constraints|obs\s*#?578|actorKind decision|actorKind ruling|#738)/i;

// SDD planning artifacts (spec.md/design.md/tasks.md/proposal.md, etc.) under
// openspec/changes/** legitimately discuss `memory save` at length while
// SPECIFYING the feature — they are not runbooks instructing a human, and
// must never trip the tripwire purely for describing what they design.
// Consolidated onto sdd-layout.mjs's CHANGES_ROOT (B1, REQ-B1-3, design §3) —
// no independent `openspec/changes` literal in this test file anymore.
const EXEMPT_PATH_RE = new RegExp(`^${CHANGES_ROOT}/`);

function _defaultListTrackedMarkdownFiles(root) {
  const r = spawnSync('git', ['ls-files', '*.md'], { encoding: 'utf8', cwd: root });
  if (r.status !== 0) return [];
  return (r.stdout ?? '').split('\n').filter(Boolean);
}

function _defaultReadFile(root, relPath) {
  return readFileSync(join(root, relPath), 'utf8');
}

/**
 * scanDocsForActorKindTripwire() — reports every tracked doc that instructs
 * a human to run `memory save` under plainfiles WITHOUT an adjacent
 * reference to the actorKind decision.
 *
 * @param {{root?: string, _listFiles?: Function, _readFile?: Function}} [opts]
 * @returns {{clean: boolean, violations: string[]}}
 */
function scanDocsForActorKindTripwire({
  root = repoRoot,
  _listFiles = _defaultListTrackedMarkdownFiles,
  _readFile = _defaultReadFile,
} = {}) {
  const violations = [];
  for (const relPath of _listFiles(root)) {
    if (EXEMPT_PATH_RE.test(relPath)) continue; // SDD planning artifact — never flagged
    let text;
    try {
      text = _readFile(root, relPath);
    } catch {
      continue; // vanished/unreadable between list and read — best-effort, never throw
    }
    const instructs = INSTRUCTION_RE.test(text) || FENCE_RE.test(text);
    if (instructs && !DECISION_REFERENCE_RE.test(text)) {
      violations.push(relPath);
    }
  }
  return { clean: violations.length === 0, violations };
}

const VIOLATING_DOC = `
# Some runbook

To store a decision by hand, run \`MEMORY_BACKEND=plainfiles memory save "title" "content"\`.
`;

const CLEAN_DOC_WITH_REFERENCE = `
# Some runbook

To store a decision by hand, run \`MEMORY_BACKEND=plainfiles memory save "title" "content"\`.

See sdd/issue-246-c3/constraints for the actorKind decision before adding a human-authored save path.
`;

const UNRELATED_DOC = `
# Unrelated

Run \`npm test\` before pushing.
`;

test('scanDocsForActorKindTripwire: a doc instructing a human to run memory save WITHOUT the actorKind reference reports a violation', () => {
  const result = scanDocsForActorKindTripwire({
    _listFiles: () => ['docs/inbox/fake-runbook.md'],
    _readFile: () => VIOLATING_DOC,
  });
  assert.equal(result.clean, false, 'a doc instructing memory save without the actorKind reference must fail the scan');
  assert.deepEqual(result.violations, ['docs/inbox/fake-runbook.md']);
});

test('scanDocsForActorKindTripwire: the SAME instruction PLUS an adjacent actorKind-decision reference reports clean', () => {
  const result = scanDocsForActorKindTripwire({
    _listFiles: () => ['docs/inbox/fake-runbook.md'],
    _readFile: () => CLEAN_DOC_WITH_REFERENCE,
  });
  assert.equal(result.clean, true, 'the same instruction with an adjacent actorKind reference must pass the scan');
  assert.deepEqual(result.violations, []);
});

test('scanDocsForActorKindTripwire: a doc with no memory-save instruction at all reports clean', () => {
  const result = scanDocsForActorKindTripwire({
    _listFiles: () => ['docs/inbox/unrelated.md'],
    _readFile: () => UNRELATED_DOC,
  });
  assert.equal(result.clean, true);
});

// #738: the reference alone (no obs #578 / actorKind wording needed).
const CLEAN_DOC_WITH_738_REFERENCE = `
# Some runbook

To store a decision by hand, run \`MEMORY_BACKEND=plainfiles memory save "title" "content"\`.

Unset \`brain.actor\`? Run \`git config --local brain.actor @<handle>\` once per clone (#738).
`;

test('scanDocsForActorKindTripwire: #738 alone is an accepted decision reference, alongside obs #578', () => {
  const result = scanDocsForActorKindTripwire({
    _listFiles: () => ['docs/inbox/fake-runbook-738.md'],
    _readFile: () => CLEAN_DOC_WITH_738_REFERENCE,
  });
  assert.equal(result.clean, true, 'a #738 reference alone must satisfy the tripwire');
  assert.deepEqual(result.violations, []);
});

// ── Live assertion over the REAL tracked docs (default seams) ────────────────

test('scanDocsForActorKindTripwire: the REAL tracked *.md docs report clean today (no doc yet instructs a human plainfiles save)', () => {
  const result = scanDocsForActorKindTripwire();
  assert.equal(
    result.clean,
    true,
    `expected the real tracked docs to be clean; violations: ${JSON.stringify(result.violations)}. ` +
      'If this now fails, a doc was just added that instructs a human to run memory save under ' +
      'plainfiles WITHOUT referencing the actorKind decision (sdd/issue-246-c3/constraints) — add that reference.',
  );
});

// ── Bypass hardening (fresh-context review MINOR 1): other imperative verbs +
// a bare fenced code block with no imperative prose nearby ──────────────────

const INVOKE_BYPASS_DOC = `
# Some runbook

If you need to do this by hand, invoke \`memory save "title" "content"\` from a shell.
`;

const USE_BYPASS_DOC = `
# Some runbook

To store a decision manually, use \`MEMORY_BACKEND=plainfiles memory save "title" "content"\`.
`;

const TYPE_BYPASS_DOC = `
# Some runbook

Type the following at your prompt: \`memory save "title" "content"\`.
`;

const PASTE_BYPASS_DOC = `
# Some runbook

Paste this into your terminal: \`MEMORY_BACKEND=plainfiles memory save "title" "content"\`.
`;

const SPANISH_BYPASS_DOC = `
# Runbook en español

Para guardarlo a mano, corré \`memory save "titulo" "contenido"\` o usá
\`MEMORY_BACKEND=plainfiles memory save "titulo" "contenido"\`.
`;

const FENCE_BYPASS_DOC = `
# Some runbook

Here is the command:

\`\`\`bash
MEMORY_BACKEND=plainfiles memory save "title" "content"
\`\`\`
`;

for (const [label, doc] of [
  ['invoke', INVOKE_BYPASS_DOC],
  ['use', USE_BYPASS_DOC],
  ['type', TYPE_BYPASS_DOC],
  ['paste', PASTE_BYPASS_DOC],
  ['corré/usá (Spanish)', SPANISH_BYPASS_DOC],
  ['bare fenced code block (no imperative prose nearby)', FENCE_BYPASS_DOC],
]) {
  test(`scanDocsForActorKindTripwire: the "${label}" bypass is caught — a violation WITHOUT the actorKind reference`, () => {
    const result = scanDocsForActorKindTripwire({
      _listFiles: () => ['docs/inbox/fake-bypass.md'],
      _readFile: () => doc,
    });
    assert.equal(result.clean, false, `the "${label}" phrasing must be caught as a violation`);
    assert.deepEqual(result.violations, ['docs/inbox/fake-bypass.md']);
  });
}

// The SAME bypass phrasing, but WITH the actorKind-decision reference, must pass.
test('scanDocsForActorKindTripwire: a fenced code block WITH an adjacent actorKind reference reports clean', () => {
  const result = scanDocsForActorKindTripwire({
    _listFiles: () => ['docs/inbox/fake-bypass.md'],
    _readFile: () => `${FENCE_BYPASS_DOC}\n\nSee sdd/issue-246-c3/constraints for the actorKind decision.\n`,
  });
  assert.equal(result.clean, true);
});

// ── No false positives: docs under openspec/changes/** are SDD planning
// artifacts that legitimately discuss `memory save` at length (spec.md/
// design.md/tasks.md/proposal.md) — they must never trip the tripwire purely
// for describing the feature they are specifying. ───────────────────────────

test('scanDocsForActorKindTripwire: a doc under openspec/changes/** is exempt even with no actorKind reference', () => {
  const result = scanDocsForActorKindTripwire({
    _listFiles: () => ['openspec/changes/fake-feature/spec.md'],
    _readFile: () => VIOLATING_DOC,
  });
  assert.equal(result.clean, true, 'openspec/changes/** artifacts must be exempt from the tripwire');
});

// Proxy for "this stays clean once the C3 docs are tracked by git": run the
// guard against the REAL C3 openspec files (currently untracked, so the
// default git-ls-files seam does not see them yet) by injecting their real
// paths/content directly. Confirms the openspec/changes/** exemption covers
// them regardless of the (broadened) instruction regex.
test('scanDocsForActorKindTripwire: the C3 openspec/changes/** docs themselves (spec/design/tasks/proposal) stay clean', () => {
  const c3Files = [
    'openspec/changes/issue-246-c3/spec.md',
    'openspec/changes/issue-246-c3/design.md',
    'openspec/changes/issue-246-c3/tasks.md',
    'openspec/changes/issue-246-c3/proposal.md',
  ];
  const result = scanDocsForActorKindTripwire({
    _listFiles: () => c3Files,
    _readFile: (root, relPath) => readFileSync(join(root, relPath), 'utf8'),
  });
  assert.equal(
    result.clean,
    true,
    `the C3 planning docs must never trip the tripwire on their own design prose; violations: ${JSON.stringify(result.violations)}`,
  );
});
