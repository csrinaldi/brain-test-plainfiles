// install-provenance.mjs — where THIS consumer's brain actually came from.
//
// WHY THIS EXISTS. `resolveInstallSpec` used to answer "registry or git?" from
// the installed package's own `name`: scoped ⇒ registry. That reads a property
// of the PACKAGE as if it were a fact about the CONSUMER. The two differ exactly
// where it matters — a consumer who installed from a git URL because they cannot
// reach the registry still has a scoped name on disk, so every `brain:upgrade`
// sent them to the registry and died there. ADR-0030's invariant list forbids
// that outcome by name: *"Never document the registry as the only way in … the
// git URL is the fallback for anyone who cannot reach the registry."*
//
// Provenance is recorded by npm in the hidden lockfile it writes beside the tree
// it installed, which is the only artifact that knows the answer.
//
// CLASSIFY, NEVER COPY. `resolved` is not a reusable install spec, and using it
// as one breaks the case this module exists to protect. Measured on real
// installs: asking npm for `git+https://…#v7.0.1` records
// `git+ssh://git@…#e0976457…` — the protocol REWRITTEN (ssh, for a consumer who
// may well have no key: the very "HTTPS-only consumers (CI, containers without
// an SSH key)" that `brain-upgrade.mjs` names) and the tag replaced by a commit
// SHA. So this module answers WHICH KIND of source, and the caller keeps
// building the spec from the manifest's `repository.url` and the requested tag.
//
// It deliberately imports NOTHING from `installer.mjs`: the search paths arrive
// as an argument. A cycle between the two would be avoidable-by-accident today
// and load-order-dependent later, and this module is genuinely about lockfiles,
// not about brain's own layout.

import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/** npm's hidden lockfile — written beside the tree it describes, npm >= 7. */
export const HIDDEN_LOCKFILE = join('node_modules', '.package-lock.json');

/**
 * The kind of source an npm `resolved` value names.
 *
 * `git+…`, `ssh://` and `git://` are git. `file:` is a local tarball or link.
 * A plain `https://` is read as a registry tarball — which is what npm writes
 * for a `name@version` install, and is ALSO what it writes for a remote tarball
 * URL. Those two are genuinely indistinguishable here, and the ambiguity is
 * survivable rather than silent: a wrong guess produces a spec that fails to
 * install, and the caller's git fallback catches it.
 *
 * @param {unknown} resolved
 * @returns {'registry'|'git'|'file'|null}
 */
