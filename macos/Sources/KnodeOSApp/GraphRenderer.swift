import AppKit
import SwiftUI

/// Measured label widths, by size, weight and text: labels are placed every frame and measured once.
final class GraphLabelMetrics {
    private var widths: [String: CGFloat] = [:]

    func width(of text: String, size: CGFloat, strong: Bool, in context: GraphicsContext) -> CGFloat {
        let key = "\(size)|\(strong ? 1 : 0)|\(text)"
        if let width = widths[key] { return width }
        let width = context.resolve(GraphRenderer.label(text, size: size, strong: strong)).measure(in: CGSize(width: 2000, height: 200)).width
        widths[key] = width
        return width
    }
}

/// The type icons: SF Symbols at medium weight, made once at a large size and scaled down per node.
@MainActor
private enum TypeSymbols {
    private static var cache: [String: NSImage] = [:]

    static func image(for type: String) -> Image? {
        let name = GraphPalette.symbol(for: type)
        if let image = cache[name] { return Image(nsImage: image).renderingMode(.template) }
        let configuration = NSImage.SymbolConfiguration(pointSize: 48, weight: .medium)
        guard let image = NSImage(systemSymbolName: name, accessibilityDescription: nil)?.withSymbolConfiguration(configuration) else { return nil }
        image.isTemplate = true
        cache[name] = image
        return Image(nsImage: image).renderingMode(.template)
    }
}

/**
 * One frame of the graph in the "Glyph + glow" look, the same as the web
 * canvas (web/graph.js): every node is a dark disc in a ring of its type's
 * colour with the type's icon inside and a canvas-coloured gap round it, so
 * neighbours never merge. The relations between a pair of nodes draw as one
 * line (`GraphScene.Bundle`) in the colour and pattern of the most specific
 * one's family. A focused node's edges, or a focused edge, go full strength,
 * with chevrons for each way their relations run and their names where they
 * fit; a selected edge lies on a soft band of its colour. `settings.glow`
 * adds a deep blue field, a corona round each disc (coronas add up, so a
 * dense cluster brightens instead of clotting), light-blended lines and
 * particles that flow along the focused edges. `scene.islands` draw under
 * everything else as faint discs, each with its hub's name and its size
 * above the rim.
 *
 * Everything is drawn in screen points, so strokes, icons and labels keep
 * their size at any zoom. Nodes are drawn at `GraphScene.displayRadius`; the
 * layout keeps them apart by the older, larger `radius`, which leaves the
 * room between them.
 */
@MainActor
struct GraphRenderer {
    var scene: GraphScene
    var nodes: [GraphSimulation.Node]
    var settings: GraphSettings
    var scale: CGFloat
    /// Where the world's origin sits, relative to the canvas centre.
    var pan: CGSize
    var hoveredID: String?
    var selectedID: String?
    /// Bundle ids, focused when no node is.
    var hoveredEdgeID: String? = nil
    var selectedEdgeID: String? = nil
    /// Seconds: where the particles are.
    var time: Double
    var reduceMotion: Bool
    var metrics: GraphLabelMetrics

    static let backgroundRGB = GraphRGB(r: 0.045, g: 0.052, b: 0.066)
    static let background = backgroundRGB.color()
    private static let discRGB = GraphRGB(0x131822)
    private static let discLitRGB = GraphRGB(0x1b2230)
    private static let glowDiscRGB = GraphRGB(0x0d1019)
    private static let ink = GraphRGB(0xdfe4ec)
    private static let glowInk = GraphRGB(0xe8ebf5)

    nonisolated static func label(_ text: String, size: CGFloat, strong: Bool) -> Text {
        Text(text).font(.system(size: size, weight: strong ? .semibold : .medium))
    }

    /// A relation's type as it reads on the canvas and in the side panel.
    nonisolated static func relationName(_ type: String) -> String {
        type == "co_occurs" ? "co-occurs" : type.replacingOccurrences(of: "_", with: " ")
    }

    private struct Spot {
        let node: GraphSimulation.Node
        let point: CGPoint
        let r: CGFloat
        let on: Bool
    }

    private struct Batch: Hashable {
        let family: String
        let alpha: Int
        let width: Int
    }

