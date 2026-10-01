#!/usr/bin/env node
// port-coverage.mjs — M10 Phase 1 (#336): the port's contract coverage,
// measured rather than remembered.
//
// WHY A SCRIPT AND NOT A DOCUMENT. `prReviews` stayed unpinned until it broke
// the reviewer subsystem (#317), and the only thing that could have told
// anyone was a hand-grep nobody ran. A table written by hand answers the
// question once, on the day it is written; this answers it on the day it is
// asked.
//
// DETECTION ONLY (#336, explicit): it reports the surface and changes nothing.
// No new contract test, no new fixture, no adapter edit — the tests it
// recommends are Phase 2, and they are sliceable precisely because this ran
// first and ranked them by what depends on each verb.
//
// Everything below the `gather()` line is PURE: strings in, rows out. The
// reading lives at the edge, so the four requirements are testable without a
// repository to run inside.
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');

/** The adapters whose exports define the port surface. */
export const PROVIDER_FILES = Object.freeze({
  github: 'brain/scripts/axes/vcs/adapters/github.mjs',
  gitlab: 'brain/scripts/axes/vcs/adapters/gitlab.mjs',
});

/**
 * Pure: the verbs an adapter EXPORTS as functions.
 *
 * Anchored at line start so a commented-out export is not a verb, and limited
 * to `function` so `export const PROVIDER = 'github'` — a constant, not a verb —
 * stays out.
 */
