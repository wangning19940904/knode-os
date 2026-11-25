/* knode-os graph view — the canvas behind Knowledge → Graph.
 *
 * web/app.js fetches the data and owns the DOM around the canvas (legend,
 * caption, settings, side panel); this draws. Layout, zoom and drag come
 * from d3 (/vendor/d3.js): a force simulation that settles and sleeps, a
 * zoomable, pannable canvas, nodes that can be dragged and pinned, hover
 * that isolates a neighbourhood, labels that fade in with zoom, the way
 * Obsidian's graph view behaves. Without d3 the class still exists but
 * `KnodeGraph.available` is false, so the app can say so instead of breaking.
 *
 * The look is "Glyph + glow": every node is a dark disc in a ring of its
 * type's colour with the type's icon inside; the relations between a pair of
 * nodes draw as one edge in the colour and line pattern of the most specific
 * one's family, and a click on the edge lists them all; the `glow` setting
 * adds a corona around each node, light-blended edges and particles that flow
 * along a focused node's edges. The Mac app draws the same (GraphRenderer.swift).
 *
 * With the `cluster` setting the reply's communities (src/graph/communities.ts)
 * are laid out as islands: each community settles inside a disc of its own,
 * its hub's name above it, and only the relations inside an island pull, so the view
 * reads as groups of things that belong together and the lines between them.
 * The Mac app places and draws the same islands (GraphScene.swift). */
'use strict';

const GRAPH_FONT = '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", "Microsoft YaHei", system-ui, sans-serif';
const hexRgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgba = (hex, a) => `rgba(${hexRgb(hex).join(',')},${a})`;
/** `a` moved toward `b` by `t`. */
const mixHex = (a, b, t) => {
  const x = hexRgb(a), y = hexRgb(b);
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('');
};
const mixWhite = (hex, t) => mixHex(hex, '#ffffff', t);

class KnodeGraph {
  /** Display preferences, persisted by the app; the keys and the force values are shared with the Mac app. */
  static DEFAULTS = Object.freeze({
    limit: 150, hiddenTypes: [], hiddenRelations: [], hideOrphans: false, cooccur: true, minWeight: 0,
    nodeSize: 1, linkWidth: 1, textFade: 1, arrows: false, pin: false, glow: true, cluster: true,
    center: 0.06, repel: 180, linkDistance: 90,
  });
  static FORCE_KEYS = ['center', 'repel', 'linkDistance'];
  /** Settings the islands are placed by: they move where every node is headed. */
  static ISLAND_KEYS = ['cluster', 'linkDistance'];
  /** Room between two islands, and how much of an island's disc its nodes' own discs fill. */
  static ISLAND_GAP = 44;
  static ISLAND_FILL = 0.3;
  static FILTER_KEYS = ['hiddenTypes', 'hiddenRelations', 'hideOrphans', 'cooccur', 'minWeight'];
  static available = typeof d3 !== 'undefined' && d3 !== null;

  /** How far from a node's centre, in screen pixels, a pointer always counts as on it; past that, its disc and 5 px round it. */
  static HIT_PX = 10;
  static ZOOM_EXTENT = [0.15, 8];

  /**
   * Relation families: the ontology's predicates folded into five coloured
   * groups, a neutral "other typed" for the generic, rare and unknown ones, and
   * the derived co-occurrence. Each has a line pattern too, so a relation still
   * reads without its colour. The five hues stay apart under red-green colour
   * blindness and from the main node colours. The Mac app uses the same table.
   */
  static FAMILIES = Object.freeze([
    { id: 'structure', label: 'structure', color: '#019aeb', boost: 1, dash: [], types: ['part_of', 'member_of', 'subsidiary_of', 'located_in', 'regulated_by'] },
    { id: 'capital', label: 'capital', color: '#bfaa03', boost: 1, dash: [7, 3], types: ['owns', 'invested_in', 'acquired'] },
    { id: 'value', label: 'value chain', color: '#08d7ee', boost: 0.85, dash: [], types: ['produces', 'supplies_to', 'uses', 'depends_on'] },
    { id: 'competition', label: 'competition', color: '#fe9f9d', boost: 0.95, dash: [2.5, 2.5], types: ['competes_with', 'contradicts'] },
    { id: 'cooperation', label: 'cooperation & people', color: '#1a9951', boost: 1.3, dash: [6, 2.5, 1.5, 2.5], types: ['partner_of', 'works_at', 'reports_to', 'authored', 'founded'] },
    { id: 'other', label: 'other typed', color: '#8a93a6', boost: 1, dash: [], types: ['related_to', 'caused', 'succeeded_by'] },
    { id: 'cooccur', label: 'co-occurrence', color: '#8a93a6', boost: 1, dash: [1.2, 3.2], types: ['co_occurs'] },
  ]);
  static FAMILY_OF = new Map(this.FAMILIES.flatMap((f) => f.types.map((t) => [t, f])));
  /** No direction to show: the relation reads the same both ways, or says nothing about direction. */
  static UNDIRECTED = new Set(['competes_with', 'contradicts', 'partner_of', 'co_occurs', 'related_to']);

  /** The family a relation type draws as; anything the table does not name is "other typed". */
  static family(type) {
    return KnodeGraph.FAMILY_OF.get(type) ?? KnodeGraph.FAMILIES[5];
  }

  /**
   * The relations between one pair of nodes, folded into a bundle: drawn as
   * one line, hit as one edge and listed as one neighbour, while the layout
   * keeps every relation's own spring. A bundle's relations are the distinct
   * ones (a type once per direction, at its strongest reading), most specific
   * first: the five coloured families, then other typed, then co-occurrence,
   * each by weight. The first, the primary, gives the line its family and
   * its ends `a` → `b`; `forward` and `backward` say whether any directed
   * relation runs a → b or b → a.
   */
  static bundleLinks(links) {
    const rank = (l) => (l.co ? 2 : l.fam.id === 'other' ? 1 : 0);
    const pairs = new Map();
    for (const l of links) {
      const key = l.source.id < l.target.id ? `${l.source.id}|${l.target.id}` : `${l.target.id}|${l.source.id}`;
      let distinct = pairs.get(key);
      if (!distinct) pairs.set(key, (distinct = new Map()));
      // an undirected type is one relation whichever end it was written from
      const id = l.directed ? `${l.type}|${l.source.id}` : l.type;
      const seen = distinct.get(id);
      if (!seen || l.weight > seen.weight) distinct.set(id, l);
    }
    const bundles = [];
    for (const [id, distinct] of pairs) {
      const relations = [...distinct.values()].sort((m, n) => rank(m) - rank(n) || n.weight - m.weight);
      const primary = relations[0];
      const a = primary.source, b = primary.target;
      bundles.push({
        id, a, b, relations, primary,
        weight: Math.max(...relations.map((r) => r.weight)),
        forward: relations.some((r) => r.directed && r.source === a),
        backward: relations.some((r) => r.directed && r.source === b),
        // where along the line its particles start, so neighbouring bundles do not pulse in step
        phase: (bundles.length * 0.6180339887) % 1,
      });
    }
    return bundles;
  }