    private struct Lit {
        let bundle: GraphScene.Bundle
        let a: CGPoint
        let b: CGPoint
        let index: Int
    }

    /// Where the world point of a node is on screen, for hit testing against what is drawn.
    static func point(of node: GraphSimulation.Node, scale: CGFloat, pan: CGSize, size: CGSize) -> CGPoint {
        CGPoint(x: size.width / 2 + pan.width + node.x * scale, y: size.height / 2 + pan.height + node.y * scale)
    }

    /// Draws the frame; whether anything on it moves by itself, so the timeline keeps running.
    @discardableResult
    func draw(in context: GraphicsContext, size: CGSize) -> Bool {
        let k = scale
        let origin = CGPoint(x: size.width / 2 + pan.width, y: size.height / 2 + pan.height)
        let glow = settings.glow
        drawBackground(in: context, size: size, origin: origin, glow: glow)
        guard !nodes.isEmpty else { return false }
        drawIslands(in: context, size: size, origin: origin, glow: glow)

        // screen geometry, and what is on screen: what is not costs nothing
        let pad: CGFloat = 40
        let spots: [Spot] = nodes.map { n in
            let point = CGPoint(x: origin.x + n.x * k, y: origin.y + n.y * k)
            let radius = scene.byID[n.id].map { scene.displayRadius(of: $0, nodeSize: settings.nodeSize) } ?? 6
            let r = max(radius * k, 3)
            let on = point.x + r > -pad && point.x - r < size.width + pad && point.y + r > -pad && point.y - r < size.height + pad
            return Spot(node: n, point: point, r: r, on: on)
        }
        var spotByID: [String: Spot] = [:]
        for spot in spots { spotByID[spot.node.id] = spot }

        // what stands out: a hovered or selected node with its neighbours; with no node, a hovered or selected edge with its ends
        let focus = (hoveredID ?? selectedID).flatMap { scene.byID[$0] == nil ? nil : $0 }
        let edge = focus == nil ? (hoveredEdgeID ?? selectedEdgeID).flatMap { scene.bundle($0) } : nil
        let highlight: Set<String>? = focus.map { scene.highlight(around: $0) } ?? edge.map { [$0.a, $0.b] }
        func dimmed(_ id: String) -> Bool { highlight.map { !$0.contains(id) } ?? false }

        // one line per pair of nodes, one stroke per style: a few dozen strokes a frame instead of thousands
        let zoomWidth = min(1.5, max(0.75, Double(k).squareRoot())) * settings.linkWidth
        var rest: [Batch: Path] = [:]
        var bright: [Batch: Path] = [:]
        var chevrons: [(lit: Lit, alpha: Double)] = []
        var flows: [Lit] = []
        var middles: [(bundle: GraphScene.Bundle, point: CGPoint)] = []
        var chosen: (a: CGPoint, b: CGPoint, family: GraphPalette.Family, width: Double)?
        for (i, bundle) in scene.bundles.enumerated() {
            guard let a = spotByID[bundle.a], let b = spotByID[bundle.b], a.on || b.on else { continue }
            // the primary relation gives the line its family, and its weight the line's strength
            let primary = bundle.primary
            let family = GraphPalette.family(of: primary.type)
            let coOccurs = primary.type == "co_occurs"
            let lit = focus.map { bundle.a == $0 || bundle.b == $0 } ?? (edge.map { $0.id == bundle.id } ?? false)
            var alpha: Double = switch family.id {
            case GraphPalette.cooccurrence.id: 0.03 + 0.03 * min(1, primary.weight / 6)
            case GraphPalette.otherTyped.id: 0.04 + 0.05 * min(1, primary.weight / 3)
            default: (0.1 + 0.11 * min(1, primary.weight / 3)) * family.boost
            }
            // light-blended lines add up where they cross, so each starts fainter
            if glow { alpha *= 0.8 }
            if highlight != nil {
                alpha = lit ? (family.id == GraphPalette.cooccurrence.id ? 0.4 : family.id == GraphPalette.otherTyped.id ? 0.55 : 0.92) : alpha * 0.06
            }
            let width = (coOccurs ? 0.9 : 0.75 + 0.2 * min(4, primary.weight)) * (lit ? 1.35 : 1) * zoomWidth
            let key = Batch(family: family.id, alpha: Int((alpha * 40).rounded()), width: Int((width * 4).rounded()))
            if lit {
                bright[key, default: Path()].move(to: a.point)
                bright[key, default: Path()].addLine(to: b.point)
            } else {
                rest[key, default: Path()].move(to: a.point)
                rest[key, default: Path()].addLine(to: b.point)
            }
            if bundle.id == selectedEdgeID { chosen = (a.point, b.point, family, width) }
            let directed = bundle.forward || bundle.backward
            let item = Lit(bundle: bundle, a: a.point, b: b.point, index: i)
            if lit {
                if directed { chevrons.append((item, 1)) }
                if !coOccurs { flows.append(item) }
                // the relation names sit just below the middle, clear of a chevron there
                middles.append((bundle, CGPoint(x: (a.point.x + b.point.x) / 2, y: (a.point.y + b.point.y) / 2 + 13)))
            } else if settings.arrows && highlight == nil && directed && !coOccurs && k >= 0.7 {
                // the arrows setting marks every directed edge, as quietly as the edge itself
                chevrons.append((item, min(0.6, alpha * 2.5)))
            }
        }
        var light = context
        if glow { light.blendMode = .plusLighter }
        if let chosen {
            var band = Path()
            band.move(to: chosen.a)
            band.addLine(to: chosen.b)
            light.stroke(band, with: .color(chosen.family.rgb.color(0.28)), style: StrokeStyle(lineWidth: chosen.width + 6, lineCap: .round))
        }
        stroke(rest, in: light)
        stroke(bright, in: light)

        let shown = spots.filter(\.on)
        var moving = false
        if glow {
            for spot in shown {
                let rgb = GraphPalette.typeRGB(scene.byID[spot.node.id]?.type ?? "")
                let strength = dimmed(spot.node.id) ? 0.12 : spot.node.id == selectedID ? 1.5 : 1
                let outer = spot.r * 2.3 + 5
                let corona = Gradient(stops: [
                    .init(color: rgb.color(min(0.9, 0.48 * strength)), location: 0),
                    .init(color: rgb.color(0.15 * strength), location: 0.4),
                    .init(color: rgb.color(0), location: 1),
                ])
                light.fill(
                    Path(ellipseIn: CGRect(x: spot.point.x - outer, y: spot.point.y - outer, width: outer * 2, height: outer * 2)),
                    with: .radialGradient(corona, center: spot.point, startRadius: spot.r * 0.85, endRadius: outer)
                )
            }
            if !flows.isEmpty {
                moving = !reduceMotion
                drawParticles(flows, in: light, time: reduceMotion ? 0.35 : time)
            }
        }
        drawChevrons(chevrons, in: context, glow: glow)

        // nodes: the faded ones first, then larger under smaller, so a small node is never buried
        let order = shown.sorted { p, q in
            let dp = dimmed(p.node.id) ? 0 : 1
            let dq = dimmed(q.node.id) ? 0 : 1
            return dp != dq ? dp < dq : p.r > q.r
        }
        // each type's icon resolved once a frame, then tinted per node
        var icons: [String: GraphicsContext.ResolvedImage] = [:]
        for spot in order {
            let type = scene.byID[spot.node.id]?.type ?? ""
            if icons[type] == nil, let image = TypeSymbols.image(for: type) { icons[type] = context.resolve(image) }
            drawNode(spot, type: type, icon: icons[type], dim: dimmed(spot.node.id), glow: glow, in: context)
        }

        var placed = drawLabels(spots: spots, spotByID: spotByID, shown: shown, focus: focus, edge: edge, highlight: highlight, glow: glow, size: size, in: context)
        if (focus != nil || edge != nil) && k >= 0.75 {
            drawRelationNames(middles, placed: &placed, spots: shown, highlight: highlight, all: edge != nil, size: size, in: context)
        }
        return moving
    }

