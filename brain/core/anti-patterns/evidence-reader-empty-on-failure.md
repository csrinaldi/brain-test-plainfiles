# Evidence reader returns empty on failure (fail-open in REQUIRED gates)

- **Discovered in:** issue #193 / `providers/github.mjs` `prView()` + `decision-gate`
- **Applies to:** any reader that supplies evidence to a governance gate — VCS
  providers (GitHub, GitLab), CI-context readers, memory readers, and any future
  evidence source consumed by `REQUIRED_JOBS`

## Symptom

A REQUIRED gate passes green without ever having evaluated. In the real case:
`prView()` returned `labels: [], body: ''` on ANY failure (network, auth, proxy,
API error). A failed label fetch made `decision-gate` see "no `decision` label"
and exit 0 — skipping the hard check entirely. The same conflation silently
weakened `diff-size` (`size:exception`), `memory-gate` (`skip:memory-gate`) and
`issue-link` (`Closes #N` parsed from `body`). Nothing in the pipeline looked
red; the gate simply never ran its check.

## Cause

The reader conflates two states that gates must distinguish: **"the value is
genuinely empty"** (`[]` / `''`) and **"the value could not be obtained"**
(uncomputable). Returning an empty default on failure feels safe — no throw, no
crash, callers need no null guards — but for a gate whose trigger condition is
the _presence_ of something (a label, a marker in the body), a fabricated empty
is indistinguishable from a legitimate absence. The failure direction inverts:
the reader's error becomes the gate's approval. This violates ADR-0015's
Never-do ("a REQUIRED gate must never exit 0 without evaluating") one layer
below the gate, where no one is looking.

## Solution / correct pattern

Evidence readers return **value-or-null**: `null` = uncomputable (the fetch
failed), `[]` / `''` = genuinely empty. Consumers apply their class policy on
`null` — REQUIRED gates fail closed ("cannot fetch labels — failing closed"),
and — for a DENY/exclusion-list reader specifically — this rule is not
satisfied by returning `[]` on a config-read failure either; see "Direction
decides whether empty is safe" below (issue #942),
DETECTION gates degrade to warn with a documented reason. Never a stale
fallback (a frozen env var) in place of the live value, for the same reason: it
conflates "current state" with "state at pipeline creation".

```js
// WRONG — reader's failure becomes the gate's approval
catch { return { labels: [], body: '' }; }

// RIGHT — uncomputable is a first-class state the gate must handle
catch { return { labels: null, body: null }; }
```

Being fixed at source in slice A1 (Track A, adapter plan): `prView()` will
return `null` on failure; the seam (`ci-context.mjs`, ADR-0016) specifies the
distinction contractually (REQ-CIC-2/3/5); wrappers of REQUIRED gates fail
closed on `null`. The audit path (`brain-audit.mjs`, `audit-helpers.mjs`) is
migrated off the empty-default in the same slice so the fail-open does not
survive on a parallel path.

## Direction decides whether empty is safe (issue #942)

The rule above is direction-agnostic on its own: it says a REQUIRED gate must
fail closed on `null`, but not which readers are allowed to manufacture
`null` as `[]` in the first place. Issue #942 names the missing half.

- **A reader that supplies a DENY or exclusion list** (an identity a gate
  must refuse, or exclude from a count) MUST propagate a config read/parse
  failure rather than returning `[]`. Empty is the PERMISSIVE answer in that
  direction — it denies/excludes nobody — so a `catch { return []; }` there
  is a fail-open wearing the shape of a safe default.
- **A reader that supplies an ALLOW or exemption list** (an identity a gate
  excuses, or a fallback a gate treats as absent) MAY still degrade to `[]`
  on the same failure. Empty is the RESTRICTIVE answer in that direction —
  it excuses/admits nobody — so the existing `catch { return []; }` pattern
  above stays correct there, unchanged.

| Direction | Empty means | `catch { return []; }` is |
|---|---|---|
| DENY / exclusion list | nobody is denied/excluded | fail-open — WRONG |
| ALLOW / exemption list | nobody is excused/admitted | fail-closed — safe, unchanged |

**Exemption**: a ratified tier default — `governance-tiers.mjs`'s `resolveTier`
falling back to `'standard'` on an absent `governance.tier`, or a
never-throwing tier-resolution helper built specifically to run safely from
inside an already-failed catch block (`resolveTierForFailure`, duplicated
per file rather than shared across gates) — is not a deny/allow reader at
all. It is doctrine choosing one fixed fallback value on purpose, ratified
and reviewed on its own terms (REQ-TIER-10), and this rule does not reopen
it.

Applied at `brain/scripts/vcs/actor-check.mjs`'s `defaultReadDenyActors`,
`brain/scripts/vcs/brain-writes-reviewed.mjs`'s `defaultReadBotAllowlist` and
`defaultReadApprovalActors`, `brain/scripts/approve/cli.mjs`'s
`defaultReadDenyActors` / `defaultReadAgentActors`, and
`brain/scripts/brain-audit.mjs`'s `loadConfig` (feeding `governance.reviewActors`
to the release gate) — six readers that stopped swallowing a config-read
failure (issue #942, R1, R3 for the first five; issue #962 for the sixth).
The ALLOW-direction readers were left unchanged, deliberately, because empty
is already the strict answer for them: `actor-check.mjs`'s `approvalActors`
and `agentActors` readers, and `governance.ignoreList` consumers.
`approved-label.mjs`'s `resolveApprovedLabel` is not one of them:
`governance.approvedLabel` is a single string, not a list, and a config-read
failure degrades to the ratified constant `'status:approved'`
(`approved-label.mjs:19,56-60`) — the same fixed-fallback shape as
`governance-tiers.mjs`'s `resolveTier` (the Exemption paragraph above), not
an empty-list exemption.
