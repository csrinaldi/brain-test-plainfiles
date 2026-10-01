// engram.search-unsupported.test.mjs — REQ-C3-5 / obs #578's "engram search
// stub: YES" ruling. Under MEMORY_BACKEND=engram, `memory search ...` MUST
// reject with a message pointing to the native engram tool (mem_search) —
// never-cryptic, never a silent no-op, nothing is read via this path.
//
// `save`'s half retired at #874, split A (D7): `engram.save()` is now the
// record-first producer path (engram.save.test.mjs), so `memory.save.engramUnsupported`
// has no call site left and is removed from both i18n catalogs. `search`
// stays unsupported (R14 scope) — engram already has a native `mem_search`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { search } from './engram.mjs';

test('engram.search: rejects with a message pointing to native mem_search', async () => {
  await assert.rejects(
    () => search(),
    (err) => {
      assert.ok(err.message.includes('mem_search'), `expected the refusal to name mem_search: ${err.message}`);
      return true;
    },
  );
});
