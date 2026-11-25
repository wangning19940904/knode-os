import Foundation

/**
 * d3-force, as the web graph runs it (web/graph.js), so the two front ends
 * settle alike: the same integrator (alpha decays 2.5 % a tick toward its
 * target, velocities keep 60 %), the same four forces in the same order —
 * many-body repulsion with a 500-unit cutoff, links with d3's degree bias,
 * x/y centring, one collision pass — and the same seed, a spiral by rank so
 * hubs start in the middle.
 *
 * Pairs are visited directly instead of through d3's Barnes–Hut tree: at the
 * 400 nodes an overview can hold that is 80,000 pair checks a tick, well
 * inside a frame, and the layout is the exact force rather than its
 * approximation.
 *
 * With islands (`load(nodes:links:islands:alpha:)`) the layout is the web
 * graph's clustered one: a node is drawn to its island's centre instead of
 * the origin, twice as firmly, a relation that crosses between islands barely
 * pulls, and a last force keeps every node inside its island's disc.
 */
@MainActor
final class GraphSimulation {
    struct Node {
        let id: String
        var x: Double
        var y: Double
        var vx = 0.0
        var vy = 0.0
        var r: Double
        /// Where a drag holds the node; the integrator writes it back each tick.
        var pinned: CGPoint?
        var rank: Int
        var degree: Int
        /// Index into `islands`; none when the layout has no islands.
        var island: Int?

        var point: CGPoint { CGPoint(x: x, y: y) }
    }

    /// An island's disc: where its nodes are drawn to, and what holds them in.
    struct IslandSpec: Equatable {
        var x: Double
        var y: Double
        var radius: Double
    }

    struct Link {
        /// Indices into `nodes`: `a` is the relation's source, `b` its target.
        let a: Int
        let b: Int
        let weight: Double
        let coOccurs: Bool
        /// The relation's predicate: which family it is drawn as.
        let type: String
        var distance = 0.0
        var strength = 0.0
        /// d3's share of the correction the target takes: the source's degree against the pair's.
        let bias: Double
    }

    struct Forces: Equatable {
        var center = 0.06
        var repel = 180.0
        var linkDistance = 90.0
    }

    /// A node as the view asks for it; one the simulation already holds keeps its place.
    struct NodeSpec {
        var id: String
        /// Position in the service's ranking: the seed spiral puts rank 0 in the middle.
        var rank: Int
        var degree: Int
        var radius: Double
        /// Index into the islands passed with it.
        var island: Int? = nil
    }

    struct LinkSpec {
        var source: String
        var target: String
        var weight: Double
        var coOccurs: Bool
        var type = "related_to"
    }

    private(set) var nodes: [Node] = []
    private(set) var links: [Link] = []
    private(set) var islands: [IslandSpec] = []
    private(set) var index: [String: Int] = [:]
    var forces = Forces() {
        didSet { if forces != oldValue { applyForces() } }
    }
    private(set) var alpha = 1.0
    /// What alpha decays toward: 0 to settle, 0.3 while a drag keeps the layout live.
    var alphaTarget = 0.0
    let alphaMin = 0.001
    let alphaDecay = 0.025
    let velocityDecay = 0.4
    private let distanceMin2 = 1.0
    private let distanceMax2 = 500.0 * 500.0

    /// Cold enough to stop ticking; a drag's alpha target keeps it false.
    var settled: Bool { alpha < alphaMin }

