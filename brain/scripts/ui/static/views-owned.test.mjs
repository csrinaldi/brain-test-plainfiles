// views-owned.test.mjs — R998-2's absence proof, replacing
// no-management-views.test.mjs (#998 PR 2).
//
// That file's name and its `\bnav\b` prohibition described a page with no
// nav: #881 PR 4 drew one canvas and a four-tab drawer, nothing else. #998
// PR 2 adds a real `<nav id="modes">` with four mode buttons, so a
// prohibition on the word "nav" would now fail on the page's own, intended
// markup — the claim it protected ("we did not build the management views
// of #882") still holds, but the ABSENCE it needs to enumerate has grown:
// this PR owns four modes, not one canvas. Same rule (#881's evidence-reader
// discipline: "we built exactly this, and named what we didn't"), rewritten
// for the surface this PR actually draws.
//
// Test-only; no production code belongs to this task.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { TAB_IDS } from '../lib/drawer-model.mjs';
import { MODE_IDS, PLACEHOLDERS } from '../lib/view-model.mjs';
import { GOVERNANCE_VIEW_IDS, GOVERNANCE_PLACEHOLDERS } from '../lib/governance-model.mjs';

const STATIC_DIR = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(STATIC_DIR, 'app.js'), 'utf8');
const INDEX_HTML = readFileSync(join(STATIC_DIR, 'index.html'), 'utf8');

