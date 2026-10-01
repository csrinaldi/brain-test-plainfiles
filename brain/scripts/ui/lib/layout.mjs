// layout.mjs — {nodes, edges} -> coordinates (D10, R881-7). Pure, imported
// by the browser AND by node:test (D9): no node: builtin, no ../status/*.
//
// Four passes, always in this order:
//
//   1. CYCLE BREAKING. DFS from the numerically smallest node number; any
//      edge reaching a node already on the DFS stack is a back edge. It is
//      REVERSED for layering (pass 2 sees the opposite direction), and the
//      ORIGINAL direction is kept on the output edge as `reversed: true` so
//      the renderer can draw it differently. The graph reports `divergences`
//      rather than guaranteeing acyclicity (ruling 5) — a cycle must produce
//      a drawing here, never a hang or a thrown error.
//   2. LAYERING, longest path. `layer(to) = max(layer(from)) + 1` over the
//      now-acyclic edge set. Orientation is load-bearing:
//      `epic-graph.mjs:432-438` builds `node.blockedBy` with `from` as the
//      BLOCKER and `to` as the BLOCKED (the prose at `:346-347` reads the
//      other way; the code is the authority) — so a blocker always lands in
//      a strictly smaller layer than the node it blocks.
//   3. ORDERING, barycentre, four fixed sweeps. A constant sweep count, not
//      a convergence loop (D10's own rejected alternative) — two calls on
//      the same input are byte-identical even under floating-point ties.
//      Ties break on issue number.
//   4. COORDINATES. `x = order * (nodeWidth + gapX)`, `y = layer * (nodeHeight
//      + gapY)`, plus the bounding box. No spline routing in v1 — every edge
//      is a straight line between its two endpoints.
//
// Nodes with no edges (the `?` track, ruling 1) are laid out in a trailing
// `unlinked` band below the layered graph — ruling 1 says the canvas never
// filters a node away silently, and a node absent from every edge has no
// layer to belong to.

export const NODE_W = 160;
export const NODE_H = 60;
export const GAP_X = 40;
export const GAP_Y = 60;

/**
 * Pass 1 — DFS back-edge reversal. Returns the edge list pass 2 should
 * layer with (`layeringEdges`, direction possibly flipped from the input)
 * and the set of ORIGINAL `"from->to"` keys that were back edges
 * (`reversedKeys`), so the OUTPUT edges (built from the untouched input
 * list) can say which ones were reversed.
 */
function breakCycles(nodeNumbers, edges) {
  const adjacency = new Map(nodeNumbers.map((n) => [n, []]));
  for (const e of edges) adjacency.get(e.from)?.push(e.to);
  for (const list of adjacency.values()) list.sort((a, b) => a - b); // edge-array order must never change the result

  const ordered = [...nodeNumbers].sort((a, b) => a - b); // DFS root order — deterministic regardless of input node order
  const state = new Map(nodeNumbers.map((n) => [n, 'unvisited'])); // unvisited | onStack | done
  const layeringEdges = [];
  const reversedKeys = new Set();

  function visit(n) {
    state.set(n, 'onStack');
    for (const to of adjacency.get(n) ?? []) {
      if (state.get(to) === 'onStack') {
        layeringEdges.push({ from: to, to: n }); // reversed for layering
        reversedKeys.add(`${n}->${to}`); // the ORIGINAL direction is what the output edge marks reversed
        continue;
      }
      layeringEdges.push({ from: n, to });
      if (state.get(to) === 'unvisited') visit(to);
    }
    state.set(n, 'done');
  }

  for (const n of ordered) if (state.get(n) === 'unvisited') visit(n);
  return { layeringEdges, reversedKeys };
}

/** Pass 2 — longest-path layering, bounded relaxation (never a convergence loop: at most one pass per node). */
function computeLayers(nodeNumbers, layeringEdges) {
  const layer = new Map(nodeNumbers.map((n) => [n, 0]));
  const preds = new Map(nodeNumbers.map((n) => [n, []]));
  for (const e of layeringEdges) preds.get(e.to)?.push(e.from);

  for (let pass = 0; pass < nodeNumbers.length; pass++) {
    let changed = false;
    for (const n of nodeNumbers) {
      const from = preds.get(n) ?? [];
      if (from.length === 0) continue;
      const want = Math.max(...from.map((f) => layer.get(f))) + 1;
      if (want > layer.get(n)) { layer.set(n, want); changed = true; }
    }
    if (!changed) break;
  }
  return layer;
}