    /**
     * Replace what is simulated. Nodes already placed keep their position and
     * velocity, so a filter toggle does not scatter the view; new ones join on
     * the spiral, or, with islands, on a spiral inside their own island.
     * `alpha` is the heat to continue at, never a cooling.
     */
    func load(nodes specs: [NodeSpec], links linkSpecs: [LinkSpec], islands islandSpecs: [IslandSpec] = [], alpha: Double) {
        var kept: [String: Node] = [:]
        for node in nodes { kept[node.id] = node }
        islands = islandSpecs
        /// How many nodes of each island have come by: a new node's place on its island's spiral.
        var seated = [Int](repeating: 0, count: islandSpecs.count)
        nodes = specs.map { spec in
            let island = spec.island.flatMap { islandSpecs.indices.contains($0) ? $0 : nil }
            let seat = island.map { i -> Int in
                seated[i] += 1
                return seated[i] - 1
            }
            if var node = kept[spec.id] {
                node.r = spec.radius
                node.rank = spec.rank
                node.degree = spec.degree
                node.island = island
                return node
            }
            if let island, let seat {
                let home = islandSpecs[island]
                let angle = Double(seat) * 2.39996
                let radius = min(home.radius * 0.8, 12 * Double(seat).squareRoot())
                return Node(id: spec.id, x: home.x + cos(angle) * radius, y: home.y + sin(angle) * radius, r: spec.radius, rank: spec.rank, degree: spec.degree, island: island)
            }
            // a spiral by rank: the most mentioned sit in the middle from the first frame
            let angle = Double(spec.rank) * 2.39996
            let radius = 14 * Double(spec.rank).squareRoot()
            return Node(id: spec.id, x: cos(angle) * radius, y: sin(angle) * radius, r: spec.radius, rank: spec.rank, degree: spec.degree)
        }
        index = Dictionary(nodes.enumerated().map { ($1.id, $0) }, uniquingKeysWith: { first, _ in first })
        var count = [Int](repeating: 0, count: nodes.count)
        var pairs: [(a: Int, b: Int, spec: LinkSpec)] = []
        for spec in linkSpecs {
            guard let a = index[spec.source], let b = index[spec.target], a != b else { continue }
            count[a] += 1
            count[b] += 1
            pairs.append((a, b, spec))
        }
        links = pairs.map { pair in
            Link(a: pair.a, b: pair.b, weight: pair.spec.weight, coOccurs: pair.spec.coOccurs, type: pair.spec.type,
                 bias: Double(count[pair.a]) / Double(count[pair.a] + count[pair.b]))
        }
        applyForces()
        self.alpha = max(self.alpha, alpha)
    }

    /// Forget every position: the next load lays out afresh.
    func reset() {
        nodes = []
        links = []
        islands = []
        index = [:]
        alpha = 1
        alphaTarget = 0
    }

    func resize(_ radius: (Node) -> Double) {
        for i in nodes.indices { nodes[i].r = radius(nodes[i]) }
    }

    /// Warm the layout up again for a change it should react to: 0.6 after a force slider, 0.3 after a filter.
    func reheat(_ alpha: Double) {
        self.alpha = max(self.alpha, alpha)
    }

    func pin(_ id: String, at point: CGPoint) {
        guard let i = index[id] else { return }
        nodes[i].pinned = point
    }

    func unpin(_ id: String) {
        guard let i = index[id] else { return }
        nodes[i].pinned = nil
    }

    func node(_ id: String) -> Node? {
        index[id].map { nodes[$0] }
    }

    /// The node under a world point: the nearest centre within `hit` units, or within its own radius when that is larger.
    func node(at point: CGPoint, hit: Double) -> Node? {
        var best: Node?
        var bestDistance = Double.infinity
        for node in nodes {
            let d = hypot(node.x - point.x, node.y - point.y)
            if d <= max(hit, node.r), d < bestDistance {
                best = node
                bestDistance = d
            }
        }
        return best
    }

    /// One step of d3's integrator: cool, apply every force, move.
    func tick() {
        alpha += (alphaTarget - alpha) * alphaDecay
        manyBody()
        link()
        centre()
        collide()
        contain()
        let keep = 1 - velocityDecay
        for i in nodes.indices {
            if let p = nodes[i].pinned {
                nodes[i].x = p.x
                nodes[i].y = p.y
                nodes[i].vx = 0
                nodes[i].vy = 0
            } else {
                nodes[i].vx *= keep
                nodes[i].vy *= keep
                nodes[i].x += nodes[i].vx
                nodes[i].y += nodes[i].vy
            }
        }
    }

    /// Tick until settled; how many ticks it took, for tests and for a layout nobody watches.
    @discardableResult
    func settle(maxTicks: Int = 1000) -> Int {
        var n = 0
        while !settled, n < maxTicks {
            tick()
            n += 1
        }
        return n
    }

    /* ------------------------------- forces ------------------------------- */

    /**
     * Link rest length and pull, from the edge's weight: a strong typed edge
     * is short and firm, co-occurrence long and loose. Between two islands a
     * relation barely pulls: it is drawn, but it does not drag two islands
     * into one.
     */
    private func applyForces() {
        for i in links.indices {
            let link = links[i]
            let crosses = !islands.isEmpty && nodes[link.a].island != nodes[link.b].island
            links[i].distance = forces.linkDistance * (link.coOccurs ? 1.5 : 1) / (0.6 + 0.4 * min(1, link.weight / 3))
            links[i].strength = (link.coOccurs ? 0.12 : 0.5) * min(1, link.weight / 2 + 0.25) * (crosses ? 0.03 : 1)
        }
    }

    /// A tiny random offset, so two nodes at one point still push apart.
    private func jiggle() -> Double {
        (Double.random(in: 0..<1) - 0.5) * 1e-6
    }

