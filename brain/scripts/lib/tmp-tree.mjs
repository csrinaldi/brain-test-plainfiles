// lib/tmp-tree.mjs — removeTempTree(), the ONE way this repo disposes of a
// temp tree it owns (issue #800).
//
// The failure this exists to stop: `test/review-regulated/regulated-review.e2e.test.mjs`
// tore down its fixture with `rmSync(fx.base, { recursive: true, force: true })`. That
// passed on this exact commit, then failed on a re-run of the SAME commit with:
//
//   ENOTEMPTY: directory not empty, rmdir '.../consumer/.git/objects'
//
// `force: true` ONLY suppresses ENOENT — "the path is already gone" — because that is
// the one case `rmSync` documents as safe to swallow unconditionally. It has never
// covered ENOTEMPTY, EBUSY, or any of the other errnos a concurrent writer to the
// same tree can produce. Node's actual answer to "something else touched this
// directory mid-delete, retry" is `maxRetries` + `retryDelay`: with `recursive: true`,
// `rmSync` retries EBUSY, EMFILE, ENFILE, ENOTEMPTY and EPERM up to `maxRetries` times,
// waiting `retryDelay` ms between attempts. No call site in this repo passed either
// option before this file existed — `rg 'maxRetries|retryDelay'` returned zero hits.
//
// The race itself is UNIDENTIFIED. Every git invocation in the fixture and in the
// review CLI under test is `execFileSync` — synchronous — so no *direct* child of the
// test process can be racing the rmdir. Something else is touching `.git/objects`
// during teardown, and this file does not claim to know what. That is why the fix
// here is a structural guard, not a targeted one: retry a bounded number of times,
// and if the tree still won't go, give up WITHOUT taking the test down with it.
//
// That "give up without failing" part is the actual point, and it holds regardless
// of whether the retry ever helps: teardown runs after the test's assertions have
// already passed. A directory that outlives a test run costs disk, nothing else — a
// REQUIRED branch-protection gate reporting failure for a leaked temp dir costs
// everyone's trust in the gate. So this never throws. But "never throws" must not
// mean "never tells anyone" — an accumulating leak is a real bug in its own right,
// just a slower one, so a give-up is reported to stderr via `onLeak` rather than
// swallowed twice.
//
// `_rm` and `onLeak` are injectable purely as test seams (this repo's convention —
// see e.g. `axes/platform/adapters/claude.mjs`'s `_run`/`_env`): they let the test suite
// drive the ENOTEMPTY/other-errno/give-up paths deterministically, without waiting
// on a real race to reproduce.
//
// LOCATION (issue #887, correction C2): this module lived at
// `__fixtures__/tmp-tree.mjs` from #801 through #802's 31-file adoption sweep. #802's
// own scope note flagged, but deliberately did not resolve, that two PRODUCTION
// modules (`review/cold-boot.mjs`, `axes/memory/adapters/engram.mjs`) were importing a
// helper from a directory named `__fixtures__` — a name that reads test-only. #887
// Slice B (`memory/lane/collect.mjs`) became a THIRD production importer, at which
// point deferring the layering question further stopped being reasonable: this file
// moved to `lib/`, a directory that already holds fs/git-adjacent production helpers
// (`git-branch.mjs`, `branch-type.mjs`, ...), and `__fixtures__/tmp-tree.mjs` now
// re-exports it so every existing test import keeps working unchanged. The
// `cold-boot.mjs`/`engram.mjs` ALLOWLIST question `tmp-tree-adoption.test.mjs` records
// is untouched by this move — those two still use a bare `rmSync` on purpose, for the
// reasons pinned in that test's own comment.

import { rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

function defaultOnLeak(dir, err) {
  process.stderr.write(
    `tmp-tree: giving up on removing "${dir}" (${err?.code ?? 'unknown error'}: ${err?.message ?? err}) — ` +
    `leaving it on disk. This is not a test failure; see issue #800.\n`,
  );
}

// A `dir` that is not a string, is relative, or resolves to a path outside
// `os.tmpdir()` is not a "the tree resisted deletion" problem — it is a
// CALLER BUG: nobody meant to hand this function a path it does not own.
// Catching it here, before `_rm` is ever called, matters because `rmSync`
// with `recursive: true, force: true, maxRetries: N` does not fail loudly on
// a path like `/` or `/usr/bin`: it deletes everything the process can
// reach, retries the final `rmdir` (EBUSY is on Node's retry list), then
// hands the leftover error to `onLeak`, which reports it as an ordinary,
// ignorable leak. That would make a catastrophic path silently pass through
// the exact mechanism meant to keep teardown from failing an already-passed
// test. So this check throws — loudly, and deliberately not swallowed by
// `onLeak` — because nothing has been deleted yet, so nothing that already
// passed can be sabotaged by refusing early.
//
// The check is containment against the resolved temp root, not a segment
// count: this function's actual contract is "removes a *temp* tree", and
// path depth neither implies nor is implied by that. A path can have two
// segments and still be catastrophic (`/usr/bin`, `/home/<user>`, `/etc/ssl`
// are all exactly two segments and none of them is a temp directory), and a
// legitimately `mkdtempSync`'d path can resolve shallow if `TMPDIR` is set to
// something shallow — a segment count would then throw on an already-valid
// path, turning an already-passed test red, which is the exact failure this
// file exists to eliminate.
//
// `os.tmpdir()` itself resolving to the filesystem root (a pathological
// `TMPDIR=/`) is refused outright, with the temp root named as the cause:
// treating "no path segments" as a containment root would make every
// absolute path pass through as "contained", turning the guard into a no-op
// exactly when a degenerate `TMPDIR` makes it matter most.
//
// Containment is checked against BOTH the resolved temp root and its
// `realpathSync`-resolved form, because `os.tmpdir()` is not always the real
// path: on macOS it is typically `/var/folders/...`, itself a symlink into
// `/private/var/folders/...`. A caller that passes a realpath-resolved
// fixture path while `tmpdir()` returns the symlink form (or vice versa)
// would otherwise be refused despite being genuinely under the temp
// directory — again turning an already-passed test red. `realpathSync`
// throws if the path does not exist, so that resolution is wrapped and
// treated as "unavailable" rather than propagated; the plain `resolve()`
// check still applies in that case.
function assertRemovableDir(dir) {
  if (typeof dir !== 'string' || dir.length === 0) {
    throw new TypeError(`removeTempTree: dir must be a non-empty string, got ${JSON.stringify(dir)}`);
  }
  if (!isAbsolute(dir)) {
    throw new TypeError(`removeTempTree: dir must be an absolute path, got ${JSON.stringify(dir)}`);
  }

  const resolved = resolve(dir);
  const tmpRoot = resolve(tmpdir());

  if (tmpRoot.split(sep).filter(Boolean).length === 0) {
    throw new TypeError(
      `removeTempTree: os.tmpdir() resolves to "${tmpRoot}", the filesystem root — refusing to treat ` +
      `containment under it as a safe boundary for "${resolved}"`,
    );
  }

  let realTmpRoot = null;
  try {
    realTmpRoot = resolve(realpathSync(tmpRoot));
  } catch {
    // tmpRoot does not exist (or is not reachable right now) — the
    // realpath-based containment check below is simply unavailable; the
    // plain resolve()-based check still applies.
  }

  const isUnder = (root) => resolved !== root && resolved.startsWith(root + sep);

  if (!isUnder(tmpRoot) && !(realTmpRoot !== null && isUnder(realTmpRoot))) {
    throw new TypeError(
      `removeTempTree: dir resolves to "${resolved}", which is not inside the temp root "${tmpRoot}" — ` +
      `refusing to recursively remove a path this function does not own`,
    );
  }
}

/**
 * Removes a temp tree built for a test.
 *
 * The "never throws" guarantee here covers exactly one failure mode: the
 * tree resisted removal (a lingering handle, a concurrent writer, any errno
 * `_rm` can raise once it has actually tried to delete something). Teardown
 * is not an assertion, so THAT kind of failure may not fail a test that
 * already passed — it is reported via `onLeak` instead, and `onLeak` itself
 * is guarded so a failure inside the reporter cannot escape either. A custom
 * `onLeak` can throw synchronously for any reason, and so can the default
 * reporter's `process.stderr.write` when stderr is TTY- or file-backed — that
 * stream is a `SyncWriteStream`, whose writes are synchronous and so CAN
 * throw `EPIPE` synchronously if the reading end closed early. This is NOT
 * the common CI shape, though: when stderr is genuinely piped (`2>&1 | cat`),
 * Node backs it with a `Socket` instead, whose writes are asynchronous — an
 * EPIPE there surfaces as an `'error'` event on a later tick, not a
 * synchronous throw, so this `catch` would never see it. The guard still
 * matters — for the TTY/file case, and for any custom `onLeak` that throws
 * synchronously for an unrelated reason — it just does not defend against a
 * piped stderr's EPIPE, which arrives on a different tick entirely.
 *
 * It does NOT cover a caller bug in `dir` itself (not a string, relative, or
 * resolving outside `os.tmpdir()`). That is a programming error caught
 * before any filesystem call is made — nothing has been deleted, so nothing
 * that already passed is at risk — and it throws on purpose. Do not
 * "simplify" that throw away to make the never-throws guarantee absolute:
 * doing so would let a bad path silently `rm -rf` a filesystem root and
 * report it as an ordinary, ignorable leak.
 *
 * @param {string} dir Root of the temp tree to remove. Must be an absolute
 *   path resolving to a location strictly inside `os.tmpdir()` (or its
 *   realpath, to tolerate a symlinked temp root).
 * @param {object} [opts]
 * @param {number} [opts.maxRetries=10] Forwarded to `rmSync`; retries EBUSY,
 *   EMFILE, ENFILE, ENOTEMPTY, EPERM.
 * @param {number} [opts.retryDelay=100] Milliseconds between retries.
 * @param {(dir: string, err: unknown) => void} [opts.onLeak] Called when `_rm`
 *   still fails after retries — the leak-visibility seam. Defaults to a
 *   stderr report naming the path and the errno. Guaranteed not to bring
 *   down `removeTempTree` even if it itself throws. Must be synchronous and
 *   must handle its own errors: `removeTempTree` only guards against a
 *   *synchronous* throw from `onLeak`, so an async `onLeak` whose returned
 *   promise rejects later would surface as an unhandled rejection outside
 *   this function's control, not as a caught error here.
 * @param {(dir: string, options: object) => void} [opts._rm] Test seam for
 *   `rmSync` — never overridden in production.
 * @throws {TypeError} If `dir` is not a non-empty absolute string resolving
 *   to a location inside `os.tmpdir()` — a caller bug, not a cleanup failure.
 */
export function removeTempTree(dir, { maxRetries = 10, retryDelay = 100, onLeak = defaultOnLeak, _rm = rmSync } = {}) {
  assertRemovableDir(dir);
  try {
    _rm(dir, { recursive: true, force: true, maxRetries, retryDelay });
  } catch (err) {
    try {
      onLeak(dir, err);
    } catch {
      // The reporter itself failed while reporting a removal failure. This
      // is a last-ditch effort at visibility, not a new place for a cleanup
      // failure to escape — swallow it so "never throws" stays true for the
      // one failure mode it is meant to cover.
    }
  }
}
