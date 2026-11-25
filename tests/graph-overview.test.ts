import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppContext, createContext } from '../src/context.js';
import { applyMerge } from '../src/graph/merge.js';
import { GRAPH_MAX_NODES, graphOverview, graphSearch } from '../src/graph/query.js';
import { sync } from '../src/ingest/sync.js';
import { createApp } from '../src/server/app.js';
import { WorkspaceContextRegistry } from '../src/server/workspaces.js';
import type { GraphCommunity, GraphEdge, GraphNode } from '../src/types.js';

/**
 * The graph overview behind Knowledge → Graph: what the view can ask for
 * (how many nodes, which types, typed edges only), what every node carries
 * for it (global degree, wiki page), and the d3 bundle it draws with.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'knode-graph-overview-'));
const root = path.join(tmp, 'data');

const headers = {
  'x-knode-user': 'admin',
  'x-knode-workspace-kind': 'personal',
  'x-knode-workspace-id': 'default',
  'x-knode-workspace-name': 'Default',
};
const scope = { user: 'admin', kind: 'personal' as const, id: 'default', name: 'Default', slug: 'default', relativeDir: 'users/admin/workspaces/default' };

let rootCtx: AppContext;
let registry: WorkspaceContextRegistry;
let app: ReturnType<typeof createApp>;
let ws: AppContext;

const SEED = `---
title: graph seed
entities:
  - { name: Alpha, type: person, aliases: ["A"] }
  - { name: Beta, type: person }
  - { name: Beta Two, type: person }
  - { name: Gamma, type: organization }
  - { name: Delta, type: organization }
relations:
  - { source: Alpha, target: Gamma, type: works_at }
  - { source: Beta, target: Gamma, type: works_at }
  - { source: Alpha, target: Beta, type: knows }
---
[[Alpha]] works with [[Gamma]] on the first topic, and [[Beta]] sits on the same bench.
`;

beforeAll(async () => {
  rootCtx = await createContext(root);
  registry = new WorkspaceContextRegistry(root, { templateConfig: rootCtx.config });
  app = createApp(rootCtx, () => {}, registry);
  await app.request('/api/workspaces', { headers: { 'x-knode-user': 'admin' } });
  ws = await registry.get(scope);
  const abs = path.join(ws.dataDir, 'raw/docs/seed.md');
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, SEED);
  await sync(ws, { llmGraph: false });
  const [beta, betaTwo] = await ws.store.query<{ id: string }>(`SELECT id FROM entities WHERE name IN ('Beta', 'Beta Two') ORDER BY name`);
  await applyMerge(ws.store, { entityId: betaTwo.id, canonicalId: beta.id, actor: 'test', log: false });
});

afterAll(async () => {
  await registry.closeAll();
  await rootCtx.store.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('graphOverview', () => {
  it('returns the top entities with their global degree and wiki path, merged ones folded away', async () => {
    const g = await graphOverview(ws.store);
    const names = g.nodes.map((n) => n.name);
    expect(names).toEqual(expect.arrayContaining(['Alpha', 'Beta', 'Gamma', 'Delta']));
    expect(names).not.toContain('Beta Two');
    const alpha = g.nodes.find((n) => n.name === 'Alpha')!;
    const [{ n }] = await ws.store.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM relations WHERE tx_to IS NULL AND type <> 'co_occurs' AND (source_id = $1 OR target_id = $1)`,
      [alpha.id],
    );
    expect(n).toBe(2);
    expect(alpha.degree).toBe(2);
    expect(alpha).toHaveProperty('wikiPath', null);
    // in an overview the score is the mention count, nothing else
    expect(alpha.score).toBe(alpha.mentionCount);
    expect(g.edges.some((e) => e.type !== 'co_occurs')).toBe(true);
    expect(g.edges.some((e) => e.type === 'co_occurs')).toBe(true);
  });

  it('leaves co-occurrence out when asked for typed edges only', async () => {
    const g = await graphOverview(ws.store, { edges: 'typed' });
    expect(g.edges.length).toBeGreaterThan(0);
    expect(g.edges.every((e) => e.type !== 'co_occurs')).toBe(true);
  });

  it('restricts the nodes, and so the edges, to the requested types', async () => {
    const g = await graphOverview(ws.store, { types: ['person'] });
    expect(g.nodes.length).toBeGreaterThan(0);
    expect(g.nodes.every((n) => n.type === 'person')).toBe(true);
    const ids = new Set(g.nodes.map((n) => n.id));
    for (const e of g.edges) {
      expect(ids.has(e.source)).toBe(true);
      expect(ids.has(e.target)).toBe(true);
    }
  });

  it('takes the limit as an option or a bare number, and falls back on nonsense', async () => {
    expect((await graphOverview(ws.store, { limit: 2 })).nodes).toHaveLength(2);
    expect((await graphOverview(ws.store, 2)).nodes).toHaveLength(2);
    expect((await graphOverview(ws.store, { limit: 0 })).nodes.length).toBeGreaterThan(2);
    expect((await graphOverview(ws.store, { limit: Number.NaN })).nodes.length).toBeGreaterThan(2);
    expect((await graphOverview(ws.store, { limit: 1e9 })).nodes.length).toBeLessThanOrEqual(GRAPH_MAX_NODES);
  });
});

describe('graphSearch', () => {
  it('caps its nodes and carries the degree', async () => {
    const g = await graphSearch(ws.store, 'Alpha', { limit: 2, track: false });
    expect(g.nodes.length).toBeLessThanOrEqual(2);
    expect(g.nodes[0].name).toBe('Alpha');
    expect(g.nodes[0].degree).toBe(2);
    expect(g.nodes[0]).toHaveProperty('wikiPath', null);
  });
});

describe('GET /api/graph', () => {
  it('passes limit, types and edges through, and shrugs at a limit that is not a number', async () => {
    const res = await app.request('/api/graph?limit=2&edges=typed&types=person', { headers });
    expect(res.status).toBe(200);
    const g = (await res.json()) as { nodes: GraphNode[]; edges: GraphEdge[] };
    expect(g.nodes).toHaveLength(2);
    expect(g.nodes.every((n) => n.type === 'person')).toBe(true);
    expect(g.edges.every((e) => e.type !== 'co_occurs')).toBe(true);

    const search = (await (await app.request('/api/graph?q=Alpha&limit=1', { headers })).json()) as { nodes: GraphNode[] };
    expect(search.nodes).toHaveLength(1);

    const odd = await app.request('/api/graph?limit=abc', { headers });
    expect(odd.status).toBe(200);
    expect(((await odd.json()) as { nodes: GraphNode[] }).nodes.length).toBeGreaterThan(2);
  });

  it('marks every linked node with its community and lists the communities, for the view\'s islands', async () => {
    const g = (await (await app.request('/api/graph?edges=typed', { headers })).json()) as { nodes: GraphNode[]; communities: GraphCommunity[] };
    const byName = new Map(g.nodes.map((n) => [n.name, n]));
    // Alpha, Beta and Gamma are tied by typed relations; Delta has none, and co-occurrence was not asked for
    expect(byName.get('Alpha')!.community).toBe(0);
    expect(byName.get('Beta')!.community).toBe(0);
    expect(byName.get('Gamma')!.community).toBe(0);
    expect(byName.get('Delta')!.community).toBeUndefined();
    expect(g.communities).toHaveLength(1);
    expect(g.communities[0]).toMatchObject({ id: 0, size: 3 });
    expect(g.nodes.some((n) => n.id === g.communities[0].hub && n.name === g.communities[0].label)).toBe(true);
    // an agent's graph search is the read itself: no communities, nothing added to what it pays for
    expect('communities' in (await graphOverview(ws.store))).toBe(false);
  });
});

describe('GET /vendor/d3.js', () => {
  it('serves the d3 bundle as one of this server\'s own scripts', async () => {
    const res = await app.request('/vendor/d3.js');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^text\/javascript/);
    const body = await res.text();
    expect(body).not.toBe('window.d3=null;');
    expect(body.length).toBeGreaterThan(100_000);
  });
});
