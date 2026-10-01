// app.js — the browser entry point (#881 PR 4 / B2). Wiring only: it reads
// the API, hands every frame to `lib/frames.mjs`, and turns the resulting
// state into DOM. Every non-trivial decision — what a frame means, where a
// node goes, what colour it is, what a tab shows — lives in a pure
// `lib/*.mjs` module with its own `node:test`, because this file has no test
// runner (no DOM harness exists in this repo, design D9). What CAN be
// asserted about it is asserted by scan: `app-source-guard.test.mjs`,
// `degradation-banner.test.mjs`, `views-owned.test.mjs`.
//
// Loaded as a plain ES module (`<script type="module" src="/app.js">`): the
// imports below are resolved by the browser against `server.mjs`'s
// `/lib/<module>.mjs` route, which serves the very same files node imports.
// No bundler, no dependency, no CDN (maintainer ruling, 2026-09-14).

import { initialPageState, applyFrame, parseFrame, streamFailed, controlFailed, sectionOf, requestSequence } from './lib/frames.mjs';
import { degradationBands, pollIndicator } from './lib/banners.mjs';
import { THEMES, normalizeTheme, attributeFor } from './lib/theme.mjs';

/**
 * The viewer's own theme choice (#1059 phase 8). It lives in `localStorage`
 * and nowhere else: it is about the reader, not about the project, so it
 * never reaches the repository and no other viewer sees it. Reading it can
 * throw (a private window, blocked site data), and a page that fails to load
 * because it could not read a preference would be absurd — so it falls back
 * to `system`, which is the viewer's own setting.
 */
const THEME_KEY = 'brain:ui:theme';

function readTheme() {
  try {
    return normalizeTheme(window.localStorage.getItem(THEME_KEY));
  } catch {
    return 'system';
  }
}

function applyTheme(choice) {
  const attribute = attributeFor(choice);
  if (attribute === null) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', attribute);
  try {
    window.localStorage.setItem(THEME_KEY, normalizeTheme(choice));
  } catch {
    // The page still honours the choice for this visit; only remembering it
    // failed, and saying so in a band would be noise about the reader's own
    // browser rather than about the project.
  }
}

import { buildLaneModel, nodeSummaryFor, childrenOf } from './lib/lane-model.mjs';
import { issueUrl } from './lib/forge-url.mjs';
import { buildDrawerModel } from './lib/drawer-model.mjs';
import { markdownTree } from './lib/markdown.mjs';
import { buildSddModel, sddForIssue, buildSlicePlan, STAGE_VOCAB } from './lib/sdd-model.mjs';
import { searchNodes } from './lib/search-model.mjs';
import { buildMemoryModel } from './lib/memory-model.mjs';
import { buildReviewTimeline } from './lib/review-timeline.mjs';
import { buildRoadmapModel } from './lib/roadmap-model.mjs';
import { buildDecisionsModel } from './lib/decisions-model.mjs';
import { buildAntiPatternsModel } from './lib/anti-patterns-model.mjs';
import { buildHeaderModel } from './lib/header-model.mjs';
import { STATES } from './lib/state-vocab.mjs';
import { buildHistoryModel, capNote } from './lib/history-model.mjs';
import { buildActorsModel } from './lib/actors-model.mjs';
import { sourceStamp } from './lib/provenance.mjs';
import { MODES, PLACEHOLDERS, initialView, switchMode, keyAction } from './lib/view-model.mjs';
import { GOVERNANCE_VIEWS, GOVERNANCE_PLACEHOLDERS } from './lib/governance-model.mjs';

const mounts = {
  status: document.getElementById('status'),
  modes: document.getElementById('modes'),
  banners: document.getElementById('banners'),
  governanceNav: document.getElementById('governance-nav'),
  search: document.getElementById('search'),
  canvas: document.getElementById('canvas'),
  drawer: document.getElementById('drawer'),
};

let state = initialPageState();
/** The current mode id (#998 R998-2). `map`, `sdd`, `reviews` and `governance` all have real content (#882 R882-1). */
let view = initialView();
/** The active governance sub-view id (#882 R882-1) — mouse/Enter-activated only; the top-level Tab/Esc/J/K contract is untouched. */
let governanceView = GOVERNANCE_VIEWS[0].id;
/** The issue whose node is activated; `null` until one is. The drawer follows it — `map` mode only. */
let selectedIssue = null;
/**
 * The finder's query, and the two nodes it owns (#1059). The INPUT is built
 * once at boot and never re-created, because `render()` runs on every stream
 * frame and `renderStatus` on a five-second clock: rebuilding the control
 * would drop the caret and erase a half-typed query under the reader's hands.
 * Only the result list is redrawn.
 */
/**
 * How the board groups (#1032). The design draws both choices; only track
 * swimlanes could be honoured until `kind` and `parent` became data. `epic`
 * draws one cluster per declared epic and keeps every node the grouping did
 * not claim in its own track lane below, so no node is ever drawn twice and
 * none disappears.
 */
let clustering = 'track';

let searchQuery = '';
let searchInput = null;
let searchResultsMount = null;
/** The last `GET /api/change/<N>` body for the selected issue; `null` while it is still being read. */
let changeView = null;
let activeTab = 'spec';
/**
 * Which track lanes are collapsed (#998 R998-3): a local Set, the same kind
 * of page-only interaction state `selectedIssue`/`activeTab` already are —
 * not part of `frames.mjs`'s state, because it is never derived from a
 * server frame. The `?` holding lane starts in it (lane-model.mjs's own
 * default), so this page never has to decide that on its own.
 */
let collapsedTracks = new Set(['?']);
/** The `?` holding lane's current page (#998 R998-3), 24 rows at a time. */
let holdingPage = 0;
/**
 * Which SDD documents are expanded (#1198), keyed `<issue>:<document>`: the
 * same kind of page-only interaction state as `collapsedTracks`, so a drawer
 * re-render (a tab switch, a refs frame) restores what the reader opened.
 */
let expandedDocs = new Set();
/**
 * `path @ commit` to its markdown tree. A document read at one commit never
 * changes, so the tree is built once per expansion and reused; the map is
 * cleared whenever the selected issue changes so it cannot grow without bound.
 */
let docTrees = new Map();

// ── DOM helpers ────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * THE page's only clock read (#998 R998-6 T4/T6, kept in #1059). Two reads can
 * disagree with each other, so every part of the page that needs "now" takes
 * it from here and passes it into a pure model — no `lib/*.mjs` touches a
 * clock, and no renderer invents an age of its own.
 */
function nowMs() {
  return Date.now();
}

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** A stated reason, in band. The one thing this page never does is show an empty area instead (R881-9). */
function said(text) {
  return el('p', 'said', text);
}

/** A stated list — the same rule as `said`, for facts that come by the handful.
 *  Restored in #1059: phase 5 removed the SVG helpers this sat above and took
 *  it along, leaving seven call sites pointing at nothing. */
function saidList(heading, lines) {
  const wrap = el('div', 'said-group');
  wrap.appendChild(said(heading));
  const list = el('ul', 'said-list');
  for (const line of lines) list.appendChild(el('li', null, line));
  wrap.appendChild(list);
  return wrap;
}


// ── render ─────────────────────────────────────────────────────────────────

function render() {
  renderStatus();
  renderModes();
  renderSearchResults();
  renderBands();
  renderContent();
}

/** The four mode buttons, drawn straight from `lib/view-model.mjs`'s table — no inline handler, no second copy of the labels. */
function renderModes() {
  clear(mounts.modes);
  // Region 02 of the design: the modes as pills carrying their glyph, then the
  // keyboard chips. The glyph and the label both come from `view-model.mjs`'s
  // table — the buttons are that table, never a second copy of it (#1059
  // phase 2, retabled to three modes in #1059's last slice).
  const group = el('div', 'mode-group');
  for (const mode of MODES) {
    const button = el('button', null);
    button.type = 'button';
    button.appendChild(el('span', 'mode-glyph', mode.glyph));
    button.appendChild(el('span', 'mode-label', mode.label));
    // The count that used to ride the Reviews mode does NOT move here. `(3)`
    // beside "Reviews" reads as three reviews; beside "Governance" it reads as
    // three governance things, which is not what it counts. It moved to the
    // Verdict queue sub-nav button, where the word beside it says what it is
    // (#1059).
    if (mode.id === view) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => switchToMode(mode.id));
    group.appendChild(button);
  }
  mounts.modes.appendChild(group);

  const keys = el('div', 'mode-keys');
  for (const [key, what] of [['J/K', 'node'], ['Tab', 'view'], ['Esc', 'close']]) {
    const hint = el('span', 'mode-key');
    hint.appendChild(el('kbd', null, key));
    hint.appendChild(el('span', null, what));
    keys.appendChild(hint);
  }
  mounts.modes.appendChild(keys);
}

function switchToMode(mode) {
  view = switchMode(view, mode);
  render();
}

/** The router (#998 R998-2/R998-4/R998-5, #882 R882-1): `map` draws the canvas + drawer, `sdd` draws the seven-stage matrix, `reviews` draws the timeline + verdict queue, `governance` draws its own sub-nav + sub-router. `#governance-nav` is shown only while `governance` is the active mode. */
/**
 * The finder (#1059, the maintainer's ask: "un buscador para poder encontrar
 * las epicas, trackers y tickets"). Built ONCE, at boot.
 *
 * The control cannot be rebuilt on render. `render()` runs on every stream
 * frame and `renderStatus` on a five-second clock, and re-creating an input
 * element drops the caret and the value with it — the reader would lose the
 * word they were half way through typing, on someone else's push. So the
 * shell is mounted once and only `renderSearchResults` ever redraws, which is
 * also why the query lives in module state rather than in the DOM.
 */
function mountSearch() {
  clear(mounts.search);

  const field = el('label', 'search-field');
  field.appendChild(el('span', 'search-label', 'Find'));

  const input = document.createElement('input');
  input.type = 'search';
  input.className = 'search-input';
  input.setAttribute('placeholder', 'issue number, title, track or label');
  input.setAttribute('autocomplete', 'off');
  input.addEventListener('input', () => {
    searchQuery = input.value;
    renderSearchResults();
  });
  input.addEventListener('keydown', (event) => {
    // The page owns J/K/Tab/Esc as chords over the board. They must not fire
    // while someone is typing a title into this box, and the input is where
    // that is decided — `onKeyDown` listens on the document, so without this
    // every letter would also be a shortcut.
    if (typeof event.stopPropagation === 'function') event.stopPropagation();
    if (event.key === 'Escape') {
      input.value = '';
      searchQuery = '';
      renderSearchResults();
      return;
    }
    if (event.key === 'Enter') {
      const first = searchNodes(sectionOf(state, 'graph'), searchQuery);
      if (first.ok && first.value.results.length > 0) selectNode(first.value.results[0].number);
    }
  });
  field.appendChild(input);
  searchInput = input;

  mounts.search.appendChild(field);
  searchResultsMount = el('div', 'search-results');
  mounts.search.appendChild(searchResultsMount);
  renderSearchResults();
}

/**
 * The result list, and only it. Every row states what it matched on, so a hit
 * a reader did not expect explains itself instead of looking like noise; a
 * node whose body could not be read is still listed, with its reason, because
 * an unreadable issue is exactly the one a reader is most likely hunting.
 */