    /* ----------------------------- pieces ----------------------------- */

    /// Glow: a deep blue field. Without: the canvas colour with a faint dot grid that moves with the view.
    private func drawBackground(in context: GraphicsContext, size: CGSize, origin: CGPoint, glow: Bool) {
        let all = Path(CGRect(origin: .zero, size: size))
        if glow {
            let field = Gradient(colors: [GraphRGB(0x121730).color(), GraphRGB(0x06070c).color()])
            context.fill(all, with: .radialGradient(field, center: CGPoint(x: size.width / 2, y: size.height * 0.45), startRadius: 0, endRadius: max(size.width, size.height) * 0.8))
            return
        }
        context.fill(all, with: .color(Self.background))
        let step = 40 * scale
        guard step >= 14 else { return }
        var dots = Path()
        let ox = (origin.x.truncatingRemainder(dividingBy: step) + step).truncatingRemainder(dividingBy: step)
        let oy = (origin.y.truncatingRemainder(dividingBy: step) + step).truncatingRemainder(dividingBy: step)
        var x = ox
        while x < size.width {
            var y = oy
            while y < size.height {
                dots.addRect(CGRect(x: x - 0.6, y: y - 0.6, width: 1.2, height: 1.2))
                y += step
            }
            x += step
        }
        context.fill(dots, with: .color(Color(.sRGB, red: 160 / 255, green: 175 / 255, blue: 200 / 255, opacity: 0.07)))
    }

