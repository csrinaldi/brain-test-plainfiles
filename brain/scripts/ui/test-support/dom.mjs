// dom.mjs — a DOM small enough to read, faithful enough to run the page.
//
// WHY THIS EXISTS. Design D9 said `static/app.js` has no test runner, so
// everything it does was asserted by SCANNING its source instead. That held
// until #1059, when three defects shipped that no scan could see:
//
//   - `renderNodeSdd` read `change.stages`, a field no entry the server sends
//     has ever carried, and threw on every card with a change directory;
//   - `saidList` was called in seven places and defined in none, after phase 5
//     removed the SVG helpers it happened to sit above;
//   - and, masked by both, the panel was drawn only in the map view.
//
// The page rendered a blank board and every click did nothing. The maintainer
// found all of it by clicking, because a `ReferenceError` in `app.js` is not a
// red test — it is a blank page. D9's premise was that no DOM was available
// without a dependency. This file is the counter-example: no dependency, no
// bundler, no browser, about a hundred lines, and it runs the real module.
//
// It is DELIBERATELY not a DOM implementation. There is no layout, no CSS, no
// event bubbling and no query selector, because none of those are what broke.
// What it does have is exactly the surface `app.js` touches, so that the page's
// own render path executes and any exception on it becomes a failing test.
// A property the page starts using and this file lacks will throw here too,
// which is the correct outcome: this file grows when the page does.

/** Every listener a node was given, so a test can activate one the way a user would. */
const LISTENERS = Symbol('listeners');

/**
 * A text node built WITHOUT going through the `textContent` setter, which
 * would call this function again and recurse forever. It is the leaf every
 * string on the page becomes, exactly as `document.createTextNode` is in a
 * browser.
 */
function rawTextNode(text) {
  return {
    tagName: '#text',
    className: '',
    childNodes: [],
    parentNode: null,
    attributes: Object.create(null),
    [LISTENERS]: Object.create(null),
    _ownText: text,
    get textContent() { return this._ownText; },
    set textContent(value) { this._ownText = value === null || value === undefined ? '' : String(value); },
    get firstChild() { return null; },
    appendChild(child) { return child; },
    removeChild(child) { return child; },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    hasAttribute() { return false; },
    addEventListener() {},
    removeEventListener() {},
    classList: { add() {}, remove() {}, contains() { return false; }, toggle() { return false; } },
  };
}

function makeClassList(node) {
  const parts = () => (node.className ? String(node.className).split(/\s+/).filter(Boolean) : []);
  const write = (list) => { node.className = list.join(' '); };
  return {
    add(...names) { const l = parts(); for (const n of names) if (!l.includes(n)) l.push(n); write(l); },
    remove(...names) { write(parts().filter((c) => !names.includes(c))); },
    contains(name) { return parts().includes(name); },
    toggle(name, force) {
      const has = parts().includes(name);
      const want = force === undefined ? !has : Boolean(force);
      if (want) this.add(name); else this.remove(name);
      return want;
    },
  };
}

export function createElement(tag) {
  const node = {
    tagName: String(tag).toUpperCase(),
    className: '',
    hidden: false,
    attributes: Object.create(null),
    childNodes: [],
    parentNode: null,
    [LISTENERS]: Object.create(null),
    _ownText: '',

    get firstChild() { return this.childNodes[0] ?? null; },
    get children() { return this.childNodes; },

    // `textContent` is the one property with real semantics here, and getting
    // it wrong is worse than not having the harness at all.
    //
    // In a browser, assigning it REPLACES the children with a single text
    // node — so a later `appendChild` leaves BOTH, and reading it back returns
    // both concatenated. This shim first kept the string in a field beside the
    // children and returned it only when there were none, which meant the
    // `el(tag, class, text)` + `appendChild` pattern the page uses everywhere
    // silently LOST the text: a Governance button built as
    // `el('button', null, 'Verdict queue')` plus a count span read back as
    // " (1)", with its own label gone. Found by driving the live page, not by
    // a test — the harness agreed with itself and disagreed with the browser.
    set textContent(value) {
      const text = value === null || value === undefined ? '' : String(value);
      this.childNodes = [];
      this._ownText = '';
      if (text !== '') this.appendChild(rawTextNode(text));
    },
    get textContent() {
      if (this.childNodes.length === 0) return this._ownText;
      return this.childNodes.map((child) => child.textContent).join('');
    },

    appendChild(child) {
      // A fragment appends its children and keeps nothing, which is the only
      // behaviour of `DocumentFragment` the page depends on.
      if (child.tagName === '#FRAGMENT') {
        for (const grand of child.childNodes) { grand.parentNode = node; node.childNodes.push(grand); }
        child.childNodes = [];
        return child;
      }
      child.parentNode = node;
      node.childNodes.push(child);
      return child;
    },
    removeChild(child) {
      node.childNodes = node.childNodes.filter((c) => c !== child);
      child.parentNode = null;
      return child;
    },
    setAttribute(name, value) { node.attributes[name] = String(value); },
    getAttribute(name) { return name in node.attributes ? node.attributes[name] : null; },
    removeAttribute(name) { delete node.attributes[name]; },
    hasAttribute(name) { return name in node.attributes; },
    addEventListener(type, fn) { (node[LISTENERS][type] ??= []).push(fn); },
    removeEventListener(type, fn) {
      const list = node[LISTENERS][type];
      if (list) node[LISTENERS][type] = list.filter((f) => f !== fn);
    },
  };
  node.classList = makeClassList(node);
  return node;
}