export function exportedVerbs(source) {
  const found = new Set();
  // `export [async] function name(` — the shape both adapters use today.
  // `function*` too: a generator puts `*` where the whitespace was, and the
  // expression branch below already tolerated it via `function\b` — so the two
  // paths disagreed about the identical shape (round 9). A verb declared as a
  // generator produced no row and no orphan, which is the silent omission this
  // whole file refuses.
  for (const m of source.matchAll(/^export\s+(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/gm)) found.add(m[1]);
  // `export const name = [async] (…) =>` / `= [async] function` — exported as a
  // function without being a function DECLARATION. Neither adapter uses this
  // today, which is exactly why it had to be added: a verb in this shape would
  // have vanished from the report with no row, no orphan and no error, and this
  // file refuses that outcome for every other input it handles (round 5).
  for (const m of source.matchAll(/^export\s+(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/gm)) {
    found.add(m[1]);
  }
  return [...found];
}

/**
 * Pure: one verb's fixture provenance, folded.
 *
 * `mixed` is a first-class answer, not a rounding error: a verb whose fixtures
 * disagree is the #334 shape — a derived fixture encoding an author's
 * assumption sitting beside a recorded one — and collapsing it would hide the
 * distinction the ticket calls load-bearing.
 *
 * `unreadable` dominates everything, for the reason `uncomputable` dominates a
 * gate verdict elsewhere in this repo: a file we could not read is not a file
 * that said `none`.
 */
/**
 * Pure: source with COMMENTS removed — code only.
 *
 * Round 6 measured why this is not optional: this file's own explanatory
 * comments contain `providerModule.branchProtect(...)` and `.prView(...)`, and
 * `gather()` walks this file like any other, so the audit counted ITSELF as a
 * consumer of the verbs it discusses. `branchProtect` read 2 with one real call
 * site. That is `rec-de8fc48c0201e015` — "count callers by IMPORT, never by
 * mention" — reproduced across five rounds that hardened this very regex.
 *
 * ONE alternation, never sequential passes (#850's lesson): a comment pass run
 * before a string pass lets a `//` inside a string eat the rest of the line.
 * Strings are KEPT — a verb name in a string can be a real dynamic dispatch.
 */
export function stripComments(text) {
  const re = /\/\*[\s\S]*?\*\/|\/\/[^\n]*|`(?:\\.|[^\\`])*`|'(?:\\.|[^\\'])*'|"(?:\\.|[^\\"])*"/g;
  return text.replace(re, (m) => (m.startsWith('/') ? ' ' : m));
}

/**
 * Pure: does this file dispatch the port with a verb resolved at RUNTIME —
 * `vcs[verb](args)`?
 *
 * `brain/scripts/vcs/cli.mjs` does exactly that, so its source never spells any
 * verb name and seven verbs read `consumers: 0` while being reachable through
 * the CLI (round 6's blocker).
 *
 * REPORTED, NOT COUNTED, and the distinction is the honest part. Counting it
 * per verb was this fix's own first cut: the detection matches any computed
 * call, so `branchProtect` jumped to 8 consumers and no verb read zero —
 * silent inflation of the very ranking R336-3 exists to produce, which is the
 * same sin as the undercount it was meant to cure. A dispatcher reaches every
 * verb, but it is not evidence that any PARTICULAR verb is depended upon.
 * So it appears as its own line, naming the files, where a reader can judge it.
 */
export function isGenericDispatcher(code) {
  return /(?<![\w$])(?:vcs|port|provider[A-Za-z]*)\s*\[\s*[A-Za-z_$][\w$]*\s*\]\s*\(/.test(code);
}

export const RECORDING_EVIDENCE = Object.freeze(['recorded', 'endpoint', 'measured', 'live_verified']);

/** Pure: what ONE fixture's `_provenance` actually claims. */
export function classifyProvenance(p) {
  if (p?.unreadable) return 'unreadable';
  if (p?.derived) return 'derived';
  // Truthiness, not presence — the SAME test `derived` gets two lines up. With
  // `!== undefined`, `{ endpoint: null }` and `{ recorded: false }` read as
  // `recorded`, the strongest category, from a field explicitly saying no
  // (round 11). One function must not hold two ideas of what a field
  // answering "yes" looks like.
  if (RECORDING_EVIDENCE.some((k) => Boolean(p?.[k]))) return 'recorded';
  return 'undeclared';
}

export function foldProvenance(provenances) {
  if (provenances.length === 0) return 'none';
  const kinds = new Set(provenances.map(classifyProvenance));
  // Weakest-wins for the two "we do not know" answers, in that order: an
  // unreadable file dominates everything, and an undeclared one dominates the
  // claims, because a verb is only as trustworthy as its least-evidenced fixture.
  if (kinds.has('unreadable')) return 'unreadable';
  if (kinds.has('undeclared')) return 'undeclared';
  return kinds.size > 1 ? 'mixed' : [...kinds][0];
}

/**
 * Pure: a verb name, safe to interpolate into a RegExp.
 *
 * `exportedVerbs` accepts `[A-Za-z_$][\w$]*`, so a JS-legal verb may contain
 * `$` — which is an END-OF-STRING ANCHOR unescaped, and would silently turn a
 * name match into something else entirely. And `\b` is no good at that edge
 * either: `$` is a non-word character, so `\bfoo$bar\b` does not mean what a
 * reader assumes. Hence the explicit lookarounds below, which treat `$` as part
 * of an identifier the way JavaScript does. No verb in either adapter carries
 * one today; this is here so the day one does is not the day the audit starts
 * lying quietly.
 */
export function escapeForRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pure: `contract` | `elsewhere` | `uncovered`.
 *
 * Word-bounded, never `includes()`: `issueList` must not borrow the coverage of
 * a test named for `issueListComments`. "Covered elsewhere" is kept as its own
 * state because the ticket asks to distinguish it — it is real, and weaker.
 */
export function coverageOf(verb, contractText, otherTestText) {
  const re = new RegExp(`(?<![\\w$])${escapeForRegExp(verb)}(?![\\w$])`);
  // Comments stripped here too (round 6, cold-3): a verb NAMED in a test's
  // prose is not a verb the test exercises, and reading one as covered is the
  // same mention-for-call error in the other column.
  if (re.test(stripComments(contractText))) return 'contract';
  if (re.test(stripComments(otherTestText))) return 'elsewhere';
  return 'uncovered';
}

/**
 * Pure: how many distinct FILES call `vcs.<verb>(`.
 *
 * Files, not call sites: two calls in one module are one thing that breaks.
 * The adapters are excluded by the caller — a provider calling itself is not a
 * consumer of the port.
 */
export function countConsumers(verb, consumers) {
  // THE RECEIVER IS NOT `vcs`, and assuming it was is the defect three review
  // rounds circled. Rounds 1 and 2 hardened the boundaries of `vcs.<verb>(` —
  // escaping the verb, then anchoring the left side of the literal `vcs` —
  // while the object NAME itself was the wrong premise. Production reaches the
  // port through several bindings:
  //     providerModule.branchProtect(...)          brain-protect.mjs
  //     (await getVcsFn({ provider })).prView(...) review/cold-boot.mjs
  // Measured before this fix: branchProtect, capabilities and mrCreate all read
  // `consumers: 0` with live call sites — the audit reproducing, inside itself,
  // the exact #317 blindness it was commissioned to end.
  //
  // So the receiver is ANY expression and the verb carries the identity. The
  // trade is deliberate and one-directional: a same-named method on an
  // unrelated object would over-count, and over-counting is visible and moves a
  // verb UP a list someone then reads. Under-counting hides a verb at the
  // bottom and is how `prReviews` stayed invisible. Between a wrong number and
  // a missing row, this audit chooses the wrong number.
  // A REFERENCE is a use. Round 10 measured what "only a call counts" cost:
  // `brain-protect.mjs` passes `providerModule.checkRuns` by reference and
  // invokes it as `listCheckRuns(...)`, so `checkRuns` read `consumers: 0`
  // with a live call target. You do not reference a function you do not intend
  // to call, and an earlier round of this file encoded the opposite assumption
  // as a test — the reviewer produced the real case that refuted it.
  //
  // What stays excluded is a PROPERTY CHAIN: `vcs.prReviews?.length` reads
  // something off the verb rather than using the verb. So: the verb, its right
  // boundary, and then anything that is not a further property access.
  //
  // `?.` is still part of a call, not a different call — the defensive idiom
  // this codebase already uses (`mode.stageDeps?.(root)`, round 8).
  const v = escapeForRegExp(verb);
  // The excluded continuation is any PROPERTY ACCESS, dotted or bracketed:
  // `.checkRuns.length`, `.checkRuns?.length` and `.checkRuns?.[0]` all read
  // something off the verb. Round 11 measured that only the dotted forms were
  // excluded, so a computed read over-counted (`.checkRuns?.[0]` → 1).
  const re = new RegExp(`\\.${v}(?![\\w$])\\s*(?!\\??\\.\\s*[A-Za-z_$])(?!\\??\\.?\\s*\\[)`);
  const files = new Set();
  for (const c of consumers) {
    if (re.test(stripComments(c.text))) files.add(c.file);
  }
  return files.size;
}

/**
 * Pure: the whole report.
 *
 * Uncovered rows lead, sorted by consumer count descending — the ranking this
 * ticket exists for. Alphabetical order is what let `prReviews` sit between
 * `prCommits` and `prStatusRollup` saying nothing.
 */
export function buildReport({ adapters, fixtures, contractText, otherTestText, consumers }) {
  const rows = [];
  for (const [provider, source] of Object.entries(adapters)) {
    for (const verb of exportedVerbs(source)) {
      const mine = fixtures.filter((f) => f.provider === provider && f.verb === verb);
      rows.push({
        provider,
        verb,
        coverage: coverageOf(verb, contractText, otherTestText),
        provenance: foldProvenance(mine.map((f) => f.provenance)),
        fixtures: mine.length,
        consumers: countConsumers(verb, consumers),
      });
    }
  }
  const rank = { uncovered: 0, elsewhere: 1, contract: 2 };
  rows.sort((a, b) =>
    rank[a.coverage] - rank[b.coverage] ||
    b.consumers - a.consumers ||
    a.provider.localeCompare(b.provider) ||
    a.verb.localeCompare(b.verb));
  // Fixtures whose `<provider>-<verb>-` prefix names no exported verb, and files
  // outside the convention entirely. Reported, never dropped: a fixture kept for
  // a verb the port no longer exports is maintenance spent on nothing, and a
  // silently-skipped file is the audit lying about its own coverage. Found by
  // cross-checking this report's fixture total against a direct count — they
  // disagreed by five, and the five were real.
  const known = new Set(rows.map((r) => `${r.provider}.${r.verb}`));
  const orphans = fixtures
    .filter((f) => f.verb === null || !known.has(`${f.provider}.${f.verb}`))
    .map((f) => ({ name: f.name, claims: f.verb === null ? null : `${f.provider}.${f.verb}` }));

  const derivedFixtures = fixtures.filter((f) => f.provenance?.derived).length;
  // Fixtures counted ONCE, over the same population the derived count uses:
  // rows plus orphans. Round 7 measured the mismatch — `derivedFixtures` folded
  // every fixture while the denominator summed rows only, so the report printed
  // "51 of 55 (93%)" where the truth is 51 of 60 (85%), contradicting this
  // change's own proposal. A ratio whose halves count different things is a
  // statistic about nothing.
  const totalFixtures = fixtures.length;
  const dispatchers = consumers
    .filter((c) => isGenericDispatcher(stripComments(c.text)))
    .map((c) => c.file);
  return { rows, generated: rows.length, derivedFixtures, totalFixtures, orphans, dispatchers };
}

// ── The edge: reading. Everything above is pure. ────────────────────────────

/** Reads the tree into `buildReport`'s inputs. */
export function gather({ repo = REPO, _read = readFileSync, _readdir = readdirSync } = {}) {
  const read = (rel) => { try { return _read(join(repo, rel), 'utf8'); } catch { return ''; } };

  const adapters = {};
  for (const [provider, rel] of Object.entries(PROVIDER_FILES)) adapters[provider] = read(rel);

  const fixDir = 'brain/scripts/vcs/fixtures';
  const fixtures = [];
  let names = [];
  try { names = _readdir(join(repo, fixDir)).filter((n) => n.endsWith('.json')); } catch { names = []; }
  for (const name of names) {
    // <provider>-<verb>-<case>.json — the convention the fixtures already follow.
    const m = /^([a-z]+)-([A-Za-z0-9_$]+)-/.exec(name);
    let provenance;
    try {
      // `?? {}` maps a MISSING `_provenance` to the same empty object an empty
      // one produces — and both are `undeclared`, which is the honest answer
      // for each. The distinction that matters is against `recorded`, not
      // between the two shapes of saying nothing.
      provenance = JSON.parse(_read(join(repo, fixDir, name), 'utf8'))._provenance ?? {};
    } catch {
      provenance = { unreadable: true };   // never silently `none`
    }
    fixtures.push({ provider: m ? m[1] : null, verb: m ? m[2] : null, name, provenance });
  }

  const contractText = read('brain/scripts/axes/vcs/contract.test.mjs');

  const consumers = [];
  let otherTestText = '';
  const walk = (rel) => {
    let entries = [];
    try { entries = _readdir(join(repo, rel), { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = `${rel}/${e.name}`;
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.mjs')) continue;
      const text = read(p);
      if (e.name.endsWith('.test.mjs')) {
        // The audit's OWN test is not evidence about the port. Its mock strings
        // spell `vcs.prReviews({})` to exercise countConsumers, and folding them
        // into otherTestText made `prReviews` read `elsewhere` forever — the
        // file's own worked example, permanently unable to report the very
        // regression it exists to catch. Third appearance of one shape: the tool
        // must not be evidence about itself, on ANY path (rounds 4, 6, 7).
        if (p.endsWith('/vcs/port-coverage.test.mjs')) continue;
        if (!p.includes('vcs.contract.test.mjs')) otherTestText += `\n${text}`;
        continue;
      }
      if (p.includes('/axes/vcs/adapters/')) continue;   // a provider calling itself is not a consumer
      // And the audit is not a consumer of the port either. This file discusses
      // verbs by name in its own prose and carries a regex whose SOURCE matches
      // its own dispatcher pattern — measured: it counted itself for
      // `branchProtect` and listed itself as a dispatcher. Stripping comments
      // does not settle it, and it should not have to: excluding the tool is
      // the true statement, the same one that excludes the adapters.
      if (p.endsWith('/vcs/port-coverage.mjs')) continue;
      consumers.push({ file: p, text });
    }
  };
  walk('brain/scripts');

  return { adapters, fixtures, contractText, otherTestText, consumers };
}

/** The markdown the ticket asks for, with its worst row explained where the reader is. */
export function renderMarkdown(report) {
  const lines = [
    '# Port verb contract coverage (M10 Phase 1, #336)',
    '',
    'Detection only. Generated by `npm run brain:port:coverage` — regenerate rather than edit.',
    '',
    '| Port verb | Contract test | Fixture provenance | Consumers |',
    '|---|---|---|---|',
  ];
  for (const r of report.rows) {
    lines.push(`| \`${r.provider}.${r.verb}\` | ${r.coverage} | ${r.provenance} (${r.fixtures}) | ${r.consumers} |`);
  }
  // The summary leads, because the table's 55 rows bury the shape. What the
  // reader needs first is where the risk actually is — and on the day this was
  // written it was NOT where #336 predicted.
  const count = (k, v) => report.rows.filter((r) => r[k] === v).length;
  lines.push('');
  lines.push('## What this run measured');
  lines.push('');
  lines.push(`- **Coverage**: ${count('coverage', 'contract')} contract · ${count('coverage', 'elsewhere')} elsewhere · ${count('coverage', 'uncovered')} uncovered`);
  lines.push(`- **Fixture provenance**: ${count('provenance', 'recorded')} recorded · ${count('provenance', 'derived')} derived · ${count('provenance', 'mixed')} mixed · ${count('provenance', 'undeclared')} undeclared · ${count('provenance', 'none')} none · ${count('provenance', 'unreadable')} unreadable`);
  lines.push('');
  const fixtureCount = report.totalFixtures ?? 0;
  const derivedFixtures = report.derivedFixtures ?? 0;
  if (fixtureCount > 0) {
    const pct = Math.round((derivedFixtures / fixtureCount) * 100);
    lines.push(`- **Fixtures themselves**: ${derivedFixtures} of ${fixtureCount} carry \`derived: true\` (${pct}%)`);
    lines.push('');
  }
  lines.push('A verb with `none` has no fixture at all: whatever pins it pins the shape the author');
  lines.push('imagined. A `mixed` verb is the #334 shape — a derived fixture encoding an assumption');
  lines.push('beside a recorded one, agreeing with each other while both may disagree with production.');
  if (count('provenance', 'recorded') === 0 && fixtureCount > 0) {
    lines.push('');
    lines.push('**Not one verb has fixtures that are all recorded.** That is the Phase 2 input this audit');
    lines.push('was built to produce, and it is not the gap #336 expected to find: contract COVERAGE is');
    lines.push('complete, and the exposure moved to what the covered tests are checked against.');
  }

  if (report.dispatchers?.length) {
    lines.push('');
    lines.push('## Reached without being named');
    lines.push('');
    lines.push('These files call the port with the verb resolved at runtime, so their source spells no');
    lines.push('verb name and the counts above cannot see them. Every verb is reachable through each:');
    lines.push('');
    for (const f of report.dispatchers) lines.push(`- \`${f}\``);
    lines.push('');
    lines.push('Listed rather than added to the counts: a dispatcher reaches every verb, but it is not');
    lines.push('evidence that any particular verb is depended upon, and folding it in would inflate the');
    lines.push('ranking this report exists to produce.');
  }

  if (report.orphans?.length) {
    lines.push('');
    lines.push('## Fixtures with no verb');
    lines.push('');
    lines.push('Maintained for something the adapters do not export — either a verb that was removed,');
    lines.push('or a name outside the `<provider>-<verb>-<case>.json` convention. Reported because an');
    lines.push('audit that skips what it cannot classify is lying about its own coverage.');
    lines.push('');
    for (const o of report.orphans) {
      lines.push(`- \`${o.name}\` — ${o.claims ? `claims \`${o.claims}\`, which no adapter exports` : 'does not match the naming convention'}`);
    }
  }

  const prReviews = report.rows.find((r) => r.verb === 'prReviews');
  lines.push('');
  if (prReviews && prReviews.coverage === 'uncovered') {
    lines.push(
      `**\`prReviews\` is uncovered and has ${prReviews.consumers} consumer file(s).** This is the worked`,
      'example #336 names: it stayed unpinned until it broke the whole reviewer subsystem (#317).',
      'The rows above lead with uncovered verbs sorted by consumer count for that reason — sorted',
      'alphabetically, this row would sit between `prCommits` and `prStatusRollup` and say nothing.',
    );
  } else if (prReviews) {
    lines.push(
      `**\`prReviews\` now reads \`${prReviews.coverage}\`.** #336 predicted it would be uncovered; it is not,`,
      'and this line records the difference rather than restating the ticket. Its gap is what broke the',
      'reviewer subsystem in #317.',
    );
  }
  return lines.join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const report = buildReport(gather());
  console.log(process.argv.includes('--json') ? JSON.stringify(report, null, 2) : renderMarkdown(report));
}