export function classifyResolved(resolved) {
  if (typeof resolved !== 'string') return null;
  const r = resolved.trim();
  if (!r) return null;
  if (/^(git\+|git:\/\/|ssh:\/\/)/.test(r)) return 'git';
  if (/^file:/.test(r)) return 'file';
  if (/^https?:\/\//.test(r)) return 'registry';
  return null;
}

/**
 * The kind of source a DECLARED dependency spec names — the value npm, pnpm,
 * yarn and bun all write into the consumer's own `package.json`.
 *
 * This is the more durable of the two records, and the measurements say so:
 *
 * | route           | declared spec                        |
 * |-----------------|--------------------------------------|
 * | registry        | `^7.0.1`                             |
 * | git (shorthand) | `github:sindresorhus/is#v7.0.1`      |
 * | git (url)       | `git+file:///srv/remote.git#v9.0.0`  |
 * | tarball         | `file:../../logikas-brain-1.1.0.tgz` |
 *
 * Three properties the hidden lockfile does not have: it lives in a file the
 * consumer COMMITS, so it survives `rm -rf node_modules`; every package manager
 * writes it, so pnpm/yarn/bun consumers are covered; and it keeps the ref AS
 * WRITTEN (`#v9.0.0`) where the lockfile substitutes a commit SHA.
 *
 * A semver range or a dist-tag means the registry. Anything unrecognised is
 * `null` — the caller then keeps looking, and finally says it could not tell.
 *
 * @param {unknown} spec
 * @returns {'registry'|'git'|'file'|null}
 */
export function classifyDependencySpec(spec) {
  if (typeof spec !== 'string') return null;
  const s = spec.trim();
  if (!s) return null;
  if (/^(git\+|git:\/\/|ssh:\/\/|git@)/.test(s)) return 'git';
  if (/^(github|gitlab|bitbucket|gist):/.test(s)) return 'git';
  if (/^(file:|link:|portal:)/.test(s)) return 'file';
  // `npm:@scope/name@^1.0.0` — an alias install, still by name from a registry.
  if (/^npm:/.test(s)) return 'registry';
  // A semver range, an exact version, `*`, or a dist-tag like `latest`/`next`.
  if (/^([\^~><=v]|\d|\*$|latest$|next$)/.test(s)) return 'registry';
  return null;
}

/**
 * Reads provenance from the consumer's own manifest — the durable half.
 *
 * Checks `devDependencies` before `dependencies` because that is where
 * `brain:upgrade` installs itself (`npm install -D`), but honours either: a
 * consumer who moved it is not wrong, only unusual.
 *
 * @param {object} o
 * @param {any}    o.pkg          parsed consumer `package.json`
 * @param {string} o.packageName
 * @returns {{source:'registry'|'git'|'file'|'unknown', resolved:string|null, why:string}}
 */
export function evaluateDeclaredProvenance({ pkg, packageName } = {}) {
  const unknown = (why) => ({ source: 'unknown', resolved: null, why });
  if (!pkg || typeof pkg !== 'object') return unknown('the consumer package.json could not be read.');

  for (const field of ['devDependencies', 'dependencies', 'optionalDependencies']) {
    const spec = pkg[field]?.[packageName];
    if (typeof spec !== 'string') continue;
    const source = classifyDependencySpec(spec);
    if (source === null) {
      return unknown(`package.json ${field}.${packageName} is "${spec}", which names no route this reader knows.`);
    }
    return { source, resolved: spec, why: `package.json ${field} declares ${packageName} as "${spec}" (${source}).` };
  }
  return unknown(`${packageName} is not declared in the consumer package.json — it may have been installed without being saved.`);
}

/**
 * Pure core: reads the provenance of the package at one of `searchPaths` out of
 * an already-parsed hidden-lockfile document.
 *
 * Answers `unknown` with a REASON rather than a bare null, so a caller can say
 * why it is about to guess. "Could not read" and "read, and it says registry"
 * must never look the same — the `evidence-reader-empty-on-failure` shape
 * ADR-0030 Amendment 1 forbids for exactly this surface.
 *
 * @param {object}   o
 * @param {any}      o.doc          parsed `.package-lock.json`
 * @param {string[]} o.searchPaths  node_modules-relative dirs, in probe order —
 *                                  pass `installedPackageSearchPaths()` so this
 *                                  answers about the package the upgrade will use
 * @returns {{source:'registry'|'git'|'file'|'unknown', resolved:string|null, why:string}}
 */
export function evaluateProvenance({ doc, searchPaths = [] } = {}) {
  const unknown = (why) => ({ source: 'unknown', resolved: null, why });

  if (!Array.isArray(searchPaths) || searchPaths.length === 0) {
    return unknown('no package location was given to look up — the caller must pass its search paths.');
  }

  const packages = doc && typeof doc === 'object' ? doc.packages : null;
  if (!packages || typeof packages !== 'object') {
    return unknown(`${HIDDEN_LOCKFILE} has no \`packages\` map — not a lockfile this reader understands.`);
  }

  for (const dir of searchPaths) {
    const entry = packages[dir];
    if (!entry || typeof entry !== 'object') continue;
    // A `link: true` entry points elsewhere (workspace or file link) and carries
    // no install source of its own.
    if (entry.link === true) {
      return unknown(`${dir} is a link in ${HIDDEN_LOCKFILE} — its origin is the link target, not an install source.`);
    }
    const source = classifyResolved(entry.resolved);
    if (source === null) {
      return unknown(
        `${dir} is in ${HIDDEN_LOCKFILE} with no recognisable \`resolved\` (${JSON.stringify(entry.resolved ?? null)}).`,
      );
    }
    const resolved = entry.resolved.trim();
    return { source, resolved, why: `${dir} was installed from ${source} (${resolved}).` };
  }

  return unknown(`none of ${searchPaths.join(', ')} appears in ${HIDDEN_LOCKFILE}.`);
}

/**
 * Reads the consumer's install provenance from disk.
 *
 * Every failure is a STATED `unknown`, never a throw and never a silent default:
 * the hidden lockfile is npm-only, and brain supports pnpm, yarn and bun
 * (`lib/pm.mjs`), so "no provenance available" is an ordinary, expected answer
 * for a supported consumer rather than an error. The caller keeps its
 * pre-existing behaviour in that case and says that it guessed.
 *
 * @param {object}   o
 * @param {string}   o.repoRoot
 * @param {string[]} o.searchPaths
 * @param {Function} [o.readFile]  injectable for tests
 * @param {Function} [o.exists]    injectable for tests
 * @returns {{source:'registry'|'git'|'file'|'unknown', resolved:string|null, why:string}}
 */
export function readInstallProvenance({
  repoRoot,
  searchPaths = [],
  packageName = null,
  readFile = (p) => readFileSync(p, 'utf8'),
  exists = existsSync,
} = {}) {
  // TWO SOURCES, DURABLE ONE FIRST.
  //
  // The consumer's own package.json is a COMMITTED file: it survives
  // `rm -rf node_modules` and a deleted package-lock.json, both of which are
  // ordinary events, and every package manager writes it. The hidden lockfile
  // is npm-only and lives inside the directory people delete to fix things.
  //
  // Measured, on a consumer installed from a local git remote: delete
  // `package-lock.json` and provenance still reads `git` (the hidden lockfile
  // is inside node_modules, so it survives). Delete `node_modules` and BOTH the
  // hidden lockfile and the installed manifest are gone — without this first
  // source the upgrade silently redirected to the canonical GitHub URL, which
  // is precisely the wrong answer for the mirror/air-gap consumer the git route
  // exists to serve.
  const reasons = [];
  if (packageName) {
    const pkgPath = join(repoRoot, 'package.json');
    if (exists(pkgPath)) {
      let pkg = null;
      try {
        pkg = JSON.parse(readFile(pkgPath));
      } catch (e) {
        reasons.push(`consumer package.json could not be parsed (${e.message})`);
      }
      if (pkg) {
        const declared = evaluateDeclaredProvenance({ pkg, packageName });
        if (declared.source !== 'unknown') return declared;
        reasons.push(declared.why);
      }
    } else {
      reasons.push('the consumer package.json is absent');
    }
  }

  const lockPath = join(repoRoot, HIDDEN_LOCKFILE);
  if (!exists(lockPath)) {
    reasons.push(`${HIDDEN_LOCKFILE} is absent — it is written by npm >= 7, and this consumer may use pnpm, yarn or bun`);
    return { source: 'unknown', resolved: null, why: `${reasons.join('; ')}.` };
  }
  let doc;
  try {
    doc = JSON.parse(readFile(lockPath));
  } catch (e) {
    reasons.push(`${HIDDEN_LOCKFILE} could not be parsed (${e.message})`);
    return { source: 'unknown', resolved: null, why: `${reasons.join('; ')}.` };
  }
  const fromLock = evaluateProvenance({ doc, searchPaths });
  if (fromLock.source !== 'unknown') return fromLock;
  reasons.push(fromLock.why);
  return { source: 'unknown', resolved: null, why: reasons.join('; ') };
}
