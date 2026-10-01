// frames.mjs — the SSE stream reduced to page state (#881 PR 4 / B2, D6).
// Pure, imported by the browser AND by node:test (D9): no clock, no DOM, no
// EventSource — `app.js` owns the transport, this module owns the shape.
//
// The server pushes four frames (`server.mjs`): `sync` (the whole held
// snapshot plus meta), `section` (one diffed section, Q5/D6), `refs` (a
// worktree's head moved, Q3/A2) and `status` (watcher + poller state). Each
// one is a REPLACEMENT of part of the state, never a mutation: `app.js`
// re-renders from the returned object, and the previous object stays valid
// for a diff or a rollback.
//
// Never empty-on-failure (R881-9): nothing here can clear the snapshot. A
// frame that cannot be applied — arriving before the first `sync`, or naming
// an event this page does not know — leaves every held value in place and
// records the reason on `state.stream`, which `app.js` shows in band.

/** The ref log is bounded: a rebase firing forty ref events must not grow the page without limit. */
const MAX_REFS = 20;

/** The page before anything has been read — stated, not blank. */
export function initialPageState() {
  return {
    snapshot: null,
    meta: null,
    stream: { ok: false, reason: 'the live stream has not connected yet' },
    // The poll buttons' own health, separate from the transport's: a control
    // that did not take says nothing about whether the page is live (R881-4).
    controls: { ok: true },
    refs: [],
    lastFrameAt: null,
  };
}

/**
 * applyFrame(state, event, data) -> the next state. Total: every event name
 * returns a state, no input throws.
 *
 * @param {object} state the current page state
 * @param {string} event the SSE event name (`sync` | `section` | `refs` | `status`)
 * @param {object} data the frame's parsed `data:` payload
 */
export function applyFrame(state, event, data = {}) {
  if (event === 'sync') {
    return {
      ...state,
      snapshot: data.snapshot ?? state.snapshot,
      // The REST read (`GET /api/snapshot`) carries no meta; it must not erase
      // what the stream already said about the watcher and the poller.
      meta: data.meta ?? state.meta,
      stream: { ok: true },
      lastFrameAt: data.generatedAt ?? state.lastFrameAt,
    };
  }
  if (event === 'section') {
    if (state.snapshot === null) {
      return { ...state, stream: { ok: false, reason: `a "${data.name}" section frame arrived before the first sync — waiting for a full sync` } };
    }
    // A name this snapshot does not carry is the same class of fact as an
    // unknown event: said, never written — an invented key would draw as data.
    if (!Object.hasOwn(state.snapshot, data.name)) {
      return { ...state, stream: { ok: false, reason: `a section frame named "${data.name}", which is not in the snapshot this server serves — the page may be older than the server` } };
    }
    return {
      ...state,
      snapshot: { ...state.snapshot, [data.name]: data.section, generatedAt: data.generatedAt ?? state.snapshot.generatedAt },
      stream: { ok: true },
      lastFrameAt: data.generatedAt ?? state.lastFrameAt,
    };
  }
  if (event === 'refs') {
    return { ...state, refs: [data, ...state.refs].slice(0, MAX_REFS), stream: { ok: true } };
  }
  if (event === 'status') {
    return { ...state, meta: data, stream: { ok: true } };
  }
  return { ...state, stream: { ok: false, reason: `unknown stream frame "${event}" — the page may be older than the server` } };
}

/**
 * parseFrame(text) -> {ok:true, frame} | {ok:false, reason}. The parse lives
 * here, not in the listener, because a throw inside an `EventSource` callback
 * loses the frame AND leaves the page with nothing to say about it.
 */
export function parseFrame(text) {
  try {
    return { ok: true, frame: JSON.parse(text) };
  } catch (err) {
    return { ok: false, reason: `a stream frame was not JSON and was dropped: ${err?.message ?? err}` };
  }
}

/** The transport failed (an `EventSource` error): keep every value, say why it is no longer live. */
export function streamFailed(state, reason) {
  return { ...state, stream: { ok: false, reason } };
}

/** A poll control's POST failed. Distinct from `streamFailed`: the transport is fine, the button is not. */
export function controlFailed(state, { action, reason }) {
  return { ...state, controls: { ok: false, action, reason } };
}

/**
 * sectionOf(state, name) -> the section's `{ok, value|reason}` — never
 * `undefined`. A renderer that got `undefined` would draw an empty area,
 * which reads as "there is nothing here" instead of "this was never read"
 * (`evidence-reader-empty-on-failure.md`, R881-9).
 */
export function sectionOf(state, name) {
  if (state.snapshot === null) return { ok: false, reason: `no snapshot has been read yet, so "${name}" is unknown` };
  const section = state.snapshot[name];
  if (section === undefined) return { ok: false, reason: `"${name}" is not in the snapshot this server serves` };
  return section;
}

/**
 * requestSequence() — one counter per kind of in-flight read. `next()` starts
 * a request; `isCurrent(token)` is true only for the latest one, so a slower
 * earlier answer is dropped instead of rendering over a fresher one (cold
 * review of #982, correction 2: a burst of `refs` frames reloads the drawer).
 */
export function requestSequence() {
  let latest = 0;
  return { next: () => ++latest, isCurrent: (token) => token === latest };
}
