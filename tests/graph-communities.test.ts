import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { graphCommunities, louvain, withCommunities } from '../src/graph/communities.js';
import type { GraphEdge, GraphNode } from '../src/types.js';

/**
 * Communities of a graph read (src/graph/communities.ts), what the graph
 * view lays out as islands, and how the view places those islands
 * (web/graph.js `packIslands`).
 */

const node = (id: string, degree?: number): GraphNode => ({ id, name: id.toUpperCase(), type: 'concept', description: '', score: 1, mentionCount: 1, degree });
const edge = (source: string, target: string, type = 'uses', weight = 1): GraphEdge => ({ source, target, type, description: '', weight });

/** Two cliques of four joined by one edge, an orphan, and a pair on their own. */
function twoCliques(): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const a = ['a1', 'a2', 'a3', 'a4'], b = ['b1', 'b2', 'b3', 'b4', 'b5'];
  const clique = (ids: string[]) => ids.flatMap((x, i) => ids.slice(i + 1).map((y) => edge(x, y)));
  return {
    nodes: [...a, ...b, 'lone', 'p1', 'p2'].map((id) => node(id, id === 'b3' ? 9 : id === 'a2' ? 5 : 1)),
    edges: [...clique(a), ...clique(b), edge('a1', 'b1'), edge('p1', 'p2')],
  };
}

describe('louvain', () => {
  it('separates two cliques joined by one edge', () => {
    const links = [[0, 1], [0, 2], [1, 2], [3, 4], [3, 5], [4, 5], [2, 3]].map(([a, b]) => ({ a, b, weight: 1 }));
    const c = louvain(6, links);
    expect(new Set(c).size).toBe(2);
    expect(c[0]).toBe(c[1]);
    expect(c[1]).toBe(c[2]);
    expect(c[3]).toBe(c[4]);
    expect(c[4]).toBe(c[5]);
    expect(c[0]).not.toBe(c[3]);
  });

  it('leaves unlinked nodes each on their own, and ignores loops and edges to nowhere', () => {
    expect(louvain(3, [])).toEqual([0, 1, 2]);
    expect(louvain(2, [{ a: 0, b: 0, weight: 3 }, { a: 0, b: 7, weight: 1 }, { a: 0, b: 1, weight: 0 }])).toEqual([0, 1]);
  });

  it('folds a ring of cliques level by level into one community per clique', () => {
    // eight triangles in a ring: the first level alone would already find them; the fold must not merge neighbours
    const links: { a: number; b: number; weight: number }[] = [];
    for (let k = 0; k < 8; k++) {
      const [x, y, z] = [k * 3, k * 3 + 1, k * 3 + 2];
      links.push({ a: x, b: y, weight: 1 }, { a: y, b: z, weight: 1 }, { a: x, b: z, weight: 1 }, { a: z, b: ((k + 1) % 8) * 3, weight: 0.2 });
    }
    const c = louvain(24, links);
    expect(new Set(c).size).toBe(8);
    for (let k = 0; k < 8; k++) expect(new Set([c[k * 3], c[k * 3 + 1], c[k * 3 + 2]]).size).toBe(1);
  });
});

describe('graphCommunities', () => {
  it('ranks communities by size, names each after its highest-degree member and leaves orphans out', () => {
    const { nodes, edges } = twoCliques();
    const { of, communities } = graphCommunities(nodes, edges);
    expect(communities.map((c) => [c.id, c.size, c.hub, c.label])).toEqual([[0, 5, 'b3', 'B3'], [1, 4, 'a2', 'A2'], [2, 2, 'p1', 'P1']]);
    expect(of.get('b1')).toBe(0);
    expect(of.get('a4')).toBe(1);
    expect(of.get('p2')).toBe(2);
    expect(of.has('lone')).toBe(false);
  });

  it('gives the same answer for the same reply', () => {
    const { nodes, edges } = twoCliques();
    expect(graphCommunities(nodes, edges)).toEqual(graphCommunities(nodes, edges));
  });

  it('counts a co-occurrence for less than a typed relation', () => {
    // x sits between two pairs: one typed edge to the left pair outweighs one co-occurrence of the same weight to the right
    const nodes = ['l1', 'l2', 'x', 'r1', 'r2'].map((id) => node(id));
    const edges = [edge('l1', 'l2'), edge('r1', 'r2'), edge('x', 'l1'), edge('x', 'l2'), edge('x', 'r1', 'co_occurs'), edge('x', 'r2', 'co_occurs')];
    const { of } = graphCommunities(nodes, edges);
    expect(of.get('x')).toBe(of.get('l1'));
    expect(of.get('x')).not.toBe(of.get('r1'));
  });

  it('marks the nodes of a reply and lists its communities, leaving the rest of it as it was', () => {
    const { nodes, edges } = twoCliques();
    const reply = withCommunities({ nodes, edges, chunks: [] });
    expect(reply.communities).toHaveLength(3);
    expect(reply.nodes.find((n) => n.id === 'b2')!.community).toBe(0);
    expect('community' in reply.nodes.find((n) => n.id === 'lone')!).toBe(false);
    expect(reply.edges).toBe(edges);
    expect(nodes.every((n) => n.community === undefined)).toBe(true);
  });
});

describe('packIslands (web/graph.js)', () => {
  interface Island { R: number; x: number; y: number }
  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web');
  // the class reads d3 only when a graph is made: the page's script loads without it
  const page = vm.createContext({ window: {}, d3: undefined });
  vm.runInContext(`${fs.readFileSync(path.join(webDir, 'graph.js'), 'utf8')}\nthis.KnodeGraph = KnodeGraph;`, page);
  const { packIslands, ISLAND_GAP } = (page as unknown as { KnodeGraph: { packIslands: (islands: Island[]) => void; ISLAND_GAP: number } }).KnodeGraph;

  it('places islands apart by the gap, centred on the origin, the same way every time', () => {
    const make = (): Island[] => [260, 200, 180, 120, 120, 90, 60, 40].map((R) => ({ R, x: 0, y: 0 }));
    const islands = make();
    packIslands(islands);
    for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        const d = Math.hypot(islands[i].x - islands[j].x, islands[i].y - islands[j].y);
        expect(d).toBeGreaterThanOrEqual(islands[i].R + islands[j].R + ISLAND_GAP - 1e-6);
      }
    }
    const x0 = Math.min(...islands.map((p) => p.x - p.R)), x1 = Math.max(...islands.map((p) => p.x + p.R));
    const y0 = Math.min(...islands.map((p) => p.y - p.R)), y1 = Math.max(...islands.map((p) => p.y + p.R));
    expect(Math.abs(x0 + x1)).toBeLessThan(1e-6);
    expect(Math.abs(y0 + y1)).toBeLessThan(1e-6);
    // wider than tall, to suit the canvas
    expect(x1 - x0).toBeGreaterThan(y1 - y0);
    const again = make();
    packIslands(again);
    expect(again).toEqual(islands);
  });

  it('puts a lone island in the middle', () => {
    const one = [{ R: 100, x: 5, y: 5 }];
    packIslands(one);
    expect(one[0]).toEqual({ R: 100, x: 0, y: 0 });
  });
});
