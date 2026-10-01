# The red-proof is blind along an axis the mutation never varies

- **Discovered in:** issue #405 / PR #490 — fourteen cold-review rounds over one change
- **Applies to:** every red-proof in this repo, and with particular force to the
  reviewer's own guards (`vcs-contract.md`'s port verbs, `reviewer-protocol.md` §2's three
  locks), where a test that fails to protect is indistinguishable from one that protects

## Symptom

A mutation is applied to production code, its diff is printed, the file parses, the full
suite runs — and it comes back **green**, so the protection is declared sound. Later, a
*different spelling of the same defect* turns the same protection red. The first green was
never evidence of anything: the mutation and the test agreed on an axis neither of them
varied.

On PR #490 this happened **eight times across fourteen rounds**, and twice the survivor was
an exploitable defect in the guard that keeps the automated reviewer structurally unable to
approve a merge.

## Cause

A red-proof measures the pair (mutation, test), not the code. When both are written by the
same person in the same sitting, they share the author's blind spot — and the shape of that
blind spot is an **axis the mutation does not vary**. Six axes, each found the round *after*
the previous one was fixed:

| axis | the mutation varies… | what it cannot see | round |
|---|---|---|---|
| **PATH** | the value | a branch the fixture never reaches | 8 |
| **BRANCH** | both branches together | a gap in exactly one of them | 12 |
| **VALUE CLASS** | one representative value | a predicate relaxed for a class not driven | 13 |
| **SPELLING** | one form of the defect | an equivalent form the assertion's regex admits | 6 |
| **FIELD** | the fields the assertion names | a field the payload carries and the scan skips | 7 |
| **SITE** | the site the author was thinking about | a second call site the same change created | 8, 9 |

Two concrete instances, both from the lock that forbids the reviewer posting an APPROVE:

- The guard was a source scan for the literal `APPROVE`. Adding `event = 'COMMENT'` as a
  **parameter** walks past it — the value is a variable, not a literal. Blind by SPELLING.
- The behavioural guard that replaced it drove a fixture whose transport **always
  succeeded**, so the bare-retry payload was never sent. Blind by PATH. Fixed, then found
  blind by SITE: the verb builds three `event`-carrying payloads and the ternary reads as
  one, so "both call sites" was two of three — and the uncovered one was the only one
  production reaches.

## Two failure modes of the harness itself

Both produce a green that means nothing, and both look correct in a printed diff:

1. **Semantically inert substitution.** `{ ..., comments, ev }` destructures a property
   named `ev`; the intended mutation was `{ ..., comments, event: ev }`. The text changed,
   the file parsed, the mutation did nothing.
2. **The harness silently failed to substitute.** A `cut -d'|'` pipeline split on the `||`
   inside the mutation string. Four "greens" in one run, all meaningless.

## Third failure mode, subtler: the negative fixture that fails for the wrong reason

A case asserting *"an empty path is rejected"* used `{ file: '', line: null }`. The **line**
check excluded it, so the **path** check was never consulted, and deleting the path check
left the case green. A negative fixture must fail for the criterion under test **and no
other** — otherwise it pins whichever criterion happens to fire first.

## Solution / correct pattern

**Before trusting a green, name the axis the mutation did not vary, and vary it.**

1. **Enumerate the sites from the CODE, not from the sentence describing it.**
   `grep -o` counts occurrences; `grep -c` counts lines, and a ternary puts two payloads on
   one line. Assert the expected substitution-site count and refuse to run when it differs.
2. **Mutate per branch AND together.** A both-branch mutation cannot detect a one-branch
   gap.
3. **Drive every value class the predicate names.** If a guard's own comment enumerates
   `0`, `''`, `'abc'`, `2.5`, `-3`, the negative case carries all five, on every branch.
4. **Try more than one spelling per defect** — a parameter, a flag, an env read, a
   partially-relaxed predicate. A partial re-inline is the one most tests miss, because it
   still rejects the values the tests do drive.
5. **Confirm the mutation is LIVE**, not merely present: read the forged value back off the
   wire, or from the artefact under assertion. `node --check` proves it parses, not that it
   bites.
6. **Negative fixtures fail for one reason.** Give the empty-path case a usable line.
7. **When two copies of a rule exist, delete one.** Every drift on PR #490 was between
   duplicated predicates. Renderer and poster now share one exported `hasUsableAnchor`; two
   copies drift, one function cannot.

## Why this belongs in the reviewer's own doctrine

`reviewer-protocol.md` §10 says an unquoted warn is a review defect. This is the same rule
one level down: **an unproven protection is a review defect**, and a red-proof whose axis
was never varied has proven nothing. The reviewer's three locks are exactly the guards where
a false green is most expensive — on PR #490, two rounds' worth of false greens sat between
`prReviewComment` and a postable APPROVE carrying the reviewer's own token.

The cheap operational form, for a reviewer or an implementer: **after a green mutation, ask
"what OTHER shape of this same defect would also have been green?" If the answer is not
"none", the proof is not finished.**

## Cost, recorded so the next person can size it

Fourteen zero-context review rounds, ~450 mutations. Findings by round were: two blockers
(rounds 8, 9), two behavioural defects (1, 11), and — in every single round — at least one
protection that pinned nothing or one claim that did not reproduce. **No round was clean.**
Eleven of the fourteen rounds found their principal finding *inside the previous round's
repair*, which is the empirical case for the axis list above: each repair fixed one axis and
exposed the next.
