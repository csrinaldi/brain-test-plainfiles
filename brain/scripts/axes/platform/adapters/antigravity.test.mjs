// scripts/axes/platform/adapters/antigravity.test.mjs — unit + end-to-end dispatch
// tests for the `antigravity` SDD_HARNESS backend (issue #256, B2 Half 1).
//
// (a) compileAgentsMd(): pure compiler — provenance banner + verbatim splice
//     of all 5 SOURCE_DOCS + determinism (Phase 1, REQ-B2-2).
// (b) init(): seam-injected wrapper — reads 5 docs, writes AGENTS_EMIT_PATH,
//     never throws (Phase 2, REQ-B2-1/2).
// (c) end-to-end: real dispatch('antigravity', 'init', []) through the
//     UNMODIFIED harness/cli.mjs dispatch path — proves n=3 with zero
//     cli.mjs change (REQ-B2-1). HERMETIC BY CONSTRUCTION: the test injects
//     a capturing fake `_writeAgents`, so `init()` reads the REAL 5
//     SOURCE_DOCS (default `_readDoc`) but NEVER touches the tracked
//     `AGENTS.md` on disk. A fresh-context review (post-apply) found the
//     earlier version wrote the real file as a side effect — masked by file
//     ordering (the drift-guard happened to run first) but fragile: on
//     reorder/parallelization, this test would "heal" a hand-edited
//     `AGENTS.md` BEFORE the drift-guard could catch it, silently defeating
//     the whole #601 ignoreList classification. The committed `AGENTS.md`'s
//     regeneration is now EXCLUSIVELY a deliberate CLI act:
//     `AGENT_PLATFORM=antigravity node brain/scripts/harness/cli.mjs init`
//     (task 3.1) — never a side effect of `npm test`.
//
// Run with: npm test.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// RED: fails until antigravity.mjs exists and exports these.
import { SOURCE_DOCS, AGENTS_EMIT_PATH, GEMINI_SETTINGS_EMIT_PATH, compileAgentsMd, init } from './antigravity.mjs';
import { compileSettingsHooksJson } from '../lib/settings-hooks.mjs';
import { dispatch } from '../../../harness/cli.mjs';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..', '..');

/** Capture console.warn lines while calling fn(). Returns fn()'s resolved value. */
async function captureWarn(fn) {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));
  let result;
  try { result = await fn(); } finally { console.warn = orig; }
  return { warnings, result };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const FAKE_DOCS = {
  'brain/HOME.md': 'FAKE-HOME-NAV-CONTENT — links to core/methodology/*.md',
  'brain/core/methodology/agent-authorities.md':
    'FAKE-TIER-TABLE\n| Tier 1 | Autonomous |\n| Tier 2 | Confirm |\n| Tier 3 | Prohibited |',
  'brain/core/methodology/harness-contract.md': 'FAKE-VERB-TABLE\n| npm run brain:env:init | ... |',
  'brain/core/methodology/sdd-layout.md': 'FAKE-SDD-LAYOUT — proposal.md, spec.md, design.md, tasks.md',
  'brain/core/methodology/workflow-governance.md':
    'FAKE-GATE-LIST\n| issue-link | size:exception | diff-size |',
};

// ── (a) compileAgentsMd() — pure compiler ────────────────────────────────────

test('1.1: compileAgentsMd() returns a provenance banner naming all 5 SOURCE_DOCS paths, "generated from ... — do not edit"', () => {
  const out = compileAgentsMd(FAKE_DOCS);
  assert.match(out, /generated from/);
  assert.match(out, /— do not edit/);
  for (const path of SOURCE_DOCS) {
    assert.ok(out.includes(path), `banner must name source path "${path}"`);
  }
});

test('1.1: compileAgentsMd() splices the agent-authorities.md fake content verbatim (byte-for-byte substring)', () => {
  const out = compileAgentsMd(FAKE_DOCS);
  assert.ok(
    out.includes(FAKE_DOCS['brain/core/methodology/agent-authorities.md']),
    'agent-authorities.md content must be reproduced verbatim (Tier table unmodified)',
  );
});

test('1.1: compileAgentsMd() output is traceable to each of the other 4 fake docs (HOME nav, verb table, sdd-layout, gate list)', () => {
  const out = compileAgentsMd(FAKE_DOCS);
  assert.ok(out.includes(FAKE_DOCS['brain/HOME.md']));
  assert.ok(out.includes(FAKE_DOCS['brain/core/methodology/harness-contract.md']));
  assert.ok(out.includes(FAKE_DOCS['brain/core/methodology/sdd-layout.md']));
  assert.ok(out.includes(FAKE_DOCS['brain/core/methodology/workflow-governance.md']));
});