/**
 * Fire one listener set, the way a click or a change reaches it. There is no
 * bubbling: the page attaches its handlers to the element it wants activated,
 * and inventing propagation would let a test pass on a path the browser never
 * takes.
 */
export function fire(node, type, event = {}) {
  const list = node[LISTENERS][type] ?? [];
  if (list.length === 0) throw new Error(`no ${type} listener on <${node.tagName.toLowerCase()} class="${node.className}">`);
  for (const fn of list) fn(event);
  return list.length;
}

/** Whether a node would answer a `fire` of this type — a test asserts the wiring, not the shape. */
export function listens(node, type) {
  return (node[LISTENERS][type] ?? []).length > 0;
}

/** Every node in the tree, depth first, that the predicate accepts. */
export function findAll(root, predicate) {
  const out = [];
  const walk = (node) => {
    if (predicate(node)) out.push(node);
    for (const child of node.childNodes) walk(child);
  };
  walk(root);
  return out;
}

/** The first match, or `null` — the shape most assertions want. */
export function find(root, predicate) {
  return findAll(root, predicate)[0] ?? null;
}

/** A node whose class list carries this name. */
export const byClass = (name) => (node) => node.classList && node.classList.contains(name);

/**
 * Install a document, a window and the two network globals the page opens, and
 * return the mounts plus a `restore()`. `snapshot` is served at
 * `/api/snapshot`; `changes` answers `/api/change/<issue>` by issue number.
 *
 * The stream is a stub that never emits: the page's first paint comes from the
 * REST read, and a harness that also replayed frames would be testing the
 * stub's timing rather than the render.
 */
export function installDom({ mountIds, snapshot = null, changes = {}, storage = new Map() } = {}) {
  const saved = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, EventSource: globalThis.EventSource };

  const mounts = Object.fromEntries(mountIds.map((id) => [id, createElement('div')]));
  const documentElement = createElement('html');

  globalThis.document = {
    documentElement,
    getElementById: (id) => mounts[id] ?? null,
    createElement,
    createDocumentFragment: () => createElement('#fragment'),
    createTextNode: (text) => rawTextNode(String(text)),
    addEventListener() {},
    removeEventListener() {},
  };
  globalThis.window = {
    localStorage: {
      getItem: (key) => (storage.has(key) ? storage.get(key) : null),
      setItem: (key, value) => storage.set(key, String(value)),
      removeItem: (key) => storage.delete(key),
    },
  };

  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  globalThis.fetch = async (url, init) => {
    const path = String(url);
    if (path === '/api/snapshot') {
      return snapshot === null ? json({ reason: 'no snapshot in this harness' }, 503) : json(snapshot);
    }
    const change = path.match(/^\/api\/change\/(\d+)$/);
    if (change) {
      const body = changes[change[1]];
      return body ? json(body) : json({ reason: `no change was staged for issue #${change[1]}` }, 404);
    }
    if (path.startsWith('/api/poll/')) return json({ reason: 'the poller is not part of this harness' }, 503);
    throw new Error(`the page reached for ${path}, which this harness does not answer — ${init?.method ?? 'GET'}`);
  };
  globalThis.EventSource = class {
    constructor(url) { this.url = url; }
    addEventListener() {}
    removeEventListener() {}
    close() {}
  };

  return {
    mounts,
    documentElement,
    storage,
    restore() {
      globalThis.document = saved.document;
      globalThis.window = saved.window;
      globalThis.fetch = saved.fetch;
      globalThis.EventSource = saved.EventSource;
    },
  };
}