  /**
   * Put islands (`{ R }`, in the order given: largest first) on the plane
   * without overlap, each at `x`, `y`: the first in the middle, every next
   * one at the nearest free spot to the middle, tried ring by ring from an
   * angle of its own. The plane is squashed to suit a wide canvas, and the
   * whole is centred on the origin.
   */
  static packIslands(islands, gap = KnodeGraph.ISLAND_GAP) {
    const placed = [];
    islands.forEach((is, i) => {
      is.x = 0;
      is.y = 0;
      for (let ring = placed.length ? 1 : 0, free = !placed.length; !free; ring++) {
        const d = ring * 14;
        const steps = Math.max(16, Math.round(d / 8));
        for (let step = 0; step < steps && !free; step++) {
          const a = i * 2.39996 + (step / steps) * Math.PI * 2;
          const x = Math.cos(a) * d, y = Math.sin(a) * d * 0.7;
          if (placed.every((p) => Math.hypot(p.x - x, p.y - y) >= p.R + is.R + gap)) {
            is.x = x;
            is.y = y;
            free = true;
          }
        }
      }
      placed.push(is);
    });
    if (!placed.length) return;
    const cx = (Math.min(...placed.map((p) => p.x - p.R)) + Math.max(...placed.map((p) => p.x + p.R))) / 2;
    const cy = (Math.min(...placed.map((p) => p.y - p.R)) + Math.max(...placed.map((p) => p.y + p.R))) / 2;
    for (const p of placed) {
      p.x -= cx;
      p.y -= cy;
    }
  }

  /** A relation's type as it reads in the panel and on the canvas. */
  static relationName(l) {
    return l.co ? 'co-occurs' : l.type.replace(/_/g, ' ');
  }

  constructor(canvas, { colors = {}, settings = {} } = {}) {
    if (!KnodeGraph.available) throw new Error('d3 is not available');
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colors = colors;
    this.settings = { ...KnodeGraph.DEFAULTS, ...settings };
    const css = getComputedStyle(document.documentElement);
    this.fg = css.getPropertyValue('--fg').trim() || '#d7dde6';
    this.halo = css.getPropertyValue('--bg2').trim() || '#161a21';
    this.motion = window.matchMedia?.('(prefers-reduced-motion: reduce)') ?? null;
    this.motion?.addEventListener?.('change', () => this.invalidate());
    /** Measured label widths, by font and text: labels are placed every frame, measured once. */
    this.widths = new Map();

    this.all = { nodes: [], edges: [] };
    /** The reply's communities, by id (src/graph/communities.ts). */
    this.communities = new Map();
    /** The communities in view as islands, largest first; empty when `cluster` is off or there are not two to tell apart. */
    this.islands = [];
    /** Every node object this view has ever placed, by id: a refilter keeps positions. */
    this.byId = new Map();
    this.nodes = [];
    this.links = [];
    /** One per pair of nodes in view: what is drawn and clicked (see bundleLinks). */
    this.bundles = [];
    /** Node id → neighbour id → the bundle between them. */
    this.adj = new Map();
    this.largest = new Set();
    this.hover = null;
    this.selected = null;
    this.hoverEdge = null;
    this.selectedEdge = null;
    this.matches = null;
    this.mode = 'overview';
    this.handlers = {};
    this.raf = null;
    this.t = d3.zoomIdentity;
    this.sized = false;

    this.sim = d3.forceSimulation([])
      .alphaDecay(0.025)
      .velocityDecay(0.4)
      .alphaMin(0.001)
      .force('charge', d3.forceManyBody().distanceMax(500).theta(0.9))
      .force('link', d3.forceLink([]))
      .force('x', d3.forceX(0))
      .force('y', d3.forceY(0))
      .force('collide', d3.forceCollide().iterations(1))
      // an island keeps its nodes inside its disc: hubs push the rest out to the rim, the rim holds them
      .force('island', () => {
        for (const n of this.nodes) {
          const is = n.island;
          if (!is) continue;
          const dx = n.x + n.vx - is.x, dy = n.y + n.vy - is.y;
          const d = Math.hypot(dx, dy), reach = Math.max(0, is.R - n.spacing);
          if (d <= reach || !d) continue;
          const pull = ((d - reach) / d) * 0.3;
          n.vx -= dx * pull;
          n.vy -= dy * pull;
        }
      })
      .on('tick', () => this.invalidate())
      .stop();
    this.applyForces();

    // drag before zoom: a press on a node drags it, a press elsewhere pans
    this.drag = d3.drag()
      .container(canvas)
      .subject((ev) => {
        const n = this.nodeAt(ev.x, ev.y);
        // the subject lives in screen space, so d3's offsets stay in one coordinate system
        return n ? { node: n, x: this.t.applyX(n.x), y: this.t.applyY(n.y) } : null;
      })
      .on('start', (ev) => {
        if (!ev.active) this.sim.alphaTarget(0.3).restart();
        const n = ev.subject.node;
        n.fx = n.x;
        n.fy = n.y;
      })
      .on('drag', (ev) => {
        const n = ev.subject.node;
        n.fx = this.t.invertX(ev.x);
        n.fy = this.t.invertY(ev.y);
      })
      .on('end', (ev) => {
        if (!ev.active) this.sim.alphaTarget(0);
        if (!this.settings.pin) {
          ev.subject.node.fx = null;
          ev.subject.node.fy = null;
        }
      });
    this.zoom = d3.zoom()
      .scaleExtent(KnodeGraph.ZOOM_EXTENT)
      .on('zoom', (ev) => {
        this.t = ev.transform;
        this.invalidate();
      });
    this.sel = d3.select(canvas).call(this.drag).call(this.zoom).on('dblclick.zoom', null);

    // a node under the pointer wins; otherwise the nearest edge within reach
    this.onMove = (ev) => {
      const [x, y] = d3.pointer(ev, canvas);
      const n = this.nodeAt(x, y);
      if (n !== this.hover) this.setHover(n ? n.id : null);
      const e = n ? null : this.edgeAt(x, y);
      if (e !== this.hoverEdge) this.setHoverEdge(e ? e.id : null);
    };
    this.onLeave = () => {
      this.setHover(null);
      this.setHoverEdge(null);
    };
    this.onClick = (ev) => {
      const [x, y] = d3.pointer(ev, canvas);
      const n = this.nodeAt(x, y);
      if (n) return this.select(n.id);
      const e = this.edgeAt(x, y);
      if (e) return this.selectEdge(e.id);
      this.select(null);
      this.selectEdge(null);
    };
    this.onDblClick = (ev) => {
      const [x, y] = d3.pointer(ev, canvas);
      const n = this.nodeAt(x, y);
      if (n) this.emit('open', n);
    };
    this.onKey = (ev) => {
      if (ev.key !== 'Escape') return;
      this.setHover(null);
      this.setHoverEdge(null);
      this.select(null);
      this.selectEdge(null);
    };
    canvas.addEventListener('mousemove', this.onMove);
    canvas.addEventListener('mouseleave', this.onLeave);
    canvas.addEventListener('click', this.onClick);
    canvas.addEventListener('dblclick', this.onDblClick);
    canvas.addEventListener('keydown', this.onKey);

    // the tab is display:none until shown, so the first real size arrives here
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(canvas);
    this.resize();
  }

  /* ------------------------------- events ------------------------------- */

  on(event, fn) {
    (this.handlers[event] ??= []).push(fn);
    return this;
  }

  emit(event, ...args) {
    for (const fn of this.handlers[event] ?? []) fn(...args);
  }

  /* -------------------------------- data -------------------------------- */

  /** Show a graph read: nodes as the server ranked them, so hubs seed the centre. */
  load(nodes, edges, { mode = 'overview', communities = [] } = {}) {
    this.mode = mode;
    this.all = { nodes: nodes.map((n, rank) => ({ ...n, rank })), edges: edges.map((e) => ({ ...e })) };
    this.communities = new Map(communities.map((c) => [c.id, c]));
    this.byId.clear();
    this.hover = null;
    this.selected = null;
    this.matches = null;
    this.applyFilter(1);
    this.homeView();
  }

