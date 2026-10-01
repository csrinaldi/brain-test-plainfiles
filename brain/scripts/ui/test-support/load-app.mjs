// load-app.mjs — import the REAL `static/app.js` into a node test.
//
// The browser resolves `./lib/<module>.mjs` through `server.mjs`'s `/lib/`
// route, which serves `ui/lib/` — the same files `node:test` imports. Node
// resolves that same specifier against the file's own directory, where no
// `lib/` exists. So the page is copied into a temp directory with its
// specifiers rewritten to the real modules, and imported from there.
//
// The copy is written under `testTmp`, NEVER in the repository: a review
// candidate whose worktree changed is refused outright, and tests writing into
// the repo root have caused three separate incidents (#1019, #1022, #1026).
//
// Each load gets its own filename because ESM caches by URL. A test that needs
// a fresh module — a different stored theme, a different snapshot — gets a
// fresh instance instead of the previous test's module state.

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { testTmp } from '../../lib/test-tmp.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP_JS = join(HERE, '..', 'static', 'app.js');
const LIB_DIR = join(HERE, '..', 'lib');

let loads = 0;

/**
 * Import a fresh instance of the page. The DOM and the network globals must
 * already be installed (`installDom`), because `app.js` renders and fetches
 * the moment it is evaluated — that first paint is most of what this tests.
 */
export async function loadApp() {
  const source = readFileSync(APP_JS, 'utf8');
  const libUrl = pathToFileURL(join(LIB_DIR, '/')).href;
  const rewritten = source.replace(/(\bfrom\s*['"])\.\/lib\//g, `$1${libUrl}`);
  if (rewritten === source) throw new Error('app.js imported nothing from ./lib/ — the rewrite matched nothing, so this harness would be testing a page that is not the real one');

  const file = join(testTmp('ui-smoke-'), `app-${++loads}.mjs`);
  writeFileSync(file, rewritten);

  // The page re-renders its "polled N s ago" claim on a clock of its own, and
  // a real `setInterval` holds the event loop open for as long as the process
  // lives — `node --test` then never exits and the run hangs instead of
  // failing. The stub is installed ONLY across the import, because replacing a
  // global timer for the whole run would reach the test runner itself.
  const realSetInterval = globalThis.setInterval;
  const timers = [];
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  try {
    const mod = await import(pathToFileURL(file).href);
    // Handed back so a test can drive the clock deliberately rather than wait
    // for one: `timers[0].fn()` is the status bar re-rendering.
    return Object.assign(Object.create(mod), { timers });
  } finally {
    globalThis.setInterval = realSetInterval;
  }
}

/** Let the page's boot read settle — one REST read, then its render. */
export async function settle(ticks = 6) {
  for (let i = 0; i < ticks; i += 1) await new Promise((resolve) => setImmediate(resolve));
}