test('1.3: SOURCE_DOCS is a frozen array of exactly the 5 paths, in the design\'s exact order', () => {
  assert.deepEqual(SOURCE_DOCS, [
    'brain/HOME.md',
    'brain/core/methodology/agent-authorities.md',
    'brain/core/methodology/harness-contract.md',
    'brain/core/methodology/sdd-layout.md',
    'brain/core/methodology/workflow-governance.md',
  ]);
  assert.ok(Object.isFrozen(SOURCE_DOCS), 'SOURCE_DOCS must be frozen');
});

test('1.3: AGENTS_EMIT_PATH === "AGENTS.md"', () => {
  assert.equal(AGENTS_EMIT_PATH, 'AGENTS.md');
});

test('1.4: compileAgentsMd() is deterministic — same docs map twice yields byte-identical output', () => {
  const first = compileAgentsMd(FAKE_DOCS);
  const second = compileAgentsMd(FAKE_DOCS);
  assert.equal(first, second);
});

// ── (a2) compileAgentsMd() — relative link rebasing ──────────────────────────
// CP-B2 inaugural-read finding (owner ruling, fixed in-PR): verbatim splicing
// alone breaks relative markdown links. A link is correct only from ITS OWN
// source doc's location — spliced unmodified into AGENTS.md at repo root, the
// SAME relative link resolves to a DIFFERENT (often outside-the-repo) target.
// Antigravity follows the file (Exp 4, #604) — a broken link is a real
// consumer defect, not cosmetic. Fixture, isolated from FAKE_DOCS above so
// the byte-for-byte verbatim assertions (which use link-free fixtures) stay
// unaffected by link rewriting.

const LINK_DOCS = {
  'brain/HOME.md':
    '[Adoption guide](../docs/adoption.md)\n' +
    '[Harness contract](core/methodology/harness-contract.md)\n' +
    '[External](https://example.com/x.md)\n' +
    '[Anchor only](#section)\n' +
    '[Already root-relative](/already/root.md)\n' +
    '[Mail](mailto:foo@bar.com)\n',
  'brain/core/methodology/agent-authorities.md': '[Anti-patterns](../anti-patterns/README.md)\n',
  'brain/core/methodology/harness-contract.md': '',
  'brain/core/methodology/sdd-layout.md': '',
  'brain/core/methodology/workflow-governance.md': '',
};

test('link-rebase: a brain/HOME.md-relative "../docs/adoption.md" link rebases to "docs/adoption.md" from repo-root AGENTS.md', () => {
  const out = compileAgentsMd(LINK_DOCS);
  assert.ok(out.includes('(docs/adoption.md)'), 'rebased link must resolve correctly from repo root');
  assert.ok(!out.includes('(../docs/adoption.md)'), 'the un-rebased original relative link must not survive');
});

test('link-rebase: a brain/HOME.md same-dir-relative "core/methodology/harness-contract.md" link rebases to "brain/core/methodology/harness-contract.md"', () => {
  const out = compileAgentsMd(LINK_DOCS);
  assert.ok(out.includes('(brain/core/methodology/harness-contract.md)'));
});

test('link-rebase: a methodology-doc-relative link is rebased through ITS OWN source dir, not brain/HOME.md\'s', () => {
  const out = compileAgentsMd(LINK_DOCS);
  // agent-authorities.md lives at brain/core/methodology/ — "../anti-patterns/README.md"
  // from there resolves to brain/core/anti-patterns/README.md.
  assert.ok(out.includes('(brain/core/anti-patterns/README.md)'));
});

test('link-rebase: absolute URLs, pure anchors, mailto:, and already-root-relative links are left untouched', () => {
  const out = compileAgentsMd(LINK_DOCS);
  assert.ok(out.includes('(https://example.com/x.md)'));
  assert.ok(out.includes('(#section)'));
  assert.ok(out.includes('(/already/root.md)'));
  assert.ok(out.includes('(mailto:foo@bar.com)'));
});

test('link-rebase: compileAgentsMd() over the REAL 5 SOURCE_DOCS rebases brain/HOME.md\'s real "../docs/adoption.md" link', () => {
  const docs = {};
  for (const relPath of SOURCE_DOCS) {
    docs[relPath] = readFileSync(join(REPO_ROOT, relPath), 'utf8');
  }
  const out = compileAgentsMd(docs);
  assert.ok(out.includes('(docs/adoption.md)'), 'the real HOME.md link must rebase to resolve from repo root');
  assert.ok(!out.includes('(../docs/adoption.md)'), 'the real, un-rebased relative link must not survive');
});