  /** The visible subset under the current filters; positions carry over, so a toggle does not scatter the view. */
  applyFilter(alpha = 0.3) {
    const s = this.settings;
    const hidden = new Set(s.hiddenTypes);
    const hiddenFamilies = new Set(s.hiddenRelations);
    const kept = this.all.nodes.filter((n) => !hidden.has(n.type));
    const ids = new Set(kept.map((n) => n.id));
    const edges = this.all.edges.filter((e) =>
      ids.has(e.source) && ids.has(e.target) && e.source !== e.target && (s.cooccur || e.type !== 'co_occurs') && e.weight >= s.minWeight
      && !hiddenFamilies.has(KnodeGraph.family(e.type).id));
    const linked = new Set();
    for (const e of edges) {
      linked.add(e.source);
      linked.add(e.target);
    }
    const shown = s.hideOrphans ? kept.filter((n) => linked.has(n.id)) : kept;
    this.nodes = shown.map((n) => {
      let o = this.byId.get(n.id);
      if (!o) {
        // a spiral by rank: the most mentioned sit in the middle from the first frame
        const a = n.rank * 2.39996;
        const r = 14 * Math.sqrt(n.rank);
        o = { ...n, x: Math.cos(a) * r, y: Math.sin(a) * r, vx: 0, vy: 0, fx: null, fy: null, fresh: true };
        this.byId.set(n.id, o);
      }
      return o;
    });
    const objById = new Map(this.nodes.map((o) => [o.id, o]));
    this.links = edges.map((e) => ({
      source: objById.get(e.source), target: objById.get(e.target),
      type: e.type, weight: e.weight, description: e.description, co: e.type === 'co_occurs',
      fam: KnodeGraph.family(e.type), directed: !KnodeGraph.UNDIRECTED.has(e.type),
      validFrom: e.validFrom ?? null, validTo: e.validTo ?? null,
    }));
    for (const o of this.nodes) o.inDegree = 0;
    for (const l of this.links) {
      l.source.inDegree++;
      l.target.inDegree++;
    }
    this.bundles = KnodeGraph.bundleLinks(this.links);
    this.adj = new Map();
    for (const b of this.bundles) {
      (this.adj.get(b.a.id) ?? this.adj.set(b.a.id, new Map()).get(b.a.id)).set(b.b.id, b);
      (this.adj.get(b.b.id) ?? this.adj.set(b.b.id, new Map()).get(b.b.id)).set(b.a.id, b);
    }
    this.sizeNodes();
    if (this.selected && !objById.has(this.selected.id)) this.select(null);
    if (this.hover && !objById.has(this.hover.id)) this.hover = null;
    // a selected edge survives a refilter while its pair still has a relation in view, now with what is left of it
    if (this.selectedEdge) {
      const kept = this.bundles.find((b) => b.id === this.selectedEdge.id) ?? null;
      this.selectedEdge = kept;
      this.emit('selectEdge', kept);
    }
    if (this.hoverEdge) this.hoverEdge = this.bundles.find((b) => b.id === this.hoverEdge.id) ?? null;
    this.sim.nodes(this.nodes);
    this.sim.force('link').links(this.links);
    this.sim.alpha(alpha).restart();
    this.emit('stats', this.counts());
  }

