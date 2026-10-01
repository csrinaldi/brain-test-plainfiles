// bootstrap-alias.test.mjs — the one alias brain writes into a consumer's
// package.json must survive the scoped rename (issue #628, delivered in #655).
//
// THE BREAK. `BOOTSTRAP_SCRIPT_VALUE` spelled `node_modules/brain/...` as a
// literal, and `writeBootstrapAlias` writes it into the CONSUMER's package.json.
// After the rename that path does not exist, so `npm run brain:upgrade` — the
// verb a consumer runs to recover — fails with a missing-file error from node,
// which says nothing about what happened or what to do.
//
// AND IT DOES NOT SELF-HEAL. `writeBootstrapAlias` keeps a consumer-set value
// ("keeping your value"), which is the correct rule in general and exactly the
// wrong one here: that value is brain's OWN previous output, now broken. So the
// migration is narrow and explicit — a value byte-identical to something brain
// itself wrote is replaced; anything else is a consumer's and is kept.
//
// The list of legacy values is a list, not a regex, for the same reason: a
// pattern would eventually match something a consumer wrote on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  BOOTSTRAP_SCRIPT_KEY,
  BOOTSTRAP_SCRIPT_VALUE,
  LEGACY_BOOTSTRAP_VALUES,
  writeBootstrapAlias,
} from './init.mjs';
import { PACKAGE_NAME } from './installer.mjs';

/** A consumer package.json plus the writer seam, so nothing touches a disk. */
function consumer(scripts) {
  // A real package.json ends with a newline. Without it the merge normalises the
  // file and reports `written`, which looks like a product defect and is a
  // fixture defect — measured, on the first run of this file.
  const state = { text: `${JSON.stringify({ name: 'consumer', version: '1.0.0', scripts }, null, 2)}
` };
  const r = writeBootstrapAlias({
    pkgPath: '/consumer/package.json',
    readFile: () => state.text,
    writeFile: (_p, text) => { state.text = text; },
  });
  return { ...r, value: JSON.parse(state.text).scripts?.[BOOTSTRAP_SCRIPT_KEY] };
}

test('#628: the alias is derived from PACKAGE_NAME, never spelled out', () => {
  assert.equal(BOOTSTRAP_SCRIPT_VALUE, `node node_modules/${PACKAGE_NAME}/brain/scripts/brain-upgrade.mjs`);
});

test('#628: a scope becomes two directory segments, exactly as npm lays it out', () => {
  if (!PACKAGE_NAME.startsWith('@')) return; // pre-rename: nothing to assert
  const [scope, name] = PACKAGE_NAME.split('/');
  assert.match(BOOTSTRAP_SCRIPT_VALUE, new RegExp(`node_modules/${scope}/${name}/`));
});

test('#628: no alias yet — it is written', () => {
  const r = consumer({});
  assert.equal(r.written, true);
  assert.equal(r.alreadyPresent, false);
  assert.equal(r.value, BOOTSTRAP_SCRIPT_VALUE);
});

test('#628: a STALE alias brain itself wrote is migrated, not preserved', () => {
  for (const legacy of LEGACY_BOOTSTRAP_VALUES) {
    const r = consumer({ [BOOTSTRAP_SCRIPT_KEY]: legacy });
    assert.equal(r.value, BOOTSTRAP_SCRIPT_VALUE, `the pre-rename value was kept: ${legacy}`);
    assert.equal(r.migrated, true, 'the migration happened silently — the caller cannot tell the consumer what changed');
  }
});

test('#628: a value the CONSUMER chose is still kept — the general rule is unchanged', () => {
  const mine = 'node ./scripts/my-own-upgrade.mjs --with-flags';
  const r = consumer({ [BOOTSTRAP_SCRIPT_KEY]: mine });
  assert.equal(r.value, mine, 'a consumer-authored alias was overwritten — that is the rule this must not break');
  assert.equal(r.migrated, false);
  assert.equal(r.alreadyPresent, true);
});

test('#628: the current value is left alone and reported as already present', () => {
  const r = consumer({ [BOOTSTRAP_SCRIPT_KEY]: BOOTSTRAP_SCRIPT_VALUE });
  assert.equal(r.value, BOOTSTRAP_SCRIPT_VALUE);
  assert.equal(r.written, false);
  assert.equal(r.migrated, false);
  assert.equal(r.alreadyPresent, true);
});

test('#628: the legacy list is a real list of literals, not a pattern', () => {
  assert.ok(Array.isArray(LEGACY_BOOTSTRAP_VALUES) && LEGACY_BOOTSTRAP_VALUES.length >= 1,
    'the legacy list is empty — every stale alias would then be treated as consumer-authored and kept');
  for (const v of LEGACY_BOOTSTRAP_VALUES) {
    assert.equal(typeof v, 'string');
    assert.ok(!v.includes('*') && !v.includes('('), `"${v}" looks like a pattern; a pattern eventually matches something a consumer meant`);
    assert.notEqual(v, BOOTSTRAP_SCRIPT_VALUE, 'the current value is in the legacy list — migration would loop on itself');
  }
});