function renderSearchResults() {
  if (searchResultsMount === null) return;
  clear(searchResultsMount);

  const found = searchNodes(sectionOf(state, 'graph'), searchQuery);
  if (!found.ok) {
    searchResultsMount.appendChild(said(found.reason));
    return;
  }

  const { results, shown, total, note, epicTrackerFacet } = found.value;

  // Asked for epics or trackers BY NAME, the page must not answer with an
  // empty list as though none existed: those are declared fields that no
  // issue body carries yet, and the model says so. The notice is gated on the
  // query actually asking, because a sentence about `kind` under every search
  // for a title is noise, and noise is how a real statement stops being read.
  if (!epicTrackerFacet.ok && /epic|tracker/i.test(searchQuery)) {
    searchResultsMount.appendChild(said(epicTrackerFacet.reason));
  }

  if (note && results.length === 0) {
    searchResultsMount.appendChild(said(note));
    return;
  }

  const count = el('p', 'search-count', shown === total
    ? `${total} match${total === 1 ? '' : 'es'}`
    : `${shown} of ${total} matches — narrow the query to see the rest`);
  searchResultsMount.appendChild(count);

  const list = el('div', 'search-list');
  for (const row of results) {
    const hit = el('div', `search-hit${row.ok ? '' : ' search-hit-unreadable'}`);
    hit.setAttribute('role', 'button');
    hit.setAttribute('tabindex', '0');
    hit.setAttribute('data-issue', String(row.number));

    const head = el('div', 'search-hit-head');
    head.appendChild(el('span', 'search-hit-number', `#${row.number}`));
    // The maintainer asked to find EPICS, TRACKERS and tickets, so a result
    // that is one says which — from the node's own declaration, never from
    // its title text. A ticket declares nothing here and stays a ticket.
    if (row.kind) head.appendChild(el('span', `search-hit-kind kind-${row.kind}`, row.kind));
    if (row.tracker) head.appendChild(el('span', 'search-hit-tracker', `tracker ${row.tracker}`));
    if (row.track) head.appendChild(el('span', 'search-hit-track', row.track));
    head.appendChild(el('span', 'search-hit-matched', `matched ${row.matchedBy.join(', ')}`));
    hit.appendChild(head);

    hit.appendChild(el('p', 'search-hit-title', row.title || '(no title)'));
    if (!row.ok) hit.appendChild(said(row.reason));

    hit.addEventListener('click', () => selectNode(row.number));
    hit.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') selectNode(row.number); });
    list.appendChild(hit);
  }
  searchResultsMount.appendChild(list);
}

/**
 * Memory (#1059, the maintainer's ask): the `.memory/records` ledger, at the
 * top level rather than buried inside two governance sub-views that each read
 * a slice of it. The summary leads: how many records there are and how they
 * split by type and by who wrote them, then the integrity signal, then the
 * most recent rows.
 *
 * `now` is read HERE and passed in, because `lib/memory-model.mjs` is pure and
 * forbidden from touching a clock — an age it invented would be a fact with no
 * source, which is the one thing this page never shows.
 */
function renderMemory() {
  clear(mounts.canvas);

  const model = buildMemoryModel(sectionOf(state, 'records'), { now: nowMs() });
  if (!model.ok) {
    mounts.canvas.appendChild(said(`the memory ledger could not be read: ${model.reason}`));
    return;
  }
  const { totalRecords, recent, countsByType, countsByActorKind, duplicates, note } = model.value;

  mounts.canvas.appendChild(el('p', 'canvas-summary', `${totalRecords} memory record(s) · .memory/records/`));
  if (note) {
    // An empty ledger is a different fact from an unreadable one, and the
    // model keeps them apart; so does the page.
    mounts.canvas.appendChild(said(note));
    return;
  }

  const chips = el('div', 'memory-counts');
  for (const { type, count } of countsByType) {
    const chip = el('span', 'memory-chip');
    chip.appendChild(el('span', 'memory-chip-word', type));
    chip.appendChild(el('span', 'memory-chip-count', String(count)));
    chips.appendChild(chip);
  }
  for (const { actorKind, count } of countsByActorKind) {
    const chip = el('span', 'memory-chip memory-chip-actor');
    chip.appendChild(el('span', 'memory-chip-word', actorKind));
    chip.appendChild(el('span', 'memory-chip-count', String(count)));
    chips.appendChild(chip);
  }
  mounts.canvas.appendChild(chips);

  // The integrity signal is never a number on its own: the same record id
  // disagreeing with itself is a problem someone has to go and look at, so
  // the ids and the lines they sit on are named.
  if (!duplicates.ok) {
    mounts.canvas.appendChild(said(duplicates.reason));
  } else if (duplicates.integrityNote) {
    const divergent = duplicates.groups.filter((g) => g.divergent);
    if (divergent.length > 0) {
      mounts.canvas.appendChild(saidList(duplicates.integrityNote,
        divergent.map((g) => `${g.id}: ${g.occurrences.join(', ')}`)));
    } else {
      mounts.canvas.appendChild(said(duplicates.integrityNote));
    }
  }

  mounts.canvas.appendChild(el('p', 'canvas-summary', recent.shown === recent.total
    ? `every record, most recent first`
    : `the ${recent.shown} most recent of ${recent.total}`));

  const scroller = el('div', 'table-scroller');
  const table = el('table', 'memory-table');
  const thead = el('thead', null);
  const head = el('tr', null);
  for (const column of ['when', 'type', 'actor', 'record', 'source']) head.appendChild(el('th', null, column));
  thead.appendChild(head);
  table.appendChild(thead);

  const body = el('tbody', null);
  for (const record of recent.records) {
    const tr = el('tr', null);
    // A record whose own timestamp could not be parsed says so where its age
    // would have gone — never a blank cell, and never a guessed age.
    tr.appendChild(el('td', 'memory-when', record.relativeTime ?? (record.tsUnparseable ? `unparseable: ${record.ts}` : record.ts)));
    tr.appendChild(el('td', 'memory-type', record.type));
    const actor = el('td', 'memory-actor');
    actor.appendChild(el('span', 'memory-actor-name', record.actor));
    actor.appendChild(el('span', 'memory-actor-kind', record.actorKind ?? 'unknown'));
    tr.appendChild(actor);
    tr.appendChild(el('td', 'memory-id', record.id));
    const source = el('td', 'memory-source');
    source.appendChild(renderSourceStamp(record.sourceStamp));
    tr.appendChild(source);
    body.appendChild(tr);
  }
  table.appendChild(body);
  scroller.appendChild(table);
  mounts.canvas.appendChild(scroller);
}

function renderContent() {
  mounts.governanceNav.hidden = view !== 'governance';
  if (view !== 'governance') clear(mounts.governanceNav);

  if (view === 'map') renderLanes();
  else if (view === 'governance') renderGovernance();
  else if (view === 'memory') renderMemory();

  // The panel is about a TICKET; a mode is about the project. So it is drawn
  // once, for every mode — a queue row or a plan issue opens it without
  // throwing the reader out of what they were reading (#1059 phase 10, found
  // by the maintainer clicking a row and getting nothing).
  renderDrawer();
}

/** R881-9: one band per degraded thing, each one BESIDE the data, never instead of it. */
function renderBands() {
  clear(mounts.banners);
  for (const band of degradationBands({ stream: state.stream, controls: state.controls, meta: state.meta, snapshot: state.snapshot })) {
    const node = el('div', 'band');
    node.appendChild(el('span', null, band.text));
    if (band.detail?.length) {
      const list = el('ul', 'said-list');
      for (const line of band.detail) list.appendChild(el('li', null, line));
      node.appendChild(list);
    }
    mounts.banners.appendChild(node);
  }
}

/**
 * The maintainer's poll ruling, rendered: a visible "forge polled N s ago /
 * paused" indicator, a control that disables polling, and a button for one
 * manual poll. Both controls POST — the only mutation verbs this server
 * accepts (R881-5).
 */
/** The served branch, said with its own source stamp (#998 R998-6 T3) — a detached or unreadable HEAD is a said reason, never a blank header. */
function renderServedBranch(servedBranch) {
  const frag = document.createDocumentFragment();
  if (servedBranch === null) {
    frag.appendChild(el('span', 'served-branch', 'serving: unknown until the stream connects'));
    return frag;
  }
  const text = servedBranch.ok ? `serving ${servedBranch.branch}` : `serving: unknown (${servedBranch.reason})`;
  frag.appendChild(el('span', 'served-branch', text));
  frag.appendChild(renderSourceStamp(sourceStamp(servedBranch.source)));
  return frag;
}

function renderStatus() {
  const indicator = pollIndicator({ poller: state.meta?.poller ?? null, nowMs: nowMs() });
  // Region 01 of the maintainer's design: the wordmark and the branch, then
  // what is live, then the counts, then the controls. `header-model.mjs` owns
  // every value; this function places them (#1059 phase 1).
  const header = buildHeaderModel(sectionOf(state, 'graph'), state.meta ?? {});
  const { counts, epic } = header.value;
  clear(mounts.status);

  mounts.status.appendChild(el('strong', 'title', 'brain:ui'));
  mounts.status.appendChild(renderServedBranch(state.meta?.servedBranch ?? null));

  const live = el('span', 'status-live', indicator.paused ? 'paused' : 'live');
  live.setAttribute('title', indicator.paused ? 'polling is paused' : 'the page is connected to the stream');
  mounts.status.appendChild(live);

  mounts.status.appendChild(el('span', indicator.paused ? 'poll-indicator paused' : 'poll-indicator', indicator.text));
  mounts.status.appendChild(el('span', 'poll-countdown', indicator.countdown));

  // The epic this checkout serves: an epic declares its tracker branch, and
  // nothing joins the two yet, so the bar says that rather than parsing an
  // epic out of a branch name.
  mounts.status.appendChild(el('span', 'status-epic', epic.ok ? `epic #${epic.issue}` : 'epic: not resolved'));
  mounts.status.appendChild(el('span', 'status-epic-reason', epic.ok ? '' : epic.reason));

  const countsEl = el('span', 'status-counts');
  if (counts.ok) {
    countsEl.appendChild(el('span', 'count-label', 'nodes'));
    countsEl.appendChild(el('span', 'count-total', String(counts.nodes)));
    countsEl.appendChild(el('span', 'count-sep', '\u00b7'));
    countsEl.appendChild(el('span', 'count-label', 'tracked'));
    countsEl.appendChild(el('span', 'count-tracked', String(counts.tracked)));
    countsEl.appendChild(el('span', 'count-sep', '\u00b7'));
    countsEl.appendChild(el('span', 'count-undeclared', `${counts.undeclared} undeclared`));
  } else {
    countsEl.appendChild(el('span', 'count-label', `nodes: not counted — ${counts.reason}`));
  }
  mounts.status.appendChild(countsEl);

  mounts.status.appendChild(el('span', 'spacer'));

  // The theme control: three choices, the current one selected. `system` is
  // the default and stamps nothing, so the page follows the viewer's own
  // setting unless they say otherwise.
  const themeWrap = el('label', 'theme-choice');
  themeWrap.appendChild(el('span', 'theme-label', 'theme'));
  const select = document.createElement('select');
  select.id = 'theme-select';
  const current = readTheme();
  for (const theme of THEMES) {
    const option = document.createElement('option');
    option.value = theme.id;
    option.textContent = theme.label;
    if (theme.id === current) option.selected = true;
    select.appendChild(option);
  }
  select.addEventListener('change', () => { applyTheme(select.value); });
  themeWrap.appendChild(select);
  mounts.status.appendChild(themeWrap);

  const toggle = el('button', 'poll-toggle', indicator.paused ? 'resume polling' : 'disable polling');
  toggle.addEventListener('click', () => postPoll(indicator.paused ? 'resume' : 'pause'));
  const once = el('button', 'poll-once', 'poll now');
  once.addEventListener('click', () => postPoll('once'));
  mounts.status.appendChild(toggle);
  mounts.status.appendChild(once);
}

