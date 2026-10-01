// identity.drift.test.mjs — the bound identity cannot be bypassed (issue #501).
//
// SOURCE assertions, deliberately, and this file exists because behavioural tests
// cannot see the failure it guards against.
//
// History: `whoami` was the ONE call site in github.mjs that applied the reviewer
// token. It was correct, and it stayed alone for the entire life of #413 while
// nineteen other verbs resolved auth some other way. Nothing failed, because a
// verb that ignores the credential still WORKS — it just works as somebody else.
// Measured on PR #500: the reviewer verified as `csrinaldibot` and posted as
// `csrinaldi`, and every test in the suite was green.
//
// So the guard is on the shape of the source: a verb added tomorrow that calls
// `run('gh', …)` directly, or resolves `vcsToken(PROVIDER)` inline, would bypass
// the binding, pass every behavioural test, and reopen this exact defect.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const readProvider = (name) => readFileSync(join(here, `${name}.mjs`), 'utf8');

/** Source with block and line comments removed — a rule must be enforced on CODE. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

test('#501 github: every `gh` invocation goes through the chokepoint', () => {
  const code = stripComments(readProvider('github'));

  // The chokepoint itself is the only place `run`/`runJson` may name 'gh'.
  const chokepoint = [
    "const gh = (args, opts) => run('gh', args, ghOpts(opts));",
    "const ghJson = (args, opts) => runJson('gh', args, ghOpts(opts));",
  ];
  for (const line of chokepoint) {
    assert.equal(
      code.split(line).length - 1,
      1,
      `the chokepoint must be defined exactly once — this test is meaningless if it moved: ${line}`,
    );
  }

  const rest = chokepoint.reduce((acc, line) => acc.split(line).join(''), code);
  const escapes = [...rest.matchAll(/\b(runJson|run)\(\s*['"]gh['"]/g)].map((m) => m[0]);
  assert.deepStrictEqual(
    escapes,
    [],
    `every gh invocation must go through gh()/ghJson(), or it runs under the operator's ` +
      `ambient login instead of the bound identity. Found: ${JSON.stringify(escapes)}`,
  );
});

test('#501 gitlab: the credential is resolved in exactly one place', () => {
  const code = stripComments(readProvider('gitlab'));

  const resolver = 'const glToken = (token) => token ?? currentIdentity() ?? vcsToken(PROVIDER);';
  assert.equal(
    code.split(resolver).length - 1,
    1,
    'the resolver must be defined exactly once — this test is meaningless if it moved',
  );

  // Thirteen verbs used to resolve `token ?? vcsToken(PROVIDER)` inline. The
  // parameter was CORRECT and the reviewer still wrote with the wrong credential,
  // because nothing passed it — which is why an inline fallback is now a failure
  // rather than a style preference.
  const rest = code.split(resolver).join('');
  const inline = [...rest.matchAll(/vcsToken\(\s*PROVIDER\s*\)/g)].map((m) => m[0]);
  assert.deepStrictEqual(
    inline,
    [],
    `no verb may resolve vcsToken(PROVIDER) inline — it ignores the bound identity ` +
      `and falls back to the GENERIC credential. Found ${inline.length} occurrence(s)`,
  );
});

test('#501 both providers import the identity context — the binding is not optional', () => {
  // A provider that stops importing it silently loses the binding while every
  // behavioural test stays green, because "acts as the ambient user" is a working
  // program. The import is the cheapest observable proof that the file is bound
  // at all.
  for (const name of ['github', 'gitlab']) {
    const code = stripComments(readProvider(name));
    assert.match(
      code,
      /import \{ currentIdentity \} from '\.\.\/\.\.\/\.\.\/vcs\/lib\/identity-context\.mjs';/,
      `${name}.mjs must read the bound identity`,
    );
    assert.match(code, /currentIdentity\(\)/, `${name}.mjs must USE it, not merely import it`);
  }
});

test('#501 lock 2 is untouched: event COMMENT is still hardcoded at every payload', () => {
  // REQ-501-4. This change threads a credential into prReviewComment, which is the
  // function both blockers on PR #490 lived in — "while I was in there" is exactly
  // how they were introduced. ADR-0020: no parameter, flag or branch selects a
  // different event.
  const code = stripComments(readProvider('github'));
  const literals = [...code.matchAll(/event:\s*'COMMENT'/g)].map((m) => m[0]);
  assert.equal(
    literals.length,
    3,
    `github.prReviewComment builds THREE event-carrying payloads — the ternary's ` +
      `anchored branch, its bare branch, and the retry. Got ${literals.length}`,
  );
  const variable = [...code.matchAll(/event:\s*(?!'COMMENT')[A-Za-z_$]/g)];
  assert.deepStrictEqual(
    variable.map((m) => m[0]),
    [],
    'no payload may take its event from a variable — lock 2 is a literal, on every branch',
  );
});
