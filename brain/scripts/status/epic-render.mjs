// epic-render.mjs — the graph as a mermaid block, and the marker-bounded body write
// (issue #459).
//
// Mermaid because it renders NATIVELY in issue bodies on both GitHub and GitLab — no
// external hosting, no image to regenerate, no provider lock (ADR-0008 parity). The
// rich hand-authored diagram stays a deluxe manual artifact; the embedded,
// self-updating form is mermaid.

export const BEGIN = '<!-- brain:epic:map BEGIN -->';
export const END = '<!-- brain:epic:map END -->';

const ESC = /["<>[\]{}()|]/g;

/** Mermaid labels are not HTML-escaped by the renderer, and a `|` or `[` in a title
 *  breaks the node syntax rather than merely looking wrong. Titles are user text, so
 *  they are sanitised on the way in — never trusted because "our titles are fine". */
function label(s) {
  return String(s).replace(ESC, ' ').replace(/\s+/g, ' ').trim().slice(0, 72);
}

/**
 * The executor, as a node suffix (#533 slice 2).
 *
 * THREE OUTCOMES, never two. `null` is "brain cannot see the assignment" and prints
 * nothing at all; `[]` is "read, and nobody is assigned" and prints `· sin asignar`;
 * a non-empty list prints the names. Slice 1 could only ever produce the first, and
 * said so in prose because printing `sin asignar` for it would have been a claim the
 * port could not back.
 *
 * Names are `label()`ed for the same reason titles are: they land inside a mermaid
 * node and a `|` or `[` there breaks the syntax rather than merely looking wrong.
 */
function who(n) {
  const a = n?.assignees;
  if (a === null || a === undefined) return '';
  if (a.length === 0) return ' · sin asignar';
  return ` · ${a.map(x => label(x)).join(', ')}`;
}

/**
 * Renders the graph. Deterministic: nodes sorted by number, edges by endpoints, so
 * two runs over unchanged server state produce byte-identical output — which is what
 * makes the body write idempotent rather than merely usually-idempotent.
 *
 * @param {{nodes:Array,edges:Array}} graph
 * @returns {string}
 */
export function renderMermaid({ nodes = [], edges = [] } = {}) {
  const shown = [...nodes].sort((a, b) => a.number - b.number);
  const lines = ['```mermaid', 'graph LR'];

  for (const n of shown) {
    lines.push(`  N${n.number}["#${n.number} ${label(n.title)}${who(n)}"]`);
  }
  for (const e of [...edges].sort((a, b) => a.from - b.from || a.to - b.to)) {
    // An edge to a node outside the set is kept and drawn to a stub: dropping it
    // would make the map claim there is no dependency, which is a stronger and
    // falser statement than "there is one, and it is out of scope here".
    if (!shown.some(n => n.number === e.to)) lines.push(`  N${e.to}["#${e.to} (fuera del alcance)"]`);
    lines.push(`  N${e.from} --> N${e.to}`);
  }

  const cls = { ready: [], blocked: [], 'awaiting-human': [], unclassified: [] };
  for (const n of shown) cls[n.status]?.push(`N${n.number}`);
  lines.push('  classDef ready fill:#DEF7E5,stroke:#216E43,color:#0B2E1C;');
  lines.push('  classDef blocked fill:#F6E2DF,stroke:#A33227,color:#3A100C;');
  lines.push('  classDef human fill:#FBF0D9,stroke:#8F6410,color:#3A2A05;');
  lines.push('  classDef unknown fill:#ECEEF0,stroke:#7A828A,color:#242A2F;');
  if (cls.ready.length) lines.push(`  class ${cls.ready.join(',')} ready;`);
  if (cls.blocked.length) lines.push(`  class ${cls.blocked.join(',')} blocked;`);
  if (cls['awaiting-human'].length) lines.push(`  class ${cls['awaiting-human'].join(',')} human;`);
  if (cls.unclassified.length) lines.push(`  class ${cls.unclassified.join(',')} unknown;`);

  lines.push('```');
  return lines.join('\n');
}

/**
 * Renders the reading the hand-made map proved valuable: what is startable now, what
 * is blocked on what, and what waits on a human rather than on code.
 *
 * `unclassified` is reported with its count and never hidden. A map that silently
 * omits what it could not read is a map that overstates its own coverage.
 */
export function renderSummary({
  nodes = [], tracks = new Map(),
  divergences = [], declarationDivergences = [], relationsUnreadable = [], blocksUnreadable = [], foreignRelations = 0,
} = {}) {
  const by = (s) => nodes.filter(n => n.status === s).sort((a, b) => a.number - b.number);
  const ref = (ns) => (ns.length ? ns.map(n => `#${n.number}`).join(' ') : '—');
  const ready = by('ready');
  const exec = (n) => (n.assignees === null || n.assignees === undefined
    ? `#${n.number} (?)`
    : n.assignees.length === 0 ? `#${n.number} (sin asignar)` : `#${n.number} → ${n.assignees.join(', ')}`);
  const lines = [
    `**Listos ahora:** ${ready.length ? ready.map(exec).join(' · ') : '—'}`,
    `**Bloqueados:** ${by('blocked').map(n => `#${n.number} ← ${n.blockedBy.map(b => `#${b}`).join(' ')}`).join(' · ') || '—'}`,
    `**Esperando firma humana:** ${ref(by('awaiting-human'))}`,
  ];
  const un = by('unclassified');
  if (un.length) {
    lines.push(`**Sin ubicar** (${un.length}) — ninguna fuente los coloca (ni bloque \`brain-graph/1\` ni relación nativa): ${ref(un)}`);
  }
  const conflicts = ready.filter(n => (n.conflictsWith ?? []).length > 0);
  if (conflicts.length) {
    lines.push(`**No paralelizables entre sí** (reclaman los mismos archivos): ${conflicts.map(n => `#${n.number}↔${n.conflictsWith.map(c => `#${c}`).join(',')}`).join(' · ')}`);
  }
  // A ready node with no `files` produces an empty `conflictsWith`, which reads as
  // "proven parallelisable". It was proven nothing. Say so (#533).
  const unknownFiles = ready.filter(n => n.filesUnknown);
  if (unknownFiles.length) {
    lines.push(`**Paralelización no verificable** (no declaran \`files\`, así que «sin conflicto» no está probado): ${ref(unknownFiles)}`);
  }
  // The union of the two edge sources is only honest reported (#533, ADR-0029).
  if (divergences.length) {
    const fmt = (d) => `#${d.from}→#${d.to} (sólo ${d.only === 'declared' ? 'declarado' : 'nativo'})`;
    lines.push(`**Las dos fuentes no coinciden** (${divergences.length}) — se toma la unión y se reporta la diferencia, ninguna pisa a la otra: ${divergences.map(fmt).join(' · ')}`);
  }
  // #967: lo que cada cuerpo declaró y no se pudo honrar. El valor ofensivo se cita
  // tal como se escribió y la razón es el token del lector, no una glosa: un valor
  // malformado se DICE, no se repara ni se descarta en silencio.
  if (declarationDivergences.length) {
    const fmt = (d) => `#${d.number} \`${d.key}\`=«${d.value}» (${d.reason})`;
    lines.push(`**Declaraciones \`brain-graph/1\` no honradas** (${declarationDivergences.length}): ${declarationDivergences.map(fmt).join(' · ')} — se declararon y se dicen; ninguna se repara ni se descarta en silencio.`);
  }
  if (relationsUnreadable.length) {
    lines.push(`**Relaciones nativas ilegibles** en ${relationsUnreadable.length}: ${relationsUnreadable.map(n => `#${n}`).join(' ')} — no es «no tienen», es «no se pudieron leer».`);
  }
  // Same distinction on the declared side (#639): un bloque que no se pudo leer no
  // es un issue que no declaró nada, y sin esta línea los dos terminan juntos en
  // «Sin ubicar», indistinguibles.
  if (blocksUnreadable.length) {
    lines.push(`**Bloques \`brain-graph/1\` ilegibles** en ${blocksUnreadable.length}: ${blocksUnreadable.map(b => `#${b.number} (${b.error})`).join(' · ')} — declararon un bloque que no se pudo leer, no es «no declararon».`);
  }
  if (foreignRelations > 0) {
    lines.push(`**Relaciones cross-repo omitidas:** ${foreignRelations}. Los números son por repositorio, así que dibujarlas afirmaría una arista contra el \`#N\` de ESTE repo.`);
  }
  lines.push('', `_Regenerado por \`brain:epic:map\` sobre ${nodes.length} issues y ${tracks.size} tracks. No editar a mano: la próxima corrida lo pisa._`);
  return lines.join('\n');
}

/**
 * Everything OUTSIDE the marker region, with the region removed (#533 slice 2).
 *
 * The precondition for having a body-write verb at all. `replaceMapRegion` is
 * marker-bounded by construction, but `issueUpdate` writes an OPAQUE body and cannot
 * check that — so the caller proves byte-equality here before it writes, and a bug in
 * the composer becomes a refusal to write instead of a lost epic.
 *
 * `trimEnd` on both sides is the one normalisation, and it is required rather than
 * lenient: a first run APPENDS the region, which necessarily trims the trailing
 * whitespace of the original body. Nothing else is normalised — a change to a single
 * character of the surrounding prose makes the two differ.
 *
 * @param {string} body
 * @returns {string}
 */
export function outsideRegion(body) {
  const src = typeof body === 'string' ? body : '';
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  if (i === -1 || j === -1 || j < i) return src.trimEnd();
  return (src.slice(0, i) + src.slice(j + END.length)).trimEnd();
}

/**
 * Replaces the marker region in `body`, leaving everything outside it byte-identical.
 *
 * READ-ONLY OUTSIDE THE MARKERS is the property that makes this verb safe to run on a
 * hand-written epic. It is asserted by test, not by care: the whole value of a
 * regenerated projection evaporates if regenerating it can lose the prose around it.
 *
 * An absent marker region APPENDS one rather than rewriting anything, so a first run
 * on an untouched epic is additive.
 *
 * @param {string} body @param {string} content
 * @returns {string}
 */
export function replaceMapRegion(body, content) {
  const src = typeof body === 'string' ? body : '';
  const region = `${BEGIN}\n${content}\n${END}`;
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  if (i === -1 || j === -1 || j < i) {
    return src.trimEnd() + (src.trim() ? '\n\n' : '') + region + '\n';
  }
  return src.slice(0, i) + region + src.slice(j + END.length);
}