    /// Each island as a faint disc under everything else: the ground its community stands on.
    private func drawIslands(in context: GraphicsContext, size: CGSize, origin: CGPoint, glow: Bool) {
        let fill = glow ? GraphRGB(r: 120 / 255, g: 140 / 255, b: 1).color(0.045) : GraphRGB(r: 160 / 255, g: 175 / 255, b: 200 / 255).color(0.04)
        let rim = glow ? GraphRGB(r: 150 / 255, g: 165 / 255, b: 1).color(0.16) : GraphRGB(r: 160 / 255, g: 175 / 255, b: 200 / 255).color(0.14)
        for island in scene.islands where island.isCommunity {
            let x = origin.x + island.x * scale
            let y = origin.y + island.y * scale
            let r = island.radius * scale
            if x + r < 0 || x - r > size.width || y + r < 0 || y - r > size.height { continue }
            let disc = Path(ellipseIn: CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2))
            context.fill(disc, with: .color(fill))
            context.stroke(disc, with: .color(rim), lineWidth: 1)
        }
    }

    /**
     * Each island's title above its rim: its hub's name and how many nodes it
     * holds. The boxes they take, so no node label is written over one.
     */
    private func drawIslandTitles(highlighted: Bool, glow: Bool, size: CGSize, in context: GraphicsContext) -> [CGRect] {
        let origin = CGPoint(x: size.width / 2 + pan.width, y: size.height / 2 + pan.height)
        var placed: [CGRect] = []
        var drawn: [(text: String, point: CGPoint)] = []
        for island in scene.islands where island.isCommunity {
            let name = island.label.count > 24 ? String(island.label.prefix(23)) + "…" : island.label
            let text = "\(name) · \(island.nodeIDs.count)"
            let width = metrics.width(of: text, size: 11, strong: true, in: context)
            let point = CGPoint(x: origin.x + island.x * scale, y: origin.y + island.y * scale - island.radius * scale - 10)
            let box = CGRect(x: point.x - width / 2 - 3, y: point.y - 8, width: width + 6, height: 16)
            if box.maxX < 0 || box.minX > size.width || box.maxY < 0 || box.minY > size.height { continue }
            if placed.contains(where: { $0.intersects(box) }) { continue }
            placed.append(box)
            drawn.append((text, point))
        }
        guard !drawn.isEmpty else { return placed }
        let ink = glow ? GraphRGB(0xaab4e8) : GraphRGB(0x9aa5b8)
        context.drawLayer { layer in
            layer.addFilter(.shadow(color: (glow ? GraphRGB(0x06070c) : Self.backgroundRGB).color(0.95), radius: glow ? 4 : 2))
            layer.opacity = highlighted ? 0.4 : 1
            for title in drawn {
                layer.draw(Self.label(title.text, size: 11, strong: true).foregroundColor(ink.color()), at: title.point, anchor: .center)
            }
        }
        return placed
    }

    private func stroke(_ batches: [Batch: Path], in context: GraphicsContext) {
        for (batch, path) in batches {
            let alpha = Double(batch.alpha) / 40
            guard alpha > 0.004, let family = GraphPalette.families.first(where: { $0.id == batch.family }) else { continue }
            let style = StrokeStyle(lineWidth: Double(batch.width) / 4, lineCap: family.dash.isEmpty ? .butt : .round, dash: family.dash)
            context.stroke(path, with: .color(family.rgb.color(alpha)), style: style)
        }
    }

    /// Light particles along focused edges: each way the edge's directed relations run, both ways when none is directed.
    private func drawParticles(_ flows: [Lit], in context: GraphicsContext, time: Double) {
        var heads: [String: Path] = [:]
        var tails: [String: (near: Path, far: Path)] = [:]
        for flow in flows {
            let bundle = flow.bundle
            let family = GraphPalette.family(of: bundle.primary.type).id
            var ways: [Bool] = []
            if bundle.forward { ways.append(false) }
            if bundle.backward { ways.append(true) }
            if ways.isEmpty { ways = [false, true] }
            // a strong one-way edge carries two particles
            let count = ways.count == 1 && bundle.weight > 2 ? 2 : ways.count
            let phase = (Double(flow.index) * 0.6180339887).truncatingRemainder(dividingBy: 1)
            for i in 0..<count {
                let back = ways[i % ways.count]
                for tail in 0..<3 {
                    var p = (time * 0.22 + phase + Double(i) / Double(count) - Double(tail) * 0.018).truncatingRemainder(dividingBy: 1)
                    if p < 0 { p += 1 }
                    if back { p = 1 - p }
                    let x = flow.a.x + (flow.b.x - flow.a.x) * p
                    let y = flow.a.y + (flow.b.y - flow.a.y) * p
                    let r: CGFloat = tail == 0 ? 1.8 : 1.3
                    let dot = CGRect(x: x - r, y: y - r, width: r * 2, height: r * 2)
                    switch tail {
                    case 0: heads[family, default: Path()].addEllipse(in: dot)
                    case 1: tails[family, default: (Path(), Path())].near.addEllipse(in: dot)
                    default: tails[family, default: (Path(), Path())].far.addEllipse(in: dot)
                    }
                }
            }
        }
        for family in GraphPalette.families {
            let rgb = family.rgb.lighter(0.45)
            if let path = heads[family.id] { context.fill(path, with: .color(rgb.color(0.95))) }
            if let pair = tails[family.id] {
                context.fill(pair.near, with: .color(rgb.color(0.45)))
                context.fill(pair.far, with: .color(rgb.color(0.2)))
            }
        }
    }

    /// A chevron near the middle of an edge for each way its directed relations run; a two-way edge gets two, pointing apart.
    private func drawChevrons(_ chevrons: [(lit: Lit, alpha: Double)], in context: GraphicsContext, glow: Bool) {
        let style = StrokeStyle(lineWidth: 1.6, lineCap: .round, lineJoin: .round)
        for (lit, alpha) in chevrons {
            let family = GraphPalette.family(of: lit.bundle.primary.type)
            let shading = GraphicsContext.Shading.color((glow ? family.rgb.lighter(0.2) : family.rgb).color(alpha))
            // two-way chevrons sit well apart, clear of the relation names at the middle
            let both = lit.bundle.forward && lit.bundle.backward
            if lit.bundle.forward { context.stroke(chevron(from: lit.a, to: lit.b, at: both ? 0.64 : 0.5), with: shading, style: style) }
            if lit.bundle.backward { context.stroke(chevron(from: lit.b, to: lit.a, at: both ? 0.64 : 0.5), with: shading, style: style) }
        }
    }

    /// One chevron at fraction `t` of the way from `from` to `to`, pointing at `to`.
    private func chevron(from: CGPoint, to: CGPoint, at t: CGFloat) -> Path {
        let dx = to.x - from.x
        let dy = to.y - from.y
        let d = max(hypot(dx, dy), 1)
        let ux = dx / d
        let uy = dy / d
        let s: CGFloat = 4.5
        let mx = from.x + dx * t
        let my = from.y + dy * t
        var path = Path()
        path.move(to: CGPoint(x: mx - ux * s - uy * s, y: my - uy * s + ux * s))
        path.addLine(to: CGPoint(x: mx + ux * s * 0.6, y: my + uy * s * 0.6))
        path.addLine(to: CGPoint(x: mx - ux * s + uy * s, y: my - uy * s - ux * s))
        return path
    }

    /// A dark disc in a ring of the type's colour, the type's icon inside, and a gap round it so neighbours never merge.
    private func drawNode(_ spot: Spot, type: String, icon: GraphicsContext.ResolvedImage?, dim: Bool, glow: Bool, in context: GraphicsContext) {
        let colour = GraphPalette.typeRGB(type)
        let selected = spot.node.id == selectedID
        let hovered = spot.node.id == hoveredID
        // with glow the ring and icon run brighter and the disc takes a trace of its colour
        let ring = glow ? colour.lighter(0.12) : colour
        let ink = glow ? colour.lighter(0.25) : colour
        let p = spot.point
        let r = spot.r
        func circle(_ radius: CGFloat) -> Path {
            Path(ellipseIn: CGRect(x: p.x - radius, y: p.y - radius, width: radius * 2, height: radius * 2))
        }
        context.fill(circle(r + 2), with: .color(glow ? GraphRGB(r: 7 / 255, g: 8 / 255, b: 12 / 255).color(0.88) : Self.background))
        let disc: GraphRGB = glow
            ? Self.glowDiscRGB.mix(colour, dim ? 0.04 : selected || hovered ? 0.26 : 0.13)
            : selected || hovered ? Self.discLitRGB : Self.discRGB
        context.fill(circle(r), with: .color(disc.color()))
        context.stroke(circle(r), with: .color(ring.color(dim ? 0.22 : 1)), lineWidth: selected ? 2.6 : hovered ? 2.1 : r > 8 ? 1.7 : 1.3)
        if r >= 6.5, var image = icon {
            image.shading = .color(ink.color(dim ? 0.18 : 0.95))
            let side = r * 1.05
            let fit = min(side / max(image.size.width, 1), side / max(image.size.height, 1))
            let w = image.size.width * fit
            let h = image.size.height * fit
            context.draw(image, in: CGRect(x: p.x - w / 2, y: p.y - h / 2, width: w, height: h))
        } else {
            context.fill(circle(max(1, r * 0.36)), with: .color(ink.color(dim ? 0.2 : 1)))
        }
        if selected {
            context.stroke(circle(r + 5), with: .color(ring.color(0.5)), lineWidth: 1)
        } else if spot.node.pinned != nil {
            // held where it was dropped
            context.stroke(circle(r + 4), with: .color(Color(white: 0.86, opacity: 0.6)), style: StrokeStyle(lineWidth: 1, dash: [2, 2.5]))
        }
    }

    /// Whether a label box would cover a node that is not faded out.
    private func coversNode(_ box: CGRect, spots: [Spot], ownID: String?, highlight: Set<String>?) -> Bool {
        for spot in spots where spot.node.id != ownID && spot.r >= 3 {
            if let highlight, !highlight.contains(spot.node.id) { continue }
            let cx = max(box.minX, min(spot.point.x, box.maxX))
            let cy = max(box.minY, min(spot.point.y, box.maxY))
            if hypot(cx - spot.point.x, cy - spot.point.y) < spot.r - 1 { return true }
        }
        return false
    }

    /**
     * Labels under their nodes, most important first, each skipped when an
     * earlier label or another node holds the spot. A focused node and its
     * neighbours are labelled, or a focused edge's two ends; otherwise labels
     * fade in with zoom and the twelve largest nodes keep theirs however far
     * out the view is.
     */
    private func drawLabels(spots: [Spot], spotByID: [String: Spot], shown: [Spot], focus: String?, edge: GraphScene.Bundle?, highlight: Set<String>?, glow: Bool, size: CGSize, in context: GraphicsContext) -> [CGRect] {
        let fade = max(0, min(1, (Double(scale) - settings.textFade) / 0.35))
        // the focused node, or both ends of the focused edge, are always labelled, in bold
        func held(_ id: String) -> Bool { focus.map { $0 == id } ?? (edge.map { $0.a == id || $0.b == id } ?? false) }
        var items: [Spot]
        if let focus, let spot = spotByID[focus] {
            let neighbours = (scene.neighbours[focus] ?? [])
                .map { (id: $0.node.id, rank: $0.bundle.weight + ($0.edge.type == "co_occurs" ? 0 : 2)) }
                .sorted { $0.rank > $1.rank }
            items = [spot] + neighbours.compactMap { spotByID[$0.id] }
        } else if let edge {
            items = [edge.a, edge.b].compactMap { spotByID[$0] }
        } else {
            items = shown.filter { scene.largest.contains($0.node.id) || fade >= 0.05 }
                .sorted { scene.degree(ofID: $0.node.id) > scene.degree(ofID: $1.node.id) }
        }
        var placed = drawIslandTitles(highlighted: highlight != nil, glow: glow, size: size, in: context)
        var drawn: [(text: String, strong: Bool, point: CGPoint, alpha: Double)] = []
        for spot in items where spot.on {
            guard let node = scene.byID[spot.node.id] else { continue }
            let strong = held(spot.node.id) || spot.node.id == selectedID || scene.largest.contains(spot.node.id)
            let text = node.name.count > 24 ? String(node.name.prefix(23)) + "…" : node.name
            let width = metrics.width(of: text, size: 11, strong: strong, in: context)
            let box = CGRect(x: spot.point.x - width / 2 - 2, y: spot.point.y + spot.r + 3, width: width + 4, height: 14)
            if box.minX < 2 || box.maxX > size.width - 2 || box.maxY > size.height - 2 { continue }
            if placed.contains(where: { $0.intersects(box) }) { continue }
            if !held(spot.node.id) && coversNode(box, spots: shown, ownID: spot.node.id, highlight: highlight) { continue }
            placed.append(box)
            drawn.append((text, strong, CGPoint(x: spot.point.x, y: box.midY), highlight != nil || scene.largest.contains(spot.node.id) ? 1 : fade))
        }
        let ink = glow ? Self.glowInk : Self.ink
        context.drawLayer { layer in
            layer.addFilter(.shadow(color: (glow ? GraphRGB(0x06070c) : Self.backgroundRGB).color(0.95), radius: glow ? 4 : 2))
            for label in drawn {
                layer.opacity = label.alpha
                layer.draw(Self.label(label.text, size: 11, strong: label.strong).foregroundColor(ink.color()), at: label.point, anchor: .center)
            }
        }
        return placed
    }

    /**
     * Relation names on lit edges, where they fit. A focused edge (`all`)
     * shows every one of its relations; with a focused node, its strongest
     * edges show their primary relation and how many more they hold.
     */
    private func drawRelationNames(_ middles: [(bundle: GraphScene.Bundle, point: CGPoint)], placed: inout [CGRect], spots: [Spot], highlight: Set<String>?, all: Bool, size: CGSize, in context: GraphicsContext) {
        func named(_ bundle: GraphScene.Bundle) -> Bool {
            bundle.relations.count > 1
                || (bundle.primary.type != "co_occurs" && GraphPalette.family(of: bundle.primary.type).id != GraphPalette.otherTyped.id)
        }
        let items = all ? Array(middles) : Array(middles.filter { named($0.bundle) }.sorted { $0.bundle.weight > $1.bundle.weight }.prefix(14))
        for item in items {
            let names = item.bundle.relations.map { Self.relationName($0.type) }
            let text = all
                ? (names.count > 3 ? names.prefix(3).joined(separator: " · ") + " +\(names.count - 3)" : names.joined(separator: " · "))
                : (names.count > 1 ? "\(names[0]) +\(names.count - 1)" : names[0])
            let width = metrics.width(of: text, size: 10, strong: false, in: context)
            let box = CGRect(x: item.point.x - width / 2 - 3, y: item.point.y - 7, width: width + 6, height: 14)
            if box.minX < 2 || box.maxX > size.width - 2 || box.minY < 2 || box.maxY > size.height - 2 { continue }
            if placed.contains(where: { $0.intersects(box) }) || coversNode(box, spots: spots, ownID: nil, highlight: highlight) { continue }
            placed.append(box)
            context.fill(Path(roundedRect: box, cornerRadius: 4), with: .color(GraphRGB(r: 11 / 255, g: 13 / 255, b: 18 / 255).color(0.82)))
            context.draw(Self.label(text, size: 10, strong: false).foregroundColor(GraphRGB(0xb9c1ce).color()), at: CGPoint(x: box.midX, y: box.midY), anchor: .center)
        }
    }
}