// ── (b) init() — seam-injected wrapper ───────────────────────────────────────

test('2.1: init() calls _readDoc once per SOURCE_DOCS path (in order) and _writeAgents exactly once with AGENTS_EMIT_PATH and compileAgentsMd()\'s output', async () => {
  const readCalls = [];
  const writeCalls = [];
  const _readDoc = (relPath) => { readCalls.push(relPath); return FAKE_DOCS[relPath]; };
  const _writeAgents = (relPath, content) => writeCalls.push({ relPath, content });
  const _writeGeminiSettings = () => {};

  const result = await init({ _readDoc, _writeAgents, _writeGeminiSettings, _repoRoot: '/fake/repo' });

  assert.deepEqual(readCalls, SOURCE_DOCS);
  assert.equal(writeCalls.length, 1);
  assert.equal(writeCalls[0].relPath, AGENTS_EMIT_PATH);
  assert.equal(writeCalls[0].content, compileAgentsMd(FAKE_DOCS));

  // REQ: on the all-readable, all-writable happy path, init()'s resolved
  // value reports nothing missing and both writes as successful.
  assert.deepEqual(result, { missingDocs: [], agentsWritten: true, geminiWritten: true });
});

test('1.2: init() resolves with missingDocs naming the one path _readDoc threw for', async () => {
  const _readDoc = (relPath) => {
    if (relPath === 'brain/core/methodology/sdd-layout.md') throw new Error('boom-read');
    return FAKE_DOCS[relPath];
  };
  const _writeAgents = () => {};
  // Hermetic by construction (matches 2.1's fix, remediation batch): without
  // this, init()'s real default writer runs against '/fake/repo/.gemini' and
  // its outcome depends on ambient filesystem permissions, not on anything
  // this test asserts.
  const _writeGeminiSettings = () => {};

  const { result } = await captureWarn(() =>
    init({ _readDoc, _writeAgents, _writeGeminiSettings, _repoRoot: '/fake/repo' }),
  );

  assert.deepEqual(result.missingDocs, ['brain/core/methodology/sdd-layout.md']);
});

test('1.3: init() resolves with agentsWritten: false when _writeAgents throws, and still resolves (never throws)', async () => {
  const _readDoc = (relPath) => FAKE_DOCS[relPath];
  const _writeAgents = () => { throw new Error('boom-write'); };
  // Hermetic by construction (matches 2.1's fix, remediation batch) — see 1.2.
  const _writeGeminiSettings = () => {};

  const { result } = await captureWarn(() =>
    init({ _readDoc, _writeAgents, _writeGeminiSettings, _repoRoot: '/fake/repo' }),
  );

  assert.equal(result.agentsWritten, false);
});

test('1.4: init() resolves with geminiWritten: false when _writeGeminiSettings throws', async () => {
  const _readDoc = (relPath) => FAKE_DOCS[relPath];
  const _writeAgents = () => {};
  const _writeGeminiSettings = () => { throw new Error('boom-gemini-write'); };

  const { result } = await captureWarn(() =>
    init({ _readDoc, _writeAgents, _writeGeminiSettings, _repoRoot: '/fake/repo' }),
  );

  assert.equal(result.geminiWritten, false);
});

test('1.5: init()\'s resolved object has no "ok" property under any read/write failure combination, so harness/cli.mjs\'s r.ok === false check never matches', async () => {
  const throwingReadDoc = () => { throw new Error('boom-read-all'); };
  const throwingWrite = () => { throw new Error('boom-write-all'); };

  const { result: allFailed } = await captureWarn(() =>
    init({ _readDoc: throwingReadDoc, _writeAgents: throwingWrite, _writeGeminiSettings: throwingWrite, _repoRoot: '/fake/repo' }),
  );
  const { result: allPassed } = await captureWarn(() =>
    init({ _readDoc: (relPath) => FAKE_DOCS[relPath], _writeAgents: () => {}, _writeGeminiSettings: () => {}, _repoRoot: '/fake/repo' }),
  );

  for (const r of [allFailed, allPassed]) {
    assert.ok(!Object.prototype.hasOwnProperty.call(r, 'ok'), 'resolved value must not have an "ok" property');
  }
});