/** Pass 3 — barycentre ordering, exactly 4 down-up sweeps. Ties break on issue number. */
function orderByBarycentre(nodeNumbers, layerOf, layeringEdges) {
  const maxLayer = nodeNumbers.length === 0 ? -1 : Math.max(...nodeNumbers.map((n) => layerOf.get(n)));
  if (maxLayer < 0) return [];

  const layers = Array.from({ length: maxLayer + 1 }, () => []);
  for (const n of [...nodeNumbers].sort((a, b) => a - b)) layers[layerOf.get(n)].push(n);

  const order = new Map();
  for (const l of layers) l.forEach((n, i) => order.set(n, i));

  const preds = new Map(nodeNumbers.map((n) => [n, []]));
  const succs = new Map(nodeNumbers.map((n) => [n, []]));
  for (const e of layeringEdges) { succs.get(e.from)?.push(e.to); preds.get(e.to)?.push(e.from); }

  function sweepLayer(layerNodes, neighboursOf) {
    const scored = layerNodes.map((n) => {
      const positions = (neighboursOf.get(n) ?? []).map((m) => order.get(m)).filter((p) => p !== undefined);
      const bary = positions.length ? positions.reduce((a, b) => a + b, 0) / positions.length : order.get(n);
      return { n, bary };
    });
    scored.sort((a, b) => a.bary - b.bary || a.n - b.n); // ties break on issue number
    scored.forEach((s, i) => order.set(s.n, i));
    return scored.map((s) => s.n);
  }

  for (let sweep = 0; sweep < 4; sweep++) {
    const downward = sweep % 2 === 0;
    if (downward) for (let li = 1; li < layers.length; li++) layers[li] = sweepLayer(layers[li], preds);
    else for (let li = layers.length - 2; li >= 0; li--) layers[li] = sweepLayer(layers[li], succs);
  }
  return layers;
}

/** Pass 4 — coordinates from layer/order, plus the trailing unlinked band. */
function computeCoordinates(layers, unlinked) {
  const nodes = {};
  layers.forEach((layerNodes, layerIdx) => {
    layerNodes.forEach((n, orderIdx) => {
      nodes[n] = { x: orderIdx * (NODE_W + GAP_X), y: layerIdx * (NODE_H + GAP_Y), w: NODE_W, h: NODE_H, layer: layerIdx, order: orderIdx };
    });
  });
  // The band wraps into a square-ish grid: ceil(sqrt(n)) columns, widened to the
  // widest layer so it reuses the width the layers already claim, never more.
  const columns = Math.max(1, Math.ceil(Math.sqrt(unlinked.length)), ...layers.map((l) => l.length));
  const unlinkedY = layers.length * (NODE_H + GAP_Y);
  unlinked.forEach((n, i) => {
    const row = Math.floor(i / columns);
    const column = i % columns;
    nodes[n] = { x: column * (NODE_W + GAP_X), y: unlinkedY + row * (NODE_H + GAP_Y), w: NODE_W, h: NODE_H, layer: layers.length + row, order: column };
  });
  return nodes;
}

/**
 * layout({nodes, edges}) -> {layers, nodes, edges, width, height, unlinked, droppedEdges}
 * (see design.md's "Layout output" data shape). Pure — no clock, no random,
 * no DOM.
 *
 * @param {{nodes: Array<{number:number}>, edges: Array<{from:number,to:number}>}} input
 */
export function layout({ nodes = [], edges = [] } = {}) {
  const nodeNumbers = nodes.map((n) => n.number);
  const numberSet = new Set(nodeNumbers);
  const validEdges = edges.filter((e) => numberSet.has(e.from) && numberSet.has(e.to));
  // Said, not swallowed: an edge to a number that is not a node is reported so
  // the page can show it (pre-push review of slice 3); nodes are never dropped.
  const droppedEdges = edges.filter((e) => !(numberSet.has(e.from) && numberSet.has(e.to))).map((e) => ({ from: e.from, to: e.to, reason: 'unknown node' }));

  const inEdge = new Set();
  for (const e of validEdges) { inEdge.add(e.from); inEdge.add(e.to); }
  const linkedNumbers = nodeNumbers.filter((n) => inEdge.has(n)).sort((a, b) => a - b);
  const unlinked = nodeNumbers.filter((n) => !inEdge.has(n)).sort((a, b) => a - b);

  const { layeringEdges, reversedKeys } = breakCycles(linkedNumbers, validEdges);
  const layerOf = computeLayers(linkedNumbers, layeringEdges);
  const layers = orderByBarycentre(linkedNumbers, layerOf, layeringEdges);
  const nodesCoord = computeCoordinates(layers, unlinked);

  const outEdges = validEdges.map((e) => {
    const from = nodesCoord[e.from];
    const to = nodesCoord[e.to];
    return {
      from: e.from,
      to: e.to,
      reversed: reversedKeys.has(`${e.from}->${e.to}`),
      points: [
        { x: from.x + from.w / 2, y: from.y + from.h },
        { x: to.x + to.w / 2, y: to.y },
      ],
    };
  });

  const coords = Object.values(nodesCoord);
  const width = coords.length ? Math.max(...coords.map((c) => c.x + c.w)) : 0;
  const height = coords.length ? Math.max(...coords.map((c) => c.y + c.h)) : 0;

  return {
    layers: layers.map((l) => [...l]),
    nodes: nodesCoord,
    edges: outEdges,
    width,
    height,
    unlinked,
    droppedEdges,
  };
}