/**
 * The DAG, drawn as track lanes (#998 R998-3): one row per declared track —
 * each with its OWN board, `layout()` run once per lane by `lane-model.mjs`
 * — then the `?` holding lane last, as a paged list rather than a board
 * (undeclared nodes carry no track to lay coordinates out against). Every
 * decision — grouping, coordinates, colour, which marks a node carries —
 * was already made by `lane-model.mjs`; this function only turns that model
 * into elements.
 */
function renderLanes() {
  const model = buildLaneModel(sectionOf(state, 'graph'), { collapsedTracks, holdingPage, project: state.meta?.project ?? null, clustering });
  clear(mounts.canvas);
  if (!model.ok) {
    mounts.canvas.appendChild(said(`the graph could not be computed: ${model.reason}`));
    return;
  }
  const { lanes, crossEdges, holding, droppedEdges, issuesUnreadable, edgeSummary } = model.value;
  // The design's clustering row and legend sit above the lanes (#1059 region
  // 03). The legend is built from `state-vocab.mjs` itself — a hand-written
  // list here would be a second definition of what a state is called.
  mounts.canvas.appendChild(renderClusteringBar());
  mounts.canvas.appendChild(el('p', 'canvas-summary', `${lanes.length} track lane(s), ${holding.count} in the \`?\` holding lane`));
  mounts.canvas.appendChild(el('p', 'edge-summary', `edges: ${edgeSummary.laneInternal} in lanes, ${edgeSummary.holdingInternal} in the \`?\` holding lane, ${edgeSummary.crossLane} crossing lanes, ${edgeSummary.unknownNode} to an unknown node (${edgeSummary.total} total)`));

  // #1032: in epic clustering the declared epics lead, and the lanes below
  // carry only what no epic claimed. The filter reads the model's OWN
  // `unclaimed` set rather than re-deciding from `kind`/`parent` here — a
  // second answer to a question the model already answered can disagree with
  // the first, and the board would draw a node twice or lose one.
  const grouping = model.value.epicGrouping;
  const epicMode = clustering === 'epic' && grouping.ok;
  if (clustering === 'epic' && !grouping.ok) {
    mounts.canvas.appendChild(said(`the epics could not be grouped: ${grouping.reason}`));
  }
  if (epicMode) mounts.canvas.appendChild(renderEpicClusters(grouping.value));

  const unclaimed = epicMode ? new Set(grouping.value.unclaimed) : null;
  for (const lane of lanes) {
    const shown = epicMode ? { ...lane, nodes: lane.nodes.filter((n) => unclaimed.has(n.number)) } : lane;
    // A lane emptied by clustering is not drawn: every one of its nodes is on
    // screen above, under the epic that claimed it. A lane with zero nodes
    // does not exist here either (R998-3).
    if (shown.nodes.length > 0) mounts.canvas.appendChild(renderLaneRow({ ...shown, count: shown.nodes.length }));
  }
  mounts.canvas.appendChild(renderHoldingLane(holding));

  // A cross-lane edge is never a line (R998-3: lanes have no shared
  // coordinate space to draw one across) — it is said, like every other
  // fact this page lists beside a drawing rather than folding into it.
  if (crossEdges.length > 0) {
    mounts.canvas.appendChild(saidList(`${crossEdges.length} edge(s) cross lanes:`, crossEdges.map((e) => `#${e.from} → #${e.to} crosses lanes ${e.fromTrack} → ${e.toTrack}`)));
  }
  if (droppedEdges.length > 0) {
    mounts.canvas.appendChild(saidList(`${droppedEdges.length} edge(s) could not be drawn:`, droppedEdges.map((e) => `#${e.from} → #${e.to}: ${e.reason}`)));
  }
  if (issuesUnreadable.length > 0) {
    mounts.canvas.appendChild(saidList(`${issuesUnreadable.length} issue body(ies) could not be read:`, issuesUnreadable.map((i) => `#${i.number}: ${i.reason}`)));
  }
}

/** One state chip per code present in a lane's nodes, `mark word × n` — built from each node's own `state` (lane-model.mjs, state-vocab.mjs) so the header's summary cannot drift from the board below it. */
function stateChips(nodes) {
  const byCode = new Map();
  for (const node of nodes) {
    const entry = byCode.get(node.state.code) ?? { ...node.state, n: 0 };
    entry.n += 1;
    byCode.set(node.state.code, entry);
  }
  return [...byCode.values()];
}

function renderLaneHeader(label, count, nodes, toggle) {
  const header = el('div', 'lane-header');
  header.appendChild(el('strong', null, label));
  header.appendChild(el('span', 'lane-count', String(count)));
  const chips = el('span', 'lane-chips');
  for (const chip of stateChips(nodes)) chips.appendChild(el('span', 'chip', `${chip.mark} ${chip.label} × ${chip.n}`));
  header.appendChild(chips);
  if (toggle) header.appendChild(toggle);
  return header;
}

/**
 * The declared epics and their slices (#1032). Each epic leads its own
 * cluster: the epic's card, the tracker branch it declared, and the slices
 * that named it as their parent.
 *
 * Every absence here is a sentence, never a gap. An epic that declared no
 * tracker says so — that is `ticket-base.mjs`'s own `epic-declares-no-tracker`
 * state and it is true of every epic in this repository today. A node whose
 * declared parent did not resolve to an epic is listed apart with the reason
 * the graph reported, rather than being quietly reparented or dropped.
 */
function renderEpicClusters(grouping) {
  const wrap = document.createElement('div');
  const { epics, divergentChildren } = grouping;

  if (epics.length === 0) {
    wrap.appendChild(said('no issue declares `kind: epic`, so there is nothing to cluster by — the track lanes below are the whole board'));
    return wrap;
  }

  wrap.appendChild(el('p', 'canvas-summary', `${epics.length} declared epic(s)`));

  for (const epic of epics) {
    const cluster = el('div', 'epic-cluster');

    // The epic leads its own cluster as a HEADING, not as another card —
    // a card plus a header would say its number and title twice. But its
    // STATE must still be on screen: an epic is a node like any other, and
    // hiding whether it is planned or in flight would make the one mode
    // organised around epics the only place you cannot see how they are
    // going. The chip is built from the same `state` words every card uses.
    const head = el('div', 'epic-head');
    head.appendChild(el('span', 'epic-number', `#${epic.number}`));
    const chip = el('span', `node-state state-${epic.state.code}`);
    chip.appendChild(el('span', 'node-state-mark', epic.state.mark));
    chip.appendChild(el('span', 'node-state-word', epic.state.label));
    head.appendChild(chip);
    head.appendChild(el('h3', 'epic-title', epic.title || '(no title)'));
    if (epic.track) head.appendChild(el('span', 'epic-track', epic.track));
    head.appendChild(el('span', 'epic-count', `${epic.children.length} slice(s)`));
    cluster.appendChild(head);
    for (const mark of epic.marks) cluster.appendChild(said(mark));

    // Clicking the epic opens its panel, the same panel its slices open.
    head.setAttribute('role', 'button');
    head.setAttribute('tabindex', '0');
    head.setAttribute('data-issue', String(epic.number));
    head.addEventListener('click', () => selectNode(epic.number));
    head.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') selectNode(epic.number); });

    // The tracker is the branch an epic's slices are supposed to target, and
    // an epic that declared none cannot have that checked at all — so the
    // absence is named rather than left as a blank line.
    const tracker = el('p', 'epic-tracker');
    if (epic.tracker.branch) {
      tracker.appendChild(el('span', 'epic-tracker-label', 'tracker'));
      tracker.appendChild(el('span', 'epic-tracker-branch', epic.tracker.branch));
      if (epic.tracker.stamp) tracker.appendChild(renderSourceStamp(epic.tracker.stamp));
    } else {
      tracker.appendChild(el('span', 'epic-tracker-none', epic.tracker.reason ?? 'this epic declares no tracker branch'));
    }
    cluster.appendChild(tracker);

    if (epic.parentDivergence) {
      cluster.appendChild(said(`declared parent #${epic.parentDivergence.parent} (from the ${epic.parentDivergence.parentSource ?? 'unknown'}): ${epic.parentDivergence.reason}`));
    }

    if (epic.children.length === 0) {
      cluster.appendChild(said('no open issue declares this epic as its parent'));
    } else {
      const grid = el('div', 'lane-grid');
      for (const child of epic.children) grid.appendChild(renderNodeCard(child));
      cluster.appendChild(grid);
    }

    wrap.appendChild(cluster);
  }

  if (divergentChildren.length > 0) {
    wrap.appendChild(saidList(`${divergentChildren.length} issue(s) declare a parent that is not an epic:`,
      divergentChildren.map((c) => `#${c.number} declares #${c.parent} (from the ${c.parentSource ?? 'unknown'}): ${c.reason}`)));
  }

  return wrap;
}

function renderLaneRow(lane) {
  const row = el('div', 'lane-row');
  row.appendChild(renderLaneHeader(lane.label, lane.count, lane.nodes, null));
  row.appendChild(renderLaneCards(lane));
  return row;
}

/**
 * A lane as the maintainer's design draws it: a grid of cards, one per node
 * (#1059 region 03). The DAG's edges are NOT lines here — a card says what it
 * waits on in words, and the cross-lane and undrawable edges keep the said
 * lists below, which is where they already were. Every value still comes from
 * `lane-model.mjs`; this function places them.
 */
/** The design's clustering control and legend (#1059 region 03). Epic clustering is
 * not offered as a working control: `kind` and `parent` are node fields since #967
 * but the lane model does not group by them yet (#1032), so the button says what it
 * is waiting on rather than switching to nothing. */
function renderClusteringBar() {
  const bar = el('div', 'clustering-bar');

  const left = el('div', 'clustering-controls');
  left.appendChild(el('span', 'clustering-label', 'clustering'));
  const byTrack = el('button', 'clustering-choice', 'track swimlanes');
  byTrack.type = 'button';
  if (clustering === 'track') byTrack.setAttribute('aria-current', 'true');
  byTrack.addEventListener('click', () => { clustering = 'track'; render(); });

  // #1032: no longer disabled. `kind` and `parent` are declarations the issue
  // bodies carry and `lane-model.mjs` now groups by them.
  const byEpic = el('button', 'clustering-choice', 'epic clusters');
  byEpic.type = 'button';
  if (clustering === 'epic') byEpic.setAttribute('aria-current', 'true');
  byEpic.addEventListener('click', () => { clustering = 'epic'; render(); });

  left.appendChild(byTrack);
  left.appendChild(byEpic);
  left.appendChild(el('span', 'clustering-note', clustering === 'epic'
    ? 'grouped by the epic each issue declares as its parent'
    : 'grouped by the track each issue declares'));
  bar.appendChild(left);

  const legend = el('div', 'legend');
  legend.appendChild(el('span', 'legend-label', 'legend'));
  for (const state of Object.values(STATES)) {
    const item = el('span', `legend-item state-${state.code}`);
    item.appendChild(el('span', 'legend-mark', state.mark));
    item.appendChild(el('span', 'legend-word', state.label));
    legend.appendChild(item);
  }
  bar.appendChild(legend);
  return bar;
}

/**
 * The strip the design puts at the foot of a card (#1059 region 03): the stage
 * the change reached, how many of its tasks are ticked, and the directory it
 * lives in — each with its own source, like every other value here. An issue
 * with no change directory says that instead of showing an empty strip.
 */
function renderNodeSdd(issue) {
  const strip = el('div', 'node-sdd');
  const found = sddForIssue(sectionOf(state, 'changes'), issue);
  if (!found.ok) {
    strip.appendChild(el('span', 'node-sdd-none', found.reason));
    return strip;
  }
  const change = found.value;
  const reached = [...change.stages].reverse().find((stage) => stage.state === 'present' || stage.state === 'done');
  strip.appendChild(el('span', 'node-sdd-label', change.archived ? 'archived' : 'SDD'));
  strip.appendChild(el('span', 'node-sdd-stage', reached ? reached.id : 'no stage present'));
  if (change.tasks && typeof change.tasks.checked === 'number') {
    const total = change.tasks.checked + (change.tasks.open ?? 0);
    strip.appendChild(el('span', 'node-sdd-tasks', `tasks ${change.tasks.checked}/${total}`));
  }
  strip.appendChild(el('span', 'node-sdd-dir', change.dir));
  return strip;
}