test('2.3: init() never throws when _readDoc throws on one path — warns and still writes', async () => {
  const _readDoc = (relPath) => {
    if (relPath === 'brain/core/methodology/sdd-layout.md') throw new Error('boom-read');
    return FAKE_DOCS[relPath];
  };
  let wrote = false;
  const _writeAgents = () => { wrote = true; };

  const { warnings } = await captureWarn(() =>
    init({ _readDoc, _writeAgents, _writeGeminiSettings: () => {}, _repoRoot: '/fake/repo' }),
  );

  assert.ok(warnings.some((w) => w.includes('sdd-layout.md')), 'must warn naming the failing path');
  assert.equal(wrote, true, 'must still attempt the write with the docs it could read');
});

test('2.3: init() never throws when _writeAgents throws — warns, resolves', async () => {
  const _readDoc = (relPath) => FAKE_DOCS[relPath];
  const _writeAgents = () => { throw new Error('boom-write'); };

  const { warnings } = await captureWarn(() =>
    init({ _readDoc, _writeAgents, _writeGeminiSettings: () => {}, _repoRoot: '/fake/repo' }),
  );

  assert.ok(warnings.some((w) => w.includes('boom-write')));
});

// ── (c) end-to-end: real dispatch through the UNMODIFIED cli.mjs ────────────
// HERMETIC: injects a capturing fake `_writeAgents` so init() compiles from
// the REAL 5 SOURCE_DOCS (default `_readDoc`, real repoRoot) but the write
// lands in memory, never on the tracked AGENTS.md. Regenerating the real,
// committed AGENTS.md is a separate, deliberate CLI act (task 3.1) — never a
// side effect of running this test suite.

test('2.4: dispatch("antigravity", "init", [opts]) resolves through the REAL cli.mjs dispatch path with zero cli.mjs change, compiling the real 5 SOURCE_DOCS to a scratch (non-disk) target — never the tracked AGENTS.md', async () => {
  const scratchWrites = [];
  const _writeAgents = (relPath, content) => scratchWrites.push({ relPath, content });

  const settingsWrites = [];
  const _writeGeminiSettings = (relPath, content) => settingsWrites.push({ relPath, content });

  const result = await dispatch('antigravity', 'init', [{ _writeAgents, _writeGeminiSettings }]);

  // Injected too: without it the default writer lands on the REAL tracked
  // .gemini/settings.json (#616), which is what let a mutated compiler repair
  // the file the drift-guard compares against.
  assert.equal(settingsWrites.length, 1);
  assert.equal(settingsWrites[0].relPath, GEMINI_SETTINGS_EMIT_PATH);

  assert.equal(scratchWrites.length, 1, '_writeAgents must be called exactly once');
  assert.equal(scratchWrites[0].relPath, AGENTS_EMIT_PATH);
  assert.match(scratchWrites[0].content, /generated from/);
  assert.match(scratchWrites[0].content, /— do not edit/);

  // The real 5 SOURCE_DOCS are all readable and both writes succeed against
  // this fixture, so the resolved report is the happy-path shape too.
  assert.deepEqual(result, { missingDocs: [], agentsWritten: true, geminiWritten: true });
});

test('2.5: n=3 — antigravity, plain, and gentle-ai all resolve through dispatch() to a real init() export', async () => {
  const antigravity = await import('./antigravity.mjs');
  const plain = await import('../../sdd-engine/adapters/plain.mjs');
  const gentleAi = await import('../../sdd-engine/adapters/gentle-ai.mjs');
  assert.equal(typeof antigravity.init, 'function');
  assert.equal(typeof plain.init, 'function');
  assert.equal(typeof gentleAi.init, 'function');
});

// ── issue #305: .gemini/settings.json emission ───────────────────────────────

test('GEMINI_SETTINGS_EMIT_PATH === ".gemini/settings.json"', () => {
  assert.equal(GEMINI_SETTINGS_EMIT_PATH, '.gemini/settings.json');
});

test('compileSettingsHooksJson() emits valid JSON with SessionStart and PreToolUse hooks', () => {
  const jsonStr = compileSettingsHooksJson();
  const parsed = JSON.parse(jsonStr);

  assert.ok(parsed.hooks);
  assert.ok(Array.isArray(parsed.hooks.PreToolUse));
  assert.ok(Array.isArray(parsed.hooks.SessionStart));

  const sessionStartHook = parsed.hooks.SessionStart[0].hooks[0].command;
  assert.equal(sessionStartHook, 'npm run brain:session:start');

  const preToolUseHook = parsed.hooks.PreToolUse[0].hooks[0].command;
  assert.match(preToolUseHook, /--no-verify/);
});

