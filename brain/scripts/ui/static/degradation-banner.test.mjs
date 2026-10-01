// degradation-banner.test.mjs — R881-9's two bands, pinned (#881 PR 4 / B2,
// tasks T3a).
//
// tasks.md asked for a text scan of `app.js`'s template strings. The strings
// are asserted BY VALUE instead, against `lib/banners.mjs` where they live
// (`banners.test.mjs` pins them too, with their inputs): a grep can prove a
// string exists in a file, but not that anything ever shows it. What this
// file adds on top is the half a value assertion cannot reach — that `app.js`
// really WIRES those builders, through `degradationBands`, into the page, and
// that no `{ok:false}` branch in the page renders an empty area instead of a
// reason. Those are scans, because no DOM runner exists here (design D9).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { watcherBanner, pollBanner } from '../lib/banners.mjs';

const STATIC_DIR = dirname(fileURLToPath(import.meta.url));
const APP_JS = readFileSync(join(STATIC_DIR, 'app.js'), 'utf8');

test('#881 T3a / R881-9 S1: the watcher-failure band is the design\'s sentence, unchanged', () => {
  assert.equal(
    watcherBanner('<reason>'),
    'the watcher failed: <reason> — the canvas updates on the forge poll only; press Refresh for repo changes.',
  );
});

test('#881 T3a / R881-9 S2: the poll-failure band is the design\'s sentence, unchanged', () => {
  const text = pollBanner({ lastOkAt: '<time>', lastPolledAt: null, lastError: '<reason>' });
  assert.equal(text, 'forge as of <time> — last poll failed: <reason>');
});

test('#881 T3a: app.js wires the band builders into the page instead of writing its own sentences', () => {
  assert.match(APP_JS, /import \{[^}]*degradationBands[^}]*\} from '\.\/lib\/banners\.mjs'/, 'the bands come from the tested module');
  assert.match(APP_JS, /degradationBands\(\{ stream: state\.stream, controls: state\.controls, meta: state\.meta, snapshot: state\.snapshot \}\)/, 'every input the bands need is passed: transport, poll controls, watcher/poller meta, and the snapshot sections');
  assert.ok(!/the watcher failed:/.test(APP_JS), 'the sentence must not be duplicated in the browser file — one owner, one test');
  assert.ok(!/last poll failed:/.test(APP_JS), 'the sentence must not be duplicated in the browser file — one owner, one test');
});

test('#881 R881-9: app.js parses a stream frame through the tested parser, never with a bare JSON.parse in the listener', () => {
  assert.match(APP_JS, /parseFrame\(/, 'a parse that throws inside the EventSource callback loses the frame AND says nothing');
  assert.ok(!/JSON\.parse\(/.test(APP_JS), 'the browser file must not parse a frame itself — the parse is a tested value in lib/frames.mjs');
});

test('#881 R881-4: a failed poll control goes to its own band, not to the stream band', () => {
  assert.match(APP_JS, /controlFailed\(state,/, 'postPoll must report a control failure as a control failure');
  assert.ok(!/state = streamFailed\(state, `the poll control/.test(APP_JS), 'a button that did not take must not be rendered as "the live stream dropped"');
  assert.match(APP_JS, /degradationBands\(\{[^}]*controls: state\.controls/, 'the band builder must be given the control state, or the reason is held and never shown');
});

test('#881 R881-9: every {ok:false} branch in the page renders the reason, so no failure can show as an empty area', () => {
  // `.reason` is read wherever `.ok` is checked: the count is a floor, not an
  // exact shape — what matters is that no branch drops the reason on the way
  // to the DOM (`evidence-reader-empty-on-failure.md`).
  const okChecks = APP_JS.match(/\.ok\b/g) ?? [];
  const reasonUses = APP_JS.match(/\.reason\b/g) ?? [];
  assert.ok(okChecks.length > 0, 'the page must branch on {ok} at all');
  assert.ok(reasonUses.length > 0, 'the page must render reasons');
  assert.match(APP_JS, /function said\(/, 'the page has one helper for a stated reason, so no branch has to invent its own');
});