    /// d3.forceManyBody: every pair pushes apart with strength/d², up to 500 units away.
    private func manyBody() {
        let n = nodes.count
        guard n > 1 else { return }
        let strength = -forces.repel * alpha
        let minimum2 = distanceMin2
        let maximum2 = distanceMax2
        nodes.withUnsafeMutableBufferPointer { buffer in
            for i in 0..<(n - 1) {
                let xi = buffer[i].x
                let yi = buffer[i].y
                var ax = 0.0
                var ay = 0.0
                for j in (i + 1)..<n {
                    var dx = buffer[j].x - xi
                    var dy = buffer[j].y - yi
                    var l = dx * dx + dy * dy
                    if l >= maximum2 { continue }
                    if dx == 0 { dx = jiggle(); l += dx * dx }
                    if dy == 0 { dy = jiggle(); l += dy * dy }
                    if l < minimum2 { l = (minimum2 * l).squareRoot() }
                    let w = strength / l
                    ax += dx * w
                    ay += dy * w
                    buffer[j].vx -= dx * w
                    buffer[j].vy -= dy * w
                }
                buffer[i].vx += ax
                buffer[i].vy += ay
            }
        }
    }

    /// d3.forceLink: a spring toward each link's rest length, split by the endpoints' degrees.
    private func link() {
        for link in links {
            let s = nodes[link.a]
            let t = nodes[link.b]
            var x = t.x + t.vx - s.x - s.vx
            var y = t.y + t.vy - s.y - s.vy
            if x == 0 { x = jiggle() }
            if y == 0 { y = jiggle() }
            var d = (x * x + y * y).squareRoot()
            d = (d - link.distance) / d * alpha * link.strength
            x *= d
            y *= d
            nodes[link.b].vx -= x * link.bias
            nodes[link.b].vy -= y * link.bias
            nodes[link.a].vx += x * (1 - link.bias)
            nodes[link.a].vy += y * (1 - link.bias)
        }
    }

    /// d3.forceX and forceY toward the origin, or, with islands, toward each node's island, twice as firmly.
    private func centre() {
        guard !islands.isEmpty else {
            let k = forces.center * alpha
            for i in nodes.indices {
                nodes[i].vx -= nodes[i].x * k
                nodes[i].vy -= nodes[i].y * k
            }
            return
        }
        let k = max(0.02, forces.center) * 2 * alpha
        for i in nodes.indices {
            let home = nodes[i].island.map { islands[$0] }
            nodes[i].vx -= (nodes[i].x - (home?.x ?? 0)) * k
            nodes[i].vy -= (nodes[i].y - (home?.y ?? 0)) * k
        }
    }

    /// An island keeps its nodes inside its disc: hubs push the rest out to the rim, the rim holds them.
    private func contain() {
        guard !islands.isEmpty else { return }
        for i in nodes.indices {
            guard let home = nodes[i].island.map({ islands[$0] }) else { continue }
            let dx = nodes[i].x + nodes[i].vx - home.x
            let dy = nodes[i].y + nodes[i].vy - home.y
            let d = (dx * dx + dy * dy).squareRoot()
            let reach = max(0, home.radius - nodes[i].r)
            guard d > reach, d > 0 else { continue }
            let pull = (d - reach) / d * 0.3
            nodes[i].vx -= dx * pull
            nodes[i].vy -= dy * pull
        }
    }

    /// d3.forceCollide with radius r + 3, one pass: overlapping discs are pushed apart, the smaller one further.
    private func collide() {
        let n = nodes.count
        guard n > 1 else { return }
        nodes.withUnsafeMutableBufferPointer { buffer in
            for i in 0..<(n - 1) {
                let ri = buffer[i].r + 3
                let ri2 = ri * ri
                let xi = buffer[i].x + buffer[i].vx
                let yi = buffer[i].y + buffer[i].vy
                for j in (i + 1)..<n {
                    let rj = buffer[j].r + 3
                    let r = ri + rj
                    var x = xi - buffer[j].x - buffer[j].vx
                    var y = yi - buffer[j].y - buffer[j].vy
                    var l = x * x + y * y
                    guard l < r * r else { continue }
                    if x == 0 { x = jiggle(); l += x * x }
                    if y == 0 { y = jiggle(); l += y * y }
                    let d = l.squareRoot()
                    let push = (r - d) / d
                    x *= push
                    y *= push
                    let rj2 = rj * rj
                    let share = rj2 / (ri2 + rj2)
                    buffer[i].vx += x * share
                    buffer[i].vy += y * share
                    buffer[j].vx -= x * (1 - share)
                    buffer[j].vy -= y * (1 - share)
                }
            }
        }
    }
}
