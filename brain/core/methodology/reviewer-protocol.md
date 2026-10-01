# Reviewer Protocol — the cold external reviewer as doctrine

> **status:** current | **last-reviewed:** 2026-08-12 | **owner:** @crinaldi

> **Purpose:** defines the external reviewer as an invocable cold agent instead of a
> human-mediated role. It fixes the one thing that must never be mechanized — the
> merge keystroke — as **structurally impossible for the reviewer to reach**, not as a
> rule the model must remember. Referenced by the reviewer port-verbs ADR (Track H,
> issue #266, phase H0) and by ADR-0015 (the L1–L6 gate ladder this reviewer reads but
> never overrides).

The external reviewer is real and load-bearing today, but human-mediated: a human
relays a checkpoint report to the reviewer and relays the verdict back. The role —
verify against the server, rule design forks against doctrine, sequence parallel work
— is mechanizable. The judgment that must stay human is narrower than the whole role:
it is the **keystroke** (`status:approved`, `override:*`, `size:exception`), never the
verification, the ruling, or the sequencing.

---

## 1. The sacred asymmetry is structural, not remembered

The reviewer becomes a merge authorizer only if it can produce the one thing L6 counts
as *the* human review of a `brain/**` write: a non-author, non-allow-listed review with
`state === 'APPROVED'` (`evaluateBrainWritesReviewed`). That same
review also satisfies `main`'s `required_approving_review_count: 1`
(set by the `branchProtect` verb in `axes/vcs/adapters/github.mjs`). A reviewer running `gh pr review --approve`
would satisfy branch protection **and** the brain-writes gate in one call.

That asymmetry cannot be a rule the agent remembers. If it depends on the model choosing
correctly, a bug, a config regression, or a prompt injection defeats it. It must be
impossible by construction. Three independent locks (§2) make it so.

---

## 2. The three structural locks against reviewer-as-authorizer

Three independent locks. **Any one holds if the other two fail.** Removing any one leaves
the other two standing.

