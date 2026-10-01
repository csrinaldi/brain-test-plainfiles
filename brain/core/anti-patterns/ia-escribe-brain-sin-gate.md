# Anti-Pattern: AI writes to `brain/` without a human gate

**Category:** Agentic governance  
**Risk:** High — contamination of the durable source of truth  
**Related to:** `CONSTITUTION.md §4`, `methodology/consolidation-protocol.md §2`

## The problem

An AI agent that commits directly to `brain/core/**` or `brain/project/**`
can introduce:

- Incorrect or misinterpreted decisions without critical review.
- Anti-patterns that describe local solutions as if they were global rules.
- Domain terms defined from the code, not from the business.
- Methodology rules that reflect the state of one session, not team consensus.

`brain/` is the **durable** source of truth. The cost of an error here is high because
other agents and future sessions will read it as established fact.

## Why it happens

`consolidation-protocol.md §2` (version prior to issue #54) explicitly stated
"the agent must draft and attach an append-only file in brain/anti-patterns/
within the same commit". Without a human gate, the intent to capture knowledge in the
moment becomes a direct contamination vector.

## The rule

**No agent promotes its own artifacts to `brain/`. That signature is human.**

The correct flow:

```
agent drafts artifact
    → openspec/changes/{iid}/brain-drafts/{name}.md
        → human reviews in the MR
            → human moves to brain/ in a commit of their own authorship
```

## Detection

An agent that proposes writing to `brain/` directly must be stopped.
The visible symptom: a commit where the author is an agent and the modified files
are under `brain/`.

`check-refs.mjs` can be added as a future validation if the commit author is exposed.