  /**
   * Two radii per node, both from links: the global typed degree when the
   * server sent it, else what is in view. `spacing` is what the layout keeps
   * apart, the size nodes used to be drawn at, so a layout settles as it always
   * has. `r` is what is drawn: the log of the degree across the nodes in view,
   * 4 to 18 px times the node size, so hubs stand out even when every top
   * node has hundreds of links.
   */
  sizeNodes() {
    const scale = this.settings.nodeSize;
    const degree = (o) => (typeof o.degree === 'number' ? o.degree : o.inDegree);
    let lo = Infinity, hi = -Infinity;
    for (const o of this.nodes) {
      const v = Math.log1p(degree(o));
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    for (const o of this.nodes) {
      const d = degree(o);
      o.spacing = scale * Math.min(22, 3 + 2.2 * Math.sqrt(d));
      o.r = scale * (4 + 14 * (hi > lo ? (Math.log1p(d) - lo) / (hi - lo) : 0.5));
    }
    this.sim.force('collide').radius((d) => d.spacing + 3);
    this.placeIslands();
    // the twelve largest keep their label however far out the view is; an island's hub is named by the island's title instead
    const hubs = new Set(this.islands.map((is) => is.hub?.id));
    this.largest = new Set([...this.nodes].filter((o) => !hubs.has(o.id)).sort((a, b) => degree(b) - degree(a)).slice(0, 12).map((o) => o.id));
  }

  /**
   * The islands of the nodes in view: one per community with a member in
   * view, and one, undrawn, for the nodes that belong to none. Each is a disc
   * large enough for its nodes at the layout's spacing, placed by
   * `packIslands`; a node new to the view starts inside its island. With
   * `cluster` off, or fewer than two communities in view, there are none and
   * the layout is the single one it always was.
   */
  placeIslands() {
    const s = this.settings;
    const degree = (o) => (typeof o.degree === 'number' ? o.degree : o.inDegree);
    const groups = new Map();
    for (const o of this.nodes) {
      const id = typeof o.community === 'number' ? o.community : -1;
      (groups.get(id) ?? groups.set(id, []).get(id)).push(o);
    }
    const communities = [...groups.keys()].filter((id) => id >= 0).length;
    this.islands = [];
    if (s.cluster && communities >= 2) {
      const stretch = Math.sqrt(s.linkDistance / KnodeGraph.DEFAULTS.linkDistance);
      this.islands = [...groups.entries()]
        .map(([id, nodes]) => {
          const area = nodes.reduce((sum, o) => sum + (o.spacing + 3) ** 2, 0);
          const named = this.communities.get(id);
          const hub = id < 0 ? null : nodes.find((o) => o.id === named?.hub) ?? nodes.reduce((a, b) => (degree(b) > degree(a) ? b : a));
          return { id, nodes, hub, label: hub?.name ?? '', R: Math.sqrt(area / KnodeGraph.ISLAND_FILL) * stretch + 12, x: 0, y: 0 };
        })
        // the nodes of no community go last, to the outside
        .sort((a, b) => (a.id < 0) - (b.id < 0) || b.nodes.length - a.nodes.length || a.id - b.id);
      KnodeGraph.packIslands(this.islands);
    }
    for (const o of this.nodes) o.island = null;
    for (const is of this.islands) {
      is.nodes.forEach((o, i) => {
        o.island = is;
        if (!o.fresh) return;
        const a = i * 2.39996, r = Math.min(is.R * 0.8, 12 * Math.sqrt(i));
        o.x = is.x + Math.cos(a) * r;
        o.y = is.y + Math.sin(a) * r;
      });
    }
    for (const o of this.nodes) o.fresh = false;
    this.applyForces();
  }

  /**
   * The forces by the settings. With islands, a node is drawn to its island's
   * centre instead of the view's, twice as firmly, and a relation that crosses
   * between islands barely pulls: it is drawn, but it does not drag two
   * islands into one.
   */
  applyForces() {
    const s = this.settings;
    const islands = this.islands.length > 0;
    this.sim.force('charge').strength(-s.repel);
    this.sim.force('link')
      .distance((l) => s.linkDistance * (l.co ? 1.5 : 1) / (0.6 + 0.4 * Math.min(1, l.weight / 3)))
      .strength((l) => (l.co ? 0.12 : 0.5) * Math.min(1, l.weight / 2 + 0.25) * (islands && l.source.island !== l.target.island ? 0.03 : 1));
    const pull = islands ? Math.max(0.02, s.center) * 2 : s.center;
    this.sim.force('x').x((d) => d.island?.x ?? 0).strength(pull);
    this.sim.force('y').y((d) => d.island?.y ?? 0).strength(pull);
  }

  /** Change preferences; only what changed is recomputed, and only a force change reheats the layout. */
  setSettings(partial) {
    const prev = this.settings;
    const next = { ...prev, ...partial };
    this.settings = next;
    const changed = (k) => JSON.stringify(prev[k]) !== JSON.stringify(next[k]);
    if (KnodeGraph.FILTER_KEYS.some(changed)) this.applyFilter(0.3);
    else if (changed('nodeSize')) {
      this.sizeNodes();
      this.sim.alpha(0.2).restart();
    }
    if (KnodeGraph.ISLAND_KEYS.some(changed)) {
      this.sizeNodes();
      this.sim.alpha(0.6).restart();
      this.emit('stats', this.counts());
      // islands take more room than the single layout: bring them all into view when they appear
      if (changed('cluster') && this.islands.length) this.fit({ maxScale: 1 });
    } else if (KnodeGraph.FORCE_KEYS.some(changed)) {
      this.applyForces();
      this.sim.alpha(0.6).restart();
    }
    this.invalidate();
  }

  /** Highlight the nodes whose name holds the text; empty text clears it. */
  setQuery(text) {
    const q = String(text ?? '').trim().toLowerCase();
    this.matches = q ? new Set(this.nodes.filter((n) => n.name.toLowerCase().includes(q)).map((n) => n.id)) : null;
    this.invalidate();
  }

  setHover(id) {
    const n = id ? this.byId.get(id) ?? null : null;
    if (n === this.hover) return;
    this.hover = n;
    this.canvas.classList.toggle('over', Boolean(n));
    this.emit('hover', n);
    this.invalidate();
  }

  /** Select a node, or none. A node and an edge are never selected together. */
  select(id) {
    const n = id ? this.byId.get(id) ?? null : null;
    if (n === this.selected && !(n && this.selectedEdge)) return;
    this.selected = n;
    if (n) this.selectedEdge = null;
    this.emit('select', n);
    this.invalidate();
  }

  /** Select the edge between a pair of nodes (a bundle id), or none. */
  selectEdge(id) {
    const b = id ? this.bundles.find((x) => x.id === id) ?? null : null;
    if (b === this.selectedEdge) return;
    this.selectedEdge = b;
    if (b) this.selected = null;
    this.emit('selectEdge', b);
    this.invalidate();
  }

  setHoverEdge(id) {
    const b = id ? this.bundles.find((x) => x.id === id) ?? null : null;
    if (b === this.hoverEdge) return;
    this.hoverEdge = b;
    this.canvas.classList.toggle('over', Boolean(b || this.hover));
    this.invalidate();
  }

  /** A node's neighbours in view, one per neighbour with every relation between them, strongest first. */
  neighbours(id) {
    const out = [];
    for (const [other, b] of this.adj.get(id) ?? []) {
      const node = this.byId.get(other);
      const p = b.primary;
      if (node) out.push({ node, bundle: b, relations: b.relations, weight: b.weight, type: p.type, co: p.co, fam: p.fam, out: p.source.id === id });
    }
    return out.sort((a, b) => b.weight - a.weight);
  }

  counts() {
    return { nodes: this.nodes.length, edges: this.links.length, clusters: this.clusters().length };
  }

  /** The islands drawn, largest first: each community in view with its hub's name and how many of its nodes are in view. */
  clusters() {
    return this.islands.filter((is) => is.id >= 0).map((is) => ({ id: is.id, label: is.label, size: is.nodes.length, hub: is.hub.id }));
  }

  clear() {
    this.sim.stop();
    this.all = { nodes: [], edges: [] };
    this.communities = new Map();
    this.islands = [];
    this.byId.clear();
    this.nodes = [];
    this.links = [];
    this.bundles = [];
    this.adj.clear();
    this.hover = null;
    this.selected = null;
    this.hoverEdge = null;
    this.selectedEdge = null;
    this.matches = null;
    this.sim.nodes([]);
    this.sim.force('link').links([]);
    this.invalidate();
  }

  destroy() {
    this.sim.stop();
    this.ro.disconnect();
    this.sel.on('.zoom', null).on('.drag', null);
    const c = this.canvas;
    c.removeEventListener('mousemove', this.onMove);
    c.removeEventListener('mouseleave', this.onLeave);
    c.removeEventListener('click', this.onClick);
    c.removeEventListener('dblclick', this.onDblClick);
    c.removeEventListener('keydown', this.onKey);
    if (this.raf) cancelAnimationFrame(this.raf);
  }

  /* -------------------------------- view -------------------------------- */

  resize() {
    const c = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    c.width = Math.round(w * dpr);
    c.height = Math.round(h * dpr);
    if (!this.sized) {
      this.sized = true;
      this.homeView();
    }
    this.invalidate();
  }

  /** The origin in the middle at scale 1: where a fresh layout grows from. */
  resetView() {
    const c = this.canvas;
    if (!c.clientWidth || !c.clientHeight) return;
    this.sel.call(this.zoom.transform, d3.zoomIdentity.translate(c.clientWidth / 2, c.clientHeight / 2));
  }

  /** Where a fresh graph opens: the islands all in view when there are any, else the origin at scale 1. */
  homeView() {
    if (this.islands.length) this.fit({ duration: 0, maxScale: 1 });
    else this.resetView();
  }

  /** Bring the whole visible graph into the canvas. */
  fit({ duration = 400, maxScale = KnodeGraph.ZOOM_EXTENT[1] } = {}) {
    const c = this.canvas;
    if (!this.nodes.length || !c.clientWidth || !c.clientHeight) return;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of this.nodes) {
      x0 = Math.min(x0, n.x - n.r);
      y0 = Math.min(y0, n.y - n.r);
      x1 = Math.max(x1, n.x + n.r);
      y1 = Math.max(y1, n.y + n.r);
    }
    // an island's disc is in view with its nodes, wherever in it they have settled so far
    for (const is of this.islands) {
      if (is.id < 0) continue;
      x0 = Math.min(x0, is.x - is.R);
      y0 = Math.min(y0, is.y - is.R - 18);
      x1 = Math.max(x1, is.x + is.R);
      y1 = Math.max(y1, is.y + is.R);
    }
    const k = Math.max(KnodeGraph.ZOOM_EXTENT[0], Math.min(maxScale, 0.9 / Math.max((x1 - x0) / c.clientWidth, (y1 - y0) / c.clientHeight)));
    const t = d3.zoomIdentity.translate(c.clientWidth / 2, c.clientHeight / 2).scale(k).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
    if (duration) this.sel.transition().duration(duration).call(this.zoom.transform, t);
    else this.sel.call(this.zoom.transform, t);
  }

  /** Bring one island into the canvas. */
  fitCluster(id) {
    const is = this.islands.find((x) => x.id === id);
    if (!is) return;
    const c = this.canvas;
    const k = Math.max(KnodeGraph.ZOOM_EXTENT[0], Math.min(2.5, 0.8 / Math.max((2 * is.R) / c.clientWidth, (2 * is.R) / c.clientHeight)));
    const t = d3.zoomIdentity.translate(c.clientWidth / 2, c.clientHeight / 2).scale(k).translate(-is.x, -is.y);
    this.sel.transition().duration(400).call(this.zoom.transform, t);
  }

  /** Pan (and zoom in a little) to a node. */
  focus(id) {
    const n = this.byId.get(id);
    if (!n) return;
    const c = this.canvas;
    const k = Math.max(this.t.k, 1.2);
    const t = d3.zoomIdentity.translate(c.clientWidth / 2, c.clientHeight / 2).scale(k).translate(-n.x, -n.y);
    this.sel.transition().duration(400).call(this.zoom.transform, t);
  }

  /**
   * The node under a screen point, or null: on its drawn disc or within 5 px
   * of it, and always within HIT_PX of its centre. Kept that tight so the
   * edges between nodes stay easy to click.
   */
  nodeAt(sx, sy) {
    if (!this.nodes.length) return null;
    const [x, y] = this.t.invert([sx, sy]);
    const k = this.t.k;
    const reach = (n) => Math.max(KnodeGraph.HIT_PX / k, Math.max(n.r, 3 / k) + 5 / k);
    const n = this.sim.find(x, y, Math.max(KnodeGraph.HIT_PX / k, 18 * this.settings.nodeSize + 5 / k));
    return n && Math.hypot(n.x - x, n.y - y) <= reach(n) ? n : null;
  }