> **Citations here name symbols, never line numbers.** An earlier revision of this section
> cited a source line number in `brain-writes-reviewed.mjs` for lock 1; within one release
> cycle that line had become an unrelated JSDoc block while the mechanism moved elsewhere. A doctrine that points at a
> moving target sends its own verifier to the wrong text (#580).

**Lock 1 — COMMENT-state verdicts.** Every verdict posts as a COMMENT-state review. L6's
approver set is built only from `reviews.filter(r => r.state === 'APPROVED')`, inside
`evaluateBrainWritesReviewed` (`brain-writes-reviewed.mjs`); a `COMMENTED` review contributes
nothing to it. A verdict cannot be miscounted as an approval **by construction of the
counter**, not by a rule the reviewer follows.

**Lock 2 — no approve capability in the adapter.** The verb that posts a verdict,
`prReviewComment`, has no APPROVE sibling verb, no APPROVE argument, and no branch that
selects one. Even a fully compromised reviewer process has no code path to an APPROVE review.

The lock holds on **both providers, by two different mechanisms** — worth stating separately,
because describing it as one mechanism gets it wrong for one of them:

| provider | mechanism |
|---|---|
| GitHub | `event: 'COMMENT'` is hardcoded at every call site in `axes/vcs/adapters/github.mjs` — the initial post (inline and plain) and the retry alike. No call constructs any other event. |
| GitLab | **stronger** — GitLab's notes API has no review-event concept at all (`axes/vcs/adapters/gitlab.mjs`). A plain note is posted, and there is no APPROVE state for it to reach (REQ-266-3). |

**Lock 3 — one key, one meaning, enforced at two gates.** The reviewer handle registers in
`governance.reviewActors`, whose sole meaning is **"this identity is not a human approver."**
That single meaning is enforced in two places, and the two never disagree because there is
only one thing to agree about:

- **L5 — as denial.** A `brain-decision/1` authored by such an identity is refused
  (`evaluateSignedDecision`), and a `status:approved` label applied by one is refused
  (`evaluateActor`); the key is read by `defaultReadDenyActors`.
- **L6 — as exclusion.** Such an identity does not count toward the human-approver tally
  (`evaluateBrainWritesReviewed`), reading the key through `defaultReadBotAllowlist`.

`governance.approvalActors` is a **separate key with a separate meaning**: a *human-trust
grant*. It is read at **both** gates and cashed as **three** grants — at L5 it authorizes
applying `status:approved` **and** whitelists which `override:*` labels are honored; at L6 it
whitelists `override:*` there too.

Its readers are named in a way that will mislead anyone grepping, so the table is the citation:

| file | function | key it actually reads |
|---|---|---|
| `actor-check.mjs` | `defaultReadBotAllowlist` | **`approvalActors`** |
| `brain-writes-reviewed.mjs` | `defaultReadBotAllowlist` | **`reviewActors`** |
| `brain-writes-reviewed.mjs` | `defaultReadApprovalActors` | **`approvalActors`** |

**One function name, two different keys, depending on which file you are in.** That is the
single most confusing thing in this subsystem and it is not a defect — the two `botAllowlist`s
answer different questions — but a reader who greps one name and assumes the other file matches
will get the split exactly backwards.

What L6 does **not** do is read `approvalActors` as **its** `botAllowlist`. That reader takes
`reviewActors` alone — unioning the two there is the dual-semantics coupling ADR-0020's R2
exists to dissolve, because it would make one registration both exclude an identity from the
human count and authorize it to apply the label.

The authority for `approvalActors` being read at two gates is **not** R2, which says the
opposite in ADR-0020's own text (*"Read only by L5"*, *"No key feeds two gates"*). It is the
**H0-b rev-1 ruling P272-OVERRIDE-KEY**: `override:*` and `status:approved` are both
human-trust grants keyed on `approvalActors`, and the reviewer handle is in neither. The code
records the same thing in the same terms — it calls R2 *knowingly excepted* here, not
satisfied.

**The reviewer handle is in neither key.** Both effects require both registrations, explicitly,
never implicitly.

> An earlier revision of this paragraph (#580) said `approvalActors` was *"read only at L5."*
> That was false — L6's `defaultReadApprovalActors` reads it for the override whitelist — and it
> was signed in that state. Corrected by #586. The claim it was reaching for survives and is
> stated above: what is L5-only is the **authority to apply the label**, not the key.

> **What R2 forbids, precisely.** R2 forbids **one key carrying two meanings**, not two gates
> reading the same fact. Denial at L5 and exclusion at L6 are one fact — *not a human
> approver* — applied where each gate needs it.
>
> That distinction was not academic. Until #581, `reviewActors` also bought a commit an
> exemption from re-arming an approval at `lite` (ADR-0026 Amendment 1) — a **second**
> meaning, and the only one that loosened rather than tightened. On the maintainer's ruling
> that the identity is read-only, Amendment 5 removed it: a read-only identity has no commits
> to exempt, and the exemption could only ever have fired in the off-nominal case it should
> have been catching.

> Lock 1 defends against a config regression that mis-registers the reviewer. Lock 2
> against a bug that posts the wrong event. Lock 3 against the dual-semantics coupling.
> The locks fail independently, so a single fault never opens the merge path.

---

## 3. The two-key split and the hazard it dissolves

### The hazard — verified in the tree, not inferred

> **Only half of this is still current (#586).** The L5 half below describes behaviour that
> holds today; the L6 half is the **pre-split** state, which is what motivated the split and is
> no longer true — `defaultReadBotAllowlist` reads `reviewActors` alone (§2). The tenses differ
> deliberately. Kept because a resolution whose hazard is not written down reads as an arbitrary
> two-key complication, and the next person tempted to simplify it needs to know what it cost.

`governance.approvalActors` was read as the `botAllowlist` by **both** gates, with **opposite
semantics**:

- **L5 — permissive. Still true today.** `actor-check.mjs` reads `governance.approvalActors`
  through `defaultReadBotAllowlist` (which in THIS file reads `approvalActors` — see §2's
  table) into `botAllowlist`; when the approving actor is in it,
  `evaluateActor` returns `{ level: 'pass', reason: 'the approved label was applied by
  allow-listed automation identity "…" ' }`. Being in the list **authorizes** you to apply
  `status:approved`.
- **L6 — restrictive. NO LONGER TRUE — this is the pre-split state.**
  `brain-writes-reviewed.mjs` read the same `governance.approvalActors` into `botAllowlist`; the
  human approver was `approvers.find(a => a !== author && !botAllowlist.includes(a))`
  (`evaluateBrainWritesReviewed`). Being in the list **excluded** you from counting as the human
  reviewer. Today that reader takes `reviewActors`.

One key, two opposite effects. A single registration of the reviewer in
`governance.approvalActors` would simultaneously **de-authorize it at L6** (correct — we
want that) **and authorize it to self-apply `status:approved` at L5** (catastrophic — that
is the merge keystroke). You cannot satisfy both requirements with one registration; they
pull the same key in opposite directions.

### The resolution — split the key

L6 reads a **new** `governance.reviewActors`. The reviewer registers there and **never** in
`governance.approvalActors`. The coupling is dissolved by construction:

| Gate | Key it reads | Reviewer in it? | Effect on the reviewer |
|---|---|---|---|
| L5 `actor-check.mjs` | `governance.approvalActors` | **No** | Not admitted by the allow-listed branch → cannot self-approve |
| L6 `brain-writes-reviewed.mjs` | `governance.reviewActors` (new) | **Yes** | Excluded from the human-approver count → verdict never counts as review |

Two mandatory tests make this executable and ship with the implementation slice (H0-b):
`t1` — the reviewer identity does NOT pass `actor-check` when applying `status:approved`;
`t2` — the reviewer identity IS excluded from the L6 human-approver count.

> **Live-tree note.** `governance.approvalActors` is **not currently populated** in this
> repo's `brain.config.json`; `governance` there carries `auditBaseline`, `tier`,
> `ignoreList`, `reviewActors` and `agentActors`. Both gates read `approvalActors`
> defensively and default to `[]` when absent, so nothing depends on it being set. The split
> holds because `reviewActors` is a distinct key that L6's `botAllowlist` reads alone — **not**
> because `approvalActors` is L5-only, which it is not (§2). Do not assume `approvalActors` is
> set, and do not read its absence as the split being unfinished.

---

## 4. The four COMMENT-only port verbs

`brain`'s VCS port is `VERBS` in `brain/scripts/vcs/cli.mjs`. It had 16 verbs when this section
was written, **none of which wrote to the review/comment/label surface**; H0 added the four
below and `VERBS` now carries 26. They are shipped, on both providers
(`brain/scripts/axes/vcs/adapters/{github,gitlab}.mjs`), each incapable of approving. Normalized
returns match the port's existing `{ url } | { url: null, error }` / never-throws discipline
(`brain/core/methodology/vcs-contract.md`).

| Verb | Signature | Note |
|---|---|---|
| `prReviewComment` | `({ project, number, body })` | no APPROVE path exists in code (lock 2), by a different mechanism per provider — GitHub hardcodes `event: 'COMMENT'` at every call site; GitLab's notes API has no review-event concept at all. See §2 lock 2 |
| `issueComment` | `({ project, number, body })` | rulings on issues |
| `labelAdd` | `({ project, number, labels })` | **caller** enforces the deny-set (§9), not the verb |
| `labelRemove` | `({ project, number, labels })` | monotonic-tightening removals only |

The four names are added to `VERBS` (`cli.mjs`) and to the `vcs-contract.md` required-verbs
table. The parameterized contract suite (`axes/vcs/contract.test.mjs`) runs one assertion
set over `['github', 'gitlab']` and turns red until both providers implement all four with the
normalized shapes.

**Adding verbs to the port is itself a decision** → `decision` label + ADR, by this protocol's
own rule. No exception for the reviewer's own verbs.

---

## 5. Applies doctrine, never creates it

The reviewer is an **applier** of doctrine, never an author of it. On a fork it MUST:

1. Enumerate the constraining authorities — every ADR, REQ, durable-record id, or gate name
   that bears on the fork.
2. Eliminate each option that doctrine excludes, **citing the authority that excludes it**.
3. Rule **only if exactly one option survives**.
4. If ≥2 options survive, the choice is a new decision, not a ruling → emit `STOP` +
   `escalate: human` ("this is an ADR, not a ruling").

This is the lock against doctrine drift: a reviewer that could invent a rule could invent the
rule that authorizes a merge. New doctrine is reachable only through `STOP` + escalate, where a
human writes it.

---

## 6. The verdict schema — `brain-review/1` and `brain-review/2`

Every verdict is a fenced YAML block in the review body. Two schema versions exist,
`brain-review/1` and `brain-review/2`; both are defined in this section because a reviewer
parsing a verdict thread must handle either one interchangeably (`parse-verdict.mjs` accepts
both in the same guarded union — see "Compatibility" below). **Current activation status
(#743 ruling, 2026-08-20):** brain produces **`brain-review/2` and only `/2`**, at every tier.
`resolveReviewProtocol(config)` returns `PRODUCED_PROTOCOL` unless `reviewer.protocol` names
something else, and it no longer reads the tier at all.

> *"The tiers do not define the review system. The judgment half is an on/off capability, and
> the protocol is always `brain-review/2`."*

The tiered default this section used to describe — `lite`/`standard` → `/1`, `regulated` → `/2`,
specified in `openspec/changes/issue-391-t23-review-package-spec/design.md` (Q5, #358) and wired
by #394 M3 — is **retired**. A schema version is not ceremony, and ADR-0026 invariant 7 reserves
position tiering for ceremony alone; the cost of the drift was measured in #743 and paid at
`standard`, where the tier asked for the judgment half and the protocol it also chose refused it.

`/1` remains fully readable — see "Compatibility" — and an explicit `reviewer.protocol:
'brain-review/1'` is still honoured: the ruling retired `/1` as a DEFAULT, and reading it as
forbidding an operator's explicit choice would be this protocol inventing doctrine (§5).

Findings are additionally routed
through `brain/scripts/review/lib/causal-admission.mjs` before `buildVerdict`: every finding from
the deterministic evaluators (tranche/checkpoint/ruling — none of which perform LLM inference) is
annotated `evidence_class: deterministic` / `causal_disposition: introduced` unless it already
carries its own classification, and the lazy refuter (`evaluators/refuter.mjs`, issue #284,
REQ-H2-1) runs over any `evidence_class: inferential` blocker before the verdict is built — a
no-op today since no evaluator yet produces an inferential finding, but a real, wired call, not
dead code.

### 6.1 `brain-review/1` — the base schema

```yaml
protocol: brain-review/1
verdict: APPROVE | REVISE | STOP
head_sha: <mandatory — the staleness anchor>
rev: <n>
gates:
  required: [ ... ]        # from the server's statusCheckRollup, re-derived cold
  detection: [ ... ]       # detection-level warns quoted verbatim
findings:
  - id: <id>
    severity: blocker | correction | editorial
    evidence: "<a command the reviewer actually ran cold>"   # MANDATORY — no evidence ⇒ inadmissible
    cites: "<ADR / REQ / record id / gate>"                  # MANDATORY iff severity: blocker
conditions: [ ... ]
controls: [ ... ]              # which CLASSES of control ran — always emitted, `[]` included
controls_not_applied: [ ... ]  # the complement, DERIVED from the same closed vocabulary
pin: { ... }               # optional — the durable-record payload (§8)
sequencing: { ... }        # optional — seq:* / reviewed:* only, never status:*
escalate: human | null
```

- **`evidence:` is mandatory on every finding.** A finding without a command the reviewer ran
  cold is inadmissible — the reviewer never trusts the implementer's report, it re-derives.
  Inadmissible findings are dropped, and the drop is **counted into `conditions:`** (issue #483):
  the rule stands, but "no findings" and "findings discarded" must never look identical to the
  reader. For the same reason the REVISE-to-APPROVE softening below is measured against the
  findings that survived this gate, not against the raw input — otherwise a verdict whose every
  finding was dropped unread would soften to APPROVE.
- **`cites:` is mandatory for `severity: blocker`.** An uncited blocker is downgraded to
  `correction`. A blocker is an assertion that doctrine forbids something; without the citation,
  the reviewer is inventing doctrine, which §5 forbids.
- **`head_sha` is mandatory.** It binds the verdict to the exact tree the reviewer read (§8) and
  expires with it.
- **`controls:` and `controls_not_applied:` are always emitted, `[]` included** (issues #683,
  #690). `controls:` names the classes of control that actually ran. It is never omitted when
  empty: an absent key is the silence this field exists to break, while `controls: []` reads as
  "nothing declared that it ran" — loud, and true. `controls_not_applied:` is its complement,
  **derived** from the same closed vocabulary rather than maintained by hand, because a second
  list drifts from the first the day either changes. Together they stop "the control ran and
  found nothing" from rendering identically to "that control never ran".

### 6.2 `brain-review/2` — causal admission

`brain-review/2` (`brain/scripts/review/lib/schema-v2.mjs`, `verdict.mjs`) is `/1` plus two
per-finding fields and two thread-level ones, all optional in the sense that a `/1` verdict
simply omits them:

```yaml
findings:
  - id: <id>
    severity: blocker | correction | editorial
    evidence: "<a command the reviewer actually ran cold>"
    cites: "<ADR / REQ / record id / gate>"
    evidence_class: deterministic | inferential | insufficient
    causal_disposition: introduced | behavior-activated | worsened | pre-existing | base-only | unknown
    schema_invalid: "<why the causal claim above could not be read>"   # present only when it could not
follow_ups:                # present only when non-empty
  - id: <id>
    severity: blocker | correction | editorial
    evidence: "<a command the reviewer actually ran cold>"
    evidence_class: deterministic | inferential | insufficient
    causal_disposition: pre-existing | base-only
challenger_axis: human | same-model | cross-family | mechanical   # only when a reasoned finding exists
```

- **`evidence_class`** states how directly the finding was established: `deterministic` (a
  command's output proves it), `inferential` (reasoned from evidence, not directly observed),
  or `insufficient` (the reviewer could not establish it cleanly).
- **`causal_disposition`** states whether the finding is this change's doing:
  `introduced` (new in this diff), `behavior-activated` (pre-existing code, newly reachable/
  triggered by this diff), `worsened` (pre-existing, made worse), `pre-existing` (unrelated to
  this diff), `base-only` (exists only on the base, not touched by this diff), or `unknown`.
- **The admission rule.** A finding with `causal_disposition: pre-existing` or `base-only` is
  **not** a blocker against this change — it is routed to `follow_ups[]` instead
  (`buildVerdict`'s routing loop). Only `introduced`/`behavior-activated`/`worsened`/`unknown` findings
  remain in `findings[]` and can block.
- **`causal_disposition: unknown` forces escalation.** Any finding whose causality could not be
  determined forces `verdict: STOP` and `escalate: human` regardless of the evaluator's
  conclusion (`buildVerdict`) — uncertainty about causality is never silently
  admitted (treated as blocking without being sure) or silently dropped (routed to
  `follow_ups[]` without being sure it's safe to defer).
- **The schema gate — an unreadable causal claim is annotated, never resolved** (issue #483).
  `validateSchemaV2` runs inside `buildVerdict` before any routing decision is made. A finding
  whose `evidence_class` or `causal_disposition` carries a value outside the allowed set is
  **not** dropped and **not** silently reclassified: it keeps its place in `findings[]`, gains a
  `schema_invalid:` line naming what failed, and forces `verdict: STOP` + `escalate: human` on
  the same grounds as `unknown` — a disposition the validator cannot read *is* causality that
  could not be determined. The gate fires on a claim that **fails**, never on one that was never
  made: a finding carrying neither field (every `/1` finding) is untouched.
- **REVISE-to-APPROVE softening reads the shape AND the cause (issue #750).** If every
  finding that exists was routed out of the blocking set (all `pre-existing`/`base-only`)
  and the evaluator's conclusion was `REVISE`, the verdict becomes `APPROVE` (`buildVerdict`)
  — but only if the evaluator also declared `conclusionCauses` non-empty and every entry
  `'blocker'`. A `REVISE` that any uncomputable evidence contributed to is never softened —
  §10's rule ("never `APPROVE` on uncomputable evidence") restated for the mechanism that
  decides softening, not only for the evaluators that produce the evidence. An evaluator
  that declares no cause at all is not softened either: silence fails closed by
  construction (`conclusionCauses` defaults to `[]`, and `[].every(...)` would otherwise be
  vacuously true), not by luck. **This guarantee's boundary**: the evaluator's declared cause
  is authoritative and `buildVerdict` does not cross-check it against `conditions[]` strings
  — that string-matching mechanism is the one issue #750's ruling rejected — so "never
  `APPROVE` on uncomputable evidence" holds for every evaluator-produced verdict, but a direct
  `buildVerdict` caller that declares `conclusionCauses: ['blocker']` beside an uncomputable
  `conditions[]` entry has misdeclared its own cause, and no code here catches that.
- **`challenger_axis` names the axis that challenged the reasoned findings** (issue #682,
  REQ-682-3), and it renders **only when some finding carries `evidence_class: inferential`** —
  #690's rule one field over: a key that fires on every verdict turns its own channel into
  wallpaper, and an axis that challenged nothing is not evidence about this verdict. Without it,
  a verdict challenged by the same model and one challenged by a different family render
  byte-identically: two evidentiary strengths, one rendering, chosen by a configuration option.
- **Rendering.** `evidence_class` and `causal_disposition` are rendered per-finding when
  present, `challenger_axis` when a reasoned finding exists, and a `follow_ups:` block when
  non-empty (`renderVerdict`); a `/1` verdict simply never has these keys.

### Compatibility — both protocols coexist by construction

`parse-verdict.mjs` accepts either protocol string in the same guard
(`proto !== 'brain-review/1' && proto !== 'brain-review/2' → return null`) and only attaches
`protocol`/`findings`-with-causal-fields when they parse — a `/1` block never populates those
keys. `cold-boot.mjs`'s `priorVerdicts` load, the anti-loop lock, and the `rev >= 3` bound all
read `head_sha`/`rev`/`verdict` unconditionally, before any protocol-specific branch — so a
verdict thread mixing `/1` and `/2` posts loads correctly on both sides. No parser change is
required to support either protocol.

This matters more after the #743 ruling, not less: every verdict posted before it is a `/1`
block, and `cold-boot.mjs` reads that history to compute `rev` and to hold the anti-loop lock.
Retiring `/1` from the READER would rewrite the past to simplify the present. It is retired as
an output; it is not retired as an input, and the mixed thread is now the ordinary case on any
PR that predates the ruling rather than the tier-change edge case this paragraph used to cite.

---

## 7. Bounded revision — `rev >= 3` forces STOP

At `rev >= 3` the reviewer is **forbidden** from issuing a fourth REVISE. It MUST emit `STOP` +
`escalate: human` instead. Three REVISE rounds that fail to converge is evidence the fork needs a
human decision, not a fourth machine opinion. No infinite revise loop is possible by construction.

---

## 8. Cold boot — verify against the server, from a clean tree

The reviewer runs in its **own** clone/worktree, checked out **detached at the `headRefOid`
returned by the API** — never a branch name (a moving pointer the implementer controls), never a
sha quoted in a report (the report is the thing under review). If head moved mid-run, the verdict
is not posted; the run is `reviewed:stale`.

Doctrine loads from two durable, server-side sources, neither authored to persuade a reviewer:

1. `.memory/records/*.jsonl` filtered to `type: decision | architecture`;
2. every prior `brain-review/1` block on the thread.

**The memory trade (the paid cost of coldness).** A cold agent has none of the human reviewer's
accumulated conversational context — it does not remember the ruling made three checkpoints ago.
The trade: every REVISE or ruling that establishes doctrine emits a `pin:` payload, and the
implementer commits it as a `.memory/records/` record (`type: decision`, `issue`,
`source: "CP-X verdict"`). The reviewer never writes to the repo — the asymmetry holds — but its
memory does, and cold boot reads it back.

**Rejected boot inputs.** `resume.md` hydration is rejected: it is the implementer's working-memory
artifact, and reading it imports the implementer's own assumptions and documented compromises — the
exact contamination the external reviewer exists to avoid (`resume.md` is operational,
freely-discardable, and never a gate condition per `sdd-layout.md`). Branch-name anchoring
(`git pull origin feat/...`) is rejected: it violates verify-against-the-server, because a branch
name advances between the fetch and the verdict. The anchor is always the API's `headRefOid`,
checked out detached.

---

## 9. Monotonic label tightening + the hardcoded deny-set

The reviewer may apply labels that make a gate **stricter** (`decision`, `seq:*`, `reviewed:*`,
`needs-ruling`) and MUST NEVER apply labels that **loosen** (`size:exception`, `skip:memory-gate`)
or **unlock** (`status:approved`). Labels only ever tighten; a reviewer never bends a gate open.

**The deny-set is hardcoded in the caller**, not left to the model to remember. `status:approved`
is human-only.

**Defense in depth.** `actor-check` independently rejects a misapplied `status:approved` from any
identity not in `governance.approvalActors` (`evaluateActor`) — and the reviewer is never in
`governance.approvalActors` (§3) — so even a deny-set bug is still caught at L5. The actor-check is
the independent backstop; the deny-set is the first line.

**Sequencing = verdicts are truth, labels are the derived index** — the same inversion the memory
format teaches (records are truth, `index.jsonl` is regenerable — `memory-format.md`). Sequencing
lives in `seq:*` / `reviewed:*`; a label desync is a rebuildable no-op, reconstructed from the
verdict comments. `status:*` stays human-only, and the deny-set enforces it — the rejected `status:*`
sequencing namespace would have put one typo between the reviewer and self-approving an issue.

---

## 10. Failure modes

| Failure | Lock |
|---|---|
| **False APPROVE** (trusting the implementer's report) | every finding carries `evidence:` = a command the reviewer ran cold; budget/tests/diffstat re-derived, never read from the report; report-vs-tree drift is itself a blocker |
| **Reviewer becomes merge authorizer** | the three structural locks §2 (COMMENT-state, no approve verb, key separation) |
| **Stale verdict** | verdict bound to `head_sha`; not posted if head moved mid-run; `reviewed:stale` |
| **REVISE loop** | `rev >= 3` → forced `STOP` + `escalate: human` (§7) |
| **Comment loop** (the reviewer's own comment retriggers a run) | skip if the last `brain-review/1` block on the thread is this reviewer's **and** its `head_sha` equals the current head (actor lock + sha lock, both) |
| **Reviewer collision** (two runs on one PR) | per-PR concurrency mutex (prevention, H2) + verdicts keyed by `(pr, head_sha, reviewer)` (detection) |
| **Uncomputable evidence** (`gh` down) | never APPROVE on uncomputable evidence — emit REVISE with `conditions: [evidence uncomputable]`; fail-closed, mirroring `run-check.mjs` |
| **Doctrine drift** (reviewer invents a rule) | `blocker` requires `cites:`; new doctrine only via `STOP` + escalate (§5) |
| **Self-review** | a reviewer whose handle equals the PR author MUST abstain — the same rule `actor-check` enforces at L5 |
| **Board lies** (labels desync from verdicts) | labels are the derived index; `brain:review:board` rebuilds them from the verdict comments (§9) |

---

## 11. The reviewer handle — mechanism now, identity later

This protocol specified the `governance.reviewActors` **mechanism** before any concrete handle
existed. **The identity has since been minted**: `brain.config.json` carries
`reviewer: { handle: "csrinaldibot", tokenEnv: "BRAIN_REVIEWER_TOKEN", protocol: "brain-review/2" }`
and registers `csrinaldibot` in `governance.reviewActors`. It has posted verdicts. What follows
is therefore a live arrangement, not a plan.

It is registered in `governance.reviewActors` — the key L6's `botAllowlist` reads — and **never**
in `governance.approvalActors`. Note that `approvalActors` is not "the L5-only key": both gates
read it (§2). What makes the split hold is that `reviewActors` is the *only* thing L6's
`botAllowlist` takes, and the reviewer handle is absent from `approvalActors` entirely. **Do not register any reviewer handle in `governance.approvalActors` — ever.** That single
line is the dual-semantics hazard §3 exists to close.

---

## 12. The honest cost

What is lost versus the human-mediated reviewer: **accumulated conversational context** — the human
remembers the ruling made three checkpoints ago and that this fork was already litigated. Paid for
by the mandatory `pin:` → `.memory/records/` mechanism (§8).

Not recoverable, and honestly so: the human's **taste** — knowing when a rule should bend. The agent
never bends. Bending is `size:exception` / `override:*` / `status:approved`, all human-only
keystrokes. **A reviewer that cannot bend is exactly the reviewer you can automate.**

---

## 13. Subagent Executor Doctrine — invocation via canonical entrypoints

When an agent platform or orchestrator launches a subagent in the reviewer role, the subagent
**MUST NOT** be given ad-hoc manual execution prompts (such as manual diff reading or ad-hoc `gh pr comment` calls).

The subagent is strictly a **command executor** of the deterministic VCS review entrypoint:

```bash
npm run brain:review -- --pr <id>
# or for issue rulings:
npm run brain:review -- --issue <id> --mode ruling
```

### Why this is load-bearing:
1. **Zero Prompt Drift**: Guarantees that the subagent invokes `cli.mjs`, wiring `identity` → `cold-boot` → `mode` → `evaluators` → `verdict` → `poster` deterministically.
2. **Standardized Protocol Compliance**: Enforces that all review output strictly produces a fenced `brain-review/2` block, with full causal admission, at every tier (#743 ruling — see §6). `brain-review/1` stays readable and is honoured when a config names it explicitly, but nothing produces it by default.
3. **Token Minimization**: Leverages the $0-token deterministic pre-checks in `cli.mjs` before executing any LLM evaluation.

---

## References

- Reviewer port-verbs + two-key-split ADR (`brain-drafts/adr-reviewer-port-verbs-and-two-key-split.md`).
- Issue #266 (Track H design, rev-2 APPROVE — comment 4986616224); finding `H0-LOCK3-DUAL`
  (comment 4974795208); human decision (comment 4975121847).
- L5 gate: `brain/scripts/vcs/actor-check.mjs` (`evaluateActor`).
- L6 gate: `brain/scripts/vcs/brain-writes-reviewed.mjs` (`evaluateBrainWritesReviewed`).
- Port + verb contract: `brain/scripts/vcs/cli.mjs` (`VERBS`), `brain/core/methodology/vcs-contract.md`.
- Governance keys: `brain.config.json` (`governance.*`).
- Gate ladder: ADR-0015 (L1–L6 fail-closed evidence ladder).
- Durable-record format: `brain/core/methodology/memory-format.md`.