/** Every endpoint the page can reach, quoted literally in `app.js`. */
function endpoints(text) {
  const found = [];
  for (const m of text.matchAll(/(?:fetch|new EventSource)\(\s*([`'"])([^`'"]*)\1/g)) found.push(m[2]);
  return [...new Set(found)].sort();
}

test('#998 R998-2: the page reaches exactly the endpoints this slice owns — no management view, no MCP, no pulse', () => {
  assert.deepEqual(endpoints(APP_JS), [
    '/api/change/${issue}',
    '/api/poll/${action}',
    '/api/snapshot',
    '/api/stream',
  ]);
});

test('#998 R998-6: the drawer now has six tabs, in the design\'s order', () => {
  assert.deepEqual(TAB_IDS, ['spec', 'sdd', 'tasks', 'workingMemory', 'reviews', 'records']);
});

test('#998 R998-2/R998-4/R998-5/#882 R882-1: this PR owns exactly four modes; map, sdd, reviews and governance all have real content — governance mounts its own sub-nav and sub-router from #882 PR 1 on', () => {
  assert.deepEqual(MODE_IDS, ['map', 'governance', 'memory']);
  for (const mode of MODE_IDS) assert.equal(PLACEHOLDERS[mode], null, `mode "${mode}" has real content, not a placeholder`);
});

test('#882 R882-1/R882-2: the governance surface exists — the sub-nav is mounted, Roadmap draws real content', () => {
  assert.match(INDEX_HTML, /<nav id="governance-nav"/, 'R882-1: the governance sub-nav mount must exist');
  assert.match(APP_JS, /function renderRoadmap\(/, 'R882-2: Roadmap must render real content, not a placeholder');
  assert.match(APP_JS, /GOVERNANCE_PLACEHOLDERS\[/, 'the sub-views not yet built must still say their own placeholder, never an empty area');
});

test('#882 cold review of PR 1 (blocker): a roadmap row applies the same sourceStamp helper the door uses — R882-1\'s row() is not a dead export', () => {
  const fnMatch = APP_JS.match(/function renderRoadmapRow\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'renderRoadmapRow function must exist in app.js');
  assert.match(fnMatch[0], /renderSourceStamp\(row\.sourceStamp\)/, 'renderRoadmapRow must render row.sourceStamp through renderSourceStamp, never a bare #N with no stamp and no link');
});

test('#882 cold review of PR #1037 (correction 1): a roadmap row says its own stateReason when the state could not be read — the model\'s said value is not silently dropped on screen', () => {
  const fnMatch = APP_JS.match(/function renderRoadmapRow\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'renderRoadmapRow function must exist in app.js');
  assert.match(fnMatch[0], /row\.stateReason/, 'renderRoadmapRow must read row.stateReason, so roadmap-model.mjs\'s said reason for an unknown state actually reaches the screen');
});

test('#882 R882-3: Decisions draws real content — the ADR table, drift warnings beside it, never a second drift computation', () => {
  assert.match(APP_JS, /function renderDecisions\(/, 'R882-3: Decisions must render real content, not a placeholder');
  assert.match(APP_JS, /buildDecisionsModel\(/, 'renderDecisions must build its rows from lib/decisions-model.mjs, not recompute them inline');
  assert.match(APP_JS, /row\.issuesLabel/, 'the issues list must render the model\'s own label text — the parser does not distinguish "referenced" from "driving"');
});

test('#882 R882-4: Anti-patterns draws real content — the catalogue, core before project, an unlistable scope said beside the other scope\'s real rows', () => {
  assert.match(APP_JS, /function renderAntiPatterns\(/, 'R882-4: Anti-patterns must render real content, not a placeholder');
  assert.match(APP_JS, /buildAntiPatternsModel\(/, 'renderAntiPatterns must build its rows from lib/anti-patterns-model.mjs, not recompute them inline');
  // The literal string is gone: the model builds each citation's stamp through
  // `sourceStamp`/`issueUrl` now, so the page renders stamps, not text.
  assert.match(APP_JS, /for \(const stamp of row\.issueStamps\) cited\.appendChild\(renderSourceStamp\(stamp\)\)/, 'each cited issue must be its own chip, so a known project makes it clickable');
  assert.ok(!/\[forge: #\$\{n\}\]/.test(APP_JS), 'the page must not hand-build a forge label the model already stamps');
});

test('#882 R882-5: History draws real content — merges/releases/ADR amendments through lib/history-model.mjs, linked to the Reviews mode, never a duplicate review-round rendering', () => {
  assert.match(APP_JS, /function renderHistory\(/, 'R882-5: History must render real content, not a placeholder');
  assert.match(APP_JS, /buildHistoryModel\(/, 'renderHistory must build its events from lib/history-model.mjs, not recompute them inline');
  const fnMatch = APP_JS.match(/function renderHistory\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'renderHistory function must exist in app.js');
  const linkMatch = APP_JS.match(/function renderHistoryReviewsLink\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(linkMatch, 'renderHistoryReviewsLink function must exist in app.js');
  const body = fnMatch[0] + linkMatch[0];
  assert.match(body, /switchGovernanceView\('queue'\)/, 'the history pane links to the verdict queue, which moved under Governance in #1059, instead of rendering a second undated projection of the same rounds');
  assert.ok(!/renderReviewRound\(/.test(body), 'no review round is ever rendered inside the history pane');
});

test('#882 R882-5: History\'s own event renderer never branches on a review kind — buildHistoryModel already guarantees none exists', () => {
  const fnMatch = APP_JS.match(/function renderHistoryEvent\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'renderHistoryEvent function must exist in app.js');
  assert.ok(!/'review'/.test(fnMatch[0]), 'no branch on a review kind inside History\'s own event renderer');
});

test('#882 R882-6: By actor draws real content — records and reviews merged into one row per actor, humans and agents in one table, no fabricated merge count', () => {
  assert.match(APP_JS, /function renderActors\(/, 'R882-6: By actor must render real content, not a placeholder');
  assert.match(APP_JS, /buildActorsModel\(/, 'renderActors must build its rows from lib/actors-model.mjs, not recompute them inline');
  assert.match(APP_JS, /row\.reviewsPosted\.caveat/, 'reviewsPosted must render the model\'s own caveat text, never a bare count with no scope said');
  assert.match(APP_JS, /row\.prsMerged\.reason/, 'prsMerged must render the model\'s own stated reason, never a bare 0');
  assert.ok(!/prsMerged\s*:\s*0\b/.test(APP_JS), 'app.js must never hard-code prsMerged as a bare 0');
});

test('#882 R882-6: renderActors never re-sorts by volume — the model\'s own name order stands (issue #882\'s own "must NOT become a leaderboard")', () => {
  const fnMatch = APP_JS.match(/function renderActors\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'renderActors function must exist in app.js');
  assert.ok(!/\.sort\(/.test(fnMatch[0]), 'renderActors must not re-sort the model\'s rows — buildActorsModel already sorts by name only');
});

test('#882/#1059: every governance sub-view draws real content, and the two that came down from the top level are among them', () => {
  // #882's five, plus the two #1059 moved here when they stopped being modes.
  // A project-wide verdict queue and a project-wide slice plan are facts about
  // the repository, not about the ticket in front of the reader.
  assert.deepEqual(GOVERNANCE_VIEW_IDS, ['roadmap', 'decisions', 'anti-patterns', 'history', 'actors', 'queue', 'slices']);
  for (const id of GOVERNANCE_VIEW_IDS) assert.equal(GOVERNANCE_PLACEHOLDERS[id], null, `sub-view "${id}" still names a placeholder — every one of them is built`);

  // Routed, not merely tabled: a sub-view in the table with no branch in the
  // router draws the placeholder fallback, which is an empty pane wearing a
  // sentence.
  const router = APP_JS.match(/function renderGovernance\(\) \{[\s\S]*?\n}\n/);
  assert.ok(router, 'renderGovernance must exist in app.js');
  for (const id of GOVERNANCE_VIEW_IDS) {
    assert.ok(router[0].includes(`governanceView === '${id}'`), `the router has no branch for the "${id}" sub-view, so its button would draw the fallback`);
  }
});

test('#882: every governance row\'s source stamp goes through renderSourceStamp — a hand-built el(\'span\', \'source\', …) drops the "open ↗" chip a real forge link would otherwise carry', () => {
  for (const name of ['renderDecisionRow', 'renderAntiPatternRow', 'renderHistoryEvent', 'renderActorRow']) {
    const fnMatch = APP_JS.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n}\\n`));
    assert.ok(fnMatch, `${name} function must exist in app.js`);
    assert.ok(!/el\('span',\s*'source',/.test(fnMatch[0]), `${name} must not hand-build the source span directly — read it through renderSourceStamp instead`);
    assert.match(fnMatch[0], /renderSourceStamp\(/, `${name} must render its row's sourceStamp through renderSourceStamp, never a second copy of that logic`);
  }
});

test('#998 R998-2: nav, modes and Governance are allowed labels — this PR draws them on purpose', () => {
  assert.match(INDEX_HTML, /<nav id="modes"/, 'the modes nav must exist: R998-2 adds it');
});

test('#881 R881-10 S1: nothing on the page reads a worktree path — the committed tier is the only tier this slice knows', () => {
  for (const endpoint of endpoints(APP_JS)) {
    assert.ok(!/worktree|uncommitted|working-tree/i.test(endpoint), `the page reaches "${endpoint}"`);
  }
  assert.ok(!/file:\/\//.test(APP_JS), 'the page reads nothing from the filesystem directly');
});

test('#998 R998-2/#882 R882-1: the shell mounts exactly seven regions — status, modes, search, banners, governance-nav, canvas, drawer', () => {
  const ids = [...INDEX_HTML.matchAll(/id="([^"]+)"/g)].map((m) => m[1]).sort();
  // `search` joined in #1059: the finder is its own mount rather than a
  // control inside the status bar, which re-renders on a five-second clock
  // and would erase a half-typed query.
  assert.deepEqual(ids, ['banners', 'canvas', 'drawer', 'governance-nav', 'modes', 'search', 'status']);
});

test('#998 R998-5: a finding\'s own source goes through the same sourceStamp helper the door uses, never a second copy of that logic', () => {
  assert.match(APP_JS, /renderSourceStamp\(sourceStamp\(f\.source\)\)/, 'renderReviewRound must apply sourceStamp to each finding\'s own source (file:line when present)');
});

test('#1009 cold review finding 1: renderReviewRound checks round.malformed before the empty-findings case, so a malformed round is never rendered as "no findings"', () => {
  const fnMatch = APP_JS.match(/function renderReviewRound\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'renderReviewRound function must exist in app.js');
  const body = fnMatch[0];
  const malformedIdx = body.indexOf('round.malformed');
  const emptyIdx = body.indexOf('round.findings.length === 0');
  assert.ok(malformedIdx !== -1, 'renderReviewRound must check round.malformed');
  assert.ok(emptyIdx !== -1, 'renderReviewRound must still check the empty-findings case');
  assert.ok(malformedIdx < emptyIdx, 'the malformed check must come before the empty-findings case, so a malformed round is never read as "no findings"');
});

test('#1009 cold review round 2: renderReviewRound gives a STOP verdict its own mark and the "human escalation" word, distinct from the ✓/✕ marks', () => {
  const fnMatch = APP_JS.match(/function renderReviewRound\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'renderReviewRound function must exist in app.js');
  const body = fnMatch[0];
  assert.match(body, /'STOP'/, 'renderReviewRound must branch on the STOP verdict literal, not fold it into the REVISE/unknown ✕ mark');
  assert.match(body, /human escalation/, 'a STOP round must say the escalation as text, not colour alone');
});

test("#1009 cold review round 3: renderReviewRound reads round.unknownVerdict, so a verdict word outside the enum never renders byte-identical to a REVISE", () => {
  const fnMatch = APP_JS.match(/function renderReviewRound\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(fnMatch, 'renderReviewRound function must exist in app.js');
  const body = fnMatch[0];
  // The MARK itself must branch on the flag: a scan that merely finds the
  // flag mentioned somewhere in the function passes even when the mark is
  // decided without it, which is the defect this test exists to catch.
  assert.match(body, /const mark = round\.unknownVerdict/, 'the mark must be decided by the flag review-timeline.mjs sets, not merely mention it');
  assert.match(body, /unrecognised verdict/, 'an unknown verdict word must be called out as text, not only by a mark');
});

// ── #998 R998-6: the served branch and the poll countdown ───────────────────

test('#998 R998-6 T3: the status bar names the served branch through the same sourceStamp helper the door uses', () => {
  assert.match(APP_JS, /renderServedBranch\(state\.meta\?\.servedBranch/, 'renderStatus must read servedBranch off meta, the same way it already reads poller/watcher');
  assert.match(APP_JS, /renderSourceStamp\(sourceStamp\(servedBranch\.source\)\)/, 'the served branch must carry its own source stamp, never a bare string');
});

test('#998 R998-6 T4/T6: the status bar shows the poll countdown from pollIndicator, never a second Date.now() clock read', () => {
  assert.match(APP_JS, /indicator\.countdown/, 'renderStatus must render pollIndicator\'s own countdown field');
  const dateNowCalls = [...APP_JS.matchAll(/Date\.now\(\)/g)].length;
  assert.equal(dateNowCalls, 1, 'app.js reads Date.now() in exactly ONE place — every clock decision beyond that lives in lib/, driven by the injected now');
  // #1059: Memory needs "now" to say how old a record is, and a second
  // `Date.now()` beside the poll indicator's would be a second clock that can
  // disagree with the first. Both take it from one function instead.
  assert.match(APP_JS, /function nowMs\(\) \{\s*\n\s*return Date\.now\(\);/, 'the one read is wrapped, so every caller shares it');
  assert.ok([...APP_JS.matchAll(/nowMs\(\)/g)].length >= 3, 'and the wrapper is what the renderers call');
});

// #882 PR 2 merge onto PR 1's head: the shared stamp helper exists now, and a
// hand-rolled `el('span','source', …)` silently drops the "open ↗" chip the
// moment a stamp carries an href — the defect the fresh review of PR 3 named
// across both views.
test('#882 R882-1/R882-5: every governance row renders its stamp through renderSourceStamp, never a hand-built span', () => {
  // fresh-context review of PR 4, warning: renderHistoryEvent hand-built its
  // own `el('span', 'source', ...)`, silently dropping the "open ↗" chip —
  // the same defect the fresh review of PR 3 already named for Decisions
  // and Anti-patterns. Pinned here alongside those three, not a fourth
  // separate test, so the shared discipline stays in one place.
  for (const [fn, param] of [['renderRoadmapRow', 'row'], ['renderDecisionRow', 'row'], ['renderAntiPatternRow', 'row'], ['renderHistoryEvent', 'event']]) {
    const m = APP_JS.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n}\\n`));
    assert.ok(m, `${fn} must exist in app.js`);
    assert.match(m[0], new RegExp(`renderSourceStamp\\(${param}\\.sourceStamp\\)`), `${fn} must render its stamp through the shared helper`);
    assert.ok(!/el\('span', 'source'/.test(m[0]), `${fn} must not hand-build the stamp span — the helper owns the "open ↗" chip`);
  }
});

// #1043 cold review, correction 2: the commit list is capped and the tags are
// not, so an older release can appear with no merges around it. The page must
// say the cap where the reader sees the count, never leave it implied.
test('#1043 correction 2: renderHistory says the commit cap beside the event count', () => {
  const m = APP_JS.match(/function renderHistory\(\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderHistory must exist in app.js');
  assert.match(m[0], /capNote\(/, 'renderHistory must ask the model for the cap sentence');
  assert.match(m[0], /model\.value\.cap|cap\b/, 'the sentence must come from the model\'s own cap, not a literal in the page');
});

// #1043 correction 3: the model says a forge-only row is unreconciled evidence;
// the page has to show it, or the sentence never reaches the reader.
test('#1043 correction 3: renderActorRow renders the model\'s evidence note', () => {
  const m = APP_JS.match(/function renderActorRow\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderActorRow must exist in app.js');
  assert.match(m[0], /row\.evidenceNote/, 'the unreconciled-namespace note must be rendered, not left in the model');
});

// #1043 round 2, correction 1: the model states why an event sits at the end
// of the timeline; a view that prints only the date drops that sentence.
test('#1043 round 2: renderHistoryEvent renders the model\'s dateUnparseable reason', () => {
  const m = APP_JS.match(/function renderHistoryEvent\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderHistoryEvent must exist in app.js');
  assert.match(m[0], /event\.dateUnparseable/, 'an event kept at the end for an unreadable date must say so on the page, not only in the model');
});

// #1043 round 4: with counts keyed by forge login, a record-backed row never
// shows one — so a summary reading "records and open-PR review threads" says
// the two are joined when the model's whole point is that they are not.
test('#1043 round 4: the by-actor summary says the two namespaces are listed side by side, not joined', () => {
  const m = APP_JS.match(/function renderActors\(\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderActors must exist in app.js');
  assert.ok(!/records and open-PR review threads/.test(m[0]), 'the old wording implied a join this data never performs');
  assert.match(m[0], /not joined|side by side|never joined/i, 'the summary must say the two sources sit beside each other');
});

test('#1043 round 4: renderHistory says how same-day events are ordered', () => {
  const m = APP_JS.match(/function renderHistory\(\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderHistory must exist in app.js');
  assert.match(m[0], /sameDayNote/, 'the ordering caveat must reach the page, not sit in the model');
});

test('#1043 round 5: renderHistoryEvent says a malformed line\'s own reason, not only the generic date one', () => {
  const m = APP_JS.match(/function renderHistoryEvent\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderHistoryEvent must exist in app.js');
  assert.match(m[0], /event\.malformed/, 'the line-level reason must reach the page');
});

// ── #1059 phase 1: the header is built from the design's region 01 ─────────
test('#1059 region 01: the status bar is built from buildHeaderModel, not assembled ad hoc in the page', () => {
  const m = APP_JS.match(/function renderStatus\(\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderStatus must exist in app.js');
  assert.match(m[0], /buildHeaderModel\(/, 'the counts and the branch come from a model, like every other region');
  assert.match(m[0], /counts\.ok/, 'an unreadable graph must cost the header its counts and nothing else');
  assert.match(m[0], /epic\.reason/, 'the epic this branch serves is stated as unresolved, never guessed');
});

test('#1059 region 01: the design\'s six header facts each have a place in the bar', () => {
  const m = APP_JS.match(/function renderStatus\(\) \{[\s\S]*?\n}\n/);
  for (const [what, re] of [
    ['the wordmark', /brain:ui/i],
    ['the branch served', /servedBranch/],
    ['the live indicator', /status-live/],
    ['the poll indicator', /indicator\.text/],
    ['the node counts', /status-counts/],
    ['the poller controls', /poll-toggle/],
  ]) {
    assert.match(m[0], re, `${what} must be in the status bar (design region 01)`);
  }
});

test('#1059 region 02: the mode nav carries each mode\'s glyph and the keyboard chips', () => {
  const m = APP_JS.match(/function renderModes\(\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderModes must exist in app.js');
  assert.match(m[0], /mode\.glyph/, 'the glyph comes from the mode table, never a literal in the page');
  assert.match(m[0], /'kbd'/, 'the keyboard hints are chips, as the design draws them');
  assert.ok(!/mode-count/.test(m[0]),
    'the waiting count does NOT ride a mode any more: `(3)` beside "Reviews" read as three reviews, but the Reviews mode is gone and beside "Governance" the same number reads as three governance things (#1059)');
});

test('#1059: the waiting count sits on the Verdict queue sub-nav button, where the word beside it says what it counts', () => {
  const m = APP_JS.match(/function renderGovernanceNav\(\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderGovernanceNav must exist in app.js');
  assert.match(m[0], /sub\.id === 'queue'/, 'the count is attached to one named sub-view, not to whichever button happens to be there');
  assert.match(m[0], /mode-count/);
  assert.match(m[0], /buildReviewTimeline\(/, 'and it comes from the model, never recounted in the page');
});

test('#1059 region 03: a node card carries the design\'s SDD strip, sourced from the change the issue owns', () => {
  const m = APP_JS.match(/function renderNodeSdd\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderNodeSdd must exist in app.js');
  assert.match(m[0], /sddForIssue\(/, 'the change comes from the model, never a scan written into the page');
  assert.match(m[0], /found\.reason/, 'an issue with no change directory says so rather than showing an empty strip');
  assert.match(m[0], /change\.dir/, 'the strip names where the change lives, as the design does');
});

test('#1059 region 05: the verdict queue is the design\'s table, with every column from the model', () => {
  const m = APP_JS.match(/function renderQueue\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderQueue must exist in app.js');
  for (const column of ['PR', 'issue', 'rounds', 'latest verdict', 'head judged', 'waiting']) {
    assert.ok(m[0].includes(`'${column}'`), `the table must have the "${column}" column the design draws`);
  }
  assert.match(m[0], /item\.rounds/, 'the counts come from the queue entry, not a second walk of the threads');
  assert.match(m[0], /no round posted/, 'a thread with no round says so in the verdict cell, never an empty cell');
});

test('#1059 region 06: decisions and anti-patterns are tables, and an unreadable row still spans one', () => {
  for (const [fn, columns] of [
    ['renderDecisions', ['ADR', 'title', 'status', 'amendments', 'file']],
    ['renderAntiPatterns', ['scope', 'pattern', 'cited by', 'file']],
  ]) {
    const m = APP_JS.match(new RegExp(`function ${fn}\\(\\) \\{[\\s\\S]*?\\n}\\n`));
    assert.ok(m, `${fn} must exist in app.js`);
    for (const column of columns) {
      assert.ok(m[0].includes(`'${column}'`), `${fn} must draw the "${column}" column the design has`);
    }
  }
  for (const fn of ['renderDecisionRow', 'renderAntiPatternRow']) {
    const m = APP_JS.match(new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?\\n}\\n`));
    assert.match(m[0], /colspan/, `${fn} must keep an unreadable entry as a row across the table, never drop it`);
  }
});

test('#1059 phase 8: the bar offers the three theme choices, and the stored one is read before the first paint', () => {
  assert.match(APP_JS, /THEMES, normalizeTheme, attributeFor/, 'the choices come from lib/theme.mjs, never a list written into the page');
  const m = APP_JS.match(/function renderStatus\(\) \{[\s\S]*?\n}\n/);
  assert.match(m[0], /createElement\('select'\)/, 'the control is a select, as the maintainer asked');
  assert.match(m[0], /readTheme\(\)/, 'it opens on the choice the viewer already made');
  // The rule is ORDER, not adjacency: the stamp must land before anything
  // paints. Asserting the two calls were neighbours broke the moment the
  // finder was mounted between them (#1059), which was a true statement of
  // the wrong thing.
  const boot = APP_JS.slice(APP_JS.indexOf('applyTheme(readTheme());'));
  const firstPaint = boot.indexOf('\nrender();');
  assert.ok(firstPaint > 0, 'the page paints at boot');
  assert.ok(!/(^|[^a-zA-Z])render\(\)/.test(boot.slice('applyTheme(readTheme());'.length, firstPaint)),
    'the stamp lands before the first render, so the page never flashes the other theme');
  assert.match(APP_JS, /catch \{\s*\n\s*return 'system';/, 'storage that cannot be read falls back to the viewer\'s own setting rather than throwing');
});

test('#1059 region 08: the panel draws the slice plan under the stages, with its note', () => {
  const m = APP_JS.match(/function renderTab\([^)]*\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderTab must exist in app.js');
  assert.match(m[0], /tab\.slices/, 'the slice plan rides the tab the design puts it in');
  assert.match(m[0], /tab\.slices\.reason/, 'a change with no plan says why, never an empty heading');
  assert.match(m[0], /tab\.slices\.note/, 'the "PR state is not read" note must reach the reader');
});

// #1059 phase 10, found by the maintainer clicking: `renderDrawer` was called
// only in the map view, and the other three force-hid it. Phases 6 and 10 made
// queue rows and plan issues clickable, so selecting a ticket from either
// could never show its panel. A panel is about a TICKET and a mode is about
// the project, so the panel belongs in every mode.
test('#1059: the node panel is drawn in every mode, never only on the map', () => {
  const m = APP_JS.match(/function renderContent\(\) \{[\s\S]*?\n}\n/);
  assert.ok(m, 'renderContent must exist in app.js');
  const drawn = (m[0].match(/renderDrawer\(\)/g) ?? []).length;
  assert.equal(drawn, 1, 'one call, made for every mode — not one per branch, which is how three of them came to lack it');
  assert.ok(!/mounts\.drawer\.hidden = true/.test(m[0]), 'no mode may force the panel shut: closing it is the reader\'s own control');
});