// ── issue #1139: init() must merge .gemini/settings.json, not overwrite it ──

test('init(): an existing .gemini/settings.json with permissions.allow and a custom hook survives, brain hooks are current (REQ-1139-5)', async () => {
  const customEntry = { matcher: 'Read', hooks: [{ type: 'command', command: 'my-custom-hook' }] };
  const existing = {
    permissions: { allow: ['Bash(a:*)', 'Bash(b:*)'] },
    hooks: { PreToolUse: [customEntry] },
  };
  const _readDoc = (relPath) => FAKE_DOCS[relPath];
  const _writeAgents = () => {};
  const _readGeminiSettings = () => JSON.stringify(existing);
  const settingsWrites = [];
  const _writeGeminiSettings = (relPath, content) => settingsWrites.push({ relPath, content });

  await init({ _readDoc, _writeAgents, _readGeminiSettings, _writeGeminiSettings, _repoRoot: '/fake/repo' });

  assert.equal(settingsWrites.length, 1);
  const written = JSON.parse(settingsWrites[0].content);
  assert.deepEqual(written.permissions.allow, ['Bash(a:*)', 'Bash(b:*)']);
  const preToolUse = written.hooks.PreToolUse;
  assert.ok(preToolUse.some((e) => JSON.stringify(e) === JSON.stringify(customEntry)),
    'consumer custom hook must survive');
  const brainPreToolUse = JSON.parse(compileSettingsHooksJson()).hooks.PreToolUse;
  for (const brainEntry of brainPreToolUse) {
    assert.ok(preToolUse.some((e) => JSON.stringify(e) === JSON.stringify(brainEntry)),
      'brain hook entry must be present and current');
  }
});

test('init(): running twice against the same existing .gemini/settings.json content is idempotent (REQ-1139-5)', async () => {
  const existing = { permissions: { allow: ['x'] }, hooks: { PreToolUse: [] } };
  const _readDoc = (relPath) => FAKE_DOCS[relPath];
  const _writeAgents = () => {};

  const firstWrites = [];
  await init({
    _readDoc, _writeAgents,
    _readGeminiSettings: () => JSON.stringify(existing),
    _writeGeminiSettings: (relPath, content) => firstWrites.push({ relPath, content }),
    _repoRoot: '/fake/repo',
  });
  const firstContent = firstWrites[0].content;

  const secondWrites = [];
  await init({
    _readDoc, _writeAgents,
    _readGeminiSettings: () => firstContent,
    _writeGeminiSettings: (relPath, content) => secondWrites.push({ relPath, content }),
    _repoRoot: '/fake/repo',
  });

  assert.equal(secondWrites[0].content, firstContent, 'second init() must produce byte-identical output');
});

test('init(): no existing .gemini/settings.json writes brain settings exactly as before (REQ-1139-5)', async () => {
  const _readDoc = (relPath) => FAKE_DOCS[relPath];
  const _writeAgents = () => {};
  const _readGeminiSettings = () => null;
  const settingsWrites = [];
  const _writeGeminiSettings = (relPath, content) => settingsWrites.push({ relPath, content });

  await init({ _readDoc, _writeAgents, _readGeminiSettings, _writeGeminiSettings, _repoRoot: '/fake/repo' });

  assert.equal(settingsWrites.length, 1);
  assert.equal(settingsWrites[0].content, compileSettingsHooksJson());
});

test('init(): a malformed existing .gemini/settings.json is never overwritten and the failure is reported without an "ok" property (REQ-1139-5)', async () => {
  const _readDoc = (relPath) => FAKE_DOCS[relPath];
  const _writeAgents = () => {};
  const _readGeminiSettings = () => '{ not valid json';
  const settingsWrites = [];
  const _writeGeminiSettings = (relPath, content) => settingsWrites.push({ relPath, content });

  const { result } = await captureWarn(() =>
    init({ _readDoc, _writeAgents, _readGeminiSettings, _writeGeminiSettings, _repoRoot: '/fake/repo' }),
  );

  assert.equal(settingsWrites.length, 0, 'the write seam must never be invoked on a malformed file');
  assert.equal(result.geminiWritten, false);
  assert.match(result.geminiSettingsError, /\.gemini\/settings\.json/, 'must name the offending file');
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'ok'),
    'antigravity init() must never gain an "ok" property (pinned by test 1.5)');
});

