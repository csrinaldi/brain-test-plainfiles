#!/usr/bin/env node
// epic-map.mjs — `brain:epic:map` (issue #459).
//
// Read-only reporting, `brain:metrics`' character (M9): zero new gates, nothing it
// emits can block a merge. The one write it performs is bounded by markers in the
// epic's body, and everything outside them is byte-identical afterwards.
//
// SLICE 1 landed dependencies as DECLARED DATA, the graph, the mermaid block and the
// idempotent write. SLICE 2 (#533, ADR-0029) lands the executor half: `assignees` on
// the port's return contract, the provider's NATIVE relations as a second source
// feeding the same builder, and `issueUpdate` — so the map writes itself instead of
// printing a region for someone to paste.
//
// Three things this file is careful about, each recorded where it happens:
//   · `assignees === null` is "brain cannot see", `[]` is "nobody is assigned".
//     Slice 1 could only produce the first and said so in prose.
//   · the two edge sources are UNIONED and their disagreement is REPORTED — see
//     `buildGraph`. Nothing here picks a winner.
//   · nothing is written until `outsideRegion` proves the prose around the markers
//     is byte-identical. `issueUpdate` writes an opaque body and cannot check that.
//
// Usage: npm run brain:epic:map -- <issue-number> [--dry-run] [--no-relations]

import { fileURLToPath } from 'node:url';

import { getVcs } from '../vcs/cli.mjs';
import { originIdentity } from '../vcs/lib/repo.mjs';
import { loadBrainConfig } from '../lib/brain-config.mjs';
import { buildGraph } from './epic-graph.mjs';
import { renderMermaid, renderSummary, replaceMapRegion, outsideRegion } from './epic-render.mjs';

/** @returns {{ok:true,number:number,dryRun:boolean,relations:boolean}|{ok:false,error:string}} */
export function parseArgs(argv = []) {
  let number = null;
  let dryRun = false;
  // Native relations are read BY DEFAULT. A source that ships behind an opt-in flag
  // is a source nobody turns on — green in test, inert in production (#335). The
  // flag exists for its opposite: 2 extra calls per issue is a real cost on a large
  // board, and an operator who wants the cheap run must be able to ask for it.
  let relations = true;
  for (const a of argv) {
    if (a === '--dry-run') dryRun = true;
    else if (a === '--no-relations') relations = false;
    else if (/^\d+$/.test(a)) number = Number(a);
    else return { ok: false, error: `unknown argument: ${a}` };
  }
  if (number == null) return { ok: false, error: 'an issue number is required' };
  return { ok: true, number, dryRun, relations };
}

/**
 * Composes the map region. Exported so a test asserts the SAME text the CLI writes.
 * @param {{nodes:Array,edges:Array,tracks:Map}} graph
 * @returns {string}
 */
export function composeMap(graph) {
  return [
    renderMermaid(graph),
    '',
    renderSummary(graph),
  ].join('\n');
}

/** @returns {Promise<number>} exit code */
export async function main(argv = [], deps = {}) {
  const say = deps.say ?? console.log;
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    say(`✗ ${parsed.error}`);
    say('  Usage: npm run brain:epic:map -- <issue-number> [--dry-run]');
    return 2;
  }

  const config = deps.config ?? loadBrainConfig();
  const { project } = deps.origin ?? originIdentity();
  if (!project) { say('✗ could not resolve the project from the git remote.'); return 2; }

  const vcs = deps.vcs ?? await getVcs({ config });

  let listed;
  try {
    listed = await vcs.issueList({ project, state: 'open' });
  } catch (err) {
    // A partial read would draw a graph missing nodes and say nothing about it —
    // exactly the silence #518 records. Refuse instead.
    say(`✗ could not read the issue list: ${err.message}`);
    return 1;
  }

  // Bodies come one at a time; `issueList` does not carry them.
  const issues = [];
  for (const i of listed) {
    let full;
    try {
      full = await vcs.issueView({ project, number: i.number });
    } catch {
      // Unreadable body ⇒ no declared block, never silently dropped. It lands in the
      // "sin ubicar" count, which is visible in the summary.
      full = { body: '', assignees: null };
    }

    // `relations` is `undefined` when the operator asked for the cheap run, `null`
    // when the read FAILED, and an object when it succeeded. `buildGraph` treats the
    // three differently on purpose, so none of them is flattened here.
    let relations;
    if (parsed.relations && typeof vcs.issueRelations === 'function') {
      relations = await vcs.issueRelations({ project, number: i.number });
    }

    issues.push({
      number: i.number,
      title: i.title,
      labels: i.labels ?? [],
      state: 'open',
      body: full.body ?? '',
      // The list carries assignees on both providers; `issueView` is the fallback
      // for a provider whose list endpoint does not. Only `null` — "the list could
      // not see" — falls through; `[]` is a real answer and stops the chain.
      //
      // (`||` would behave identically here, because `[]` is truthy in JS. An
      // earlier version of this comment claimed `??` was what protected the empty
      // list; a mutation to `||` survived every test, which is how the claim was
      // found wrong. `??` is written for intent, not for a difference it makes.)
      assignees: i.assignees ?? full.assignees ?? null,
      relations,
    });
  }

  const graph = buildGraph(issues);
  const content = composeMap(graph);

  if (parsed.dryRun) {
    say(content);
    return 0;
  }

  let epic;
  try {
    epic = await vcs.issueView({ project, number: parsed.number });
  } catch (err) {
    say(`✗ could not read issue #${parsed.number}: ${err.message}`);
    return 1;
  }

  const before = epic.body ?? '';
  const body = replaceMapRegion(before, content);
  if (body === before) {
    say(`✓ #${parsed.number} already up to date — nothing written.`);
    return 0;
  }

  // THE PRECONDITION FOR HAVING A WRITE VERB AT ALL (#533, ADR-0029 Decision 3).
  // `issueUpdate` replaces a whole body and cannot inspect it; `replaceMapRegion` is
  // marker-bounded by construction, and this is the check that the construction held
  // on THIS body. A composer bug becomes a refusal to write instead of a lost epic.
  if (outsideRegion(body) !== outsideRegion(before)) {
    say(`✗ refusing to write #${parsed.number}: the text outside the map markers would change.`);
    say('  Nothing was written. This is a bug in the map composer, not in the epic.');
    return 1;
  }

  if (typeof vcs.issueUpdate !== 'function') {
    // A provider without the verb prints the region rather than pretending. Both
    // shipped providers implement it (#533); this is what a THIRD one gets before it
    // does, and it degrades to slice 1's behaviour instead of throwing.
    say('! this provider has no issue-body write verb — printing the region instead.');
    say('');
    say(content);
    return 0;
  }

  const res = await vcs.issueUpdate({ project, number: parsed.number, body });
  if (res && res.ok === false) {
    say(`✗ could not write #${parsed.number}: ${res.error}`);
    return 1;
  }
  say(`✓ #${parsed.number} map regenerated over ${graph.nodes.length} issues.`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(code => process.exit(code));
}
