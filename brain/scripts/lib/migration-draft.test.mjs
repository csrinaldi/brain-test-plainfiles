// migration-draft.test.mjs — issue #809: the `brain-migration/1` contract.
// Parser, number proposal and splicer are PURE; every fixture is inline so
// the oracle is the contract, never the repo's current migration list.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MIGRATION_CONTRACT_TAG,
  MIGRATION_DRAFT_BASENAME_RE,
  parseMigrationDraft,
  proposeVersion,
  spliceMigrationEntry,
} from './migration-draft.mjs';

const block = (json) => `# Draft\n\nprose above\n\n\`\`\`${MIGRATION_CONTRACT_TAG}\n${json}\n\`\`\`\n`;
const GOOD = JSON.stringify({ version: '1.4.0', description: 'Add sdd.engines.', defaults: { sdd: { engines: {} } } }, null, 2);

test('#809: the basename contract', () => {
  assert.ok(MIGRATION_DRAFT_BASENAME_RE.test('config-migrations-1.4.0.md'));
  assert.ok(!MIGRATION_DRAFT_BASENAME_RE.test('adr-0034-something.md'));
  assert.ok(!MIGRATION_DRAFT_BASENAME_RE.test('config-migrations-1.4.md'), 'full semver, always');
});

test('#809: one well-formed block parses — version, description, defaults', () => {
  const { entry, refusal } = parseMigrationDraft(block(GOOD));
  assert.equal(refusal, null);
  assert.equal(entry.version, '1.4.0');
  assert.deepEqual(entry.defaults, { sdd: { engines: {} } });
});

test('#809: zero blocks and two blocks refuse, naming the count', () => {
  const none = parseMigrationDraft('# Draft\nno block here\n');
  assert.match(none.refusal, /no .*brain-migration\/1|0/i);
  const two = parseMigrationDraft(block(GOOD) + block(GOOD));
  assert.match(two.refusal, /2|two|more than one/i);
});

test('#809 D1: JS is refused — nothing is eval\'d', () => {
  const js = block(`{ version: '1.4.0', description: 'x', defaults: {} }`); // single quotes = not JSON
  const { entry, refusal } = parseMigrationDraft(js);
  assert.equal(entry, null);
  assert.match(refusal, /JSON/);
});

test('#809 D1: a `migrate` key is refused — imperative entries remain hand edits', () => {
  const imp = block(JSON.stringify({ version: '1.4.0', description: 'x', migrate: 'fn', defaults: {} }));
  assert.match(parseMigrationDraft(imp).refusal, /migrate.*hand|declarative/i);
});

test('#809 D1: missing description or non-object defaults refuse', () => {
  assert.match(parseMigrationDraft(block(JSON.stringify({ version: '1.0.0', defaults: {} }))).refusal, /description/);
  assert.match(parseMigrationDraft(block(JSON.stringify({ version: '1.0.0', description: 'x', defaults: [] }))).refusal, /defaults/);
});

test('#809 D2: the proposed number is next-minor above max(package, tail)', () => {
  assert.equal(proposeVersion({ draftVersion: '1.4.0', packageVersion: '1.1.0', tailVersion: '0.10.0' }).version, '1.2.0');
  assert.equal(proposeVersion({ draftVersion: '9.9.9', packageVersion: '1.1.0', tailVersion: '1.5.0' }).version, '1.6.0');
});

test('#809 D2: renumbered says so; an already-right draft does not', () => {
  const r = proposeVersion({ draftVersion: '1.4.0', packageVersion: '1.1.0', tailVersion: '0.10.0' });
  assert.equal(r.renumbered, true);
  const ok = proposeVersion({ draftVersion: '1.2.0', packageVersion: '1.1.0', tailVersion: '0.10.0' });
  assert.equal(ok.renumbered, false);
});

test('#809 D2: monotonic-forever holds by construction — the computed number is ALWAYS above the tail', () => {
  for (const [pkg, tail] of [['1.1.0', '0.10.0'], ['0.5.0', '2.3.0'], ['1.1.0', '1.1.0']]) {
    const { version } = proposeVersion({ draftVersion: '0.0.1', packageVersion: pkg, tailVersion: tail });
    const [a1, a2] = version.split('.').map(Number); const [b1, b2] = tail.split('.').map(Number);
    assert.ok(a1 > b1 || (a1 === b1 && a2 > b2), `${version} must exceed tail ${tail}`);
  }
});

const FILE = `// header\nexport const migrations = [\n  {\n    version: '0.1.0',\n    description: 'first',\n    defaults: { a: 1 },\n  },\n];\n\n// NOTE trailing doctrine comment\n`;