// ═══════════════════════════════════════════════════════════════════════════
// REQ-509-6 — the AGENTS.md compiler no longer fails open for a new caller
// ═══════════════════════════════════════════════════════════════════════════

test('REQ-509-6: compileAgentsMd THROWS on an array — the shape a new caller reaches for first', () => {
  const docs = SOURCE_DOCS.map(() => 'content');
  assert.throws(() => compileAgentsMd(docs), /array|missing/i);
});

test('REQ-509-6: compileAgentsMd THROWS on a map missing one key, and names the key', () => {
  const docs = {};
  for (const rel of SOURCE_DOCS) docs[rel] = 'content';
  delete docs['brain/HOME.md'];
  assert.throws(() => compileAgentsMd(docs), /brain\/HOME\.md/);
});

test('REQ-509-6: the old fail-open would have produced a plausible file — proof the throw is load-bearing', () => {
  const complete = {};
  for (const rel of SOURCE_DOCS) complete[rel] = 'content';
  const good = compileAgentsMd(complete);
  const empty = {};
  for (const rel of SOURCE_DOCS) empty[rel] = '';
  const gutted = compileAgentsMd(empty);
  // Both are well-formed AGENTS.md files with the same banner and the same five
  // section headers. That is exactly why the old `?? ''` fallback was invisible:
  // the gutted output does not look like an error.
  assert.match(gutted, /generated from/);
  assert.equal(gutted.split('<!-- source: ').length, good.split('<!-- source: ').length);
  assert.ok(gutted.length < good.length);
});

test('antigravity declares no agent runtime probe — it ships no version-queryable CLI (issue #123)', async () => {
  const { AGENT_RUNTIME } = await import('./antigravity.mjs');
  const { probeAgentRuntime } = await import('../../lib/agent-runtime.mjs');

  // Deliberately null, and asserted so: the export must EXIST so the seam is
  // uniform across backends, and a future antigravity CLI turns this into a
  // one-line descriptor rather than a new mechanism.
  assert.equal(AGENT_RUNTIME, null);
  assert.equal(probeAgentRuntime(AGENT_RUNTIME).state, 'not-declared');
});

// ── No test may write a tracked file (issue #616) ────────────────────────────

test('2.6: no test in this file can reach the REAL emit paths', () => {
  // The previous version of this test took an mtime snapshot and injected both
  // seams itself, so it could not observe a write by construction — and node:test
  // runs top-level tests in order, so 2.4 had already written before the snapshot
  // was taken. It passed while the tracked file was being rewritten (measured:
  // 23/23 green, mtime moved, `git status` clean). A test that cannot fail for
  // the reason it names is worse than no test.
  //
  // The property is checked at the source level instead, the same way
  // brain-upgrade.test.mjs pins its merge targets: every test that reaches
  // init() must either point it at a fake root or inject BOTH write seams.
  // Deleting an injection now fails HERE, not only inside the test that owns it.
  const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
  const blocks = source.split(/\ntest\(/).slice(1);
  assert.ok(blocks.length >= 10, `expected the test blocks, found ${blocks.length} — the split is wrong`);

  const offenders = [];
  let reaching = 0;
  for (const block of blocks) {
    const title = block.slice(0, block.indexOf("'", 1) + 1);
    // Body only — scanning the title too made a test whose NAME says "init()"
    // read as a call site (measured: 2.5 flagged while calling nothing).
    const arrow = block.indexOf('=> {');
    const body = arrow === -1 ? '' : block.slice(arrow, block.indexOf('\n});'));
    const callsInit = /\binit\(|dispatch\(\s*'antigravity',\s*'init'/.test(body);
    if (!callsInit) continue;
    if (title.includes('2.6:')) continue;               // this test reads source, never calls init
    reaching++;
    const fakeRoot = /_repoRoot:\s*'\/fake/.test(body);
    const bothSeams = body.includes('_writeAgents') && body.includes('_writeGeminiSettings');
    if (!fakeRoot && !bothSeams) offenders.push(title);
  }

  // Evidence floor: a scan that matched no init() call site would report no
  // offenders and pass while proving nothing.
  assert.ok(reaching >= 3, `only ${reaching} test(s) reach init() — the scan is not finding them`);
  assert.deepEqual(
    offenders,
    [],
    `these tests call init() against the REAL repo root without injecting both write seams, ` +
      `so the default writer lands on the tracked emit paths (#616): ${offenders.join(', ')}`,
  );
});
