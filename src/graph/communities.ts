import type { GraphCommunity, GraphEdge, GraphNode, GraphSearchResult } from '../types.js';

/**
 * Communities of a graph read, for the graph view's clustered layout: which
 * nodes of the reply belong together, so the view can draw each group as an
 * island of its own instead of one ball of everything.
 *
 * Louvain over the reply's own edges (the nodes returned and the edges among
 * them, nothing fetched): modularity is what separates "densely linked to each
 * other" from "linked to a hub everything links to", which the label
 * propagation in wiki/refine.ts does not on a co-occurrence graph. Nodes are
 * visited in the reply's order and ties keep the earlier community, so the
 * same reply always gives the same communities.
 */

/** A derived co-occurrence counts for less than a stated relation between the same pair. */
const CO_OCCURS_SHARE = 0.5;
/** Passes over the nodes per level; a level that still moves nodes after these is taken as it stands. */
const MAX_SWEEPS = 20;

type Adjacency = Map<number, number>[];

/** One level of Louvain: each node moves to the neighbouring community that raises modularity most, until none moves. */
function localMoves(adj: Adjacency, self: number[]): { community: number[]; moved: boolean } {
  const n = adj.length;
  const community = Array.from({ length: n }, (_, i) => i);
  const strength = adj.map((nb, i) => {
    let s = self[i];
    for (const w of nb.values()) s += w;
    return s;
  });
  const total = [...strength];
  const m2 = strength.reduce((a, b) => a + b, 0);
  if (m2 === 0) return { community, moved: false };
  let moved = false;
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let changes = 0;
    for (let i = 0; i < n; i++) {
      const own = community[i];
      const toward = new Map<number, number>();
      for (const [j, w] of adj[i]) toward.set(community[j], (toward.get(community[j]) ?? 0) + w);
      total[own] -= strength[i];
      let best = own;
      let bestGain = (toward.get(own) ?? 0) - (total[own] * strength[i]) / m2;
      for (const [c, w] of toward) {
        const gain = w - (total[c] * strength[i]) / m2;
        if (gain > bestGain + 1e-12) {
          best = c;
          bestGain = gain;
        }
      }
      total[best] += strength[i];
      if (best !== own) {
        community[i] = best;
        changes++;
      }
    }
    if (!changes) break;
    moved = true;
  }
  return { community, moved };
}

/** Community index per node (0-based, dense, in order of first appearance) for an undirected weighted graph. */
export function louvain(n: number, links: { a: number; b: number; weight: number }[]): number[] {
  let adj: Adjacency = Array.from({ length: n }, () => new Map<number, number>());
  let self: number[] = new Array<number>(n).fill(0);
  for (const { a, b, weight } of links) {
    if (a === b || !(weight > 0) || a < 0 || b < 0 || a >= n || b >= n) continue;
    adj[a].set(b, (adj[a].get(b) ?? 0) + weight);
    adj[b].set(a, (adj[b].get(a) ?? 0) + weight);
  }
  /** Which node of the current level each original node has been folded into. */
  let member = Array.from({ length: n }, (_, i) => i);
  for (;;) {
    const { community, moved } = localMoves(adj, self);
    if (!moved) break;
    const dense = new Map<number, number>();
    for (const c of community) if (!dense.has(c)) dense.set(c, dense.size);
    const size = dense.size;
    const nextAdj: Adjacency = Array.from({ length: size }, () => new Map<number, number>());
    const nextSelf = new Array<number>(size).fill(0);
    for (let i = 0; i < adj.length; i++) {
      const ci = dense.get(community[i])!;
      nextSelf[ci] += self[i];
      for (const [j, w] of adj[i]) {
        const cj = dense.get(community[j])!;
        // an edge inside a community is seen from both of its ends: together they make its full weight twice, as a loop counts
        if (ci === cj) nextSelf[ci] += w;
        else nextAdj[ci].set(cj, (nextAdj[ci].get(cj) ?? 0) + w);
      }
    }
    member = member.map((i) => dense.get(community[i])!);
    if (size === adj.length) break;
    adj = nextAdj;
    self = nextSelf;
  }
  const dense = new Map<number, number>();
  return member.map((c) => dense.get(c) ?? dense.set(c, dense.size).get(c)!);
}

/**
 * The communities among `nodes` under `edges`, largest first. A node linked
 * to nothing in the reply belongs to none. Each community is named after its
 * hub: the member with the most typed relations across the whole graph, which
 * is what the view sizes nodes by, so the hub is the island's largest disc;
 * then the one the reply's edges tie in most, then the earlier in the reply.
 */
export function graphCommunities(nodes: GraphNode[], edges: GraphEdge[]): { of: Map<string, number>; communities: GraphCommunity[] } {
  const index = new Map(nodes.map((n, i) => [n.id, i]));
  const links: { a: number; b: number; weight: number }[] = [];
  const strength = new Array<number>(nodes.length).fill(0);
  for (const e of edges) {
    const a = index.get(e.source), b = index.get(e.target);
    if (a === undefined || b === undefined || a === b) continue;
    const weight = Math.max(0, e.weight) * (e.type === 'co_occurs' ? CO_OCCURS_SHARE : 1);
    if (!weight) continue;
    links.push({ a, b, weight });
    strength[a] += weight;
    strength[b] += weight;
  }
  const label = louvain(nodes.length, links);
  const groups = new Map<number, number[]>();
  label.forEach((c, i) => {
    if (strength[i] > 0) (groups.get(c) ?? groups.set(c, []).get(c)!).push(i);
  });
  const ranked = [...groups.values()].filter((g) => g.length > 1).sort((x, y) => y.length - x.length || x[0] - y[0]);
  const of = new Map<string, number>();
  const communities = ranked.map((group, id) => {
    let hub = group[0];
    const degree = (i: number) => nodes[i].degree ?? 0;
    for (const i of group) {
      of.set(nodes[i].id, id);
      if (degree(i) > degree(hub) || (degree(i) === degree(hub) && strength[i] > strength[hub])) hub = i;
    }
    return { id, size: group.length, hub: nodes[hub].id, label: nodes[hub].name };
  });
  return { of, communities };
}

/** A graph read with every node's community and the list of communities: what `/api/graph` answers for the graph view. */
export function withCommunities<T extends GraphSearchResult>(result: T): T {
  const { of, communities } = graphCommunities(result.nodes, result.edges);
  return {
    ...result,
    nodes: result.nodes.map((n) => (of.has(n.id) ? { ...n, community: of.get(n.id) } : n)),
    communities,
  };
}