function renderLaneCards(lane) {
  const grid = el('div', 'lane-grid');
  for (const node of lane.nodes) grid.appendChild(renderNodeCard(node));
  return grid;
}

function renderNodeCard(node) {
  const card = el('div', `node-card ${node.className}${node.number === selectedIssue ? ' selected' : ''}`);
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  card.setAttribute('data-issue', String(node.number));

  const head = el('div', 'node-card-head');
  head.appendChild(el('span', 'node-number', `#${node.number}`));
  const chip = el('span', `node-state state-${node.state.code}`);
  chip.appendChild(el('span', 'node-state-mark', node.state.mark));
  chip.appendChild(el('span', 'node-state-word', node.state.label));
  head.appendChild(chip);
  card.appendChild(head);

  card.appendChild(el('h4', 'node-title', node.title || '(no title)'));

  if (node.blockedBy.length > 0) {
    card.appendChild(el('p', 'node-blocked', `blocked by ${node.blockedBy.map((n) => `#${n}`).join(', ')}`));
  }
  for (const mark of node.marks) card.appendChild(said(mark));
  card.appendChild(renderNodeSdd(node.number));

  card.addEventListener('click', () => selectNode(node.number));
  card.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') selectNode(node.number); });
  return card;
}


/**
 * The `?` holding lane (#998 R998-3): a header with a show/hide toggle
 * (never a board), the fence an author pastes to leave it, and 24 rows at a
 * time while expanded. A lane with zero nodes does not exist, but the
 * holding lane always does — when empty, it says why instead of showing a
 * blank expanded area.
 */
function renderHoldingLane(holding) {
  // Region 04 of the design: the undeclared issues are a BATCH, not a lane —
  // a panel that states the proportion, shows what to paste to declare, and
  // lists the issues as small tiles with the rest counted. The board that used
  // to draw this page's holding-holding edges is gone with it; those edges are
  // still classified by the model and are now SAID here, which is what the
  // rest of this page does with an edge it does not draw (#1059 phase 5).
  const toggle = el('button', 'lane-toggle', holding.collapsed ? 'show' : 'hide');
  toggle.type = 'button';
  toggle.addEventListener('click', () => {
    collapsedTracks = new Set(collapsedTracks);
    if (collapsedTracks.has('?')) collapsedTracks.delete('?'); else collapsedTracks.add('?');
    render();
  });

  const panel = el('div', 'batch');

  const head = el('div', 'batch-head');
  const left = el('div', 'batch-title');
  left.appendChild(el('span', 'batch-mark', '?'));
  left.appendChild(el('span', 'batch-word', 'undeclared'));
  left.appendChild(el('span', 'batch-count', `${holding.count} of ${holding.total} open issues declared no block`));
  // Not hidden — shown somewhere else. Without this the batch would appear to
  // shrink when the reader switched clustering, which reads as the graph
  // changing rather than the view (#1079).
  if (holding.claimedElsewhere > 0) {
    left.appendChild(el('span', 'batch-elsewhere', `${holding.claimedElsewhere} more shown under their epic`));
  }
  head.appendChild(left);
  head.appendChild(toggle);
  panel.appendChild(head);

  if (holding.collapsed) return panel;

  if (holding.note) {
    panel.appendChild(said(holding.note));
    return panel;
  }

  const how = el('div', 'batch-declare');
  how.appendChild(el('span', 'batch-declare-label', 'to declare, paste in the issue body'));
  how.appendChild(el('code', null, holding.declareSnippet));
  // #1079 cold review, finding cold-2. The snippet gained `kind: epic` and
  // `parent: 878` and the note explaining that both lines are CONDITIONAL was
  // carried by the model and drawn nowhere — so the page showed a pasteable
  // block that, taken at its word, declares a repository full of epics all
  // parented to one ticket. A caveat that exists only in the model is not a
  // caveat; it is the same silence one module along.
  if (holding.declareNote) how.appendChild(el('p', 'batch-declare-note', holding.declareNote));
  panel.appendChild(how);

  const tiles = el('div', 'batch-tiles');
  for (const node of holding.nodes) {
    const tile = el('div', 'batch-tile');
    tile.setAttribute('role', 'button');
    tile.setAttribute('tabindex', '0');
    tile.appendChild(el('span', 'batch-tile-number', `#${node.number}`));
    tile.appendChild(el('p', 'batch-tile-title', node.title || '(no title)'));
    tile.addEventListener('click', () => selectNode(node.number));
    tile.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') selectNode(node.number); });
    tiles.appendChild(tile);
  }
  panel.appendChild(tiles);

  const foot = el('div', 'batch-foot');
  const shown = holding.nodes.length;
  const rest = holding.count - shown;
  foot.appendChild(el('span', 'batch-rest', rest > 0 ? `+ ${rest} more` : 'all of them are listed'));
  if (holding.edgeCount > 0) {
    foot.appendChild(el('span', 'batch-edges', `${holding.edgeCount} edge(s) run between undeclared issues — said, not drawn: this batch has no coordinate space`));
  }
  panel.appendChild(foot);

  if (holding.totalPages > 1) panel.appendChild(renderPager(holding));
  return panel;
}

function renderPager(holding) {
  const pager = el('div', 'pager');
  const prev = el('button', null, 'prev');
  prev.type = 'button';
  prev.disabled = holding.page === 0;
  prev.addEventListener('click', () => { holdingPage = Math.max(0, holdingPage - 1); render(); });
  const next = el('button', null, 'next');
  next.type = 'button';
  next.disabled = holding.page >= holding.totalPages - 1;
  next.addEventListener('click', () => { holdingPage = Math.min(holding.totalPages - 1, holdingPage + 1); render(); });
  pager.appendChild(prev);
  pager.appendChild(el('span', null, `page ${holding.page + 1} / ${holding.totalPages}`));
  pager.appendChild(next);
  return pager;
}

/**
 * The SDD view (#998 R998-4): one row per change — active first, archived
 * under their own heading with their archive path — each with its seven
 * stage cells, its task count, its slice plan (declared scope only, "PR
 * state is not read" said in band per the ruling), and its named
 * phase-order violations. `lib/sdd-model.mjs` decided all of it; this
 * renders one loop over rows this page never re-derives.
 */
function renderSdd() {
  // The PROJECT's chained-PR plan, not a matrix of every change's seven
  // stages: per-change detail belongs in the panel a reader opens by clicking
  // a ticket, which is where it lives (#1059 phase 10). This was the design's
  // fourth MODE until the last slice, when it moved under Governance — a plan
  // across every change is a fact about the repository, and that is where
  // facts about the repository live.
  const model = buildSlicePlan(sectionOf(state, 'changes'));
  clear(mounts.canvas);
  if (!model.ok) {
    mounts.canvas.appendChild(said(`the slice plan could not be computed: ${model.reason}`));
    return;
  }
  const { changes, unreadable, note, archiveSkipped } = model.value;
  mounts.canvas.appendChild(el('p', 'canvas-summary', `${changes.length} change(s) declare a chained plan`));
  mounts.canvas.appendChild(said(note));
  if (archiveSkipped.count > 0) {
    mounts.canvas.appendChild(said(`${archiveSkipped.count} archive dir(s) skipped: ${archiveSkipped.names.join(', ')}`));
  }

  if (changes.length === 0) {
    mounts.canvas.appendChild(said('no change in this tree declares a slice plan in its tasks.md'));
  }

  for (const change of changes) {
    const block = el('div', 'plan-change');
    const head = el('div', 'plan-change-head');
    const open = el('button', 'plan-issue', `#${change.issue}`);
    open.type = 'button';
    open.addEventListener('click', () => selectNode(change.issue));
    head.appendChild(open);
    if (change.archived) head.appendChild(el('span', 'plan-archived', 'archived'));
    head.appendChild(renderSourceStamp(sourceStamp(change.source)));
    block.appendChild(head);

    const list = el('ol', 'plan-slices');
    for (const slice of change.slices) {
      const item = el('li', 'plan-slice');
      item.appendChild(el('span', 'plan-slice-n', `slice ${slice.slice}`));
      item.appendChild(el('span', 'plan-claims', slice.claims.length > 0 ? slice.claims.join(', ') : 'claims nothing'));
      if (slice.terminalPr) item.appendChild(el('span', 'plan-terminal', slice.terminalPr));
      list.appendChild(item);
    }
    block.appendChild(list);
    mounts.canvas.appendChild(block);
  }

  if (unreadable.length > 0) {
    mounts.canvas.appendChild(saidList(`${unreadable.length} declared plan(s) could not be read:`, unreadable.map((u) => `#${u.issue}: ${u.reason}`)));
  }
}
function renderSddRow(change, sliceNote) {
  const row = el('div', 'sdd-row');
  const header = el('div', 'sdd-row-header');
  header.appendChild(el('strong', null, `#${change.issue}${change.slug ? ` ${change.slug}` : ''}`));
  header.appendChild(el('span', 'source', sourceStamp({ path: change.dir }).label));
  row.appendChild(header);

  const matrix = el('div', 'sdd-matrix');
  for (const stage of change.stages) {
    const cell = el('span', `sdd-stage sdd-stage-${stage.state}`, `${STAGE_VOCAB[stage.state].mark} ${stage.id} `);
    cell.appendChild(el('span', 'source', sourceStamp(stage.source).label));
    matrix.appendChild(cell);
  }
  row.appendChild(matrix);

  const t = change.tasks;
  const tasksLine = el('p', 'sdd-tasks', `tasks: ${t.checked} checked, ${t.open} open${t.next ? ` — next: ${t.next}` : ''} `);
  tasksLine.appendChild(el('span', 'source', sourceStamp(t.source).label));
  row.appendChild(tasksLine);

  if (change.slices.length > 0) {
    const wrap = document.createElement('div');
    wrap.appendChild(said(`slice plan (declared scope only — ${sliceNote}):`));
    const list = el('ul', 'said-list');
    for (const s of change.slices) {
      const li = document.createElement('li');
      li.appendChild(document.createTextNode(`slice ${s.n}: claims ${s.claims.join(', ')} → ${s.terminalPr} `));
      li.appendChild(el('span', 'source', sourceStamp(s.source).label));
      list.appendChild(li);
    }
    wrap.appendChild(list);
    row.appendChild(wrap);
  }
  if (change.phaseOrder.violations.length > 0) {
    row.appendChild(saidList(`${change.phaseOrder.violations.length} phase-order violation(s):`, change.phaseOrder.violations.map((v) => `${v.stage}: ${v.reason}`)));
  }
  return row;
}

/**
 * The reviews view (#998 R998-5): the verdict queue first ("waiting on a
 * verdict right now"), then one card per PR thread with its rounds oldest
 * first — verdict word + ✓/✕ mark, findings grouped by severity. An
 * unreadable thread is a row with its reason; a thread with no round says
 * so. `lib/review-timeline.mjs` decided all of it; this renders one loop
 * over rows this page never re-derives.
 */
function renderReviews() {
  const model = buildReviewTimeline(sectionOf(state, 'reviews'), sectionOf(state, 'prs'));
  clear(mounts.canvas);
  if (!model.ok) {
    mounts.canvas.appendChild(said(`the reviews timeline could not be computed: ${model.reason}`));
    return;
  }
  const { threads, queue, totals } = model.value;
  mounts.canvas.appendChild(el('p', 'canvas-summary', `${totals.threads} thread(s), ${totals.queue} waiting on a verdict, ${totals.unreadable} unreadable`));
  mounts.canvas.appendChild(renderQueue(queue));
  for (const thread of threads) mounts.canvas.appendChild(renderReviewThread(thread));
}

function renderQueue(queue) {
  // Region 05 of the design: the queue is a TABLE — PR, issue, rounds, latest
  // verdict, the head it judged, and what it waits on. Every column comes from
  // the entry itself (#1059 phase 6); a row opens the PR's own issue so the
  // rounds are one click away, which is what the design's rows do.
  const wrap = el('div', 'review-queue');
  wrap.appendChild(el('h3', null, 'waiting on a verdict right now'));
  wrap.appendChild(el('p', 'queue-note', 'the one review question that is about the project and not about a single PR'));
  if (queue.length === 0) {
    wrap.appendChild(said('nothing is waiting on a verdict'));
    return wrap;
  }

  const scroller = el('div', 'table-scroller');
  const table = el('table', 'queue-table');
  const head = el('tr', null);
  for (const column of ['PR', 'issue', 'rounds', 'latest verdict', 'head judged', 'waiting']) {
    head.appendChild(el('th', null, column));
  }
  const thead = el('thead', null);
  thead.appendChild(head);
  table.appendChild(thead);

  const body = el('tbody', null);
  for (const item of queue) {
    const row = el('tr', item.escalate ? 'queue-row escalate' : 'queue-row');
    row.appendChild(el('td', 'queue-pr', `#${item.pr}`));
    row.appendChild(el('td', 'queue-issue', item.issue === null ? 'no issue linked' : `#${item.issue}`));
    row.appendChild(el('td', 'queue-rounds', String(item.rounds)));

    const verdictCell = el('td', null);
    if (item.verdict === null) {
      verdictCell.appendChild(el('span', 'queue-none', 'no round posted'));
    } else {
      const chip = el('span', `queue-verdict verdict-${item.verdict.toLowerCase()}`, item.verdict);
      verdictCell.appendChild(chip);
    }
    row.appendChild(verdictCell);

    row.appendChild(el('td', 'queue-head', item.headSha7 ?? 'no head judged'));
    row.appendChild(el('td', 'queue-wait', item.wait));

    if (item.issue !== null) {
      row.classList.add('openable');
      row.setAttribute('role', 'button');
      row.setAttribute('tabindex', '0');
      row.addEventListener('click', () => selectNode(item.issue));
      row.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') selectNode(item.issue); });
    }
    body.appendChild(row);
  }
  table.appendChild(body);
  scroller.appendChild(table);
  wrap.appendChild(scroller);
  return wrap;
}

function renderReviewThread(thread) {
  const card = el('div', 'review-card');
  card.appendChild(el('strong', null, `#${thread.pr}${thread.title ? ` ${thread.title}` : ''}`));
  if (thread.unreadable) {
    card.appendChild(said(`this thread could not be read: ${thread.unreadable.reason}`));
    return card;
  }
  if (thread.noRound) {
    card.appendChild(said('no round posted'));
    return card;
  }
  for (const round of thread.rounds) card.appendChild(renderReviewRound(round));
  return card;
}

/** One round: its verdict word + mark, its findings grouped by severity (#998 R998-5) — a finding's own `source` (its `file`/`line` anchor when the verdict carried one, per `verdict.mjs`'s `hasUsableAnchor`/REQ-405-2, measured on PR #1006) is rendered through the same `sourceStamp` helper as every other value on this page, beside its excerpt and cites. A malformed findings block (#1009 cold review finding 1) is checked BEFORE the empty case: `round.findings` is `[]` either way, so an unchecked order would render an unreadable block identically to a clean zero-findings round. STOP (#1009 cold review round 2) gets its own mark (⛔, distinct from ✓/✕) and says "human escalation" as text — reviewer-protocol.md §7's "a human must look now" state is never indistinguishable from an ordinary REVISE ✕. */
function renderReviewRound(round) {
  const row = el('div', 'review-round');
  // `unknownVerdict` is review-timeline.mjs's own flag for a word outside the
  // protocol enum (a typo, or a verdict a later protocol adds). Rendering it
  // with the plain REVISE mark would make it byte-identical to a REVISE on
  // screen, which is the silence R998-5 forbids (#1009 cold review round 3).
  const mark = round.unknownVerdict ? '?' : round.verdict === 'APPROVE' ? '✓' : round.verdict === 'STOP' ? '⛔' : '✕';
  const escalation = round.unknownVerdict
    ? ' — unrecognised verdict word'
    : round.verdict === 'STOP' ? ' — human escalation' : '';
  row.appendChild(el('p', 'review-round-head', `${mark} ${round.verdict}${escalation} — rev ${round.rev}, ${round.author ?? 'unknown author'}${round.headSha7 ? `, head ${round.headSha7}` : ''}`));
  if (round.malformed && round.malformed.length > 0) {
    row.appendChild(said(`⚠ findings block unreadable: ${round.malformed.join(', ')}`));
    return row;
  }
  if (round.findings.length === 0) {
    row.appendChild(said('no findings'));
    return row;
  }
  const chips = el('div', 'severity-chips');
  for (const [severity, count] of Object.entries(round.bySeverity)) chips.appendChild(el('span', `severity-chip severity-${severity}`, `${severity} × ${count}`));
  row.appendChild(chips);
  for (const f of round.findings) {
    const item = el('div', 'finding');
    item.appendChild(el('strong', null, `${f.severity ?? 'unknown'} — ${f.id ?? '?'}`));
    item.appendChild(renderSourceStamp(sourceStamp(f.source))); // #998 R998-5: a finding's own file:line (or the said fallback), through the same stamp helper the door uses
    item.appendChild(el('p', null, `${f.evidenceExcerpt ?? ''}${f.cites ? ` (cites ${f.cites})` : ''}`));
    row.appendChild(item);
  }
  return row;
}

/**
 * The governance surface (#882 R882-1): the five sub-nav buttons, drawn
 * straight from `lib/governance-model.mjs`'s own table — no inline handler,
 * no second copy of the labels, the same idiom `renderModes` already uses
 * for the four top-level modes. Switching sub-views is mouse/Enter-activated
 * buttons only; the top-level Tab/Esc/J/K keyboard contract is untouched.
 */
function renderGovernanceNav() {
  clear(mounts.governanceNav);
  const queue = buildReviewTimeline(sectionOf(state, 'reviews'), sectionOf(state, 'prs'));
  for (const sub of GOVERNANCE_VIEWS) {
    const button = el('button', null, sub.label);
    button.type = 'button';
    // How many verdicts are waiting, beside the words "Verdict queue" — the
    // one place the number cannot be read as counting something else.
    if (sub.id === 'queue' && queue.ok) button.appendChild(el('span', 'mode-count', ` (${queue.value.queue.length})`));
    if (sub.id === governanceView) button.setAttribute('aria-current', 'page');
    button.addEventListener('click', () => switchGovernanceView(sub.id));
    mounts.governanceNav.appendChild(button);
  }
}

function switchGovernanceView(subView) {
  governanceView = subView;
  render();
}

/** The router's own sub-router: as of PR 5 (By actor, R882-6) all five sub-views draw real content — Roadmap (R882-2), Decisions (R882-3), Anti-patterns (R882-4), History (R882-5) and Actors (R882-6). The final line is a defensive fallback for a `governanceView` outside `GOVERNANCE_VIEW_IDS`, which cannot happen today (`GOVERNANCE_PLACEHOLDERS` is now all `null`, never reached). */
function renderGovernance() {
  renderGovernanceNav();
  clear(mounts.canvas);
  if (governanceView === 'roadmap') {
    renderRoadmap();
    return;
  }
  if (governanceView === 'decisions') {
    renderDecisions();
    return;
  }
  if (governanceView === 'anti-patterns') {
    renderAntiPatterns();
    return;
  }
  if (governanceView === 'history') {
    renderHistory();
    return;
  }
  if (governanceView === 'actors') {
    renderActors();
    return;
  }
  // Both arrived from the top level in #1059. They render exactly as they did
  // as modes — a project-wide fact did not change shape by moving to where
  // the project-wide facts live.
  if (governanceView === 'queue') {
    renderReviews();
    return;
  }
  if (governanceView === 'slices') {
    renderSdd();
    return;
  }
  mounts.canvas.appendChild(said(GOVERNANCE_PLACEHOLDERS[governanceView]));
}

/**
 * Roadmap (#882 R882-2): per-epic status grouping, no timeline (no
 * start/due date exists anywhere in the data — the view's own copy says
 * so). `lib/roadmap-model.mjs` decided all of it — grouping, state,
 * divergences; this renders one loop over rows this page never re-derives.
 */
function renderRoadmap() {
  const model = buildRoadmapModel(sectionOf(state, 'graph'), { project: state.meta?.project ?? null });
  if (!model.ok) {
    mounts.canvas.appendChild(said(`the roadmap could not be computed: ${model.reason}`));
    return;
  }
  const { epics, unlinked } = model.value;
  mounts.canvas.appendChild(el('p', 'canvas-summary', `${epics.length} epic(s), ${unlinked.length} unlinked node(s) — per-epic status only, no timeline is computed`));
  for (const epic of epics) mounts.canvas.appendChild(renderRoadmapEpic(epic));
  mounts.canvas.appendChild(renderRoadmapUnlinked(unlinked));
}

/** One roadmap row: its state chip, its title, its own source stamp (`row()`'s — a link when a project is known, the honest "no source was recorded" stamp when not; #882 cold review of PR 1, blocker), its own `stateReason` when the state could not be read (`roadmap-model.mjs`'s `safeStateOf` guard — #882 cold review of PR #1037, correction 1: a said reason, never a silent `unknown` mark with no explanation), its open blockers, and any `parent`-keyed divergence said inline rather than silently absorbed (R882-2, and correction 2's `nested-epic-not-supported` case). */
function renderRoadmapRow(row, className) {
  const node = el('div', className);
  node.appendChild(el('span', `roadmap-state ${row.state.className}`, `${row.state.mark} ${row.state.label}`));
  node.appendChild(el('span', 'roadmap-title', `#${row.number} ${row.title}`));
  node.appendChild(renderSourceStamp(row.sourceStamp));
  if (row.stateReason) node.appendChild(el('span', 'roadmap-state-reason', row.stateReason));
  if (row.blockedBy.length > 0) node.appendChild(el('span', 'roadmap-blocked', `blocked by ${row.blockedBy.map((n) => `#${n}`).join(', ')}`));
  for (const d of row.divergences) node.appendChild(el('span', 'roadmap-divergence', `${d.reason}${d.value !== null && d.value !== undefined ? `: #${d.value}` : ''}`));
  return node;
}

function renderRoadmapEpic(epic) {
  const wrap = el('div', 'roadmap-epic');
  wrap.appendChild(renderRoadmapRow(epic, 'roadmap-row roadmap-epic-row'));
  const children = el('div', 'roadmap-children');
  if (epic.children.length === 0) {
    children.appendChild(said('no children declared for this epic yet'));
  } else {
    for (const child of epic.children) children.appendChild(renderRoadmapRow(child, 'roadmap-row roadmap-child-row'));
  }
  wrap.appendChild(children);
  return wrap;
}

/** Rule zero (lane-model.mjs's own "never filter a node away" discipline, applied here to epic grouping): a node with no epic parent is never dropped — it lands here, said, never silently absorbed. */
function renderRoadmapUnlinked(unlinked) {
  const wrap = el('div', 'roadmap-unlinked');
  wrap.appendChild(el('h3', null, 'Unlinked'));
  if (unlinked.length === 0) {
    wrap.appendChild(said('every open node declares a real epic parent'));
    return wrap;
  }
  for (const node of unlinked) wrap.appendChild(renderRoadmapRow(node, 'roadmap-row roadmap-child-row'));
  return wrap;
}

/**
 * Decisions (#882 R882-3): the ADR table, sorted by number, an unreadable
 * ADR kept as its own row — sorted last — rather than dropped; drift
 * warnings ride beside the table, never instead of it.
 * `lib/decisions-model.mjs` decided all of it — the row shape (each row's
 * own `sourceStamp`, through `governance-model.mjs`'s `row()` helper, R882-1),
 * the sort, the drift passthrough — this renders one loop over rows this
 * page never re-derives.
 */
function renderDecisions() {
  const model = buildDecisionsModel(sectionOf(state, 'adrs'), sectionOf(state, 'drift'));
  if (!model.ok) {
    mounts.canvas.appendChild(said(`the decisions view could not be computed: ${model.reason}`));
    return;
  }
  const { rows, driftWarnings } = model.value;
  // Region 06 of the design: the decisions are a TABLE — number, title,
  // status, amendments, file — with the drift warning beside it, not a stack
  // of paragraphs (#1059 phase 6).
  mounts.canvas.appendChild(renderDriftWarnings(driftWarnings));
  mounts.canvas.appendChild(el('p', 'canvas-summary', `${rows.length} ADR(s) · brain/project/decisions/`));

  const scroller = el('div', 'table-scroller');
  const table = el('table', 'decisions-table');
  const thead = el('thead', null);
  const head = el('tr', null);
  for (const column of ['ADR', 'title', 'status', 'amendments', 'file']) head.appendChild(el('th', null, column));
  thead.appendChild(head);
  table.appendChild(thead);

  const body = el('tbody', null);
  for (const row of rows) body.appendChild(renderDecisionRow(row));
  table.appendChild(body);
  scroller.appendChild(table);
  mounts.canvas.appendChild(scroller);
}

/** One ADR row: an unreadable entry is its own said reason, kept in place (never dropped); a readable one carries its title, status, amendments, cited issues (the model's own `issuesLabel` — "referenced," never "driving") and supersession, each beside its own `sourceStamp`. */
function renderDecisionRow(row) {
  const tr = el('tr', 'decision-row');
  if (row.ok === false) {
    // An ADR the parser could not read keeps its place, sorted last, with its
    // reason across the row rather than a blank line pretending it parsed.
    const cell = el('td', 'decision-unreadable');
    cell.setAttribute('colspan', '5');
    cell.appendChild(el('strong', null, row.path ?? 'an unreadable ADR'));
    cell.appendChild(said(row.reason));
    tr.appendChild(cell);
    return tr;
  }

  tr.appendChild(el('td', 'decision-number', String(row.number).padStart(4, '0')));
  tr.appendChild(el('td', 'decision-title', row.title));
  tr.appendChild(el('td', `decision-status status-${String(row.status).replace(/\s+/g, '-').toLowerCase()}`, row.status));

  const amendments = el('td', 'decision-amendments');
  if (row.amendments.length === 0) {
    amendments.appendChild(el('span', 'decision-none', '—'));
  } else {
    for (const a of row.amendments) {
      amendments.appendChild(el('p', 'decision-amendment', `${a.n}${a.date ? ` (${a.date})` : ''}: ${a.summary}${a.issue ? ` (#${a.issue})` : ''}`));
    }
  }
  tr.appendChild(amendments);

  const file = el('td', 'decision-file');
  file.appendChild(renderSourceStamp(row.sourceStamp));
  if (row.supersedes.length > 0) file.appendChild(el('p', 'decision-supersedes', `supersedes ${row.supersedes.map((n) => `ADR-${String(n).padStart(4, '0')}`).join(', ')}`));
  if (row.supersededBy !== null) file.appendChild(el('p', 'decision-superseded-by', `superseded by ADR-${String(row.supersededBy).padStart(4, '0')}`));
  if (row.issues.length > 0) file.appendChild(el('p', 'decision-issues', `${row.issuesLabel}: ${row.issues.map((n) => `#${n}`).join(', ')}`));
  tr.appendChild(file);
  return tr;
}

/** The same drift text `renderSnapshotText` already renders in the terminal (`snapshot.mjs:457-469`) — never a second computation of what drifted, only a second place it is said. A `driftWarnings` read failure is its own said reason, beside the table above, never a reason to blank it (R882-3). */
function renderDriftWarnings(driftWarnings) {
  const wrap = el('div', 'decision-drift');
  if (!driftWarnings.ok) {
    wrap.appendChild(said(`adr drift not computed — ${driftWarnings.reason}`));
    return wrap;
  }
  const { homeOnly, filesOnly, unreadable } = driftWarnings.value;
  const n = homeOnly.length + filesOnly.length + unreadable.length;
  if (n === 0) {
    wrap.appendChild(said('adr drift: none — HOME.md and the parser agree'));
    return wrap;
  }
  const lines = [
    ...homeOnly.map((h) => `listed in HOME.md, not readable: ADR-${String(h.number).padStart(4, '0')} ${h.path ?? ''}`.trimEnd()),
    ...filesOnly.map((f) => `on disk, not listed in HOME.md: ADR-${String(f.number).padStart(4, '0')} ${f.path}`),
    ...unreadable.map((u) => `unreadable: ${u.path} — ${u.reason}`),
  ];
  wrap.appendChild(saidList(`adr drift — ${n} disagreement(s) between brain/HOME.md and the parser (reported, never a gate):`, lines));
  return wrap;
}

/**
 * Anti-patterns (#882 R882-4): the catalogue, core before project, sorted
 * by id within each scope. `lib/anti-patterns-model.mjs` decided all of it
 * — the grouping, the sort, the per-row `sourceStamp` (R882-1's shared
 * `row()` helper, reused a third time); this renders one loop over rows
 * this page never re-derives. A directory that could not be listed at all
 * is its own said reason beside the other scope's real rows (never an
 * empty section).
 */
function renderAntiPatterns() {
  const model = buildAntiPatternsModel(sectionOf(state, 'antiPatterns'), { project: state.meta?.project });
  if (!model.ok) {
    mounts.canvas.appendChild(said(`the anti-patterns catalogue could not be computed: ${model.reason}`));
    return;
  }
  const { rows, unlistable } = model.value;
  // Region 06: the catalogue is a table too — scope, name, the tickets that
  // cite it, and the file (#1059 phase 6).
  mounts.canvas.appendChild(el('p', 'canvas-summary', `${rows.length} anti-pattern(s) · brain/core/anti-patterns/`));

  const scroller = el('div', 'table-scroller');
  const table = el('table', 'anti-patterns-table');
  const thead = el('thead', null);
  const head = el('tr', null);
  for (const column of ['scope', 'pattern', 'cited by', 'file']) head.appendChild(el('th', null, column));
  thead.appendChild(head);
  table.appendChild(thead);

  const body = el('tbody', null);
  for (const row of rows) body.appendChild(renderAntiPatternRow(row));
  table.appendChild(body);
  scroller.appendChild(table);
  mounts.canvas.appendChild(scroller);

  if (unlistable.length > 0) mounts.canvas.appendChild(renderAntiPatternsUnlistable(unlistable));
}

/** One catalogue row: an unreadable entry is its own said reason, kept in place (never dropped); a readable one carries its title, scope and its own `sourceStamp`, plus the issues it cites — each stamped `[forge: #N]`, the same bracket form `sourceStamp` uses for a real forge ref, though no per-issue URL exists in this data (a bare `#N`/`ISSUE-N` mention, never a fabricated link). */
function renderAntiPatternRow(row) {
  const tr = el('tr', 'anti-pattern-row');
  if (row.ok === false) {
    const cell = el('td', 'anti-pattern-unreadable');
    cell.setAttribute('colspan', '4');
    cell.appendChild(el('strong', null, row.path ?? 'an unreadable anti-pattern'));
    cell.appendChild(said(row.reason));
    tr.appendChild(cell);
    return tr;
  }

  tr.appendChild(el('td', 'anti-pattern-scope', row.scope));
  tr.appendChild(el('td', 'anti-pattern-title', row.title));

  const cited = el('td', 'anti-pattern-issues');
  if (row.issueStamps.length === 0) {
    cited.appendChild(el('span', 'decision-none', 'no ticket cites it'));
  } else {
    // One chip per citation, so a citation with a project behind it is
    // individually clickable (#882 PR 3's own cold review).
    for (const stamp of row.issueStamps) cited.appendChild(renderSourceStamp(stamp));
  }
  tr.appendChild(cited);

  const file = el('td', 'anti-pattern-file');
  file.appendChild(renderSourceStamp(row.sourceStamp));
  tr.appendChild(file);
  return tr;
}

/** An unlistable scope's directory is said beside the other scope's real rows, never read as "zero anti-patterns in that scope" (R882-4). Only called when there is something to say — an empty area would read as "nothing happened here," the same evidence-reader discipline every other degraded band in this page follows. */
function renderAntiPatternsUnlistable(unlistable) {
  const wrap = el('div', 'anti-pattern-unlistable');
  const lines = unlistable.map((u) => `${u.scope}: ${u.reason}`);
  wrap.appendChild(saidList('anti-patterns — a scope could not be listed:', lines));
  return wrap;
}

/**
 * History (#882 R882-5): merges, releases and ADR amendments, newest
 * first. `lib/history-model.mjs` decided all of it — the merge (cited to
 * the forge URL when the commit names a reference and the served project
 * is known, a plain git source otherwise — never asserting "PR", only
 * "cites"), the release and adr-amended events, the sort, each event's own
 * `sourceStamp` (R882-1's shared `row()` helper, reused a fourth time);
 * this renders one loop over events this page never re-derives. Review
 * verdicts are deliberately excluded from this model — no field anywhere
 * in the data carries a review round's timestamp, so this pane links to
 * the Reviews mode instead of rendering a second, undated projection of
 * the same rounds.
 */
function renderHistory() {
  const model = buildHistoryModel({
    history: sectionOf(state, 'history'),
    adrs: sectionOf(state, 'adrs'),
    project: state.meta?.project ?? null,
  });
  if (!model.ok) {
    mounts.canvas.appendChild(said(`history could not be computed: ${model.reason}`));
    return;
  }
  const { events, cap } = model.value;
  // The count alone would read as the whole history; the cap sentence is what
  // keeps a capped commit list from looking like a quiet period (#1043).
  const note = capNote(cap);
  mounts.canvas.appendChild(el('p', 'canvas-summary', note ? `${events.length} event(s) — ${note}` : `${events.length} event(s)`));
  mounts.canvas.appendChild(said(model.value.sameDayNote));
  for (const event of events) mounts.canvas.appendChild(renderHistoryEvent(event));
  mounts.canvas.appendChild(renderHistoryReviewsLink());
}

/** One history event: its kind, its date, its title, and its own `sourceStamp` (the same chip every other governance row carries — a merge event's forge link when it cites a reference, a git sha or an ADR's own path otherwise). */
function renderHistoryEvent(event) {
  const wrap = el('div', 'history-event');
  wrap.appendChild(el('span', `history-kind history-kind-${event.kind}`, event.kind));
  wrap.appendChild(el('span', 'history-date', event.date ?? 'no date recorded'));
  // The model keeps an event with an unreadable date at the END and states
  // why; printing only the date would drop that sentence (#1043 round 2).
  if (event.malformed) wrap.appendChild(said(`this line could not be read: ${event.malformed}`));
  if (event.dateUnparseable) wrap.appendChild(said(event.dateUnparseable));
  wrap.appendChild(el('span', 'history-title', event.title));
  wrap.appendChild(renderSourceStamp(event.sourceStamp));
  return wrap;
}

/** No review verdict is ever rendered inside this pane (R882-5: no round timestamp exists in this data yet) — a plain button hands off to the Reviews mode instead of a second, undated projection of the same rounds. */
function renderHistoryReviewsLink() {
  const wrap = el('div', 'history-reviews-link');
  wrap.appendChild(said('review verdicts have no round timestamp yet — see the Reviews mode for those'));
  const button = el('button', null, 'Go to Reviews');
  button.type = 'button';
  button.addEventListener('click', () => { switchToMode('governance'); switchGovernanceView('queue'); });
  wrap.appendChild(button);
  return wrap;
}

/**
 * By actor (#882 R882-6): one row per actor, humans and agents in the same
 * table under the same schema — nothing here is scored or ranked
 * (issue #882's own "must NOT become"). `lib/actors-model.mjs` decided all
 * of it: the merge of `actors` and `reviews`, the name-only sort, the
 * open-PRs-only caveat on `reviewsPosted`, the stated absence on
 * `prsMerged`; this renders one loop over rows this page never re-derives.
 */
function renderActors() {
  const model = buildActorsModel(sectionOf(state, 'actors'), sectionOf(state, 'reviews'));
  if (!model.ok) {
    mounts.canvas.appendChild(said(`the by-actor view could not be computed: ${model.reason}`));
    return;
  }
  const { rows } = model.value;
  mounts.canvas.appendChild(el('p', 'canvas-summary', `${rows.length} actor(s) — memory-record names and forge review logins listed side by side, not joined; name order only`));
  for (const row of rows) mounts.canvas.appendChild(renderActorRow(row));
}

/** One actor row: its kind (or the stated "kind unknown" reason for a forge-only reviewer), its record count by type, and its own `sourceStamp` — an aggregated row names no single file, so `source: null` states that honestly (R882-1's shared `row()` helper, reused a fifth time). `reviewsPosted` always carries the model's own open-PRs-only caveat; `prsMerged` always carries the model's own stated absence, never a bare `0`. */
function renderActorRow(row) {
  const wrap = el('div', 'actor-row');
  wrap.appendChild(el('strong', 'actor-name', row.actor));
  wrap.appendChild(el('span', 'actor-kind', row.actorKind ?? row.actorKindReason ?? 'kind unknown'));
  // The two namespaces are not reconciled, so a forge-only row says what it
  // is evidence of rather than reading as a second person (#1043).
  if (row.evidenceNote) wrap.appendChild(said(row.evidenceNote));
  wrap.appendChild(renderSourceStamp(row.sourceStamp));
  wrap.appendChild(el('p', 'actor-records', `${row.records} record(s)${Object.keys(row.byType).length > 0 ? `: ${Object.entries(row.byType).map(([type, n]) => `${type} ${n}`).join(', ')}` : ''}`));
  wrap.appendChild(el('p', 'actor-reviews', row.reviewsPosted.ok
    ? `reviews posted: ${row.reviewsPosted.count} — ${row.reviewsPosted.caveat}`
    : `reviews posted: not computed — ${row.reviewsPosted.reason}`));
  wrap.appendChild(el('p', 'actor-prs-merged', `PRs merged: not shown — ${row.prsMerged.reason}`));
  return wrap;
}

/** Activating a node selects it and opens the drawer on its Spec tab (R881-8). */
function selectNode(issue) {
  selectedIssue = issue;
  docTrees = new Map();
  changeView = null;
  activeTab = 'spec';
  render();
  loadChange(issue);
}

function closeDrawer() {
  selectedIssue = null;
  docTrees = new Map();
  changeView = null;
  render();
}

/**
 * The inspector drawer: six tabs (#998 R998-6), one entry shape, and a
 * source string under every single value (A3). `drawer-model.mjs` decided
 * all of it — including
 * that a tab which failed keeps its reason and that an unreadable review
 * thread is still an entry — so this renders one loop, with no per-tab
 * branch to get wrong.
 */
function renderDrawer() {
  clear(mounts.drawer);
  mounts.drawer.hidden = selectedIssue === null;
  if (selectedIssue === null) return;

  // Region 08's header: the number, the state the card showed, the track, a
  // link to the issue on the forge, and the close control — all from the same
  // model the card used, so the panel never contradicts what was clicked.
  const head = el('div', 'drawer-head');
  const summary = nodeSummaryFor(sectionOf(state, 'graph'), selectedIssue);

  const idLine = el('div', 'drawer-id');
  idLine.appendChild(el('span', 'drawer-number', `#${selectedIssue}`));
  if (summary.ok) {
    const chip = el('span', `node-state state-${summary.value.state.code}`);
    chip.appendChild(el('span', 'node-state-mark', summary.value.state.mark));
    chip.appendChild(el('span', 'node-state-word', summary.value.state.label));
    idLine.appendChild(chip);
    if (summary.value.track) idLine.appendChild(el('span', 'drawer-track', `track ${summary.value.track}`));
  }
  const project = state.meta?.project ?? null;
  if (project) {
    const link = el('a', 'drawer-forge', `forge #${selectedIssue} \u2197`);
    link.setAttribute('href', issueUrl(project, selectedIssue));
    link.setAttribute('rel', 'noopener noreferrer');
    link.setAttribute('target', '_blank');
    idLine.appendChild(link);
  }
  head.appendChild(idLine);

  const close = el('button', 'close', '\u2715');
  close.setAttribute('aria-label', 'close this panel');
  close.addEventListener('click', closeDrawer);
  head.appendChild(close);
  mounts.drawer.appendChild(head);

  if (summary.ok) {
    if (summary.value.title) mounts.drawer.appendChild(el('h2', 'drawer-title', summary.value.title));
    for (const mark of summary.value.marks) mounts.drawer.appendChild(said(mark));
    if (summary.value.blockedBy.length > 0) {
      mounts.drawer.appendChild(el('p', 'drawer-blocked', `blocked by ${summary.value.blockedBy.map((n) => `#${n}`).join(', ')}`));
    }
    mounts.drawer.appendChild(renderChildren(selectedIssue));
  } else {
    mounts.drawer.appendChild(said(summary.reason));
  }

  if (changeView === null) {
    mounts.drawer.appendChild(el('p', 'note', 'reading this change…'));
    return;
  }
  const model = buildDrawerModel(changeView);
  if (!model.ok) {
    mounts.drawer.appendChild(said(model.reason));
    return;
  }
  mounts.drawer.appendChild(el('p', 'note', model.value.changeDir ? `change dir: ${model.value.changeDir}` : 'no change dir for this issue in the read model'));

  const tabs = el('div', 'tabs');
  for (const tab of model.value.tabs) {
    const button = el('button', null, tab.ok ? tab.label : `${tab.label} !`);
    button.setAttribute('aria-selected', String(tab.id === activeTab));
    button.addEventListener('click', () => { activeTab = tab.id; renderDrawer(); });
    tabs.appendChild(button);
  }
  mounts.drawer.appendChild(tabs);
  mounts.drawer.appendChild(renderTab(model.value.tabs.find((t) => t.id === activeTab) ?? model.value.tabs[0]));
}

/**
 * The tickets that belong to the selected one (#1059 phase 10): the issues
 * that DECLARE it as their parent, each with the state vocabulary a card
 * shows. A node nobody declares says so — "no ticket names this as its
 * parent" is a fact about the declarations, not a failure to read them.
 */
function renderChildren(issue) {
  const wrap = el('div', 'drawer-children');
  const found = childrenOf(sectionOf(state, 'graph'), issue);
  if (!found.ok) {
    wrap.appendChild(said(found.reason));
    return wrap;
  }
  wrap.appendChild(el('h3', 'drawer-section-title', `tickets that declare #${issue} as their parent`));
  if (found.value.length === 0) {
    wrap.appendChild(said('no open ticket declares this one as its parent'));
    return wrap;
  }
  const list = el('ul', 'child-list');
  for (const child of found.value) {
    const item = el('li', 'child-row');
    item.setAttribute('role', 'button');
    item.setAttribute('tabindex', '0');
    item.appendChild(el('span', 'child-number', `#${child.number}`));
    const chip = el('span', `node-state state-${child.state.code}`);
    chip.appendChild(el('span', 'node-state-mark', child.state.mark));
    chip.appendChild(el('span', 'node-state-word', child.state.label));
    item.appendChild(chip);
    item.appendChild(el('span', 'child-title', child.title || '(no title)'));
    item.addEventListener('click', () => selectNode(child.number));
    item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') selectNode(child.number); });
    list.appendChild(item);
  }
  wrap.appendChild(list);
  return wrap;
}

function renderTab(tab) {
  const wrap = document.createElement('div');
  if (tab.note) wrap.appendChild(el('p', 'note', `source: ${tab.note}`));
  if (!tab.ok) {
    wrap.appendChild(said(tab.reason));
    if (tab.source) wrap.appendChild(el('span', 'source', tab.source));
  }
  for (const item of tab.entries) wrap.appendChild(renderEntry(item));

  // The slice plan sits under the stage strip, in the same tab, as the design
  // draws it (#1059 region 08).
  if (tab.slices) {
    wrap.appendChild(el('h3', 'slice-plan-title', 'slice plan'));
    if (!tab.slices.ok) {
      wrap.appendChild(said(tab.slices.reason));
    } else {
      if (tab.slices.note) wrap.appendChild(el('p', 'note', tab.slices.note));
      for (const slice of tab.slices.entries) wrap.appendChild(renderEntry(slice));
    }
  }
  // The lines the spec grammar could not attach to a scenario (#1067 cold
  // review, finding cold-1). `spec-cards.mjs` stopped dropping them; a fact
  // collected and never drawn is the same silence one module further along,
  // so they are drawn HERE, where the author of the file will see them.
  if (tab.orphans && tab.orphans.length > 0) {
    wrap.appendChild(el('h3', 'orphan-title', `${tab.orphans.length} line(s) the grammar could not attach`));
    for (const orphan of tab.orphans) wrap.appendChild(renderEntry(orphan));
  }

  // "read, and empty" and "never read" are different facts, so they are
  // different sentences — an empty area would say neither. An orphan is
  // content, so a tab that has only orphans is not empty.
  const nothingDrawn = tab.entries.length === 0 && (tab.orphans ?? []).length === 0;
  if (tab.ok && nothingDrawn) wrap.appendChild(said('this tab\'s source was read and has nothing in it'));
  return wrap;
}

// ── markdown documents (#1198) ─────────────────────────────────────────────
// The tree comes from `lib/markdown.mjs`, which has already applied every
// ruling (inert relative links, html as text, images as alt text, http(s)
// only). These two functions are a plain walk over it, built from `el()`,
// text nodes and `setAttribute` — the page never assigns markup.

const MD_ALIGN = new Set(['left', 'center', 'right']);

function renderMdInline(parent, nodes) {
  for (const node of nodes) {
    switch (node.t) {
      case 'text':
        parent.appendChild(document.createTextNode(node.text));
        break;
      case 'strong':
      case 'em':
      case 'del': {
        const wrapper = el(node.t === 'del' ? 'del' : node.t);
        renderMdInline(wrapper, node.children);
        parent.appendChild(wrapper);
        break;
      }
      case 'codespan':
        parent.appendChild(el('code', null, node.text));
        break;
      case 'br':
        parent.appendChild(el('br'));
        break;
      case 'link': {
        const link = el('a');
        link.setAttribute('href', node.href);
        link.setAttribute('rel', 'noopener noreferrer');
        link.setAttribute('target', '_blank');
        link.setAttribute('referrerpolicy', 'no-referrer');
        renderMdInline(link, node.children);
        parent.appendChild(link);
        break;
      }
      case 'inert': {
        // A relative, anchor or refused link is not a link here: its text,
        // and where it pointed, are shown and nothing is navigable.
        const span = el('span', 'md-inert');
        renderMdInline(span, node.children);
        span.appendChild(document.createTextNode(' '));
        span.appendChild(el('code', null, node.target));
        parent.appendChild(span);
        break;
      }
      default:
        parent.appendChild(document.createTextNode(JSON.stringify(node)));
    }
  }
}

function renderMdCell(tag, align, cells) {
  const cell = el(tag, MD_ALIGN.has(align) ? `md-align-${align}` : null);
  renderMdInline(cell, cells);
  return cell;
}

function renderMdBlocks(parent, blocks) {
  for (const block of blocks) {
    switch (block.t) {
      case 'heading': {
        const heading = el(`h${Math.min(6, block.level + 2)}`, 'md-heading');
        renderMdInline(heading, block.children);
        parent.appendChild(heading);
        break;
      }
      case 'paragraph': {
        const p = el('p');
        renderMdInline(p, block.children);
        parent.appendChild(p);
        break;
      }
      case 'list': {
        const list = el(block.ordered ? 'ol' : 'ul');
        if (block.ordered && block.start !== 1) list.setAttribute('start', String(block.start));
        for (const item of block.items) {
          const li = el('li');
          if (item.task) li.appendChild(el('span', 'md-task', item.checked ? '\u2611 ' : '\u2610 '));
          renderMdBlocks(li, item.blocks);
          list.appendChild(li);
        }
        parent.appendChild(list);
        break;
      }
      case 'code': {
        const pre = el('pre');
        pre.appendChild(el('code', block.lang ? `lang-${block.lang}` : null, block.text));
        parent.appendChild(pre);
        break;
      }
      case 'blockquote': {
        const quote = el('blockquote');
        renderMdBlocks(quote, block.blocks);
        parent.appendChild(quote);
        break;
      }
      case 'hr':
        parent.appendChild(el('hr'));
        break;
      case 'table': {
        const table = el('table');
        const head = el('thead');
        const headRow = el('tr');
        block.header.forEach((cells, i) => headRow.appendChild(renderMdCell('th', block.align[i], cells)));
        head.appendChild(headRow);
        table.appendChild(head);
        const body = el('tbody');
        for (const row of block.rows) {
          const tr = el('tr');
          row.forEach((cells, i) => tr.appendChild(renderMdCell('td', block.align[i], cells)));
          body.appendChild(tr);
        }
        table.appendChild(body);
        parent.appendChild(table);
        break;
      }
      case 'frontmatter':
        parent.appendChild(el('pre', 'md-frontmatter', block.text));
        break;
      default:
        // `literal`, and anything a future tree adds: shown as written, never dropped.
        parent.appendChild(el('p', 'md-literal', block.text ?? ''));
    }
  }
}

/** The expanded document: its stamp, the truncation note when there is one, and the rendered blocks. */
function renderDocumentSection(doc, id) {
  const section = el('section', 'doc-body');
  section.setAttribute('id', id);
  section.setAttribute('role', 'region');
  section.setAttribute('aria-label', doc.stamp);
  section.appendChild(el('p', 'doc-stamp', doc.stamp));
  if (doc.note) section.appendChild(el('p', 'note', doc.note));
  if (!docTrees.has(doc.stamp)) docTrees.set(doc.stamp, markdownTree(doc.text));
  const tree = docTrees.get(doc.stamp);
  for (const notice of tree.notices) section.appendChild(el('p', 'note', notice));
  const body = el('div', 'md');
  renderMdBlocks(body, tree.blocks);
  section.appendChild(body);
  return section;
}

/**
 * A stage row's document: a native toggle when it can be read, the said reason
 * when it cannot (never an empty body, R1198-2). The click toggles in place —
 * it does not re-render the drawer, so the button keeps focus.
 */
function renderDocumentControl(card, doc) {
  if (!doc) return;
  if (doc.state !== 'present' && doc.state !== 'truncated') {
    card.appendChild(said(doc.wording));
    return;
  }
  const id = `doc-${selectedIssue}-${doc.key}`;
  const key = `${selectedIssue}:${doc.key}`;
  const button = el('button', 'doc-toggle');
  button.setAttribute('aria-controls', id);
  let section = null;
  const setOpen = (open) => {
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'hide document' : 'show document';
    if (open && section === null) {
      section = renderDocumentSection(doc, id);
      card.appendChild(section);
    }
    if (!open && section !== null) {
      card.removeChild(section);
      section = null;
    }
    if (open) expandedDocs.add(key); else expandedDocs.delete(key);
  };
  button.addEventListener('click', () => setOpen(button.getAttribute('aria-expanded') !== 'true'));
  card.appendChild(button);
  setOpen(expandedDocs.has(key));
}

function renderEntry(item) {
  const card = el('div', item.pending ? 'card pending' : 'card');
  // A numbered, marked entry is the design's stage strip (#1059 region 08);
  // everything else keeps the checkbox form the tasks tab needs.
  if (typeof item.position === 'number') {
    const line = el('div', 'stage-line');
    line.appendChild(el('span', 'stage-number', String(item.position)));
    line.appendChild(el('span', 'stage-name', item.title));
    // The file the stage is. Present or missing, the reader sees what to open
    // or what to create (#1059).
    if (item.file) line.appendChild(el('span', 'stage-file', item.file));
    line.appendChild(el('span', item.done ? 'stage-mark done' : 'stage-mark missing', item.mark));
    card.appendChild(line);
    if (item.detail) card.appendChild(el('p', null, item.detail));
    card.appendChild(renderSourceStamp(item.sourceStamp));
    renderDocumentControl(card, item.document);
    for (const child of item.children ?? []) card.appendChild(renderEntry(child));
    return card;
  }
  const done = item.done === undefined ? '' : item.done ? '[x] ' : '[ ] ';
  card.appendChild(el('strong', null, `${done}${item.title}`));
  if (item.detail) card.appendChild(el('p', null, item.detail));
  card.appendChild(renderSourceStamp(item.sourceStamp)); // #998 R998-2: the design's stamp, beside the value itself (A3)
  renderDocumentControl(card, item.document);
  for (const child of item.children ?? []) card.appendChild(renderEntry(child));
  return card;
}

/**
 * The stamp's label, plus a chip when it carries an href (#998 R998-2). The
 * href is the model's own guarantee (only an https forge/link URL ever gets
 * one) — this function sets it as an attribute, never as markup.
 */
function renderSourceStamp(stamp) {
  const wrap = document.createDocumentFragment();
  wrap.appendChild(el('span', 'source', stamp.label));
  if (stamp.href) {
    const chip = el('a', 'source-chip', 'open ↗');
    chip.setAttribute('href', stamp.href);
    chip.setAttribute('rel', 'noopener noreferrer');
    chip.setAttribute('target', '_blank');
    wrap.appendChild(chip);
  }
  return wrap;
}

/** The drawer's own IO. A failed read is a reason IN the drawer, never a drawer that stays empty. */
const changeRequests = requestSequence();
async function loadChange(issue) {
  const token = changeRequests.next();
  let next;
  try {
    const res = await fetch(`/api/change/${issue}`);
    if (!res.ok) throw new Error(`answered ${res.status}`);
    next = await res.json();
  } catch (err) {
    next = { ok: false, reason: `the change view for #${issue} could not be read: ${err.message}` };
  }
  // A slower answer for a node the operator has moved away from, or an older
  // answer for the SAME node (a burst of refs frames), never overwrites the
  // one now on screen.
  if (!changeRequests.isCurrent(token) || selectedIssue !== issue) return;
  changeView = next;
  renderDrawer();
}

// ── keyboard (#998 R998-2) ───────────────────────────────────────────────

/**
 * The nodes `j`/`k` may traverse (#998 R998-3): every board node across
 * every lane — never the `?` holding lane's paged rows, which carry no
 * board coordinates to traverse in reading order. Each lane lays itself out
 * in its OWN space starting at (0, 0) (lane-model.mjs), so two lanes' nodes
 * cannot be compared by `y` directly; folding the lane's row position into
 * a large offset keeps `keyAction`'s existing top-to-bottom sort correct
 * across the stacked rows without teaching `view-model.mjs` anything about
 * lanes.
 */
function drawnNodes() {
  if (view !== 'map') return [];
  const model = buildLaneModel(sectionOf(state, 'graph'), { collapsedTracks, holdingPage, project: state.meta?.project ?? null, clustering });
  if (!model.ok) return [];
  const nodes = [];
  model.value.lanes.forEach((lane, laneIndex) => {
    for (const node of lane.nodes) nodes.push({ ...node, y: laneIndex * 1e6 + node.y });
  });
  return nodes;
}

/**
 * One listener for the whole page, routed entirely through
 * `keyAction` — this function decides nothing, it only executes what that
 * pure function returned. A Cmd/Ctrl/Alt combination or a keystroke while
 * an input is focused is never this page's to take.
 */
function onKeyDown(event) {
  if (event.metaKey || event.ctrlKey || event.altKey) return;
  const target = event.target;
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
  const action = keyAction(view, event.key, { nodes: drawnNodes(), selected: selectedIssue });
  if (action.type === 'none') return;
  event.preventDefault();
  if (action.type === 'mode') switchToMode(action.mode);
  else if (action.type === 'select') selectNode(action.issue);
  else if (action.type === 'close') closeDrawer();
}

document.addEventListener('keydown', onKeyDown);

// ── the API: one REST read, then the stream ────────────────────────────────

async function readSnapshot() {
  try {
    const res = await fetch('/api/snapshot');
    if (!res.ok) throw new Error(`GET /api/snapshot answered ${res.status}`);
    state = applyFrame(state, 'sync', { snapshot: await res.json() });
  } catch (err) {
    state = streamFailed(state, `the snapshot could not be read: ${err.message}`);
  }
  render();
}

/** The poller's own three controls. Its answer IS the new poller state, so no extra read is needed. */
async function postPoll(action) {
  try {
    const res = await fetch(`/api/poll/${action}`, { method: 'POST' });
    if (!res.ok) throw new Error(`POST /api/poll/${action} answered ${res.status}`);
    state = { ...state, controls: { ok: true }, meta: { ...(state.meta ?? {}), poller: await res.json() } };
  } catch (err) {
    // Its own band: the stream is still connected and every value on screen
    // is still current — only this button did not take (R881-4).
    state = controlFailed(state, { action, reason: err.message });
  }
  render();
}

function subscribe() {
  const stream = new EventSource('/api/stream');
  for (const name of ['sync', 'section', 'refs', 'status']) {
    stream.addEventListener(name, (event) => {
      const parsed = parseFrame(event.data);
      // A frame this page cannot read is a band, not an exception swallowed
      // by the callback: every held value stays, the reason is on screen.
      if (!parsed.ok) { state = streamFailed(state, parsed.reason); render(); return; }
      state = applyFrame(state, name, parsed.frame);
      render();
      // Q3/A2: a worktree's head moved, so the open drawer's Working memory
      // tab (`resume.md` read at the branch tip) is the one value the snapshot
      // diff cannot refresh on its own.
      if (name === 'refs' && selectedIssue !== null) loadChange(selectedIssue);
    });
  }
  // `EventSource` reconnects on its own; the band says the page is no longer
  // live meanwhile, and every held value stays on screen (R881-9).
  stream.addEventListener('error', () => {
    state = streamFailed(state, 'the live stream dropped — reconnecting; the values below are the last ones read');
    render();
  });
  return stream;
}

applyTheme(readTheme());
mountSearch();
render();
readSnapshot().then(subscribe);
// "polled 5 s ago" is a claim that goes stale by itself, so the indicator
// re-renders on a clock of its own; nothing is re-fetched here.
setInterval(renderStatus, 5000);