test('#809 D3: the splice appends before the closing bracket, version first', () => {
  const { next, refusal } = spliceMigrationEntry(FILE, { description: 'Add x.', defaults: { x: {} } }, '1.2.0');
  assert.equal(refusal, null);
  // Key order is the contract; the quote STYLE is JSON's — double quotes are
  // valid JS and carry the language's own escaping (the apostrophe blocker).
  assert.match(next, /version: "1\.2\.0",\n\s+description: "Add x\."/, 'shipped key order: version, description, defaults');
  assert.ok(next.indexOf('version: "1.2.0"') > next.indexOf("version: '0.1.0'"), 'appended after the tail');
  assert.ok(next.indexOf('version: "1.2.0"') < next.indexOf('// NOTE'), 'and before the trailing doctrine notes');
});

test('#809 D3: a file without the anchor refuses — never a guess', () => {
  const { next, refusal } = spliceMigrationEntry('const nope = 1;\n', { description: 'x', defaults: {} }, '1.0.0');
  assert.equal(next, null);
  assert.match(refusal, /migrations/);
});

// ── D4: the backlog rides the contract — every draft in the repo parses ────
//
// The claim is "every pending draft IN THE REPO", so the oracle is a walk of
// `openspec/changes/*/brain-drafts/` and `openspec/changes/archive/*/brain-drafts/`
// for `MIGRATION_DRAFT_BASENAME_RE` basenames — never a hand-written list of
// change dirs, which goes stale the moment a change moves (#557 archived all
// three the previous list named). An empty walk fails the test rather than
// passing with nothing checked.

test('#809 D4: every pending draft in the repo parses under the contract', async () => {
  const { readFileSync, readdirSync } = await import('node:fs');
  const changesRoot = new URL('../../../openspec/changes/', import.meta.url);

  const listDirs = (rootUrl) => {
    let entries;
    try {
      entries = readdirSync(rootUrl, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.filter((e) => e.isDirectory()).map((e) => new URL(`${e.name}/`, rootUrl));
  };

  const changeDirs = [...listDirs(changesRoot), ...listDirs(new URL('archive/', changesRoot))];

  const drafts = [];
  for (const dirUrl of changeDirs) {
    const draftsDirUrl = new URL('brain-drafts/', dirUrl);
    let names;
    try {
      names = readdirSync(draftsDirUrl);
    } catch {
      continue;
    }
    for (const name of names) {
      if (MIGRATION_DRAFT_BASENAME_RE.test(name)) drafts.push(new URL(name, draftsDirUrl));
    }
  }

  assert.ok(
    drafts.length > 0,
    'expected at least one config-migrations-*.md draft under openspec/changes/*/brain-drafts/ or openspec/changes/archive/*/brain-drafts/ — an empty walk means the test checked nothing',
  );

  for (const fileUrl of drafts) {
    const { entry, refusal } = parseMigrationDraft(readFileSync(fileUrl, 'utf8'));
    assert.equal(refusal, null, `${fileUrl.pathname}: ${refusal}`);
    assert.ok(entry.description.length > 0, fileUrl.pathname);
    assert.equal(typeof entry.defaults.sdd, 'object', `${fileUrl.pathname}: every pending draft declares under sdd.*`);
  }
});

// ── round 1 of the full cold review — the apostrophe blocker ────────────────

test('#809 (review r1): an apostrophe in the description SURVIVES the splice as valid JS — reproduced on 2 of the 3 real drafts', () => {
  const entry = { description: "takes the inhabitant's declared defaults — 'quoted' too", defaults: { sdd: { configs: {} } } };
  const FILE = "export const migrations = [\n  { version: '0.1.0', description: 'x', defaults: {} },\n];\n";
  const { next, refusal } = spliceMigrationEntry(FILE, entry, '1.3.0');
  assert.equal(refusal, null);
  // The oracle is the LANGUAGE: the spliced text must evaluate, and the entry round-trip.
  const migrations = new Function(`${next.replace('export const', 'const')}; return migrations;`)();
  assert.equal(migrations.length, 2);
  assert.equal(migrations[1].description, entry.description, 'the prose survives byte-exact');
  assert.deepEqual(migrations[1].defaults, entry.defaults);
});

test('#809 (review r2): the spliced entry closes at the SAME indent it opens — the file the human signs stays shipped-style', () => {
  const FILE = "export const migrations = [\n  { version: '0.1.0', description: 'x', defaults: {} },\n];\n";
  const { next } = spliceMigrationEntry(FILE, { description: 'Add x.', defaults: { x: {} } }, '1.2.0');
  const lines = next.split('\n');
  const close = lines[lines.indexOf('];') - 1];
  assert.equal(close, '  },', 'every shipped entry closes with two-space "  }," — a promotion must not degrade the file one brace at a time');
});