  /** The edge under a screen point: the bundle whose line passes nearest, within 6 px. */
  edgeAt(sx, sy) {
    const t = this.t;
    let best = null;
    let bestD = 6;
    for (const b of this.bundles) {
      const ax = t.applyX(b.a.x), ay = t.applyY(b.a.y);
      const dx = t.applyX(b.b.x) - ax, dy = t.applyY(b.b.y) - ay;
      const len2 = dx * dx + dy * dy;
      if (!len2) continue;
      const u = Math.max(0, Math.min(1, ((sx - ax) * dx + (sy - ay) * dy) / len2));
      const d = Math.hypot(sx - (ax + u * dx), sy - (ay + u * dy));
      if (d < bestD) {
        best = b;
        bestD = d;
      }
    }
    return best;
  }

  invalidate() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = null;
      this.draw();
    });
  }

  textWidth(text, font) {
    const key = `${font}|${text}`;
    let w = this.widths.get(key);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      this.widths.set(key, w);
    }
    return w;
  }

  /**
   * One frame, drawn in screen pixels so strokes, icons and labels keep their
   * size at any zoom: background, relations, glow, direction, nodes, labels.
   */
  draw() {
    const { canvas: c, ctx, t } = this;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth;
    const h = c.clientHeight;
    if (!w || !h) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const s = this.settings;
    const glow = Boolean(s.glow);
    const k = t.k;
    this.drawBackground(w, h, glow);
    if (!this.nodes.length) return;
    this.drawIslands(w, h, glow);

    // screen geometry, and what is on screen: what is not costs nothing
    const pad = 40;
    const pos = new Map();
    for (const n of this.nodes) {
      const x = t.applyX(n.x), y = t.applyY(n.y), r = Math.max(n.r * k, 3);
      pos.set(n.id, { n, x, y, r, on: x + r > -pad && x - r < w + pad && y + r > -pad && y - r < h + pad });
    }

    // what stands out: a hovered or selected node with its neighbours; with no node, a hovered or
    // selected edge with its two ends; else the search matches
    const focus = this.hover ?? this.selected;
    const edge = focus ? null : this.hoverEdge ?? this.selectedEdge;
    const hi = focus ? new Set([focus.id, ...(this.adj.get(focus.id)?.keys() ?? [])])
      : edge ? new Set([edge.a.id, edge.b.id]) : this.matches;
    const lit = (bd) => (focus ? bd.a.id === focus.id || bd.b.id === focus.id : edge ? bd === edge : hi.has(bd.a.id) && hi.has(bd.b.id));

    // one line per pair of nodes, one stroke per style: thousands of strokes a frame became a few dozen
    const zoomW = Math.max(0.75, Math.min(1.5, Math.sqrt(k))) * s.linkWidth;
    const rest = new Map(), bright = new Map(), chevrons = [], flows = [], mids = [];
    let chosen = null;
    for (const bd of this.bundles) {
      const a = pos.get(bd.a.id), b = pos.get(bd.b.id);
      if (!a.on && !b.on) continue;
      // the primary relation gives the line its family, and its weight the line's strength
      const l = bd.primary;
      const fam = l.fam;
      const on = hi ? lit(bd) : false;
      let alpha = fam.id === 'cooccur' ? 0.03 + 0.03 * Math.min(1, l.weight / 6)
        : fam.id === 'other' ? 0.04 + 0.05 * Math.min(1, l.weight / 3)
        : (0.1 + 0.11 * Math.min(1, l.weight / 3)) * fam.boost;
      // light-blended lines add up where they cross, so each starts fainter
      if (glow) alpha *= 0.8;
      if (hi) alpha = on ? (fam.id === 'cooccur' ? 0.4 : fam.id === 'other' ? 0.55 : 0.92) : alpha * 0.06;
      alpha = Math.round(alpha * 40) / 40;
      const width = Math.round((l.co ? 0.9 : 0.75 + 0.2 * Math.min(4, l.weight)) * (on ? 1.35 : 1) * zoomW * 4) / 4;
      const key = `${fam.id}|${alpha}|${width}`;
      const batches = on ? bright : rest;
      let bt = batches.get(key);
      if (!bt) batches.set(key, (bt = { color: fam.color, alpha, width, dash: fam.dash, segs: [] }));
      bt.segs.push(a.x, a.y, b.x, b.y);
      if (bd === this.selectedEdge) chosen = { bd, a, b, width };
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (on && (focus || edge)) {
        if (bd.forward || bd.backward) chevrons.push({ bd, a, b, alpha: 1 });
        if (!l.co) flows.push({ bd, a, b });
        // the relation names sit just below the middle, clear of a chevron there
        mids.push({ bd, x: mx, y: my + 13 });
      } else if (s.arrows && !hi && (bd.forward || bd.backward) && !l.co && k >= 0.7) {
        // the arrows setting marks every directed edge, as quietly as the edge itself
        chevrons.push({ bd, a, b, alpha: Math.min(0.6, alpha * 2.5) });
      }
    }
    if (glow) ctx.globalCompositeOperation = 'lighter';
    // the selected edge lies on a soft band of its colour, picked out in either look
    if (chosen) {
      ctx.beginPath();
      ctx.moveTo(chosen.a.x, chosen.a.y);
      ctx.lineTo(chosen.b.x, chosen.b.y);
      ctx.strokeStyle = rgba(chosen.bd.primary.fam.color, 0.28);
      ctx.lineWidth = chosen.width + 6;
      ctx.lineCap = 'round';
      ctx.stroke();
    }
    this.strokeBatches(rest);
    this.strokeBatches(bright);

    const shown = [...pos.values()].filter((g) => g.on);
    let moving = false;
    if (glow) {
      // a corona round every disc; coronas add up, so a dense cluster brightens instead of clotting
      for (const g of shown) {
        const col = this.colorOf(g.n.type);
        const dim = hi && !hi.has(g.n.id);
        const R = g.r * 2.3 + 5;
        const a = dim ? 0.12 : this.selected && g.n.id === this.selected.id ? 1.5 : 1;
        const corona = ctx.createRadialGradient(g.x, g.y, g.r * 0.85, g.x, g.y, R);
        corona.addColorStop(0, rgba(col, Math.min(0.9, 0.48 * a)));
        corona.addColorStop(0.4, rgba(col, 0.15 * a));
        corona.addColorStop(1, rgba(col, 0));
        ctx.fillStyle = corona;
        ctx.beginPath();
        ctx.arc(g.x, g.y, R, 0, Math.PI * 2);
        ctx.fill();
      }
      if (flows.length) {
        const still = this.motion?.matches ?? false;
        moving = !still;
        this.drawParticles(flows, still ? 0.35 : performance.now() / 1000);
      }
    }
    ctx.globalCompositeOperation = 'source-over';
    this.drawChevrons(chevrons, glow);

    // nodes: the faded ones first, then larger under smaller, so a small node is never buried
    shown.sort((p, q) => {
      const dp = hi && !hi.has(p.n.id) ? 0 : 1, dq = hi && !hi.has(q.n.id) ? 0 : 1;
      return dp - dq || q.r - p.r;
    });
    for (const g of shown) this.drawNode(g, hi, glow);

    const placed = this.drawLabels(pos, shown, focus, edge, hi, glow, w, h);
    if ((focus || edge) && k >= 0.75) this.drawRelationNames(mids, placed, pos, hi, edge, w, h);
    // particles keep flowing while a node or an edge is focused with glow on
    if (moving) this.invalidate();
  }

  colorOf(type) {
    return this.colors[type] ?? this.colors.other ?? '#7c8088';
  }

  /** Glow: a deep blue field. Without: the stage's own colour with a faint dot grid that moves with the view. */
  drawBackground(w, h, glow) {
    const ctx = this.ctx;
    if (glow) {
      const bg = ctx.createRadialGradient(w / 2, h * 0.45, 0, w / 2, h * 0.45, Math.max(w, h) * 0.8);
      bg.addColorStop(0, '#121730');
      bg.addColorStop(1, '#06070c');
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    const step = 40 * this.t.k;
    if (step < 14) return;
    ctx.fillStyle = 'rgba(160,175,200,.07)';
    const ox = ((this.t.x % step) + step) % step, oy = ((this.t.y % step) + step) % step;
    for (let x = ox; x < w; x += step) for (let y = oy; y < h; y += step) ctx.fillRect(x - 0.6, y - 0.6, 1.2, 1.2);
  }

  /** Each island as a faint disc under everything else: the ground its community stands on. */
  drawIslands(w, h, glow) {
    const { ctx, t } = this;
    for (const is of this.islands) {
      if (is.id < 0) continue;
      const x = t.applyX(is.x), y = t.applyY(is.y), R = is.R * t.k;
      if (x + R < 0 || x - R > w || y + R < 0 || y - R > h) continue;
      ctx.beginPath();
      ctx.arc(x, y, R, 0, Math.PI * 2);
      ctx.fillStyle = glow ? 'rgba(120,140,255,.045)' : 'rgba(160,175,200,.04)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = glow ? 'rgba(150,165,255,.16)' : 'rgba(160,175,200,.14)';
      ctx.stroke();
    }
  }

  strokeBatches(batches) {
    const ctx = this.ctx;
    for (const b of batches.values()) {
      if (b.alpha <= 0.004) continue;
      ctx.beginPath();
      for (let i = 0; i < b.segs.length; i += 4) {
        ctx.moveTo(b.segs[i], b.segs[i + 1]);
        ctx.lineTo(b.segs[i + 2], b.segs[i + 3]);
      }
      ctx.strokeStyle = rgba(b.color, b.alpha);
      ctx.lineWidth = b.width;
      ctx.setLineDash(b.dash);
      ctx.lineCap = b.dash.length ? 'round' : 'butt';
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }

  /** Light particles along focused edges: each way the edge's directed relations run, both ways when none is directed. */
  drawParticles(flows, time) {
    const ctx = this.ctx;
    for (const { bd, a, b } of flows) {
      const ways = [];
      if (bd.forward) ways.push(false);
      if (bd.backward) ways.push(true);
      if (!ways.length) ways.push(false, true);
      // a strong one-way edge carries two particles
      const n = ways.length === 1 && bd.weight > 2 ? 2 : ways.length;
      const col = mixWhite(bd.primary.fam.color, 0.45);
      for (let i = 0; i < n; i++) {
        const back = ways[i % ways.length];
        for (let tail = 0; tail < 3; tail++) {
          let p = (time * 0.22 + bd.phase + i / n - tail * 0.018) % 1;
          if (p < 0) p += 1;
          if (back) p = 1 - p;
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * p, a.y + (b.y - a.y) * p, tail ? 1.3 : 1.8, 0, Math.PI * 2);
          ctx.fillStyle = rgba(col, [0.95, 0.45, 0.2][tail]);
          ctx.fill();
        }
      }
    }
  }

  /** A chevron near the middle of an edge for each way its directed relations run; a two-way edge gets two, pointing apart. */
  drawChevrons(chevrons, glow) {
    const ctx = this.ctx;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineWidth = 1.6;
    for (const { bd, a, b, alpha } of chevrons) {
      ctx.strokeStyle = rgba(glow ? mixWhite(bd.primary.fam.color, 0.2) : bd.primary.fam.color, alpha);
      const both = bd.forward && bd.backward;
      // two-way chevrons sit well apart, clear of the relation names at the middle
      if (bd.forward) this.chevron(a, b, both ? 0.64 : 0.5);
      if (bd.backward) this.chevron(b, a, both ? 0.64 : 0.5);
    }
  }

  /** One chevron at fraction `t` of the way from `from` to `to`, pointing at `to`. */
  chevron(from, to, t) {
    const ctx = this.ctx;
    const dx = to.x - from.x, dy = to.y - from.y, d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d, sz = 4.5;
    const mx = from.x + dx * t, my = from.y + dy * t;
    ctx.beginPath();
    ctx.moveTo(mx - ux * sz - uy * sz, my - uy * sz + ux * sz);
    ctx.lineTo(mx + ux * sz * 0.6, my + uy * sz * 0.6);
    ctx.lineTo(mx - ux * sz + uy * sz, my - uy * sz - ux * sz);
    ctx.stroke();
  }

  /** A dark disc in a ring of the type's colour, the type's icon inside, and a gap round it so neighbours never merge. */
  drawNode(g, hi, glow) {
    const ctx = this.ctx;
    const col = this.colorOf(g.n.type);
    const dim = hi && !hi.has(g.n.id);
    const sel = this.selected && g.n.id === this.selected.id;
    const hov = this.hover && g.n.id === this.hover.id;
    // with glow the ring and icon run brighter and the disc takes a trace of its colour
    const ring = glow ? mixWhite(col, 0.12) : col;
    const ink = glow ? mixWhite(col, 0.25) : col;
    ctx.beginPath();
    ctx.arc(g.x, g.y, g.r + 2, 0, Math.PI * 2);
    ctx.fillStyle = glow ? 'rgba(7,8,12,.88)' : this.halo;
    ctx.fill();
    ctx.beginPath();
    ctx.arc(g.x, g.y, g.r, 0, Math.PI * 2);
    ctx.fillStyle = glow ? mixHex('#0d1019', col, dim ? 0.04 : sel || hov ? 0.26 : 0.13) : sel || hov ? '#1d2330' : '#11151c';
    ctx.fill();
    ctx.lineWidth = sel ? 2.6 : hov ? 2.1 : g.r > 8 ? 1.7 : 1.3;
    ctx.strokeStyle = rgba(ring, dim ? 0.22 : 1);
    ctx.stroke();
    if (g.r >= 6.5) KnodeGraph.icon(ctx, g.n.type, g.x, g.y, g.r * 0.5, rgba(ink, dim ? 0.18 : 0.95), g.r > 12 ? 1.5 : 1.25);
    else {
      ctx.beginPath();
      ctx.arc(g.x, g.y, Math.max(1, g.r * 0.36), 0, Math.PI * 2);
      ctx.fillStyle = rgba(ink, dim ? 0.2 : 1);
      ctx.fill();
    }
    if (sel) {
      ctx.beginPath();
      ctx.arc(g.x, g.y, g.r + 5, 0, Math.PI * 2);
      ctx.lineWidth = 1;
      ctx.strokeStyle = rgba(ring, 0.5);
      ctx.stroke();
    } else if (g.n.fx != null) {
      // pinned where it was dropped
      ctx.beginPath();
      ctx.arc(g.x, g.y, g.r + 4, 0, Math.PI * 2);
      ctx.setLineDash([2, 2.5]);
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(215,221,230,.6)';
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  /**
   * Each island's title above its rim: its hub's name and how many nodes it
   * holds. The boxes they take, so no node label is written over one.
   */
  drawIslandTitles(hi, glow, w, h) {
    const { ctx, t } = this;
    const placed = [];
    const font = `600 11px ${GRAPH_FONT}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    ctx.font = font;
    for (const is of this.islands) {
      if (is.id < 0) continue;
      const name = is.label.length > 24 ? `${is.label.slice(0, 23)}…` : is.label;
      const text = `${name} · ${is.nodes.length}`;
      const tw = this.textWidth(text, font);
      const x = t.applyX(is.x), y = t.applyY(is.y) - is.R * t.k - 10;
      const box = [x - tw / 2 - 3, y - 8, x + tw / 2 + 3, y + 8];
      if (box[2] < 0 || box[0] > w || box[3] < 0 || box[1] > h) continue;
      if (placed.some((b) => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1])) continue;
      placed.push(box);
      ctx.globalAlpha = hi ? 0.4 : 1;
      ctx.lineWidth = 3;
      ctx.strokeStyle = glow ? '#06070c' : this.halo;
      ctx.strokeText(text, x, y);
      ctx.fillStyle = glow ? '#aab4e8' : '#9aa5b8';
      ctx.fillText(text, x, y);
    }
    ctx.globalAlpha = 1;
    return placed;
  }

  /** Whether a label box would cover a node that is not faded out. */
  coversNode(box, pos, ownId, hi) {
    for (const g of pos.values()) {
      if (g.n.id === ownId || !g.on || g.r < 3 || (hi && !hi.has(g.n.id))) continue;
      const cx = Math.max(box[0], Math.min(g.x, box[2])), cy = Math.max(box[1], Math.min(g.y, box[3]));
      if (Math.hypot(cx - g.x, cy - g.y) < g.r - 1) return true;
    }
    return false;
  }

  /**
   * Labels under their nodes, most important first, each skipped when an
   * earlier label or another node holds the spot. With a highlight, its
   * nodes are labelled; otherwise labels fade in with zoom and the twelve
   * largest nodes keep theirs however far out the view is.
   */
  drawLabels(pos, shown, focus, edge, hi, glow, w, h) {
    // the focused node, or both ends of the focused edge, are always labelled, in bold
    const held = (g) => (focus ? g.n.id === focus.id : Boolean(edge) && (g.n.id === edge.a.id || g.n.id === edge.b.id));
    const ctx = this.ctx;
    const k = this.t.k;
    const fade = Math.max(0, Math.min(1, (k - this.settings.textFade) / 0.35));
    let items;
    if (focus) {
      const nb = this.neighbours(focus.id).map((x) => ({ id: x.node.id, w: x.weight + (x.co ? 0 : 2) })).sort((a, b) => b.w - a.w);
      items = [pos.get(focus.id), ...nb.map((x) => pos.get(x.id))];
    } else if (hi) {
      items = shown.filter((g) => hi.has(g.n.id));
    } else {
      const degree = (o) => (typeof o.degree === 'number' ? o.degree : o.inDegree);
      items = shown.filter((g) => this.largest.has(g.n.id) || fade >= 0.05).sort((a, b) => degree(b.n) - degree(a.n));
    }
    const placed = this.drawIslandTitles(hi, glow, w, h);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const g of items) {
      if (!g || !g.on) continue;
      const strong = held(g) || (this.selected && g.n.id === this.selected.id) || this.largest.has(g.n.id);
      const font = `${strong ? 600 : 500} 11px ${GRAPH_FONT}`;
      const text = g.n.name.length > 24 ? `${g.n.name.slice(0, 23)}…` : g.n.name;
      const tw = this.textWidth(text, font);
      const top = g.y + g.r + 3;
      const box = [g.x - tw / 2 - 2, top, g.x + tw / 2 + 2, top + 14];
      if (box[0] < 2 || box[2] > w - 2 || box[3] > h - 2) continue;
      if (placed.some((b) => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1])) continue;
      if (!held(g) && this.coversNode(box, pos, g.n.id, hi)) continue;
      placed.push(box);
      ctx.globalAlpha = hi || this.largest.has(g.n.id) ? 1 : fade;
      ctx.font = font;
      if (glow) {
        ctx.shadowColor = 'rgba(6,7,12,.9)';
        ctx.shadowBlur = 6;
      }
      ctx.lineWidth = 3;
      ctx.strokeStyle = glow ? '#06070c' : this.halo;
      ctx.strokeText(text, g.x, top + 7);
      ctx.fillStyle = glow ? '#e8ebf5' : this.fg;
      ctx.fillText(text, g.x, top + 7);
      ctx.shadowBlur = 0;
    }
    ctx.globalAlpha = 1;
    return placed;
  }

  /**
   * Relation names on lit edges, where they fit. A focused edge shows all of
   * its relations; with a focused node, its strongest edges show their
   * primary relation and how many more they hold.
   */
  drawRelationNames(mids, placed, pos, hi, edge, w, h) {
    const ctx = this.ctx;
    const font = `500 10px ${GRAPH_FONT}`;
    const named = (bd) => bd.relations.length > 1 || (!bd.primary.co && bd.primary.fam.id !== 'other');
    const items = edge ? mids : mids.filter((m) => named(m.bd)).sort((p, q) => q.bd.weight - p.bd.weight).slice(0, 14);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const m of items) {
      const names = m.bd.relations.map((r) => KnodeGraph.relationName(r));
      const text = edge
        ? names.length > 3 ? `${names.slice(0, 3).join(' · ')} +${names.length - 3}` : names.join(' · ')
        : names.length > 1 ? `${names[0]} +${names.length - 1}` : names[0];
      const tw = this.textWidth(text, font);
      const box = [m.x - tw / 2 - 3, m.y - 7, m.x + tw / 2 + 3, m.y + 7];
      if (box[0] < 2 || box[2] > w - 2 || box[1] < 2 || box[3] > h - 2) continue;
      if (placed.some((b) => b[0] < box[2] && b[2] > box[0] && b[1] < box[3] && b[3] > box[1]) || this.coversNode(box, pos, null, hi)) continue;
      placed.push(box);
      ctx.fillStyle = 'rgba(11,13,18,.82)';
      ctx.beginPath();
      if (ctx.roundRect) ctx.roundRect(box[0], box[1], box[2] - box[0], box[3] - box[1], 4);
      else ctx.rect(box[0], box[1], box[2] - box[0], box[3] - box[1]);
      ctx.fill();
      ctx.font = font;
      ctx.fillStyle = '#b9c1ce';
      ctx.fillText(text, m.x, m.y + 0.5);
    }
  }

  /** A type's icon, drawn in a unit box scaled to `s` with a `lw`-pixel line: the Mac app uses the matching SF Symbols. */
  static icon(ctx, type, x, y, s, color, lw) {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(s, s);
    ctx.lineWidth = lw / s;
    ctx.strokeStyle = color;
    ctx.fillStyle = color;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    switch (type) {
      case 'organization': // building
        ctx.rect(-0.55, -0.72, 1.1, 1.45);
        ctx.stroke();
        for (const yy of [-0.42, -0.08, 0.26]) for (const xx of [-0.22, 0.22]) ctx.fillRect(xx - 0.09, yy - 0.08, 0.18, 0.16);
        break;
      case 'person':
        ctx.arc(0, -0.36, 0.3, 0, Math.PI * 2);
        ctx.moveTo(-0.66, 0.78);
        ctx.quadraticCurveTo(-0.62, 0.06, 0, 0.06);
        ctx.quadraticCurveTo(0.62, 0.06, 0.66, 0.78);
        ctx.stroke();
        break;
      case 'product': // box
        ctx.moveTo(0, -0.78); ctx.lineTo(0.68, -0.39); ctx.lineTo(0.68, 0.39); ctx.lineTo(0, 0.78); ctx.lineTo(-0.68, 0.39); ctx.lineTo(-0.68, -0.39); ctx.closePath();
        ctx.moveTo(-0.68, -0.39); ctx.lineTo(0, 0); ctx.lineTo(0.68, -0.39); ctx.moveTo(0, 0); ctx.lineTo(0, 0.78);
        ctx.stroke();
        break;
      case 'concept': // spark
        ctx.moveTo(0, -0.82); ctx.quadraticCurveTo(0.1, -0.1, 0.82, 0); ctx.quadraticCurveTo(0.1, 0.1, 0, 0.82); ctx.quadraticCurveTo(-0.1, 0.1, -0.82, 0); ctx.quadraticCurveTo(-0.1, -0.1, 0, -0.82);
        ctx.stroke();
        break;
      case 'location': // pin
        ctx.arc(0, -0.22, 0.5, Math.PI * 0.8, Math.PI * 0.2);
        ctx.lineTo(0, 0.82);
        ctx.closePath();
        ctx.stroke();
        ctx.beginPath(); ctx.arc(0, -0.22, 0.16, 0, Math.PI * 2); ctx.fill();
        break;
      case 'event': // calendar
        ctx.rect(-0.66, -0.52, 1.32, 1.22);
        ctx.moveTo(-0.66, -0.14); ctx.lineTo(0.66, -0.14);
        ctx.moveTo(-0.32, -0.78); ctx.lineTo(-0.32, -0.36); ctx.moveTo(0.32, -0.78); ctx.lineTo(0.32, -0.36);
        ctx.stroke();
        break;
      case 'technology': // chip
        ctx.rect(-0.46, -0.46, 0.92, 0.92);
        for (const v of [-0.2, 0.2]) { ctx.moveTo(v, -0.46); ctx.lineTo(v, -0.78); ctx.moveTo(v, 0.46); ctx.lineTo(v, 0.78); ctx.moveTo(-0.46, v); ctx.lineTo(-0.78, v); ctx.moveTo(0.46, v); ctx.lineTo(0.78, v); }
        ctx.stroke();
        break;
      case 'datasource': // cylinder
        ctx.ellipse(0, -0.5, 0.62, 0.22, 0, 0, Math.PI * 2);
        ctx.moveTo(-0.62, -0.5); ctx.lineTo(-0.62, 0.5); ctx.ellipse(0, 0.5, 0.62, 0.22, 0, Math.PI, 0, true); ctx.lineTo(0.62, -0.5);
        ctx.stroke();
        break;
      case 'dataset': // table
        ctx.rect(-0.68, -0.56, 1.36, 1.12);
        ctx.moveTo(-0.68, -0.18); ctx.lineTo(0.68, -0.18); ctx.moveTo(-0.14, -0.56); ctx.lineTo(-0.14, 0.56);
        ctx.stroke();
        break;
      case 'project': // flag
        ctx.moveTo(-0.5, 0.82); ctx.lineTo(-0.5, -0.78); ctx.lineTo(0.62, -0.5); ctx.lineTo(-0.5, -0.16);
        ctx.stroke();
        break;
      case 'component': // nut
        for (let i = 0; i < 6; i++) {
          const a = Math.PI / 6 + (i * Math.PI) / 3;
          if (i) ctx.lineTo(Math.cos(a) * 0.78, Math.sin(a) * 0.78);
          else ctx.moveTo(Math.cos(a) * 0.78, Math.sin(a) * 0.78);
        }
        ctx.closePath();
        ctx.moveTo(0.3, 0); ctx.arc(0, 0, 0.3, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case 'market': // exchange: a pediment over columns
        ctx.moveTo(-0.78, -0.2); ctx.lineTo(0, -0.72); ctx.lineTo(0.78, -0.2); ctx.closePath();
        for (const xx of [-0.44, 0, 0.44]) { ctx.moveTo(xx, -0.2); ctx.lineTo(xx, 0.66); }
        ctx.moveTo(-0.8, 0.66); ctx.lineTo(0.8, 0.66);
        ctx.stroke();
        break;
      case 'index': // rising line on axes
        ctx.moveTo(-0.74, -0.74); ctx.lineTo(-0.74, 0.74); ctx.lineTo(0.78, 0.74);
        ctx.moveTo(-0.5, 0.4); ctx.lineTo(-0.1, -0.02); ctx.lineTo(0.16, 0.26); ctx.lineTo(0.66, -0.42);
        ctx.moveTo(0.36, -0.46); ctx.lineTo(0.66, -0.42); ctx.lineTo(0.64, -0.12);
        ctx.stroke();
        break;
      case 'security': // ticket
        ctx.moveTo(-0.8, -0.44); ctx.lineTo(0.8, -0.44); ctx.lineTo(0.8, -0.16);
        ctx.arc(0.8, 0, 0.16, -Math.PI / 2, Math.PI / 2, true);
        ctx.lineTo(0.8, 0.44); ctx.lineTo(-0.8, 0.44); ctx.lineTo(-0.8, 0.16);
        ctx.arc(-0.8, 0, 0.16, Math.PI / 2, -Math.PI / 2, true);
        ctx.closePath();
        ctx.moveTo(0.3, -0.44); ctx.lineTo(0.3, -0.12); ctx.moveTo(0.3, 0.12); ctx.lineTo(0.3, 0.44);
        ctx.stroke();
        break;
      case 'fund': // pie, one slice filled
        ctx.arc(0, 0, 0.74, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 0.74, -Math.PI / 2, 0); ctx.closePath(); ctx.fill();
        break;
      case 'sector': // four tiles
        for (const xx of [-0.44, 0.44]) for (const yy of [-0.44, 0.44]) ctx.rect(xx - 0.27, yy - 0.27, 0.54, 0.54);
        ctx.stroke();
        break;
      case 'theme': // tag
        ctx.rotate(Math.PI / 4);
        ctx.moveTo(-0.82, 0); ctx.lineTo(-0.36, -0.44); ctx.lineTo(0.62, -0.44); ctx.lineTo(0.62, 0.44); ctx.lineTo(-0.36, 0.44); ctx.closePath();
        ctx.stroke();
        ctx.beginPath(); ctx.arc(-0.3, 0, 0.11, 0, Math.PI * 2); ctx.fill();
        break;
      case 'indicator': // gauge with needle
        ctx.arc(0, 0.14, 0.7, Math.PI * 0.78, Math.PI * 2.22);
        ctx.stroke();
        ctx.beginPath(); ctx.moveTo(0, 0.14); ctx.lineTo(0.42, -0.34); ctx.stroke();
        ctx.beginPath(); ctx.arc(0, 0.14, 0.12, 0, Math.PI * 2); ctx.fill();
        break;
      case 'currency': // banknote
        ctx.rect(-0.8, -0.5, 1.6, 1);
        ctx.moveTo(0.24, 0); ctx.arc(0, 0, 0.24, 0, Math.PI * 2);
        ctx.moveTo(-0.52, -0.16); ctx.lineTo(-0.52, 0.16); ctx.moveTo(0.52, -0.16); ctx.lineTo(0.52, 0.16);
        ctx.stroke();
        break;
      case 'commodity': // drop
        ctx.moveTo(0, -0.82);
        ctx.bezierCurveTo(0.1, -0.5, 0.58, -0.18, 0.58, 0.22);
        ctx.arc(0, 0.22, 0.58, 0, Math.PI);
        ctx.bezierCurveTo(-0.58, -0.18, -0.1, -0.5, 0, -0.82);
        ctx.closePath();
        ctx.stroke();
        break;
      case 'policy': // scroll: a page between two rollers
        ctx.ellipse(0, -0.56, 0.78, 0.17, 0, 0, Math.PI * 2);
        ctx.moveTo(0.78, 0.56); ctx.ellipse(0, 0.56, 0.78, 0.17, 0, 0, Math.PI * 2);
        ctx.moveTo(-0.46, -0.39); ctx.lineTo(-0.46, 0.39); ctx.moveTo(0.46, -0.39); ctx.lineTo(0.46, 0.39);
        ctx.moveTo(-0.2, -0.1); ctx.lineTo(0.2, -0.1); ctx.moveTo(-0.2, 0.12); ctx.lineTo(0.2, 0.12);
        ctx.stroke();
        break;
      default: // three dots
        for (const xx of [-0.45, 0, 0.45]) { ctx.moveTo(xx + 0.13, 0); ctx.arc(xx, 0, 0.13, 0, Math.PI * 2); }
        ctx.fill();
    }
    ctx.restore();
  }
}

window.KnodeGraph = KnodeGraph;
