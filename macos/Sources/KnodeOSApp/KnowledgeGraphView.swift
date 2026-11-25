import AppKit
import SwiftUI

/// Where a graph read came from: the overview, or the local graph around a name.
private enum GraphMode: Equatable {
    case overview
    case search(String)
}

/**
 * Knowledge → Graph: the knowledge graph the way Obsidian draws one. A force
 * layout (`GraphSimulation`, d3-force's integrator) settles and sleeps; nodes
 * are sized by their links and drawn by type, relations by family
 * (`GraphRenderer`, with an optional glow); hovering isolates a
 * neighbourhood; the view zooms, pans and lets nodes be dragged; labels fade
 * in with zoom. An empty search is the overview — the top entities by
 * mentions — and a name is the local graph around it, ranked by relevance.
 * With the clusters setting the reply's communities are laid out as islands
 * (`GraphScene.islands`), listed in the side panel, where a click brings one
 * into view.
 */
struct KnowledgeGraphView: View {
    @EnvironmentObject private var model: AppModel
    @AppStorage(GraphSettings.storageKey) private var settingsJSON = ""
    @State private var settings: GraphSettings
    @State private var query = ""
    @State private var depth = 2
    @State private var mode = GraphMode.overview
    @State private var response: GraphResponse?
    @State private var scene = GraphScene()
    @State private var sim = GraphSimulation()
    @State private var selectedNodeID: String?
    /// A bundle: the relations between one pair of nodes. Never selected together with a node.
    @State private var selectedEdgeID: String?
    @State private var insights: GraphInsights?
    @State private var isLoading = true
    @State private var showingInsights = false
    @State private var showingSettings = false
    /// Bumped on every reply: the canvas returns to the origin at scale 1.
    @State private var generation = 0
    /// Bumped whenever the layout is warmed up again: the canvas resumes ticking.
    @State private var heat = 0
    /// The island the side panel asked to see; `tick` tells one request from the next for the same island.
    @State private var shownIsland = IslandRequest(id: -1, tick: 0)

    init() {
        _settings = State(initialValue: GraphSettings(json: UserDefaults.standard.string(forKey: GraphSettings.storageKey)))
    }

    private var selectedNode: GraphNode? {
        selectedNodeID.flatMap { scene.byID[$0] }
    }

    private var selectedEdge: GraphScene.Bundle? {
        selectedEdgeID.flatMap { scene.bundle($0) }
    }

    private var isSearch: Bool {
        if case .search = mode { return true }
        return false
    }

    var body: some View {
        VStack(spacing: 0) {
            graphBar
            Divider()
            if isLoading && response == nil {
                ProgressView(L("Building graph view…"))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let response, !response.nodes.isEmpty {
                HSplitView {
                    ZStack(alignment: .topLeading) {
                        GraphCanvas(scene: scene, sim: sim, settings: settings, generation: generation, heat: heat, shownIsland: shownIsland, selectedID: $selectedNodeID, selectedEdgeID: $selectedEdgeID) { node in
                            query = node.name
                            Task { await loadGraph() }
                        }
                        GraphLegend(typeCounts: scene.typeCounts, familyCounts: scene.familyCounts, settings: $settings)
                            .padding(12)
                        caption
                            .padding(12)
                            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottomLeading)
                    }
                    .frame(minWidth: 500, maxWidth: .infinity, maxHeight: .infinity)
                    sidePanel(response)
                        .frame(minWidth: 330, idealWidth: 390, maxWidth: 480)
                }
            } else {
                EmptyState(
                    symbol: "point.3.connected.trianglepath.dotted",
                    title: L("The graph is empty"),
                    message: L("Index documents with wikilinks or configure entity extraction to create nodes and relations."),
                    actionTitle: L("Go to Files"),
                    action: { model.select(.files) }
                )
            }
        }
        .background(Color(nsColor: .textBackgroundColor).opacity(0.22))
        .task {
            // Entities → Explore in graph hands the name over through the model
            if let pending = model.consumePendingGraphQuery() { query = pending }
            await loadGraph()
        }
        .onChange(of: settings) { old, new in apply(old, new) }
        // a node and an edge are never selected together: picking one lets go of the other
        .onChange(of: selectedNodeID) { _, id in if id != nil { selectedEdgeID = nil } }
        .onChange(of: selectedEdgeID) { _, id in if id != nil { selectedNodeID = nil } }
        .sheet(isPresented: $showingInsights) {
            InsightsSheet(insights: insights)
        }
    }

    /* -------------------------------- bars -------------------------------- */

    private var graphBar: some View {
        HStack(spacing: 10) {
            Image(systemName: "point.3.connected.trianglepath.dotted")
                .foregroundStyle(Color.knodeViolet)
            TextField(L("Graph search — entity, product, concept…"), text: $query)
                .textFieldStyle(.plain)
                .font(.title3)
                .onSubmit { Task { await loadGraph() } }
            Picker(L("Depth"), selection: $depth) {
                Text(L("1 hop")).tag(1)
                Text(L("2 hops")).tag(2)
                Text(L("3 hops")).tag(3)
            }
            .frame(width: 110)
            Button(L("Explore")) { Task { await loadGraph() } }
                .buttonStyle(.borderedProminent)
                .tint(.knodeViolet)
                .disabled(isLoading)
            if isSearch {
                Button(L("Overview")) {
                    query = ""
                    Task { await loadGraph() }
                }
                .disabled(isLoading)
            }
            Button("Insights", systemImage: "chart.bar.xaxis") { Task { await loadInsights() } }
                .disabled(isLoading)
            Button(L("Settings"), systemImage: "slider.horizontal.3") { showingSettings.toggle() }
                .popover(isPresented: $showingSettings, arrowEdge: .bottom) {
                    GraphSettingsPanel(settings: $settings)
                }
            if isLoading { ProgressView().controlSize(.small) }
        }
        .padding(.horizontal, 18)
        .frame(height: 60)
        .background(.bar)
    }

    /// What the canvas shows and how big it is.
    private var caption: some View {
        let hops = depth == 1 ? L("1 hop") : L("%@ hops", String(depth))
        let what: String = switch mode {
        case .overview: L("overview · top %@ by mentions", String(settings.limit))
        case .search(let name): L("local graph · “%@” · %@ · ranked by relevance", name, hops)
        }
        let clusters = scene.communities.count
        let line = clusters > 0
            ? L("%@ · %@ nodes · %@ edges · %@ clusters", what, scene.nodes.count.formatted(), scene.edges.count.formatted(), clusters.formatted())
            : L("%@ · %@ nodes · %@ edges", what, scene.nodes.count.formatted(), scene.edges.count.formatted())
        return Text(line)
            .font(.caption2.monospaced())
            .foregroundStyle(.secondary)
            .padding(.horizontal, 9)
            .padding(.vertical, 5)
            .background(.thickMaterial, in: Capsule())
    }

    /* ------------------------------ side panel ----------------------------- */

    private func sidePanel(_ response: GraphResponse) -> some View {
        VStack(spacing: 0) {
            if let edge = selectedEdge {
                edgeCard(edge)
                Divider()
            } else if let node = selectedNode {
                selectedCard(node)
                Divider()
            }
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let edge = selectedEdge {
                        relationList(edge)
                    } else if let node = selectedNode {
                        neighbourList(node)
                        claimList(node)
                    } else {
                        topList(response)
                    }
                    if !response.chunks.isEmpty {
                        chunkList(response.chunks)
                    }
                }
                .padding(14)
            }
        }
        .background(.ultraThinMaterial)
    }

    private func selectedCard(_ node: GraphNode) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                RouteBadge(label: node.type, color: nodeColor(node.type))
                Spacer()
                Button { selectedNodeID = nil } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(L("Clear selection"))
            }
            Text(node.name).font(.title2.bold())
            if !node.description.isEmpty {
                Text(node.description).font(.callout).foregroundStyle(.secondary)
            }
            Text(numbers(node))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
            HStack(spacing: 8) {
                Button(L("Local graph"), systemImage: "arrow.triangle.branch") {
                    query = node.name
                    Task { await loadGraph() }
                }
                .buttonStyle(.borderedProminent)
                .tint(.knodeViolet)
                Button(L("Open wiki page"), systemImage: "book.closed") {
                    if let path = node.wikiPath { model.openFile(path) }
                }
                .disabled(node.wikiPath == nil)
                .help(node.wikiPath.map { L("Open %@", $0) } ?? L("No wiki page yet"))
            }
            .controlSize(.small)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.knodeViolet.opacity(0.07))
    }

    /// The selected edge: its two ends, each a way to that node, and how many distinct relationships it holds.
    private func edgeCard(_ edge: GraphScene.Bundle) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Eyebrow(text: L("Relationship"), color: .knodeViolet)
                Spacer()
                Button { selectedEdgeID = nil } label: {
                    Image(systemName: "xmark.circle.fill")
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help(L("Clear selection"))
            }
            ForEach([edge.a, edge.b], id: \.self) { id in
                if let node = scene.byID[id] {
                    Button { selectedNodeID = id } label: {
                        HStack(spacing: 8) {
                            RouteBadge(label: node.type, color: nodeColor(node.type))
                            Text(node.name).font(.title3.bold()).lineLimit(1)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(L("Select this node"))
                }
            }
            Text(edge.relations.count == 1 ? L("1 relationship between them") : L("%@ distinct relationships between them", String(edge.relations.count)))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.knodeViolet.opacity(0.07))
    }

    /// Each distinct relationship in the selected edge: its family, which way it runs, its weight, what the source said and when it holds.
    @ViewBuilder
    private func relationList(_ edge: GraphScene.Bundle) -> some View {
        ForEach(Array(edge.relations.enumerated()), id: \.offset) { _, relation in
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 8) {
                    Capsule()
                        .fill(GraphPalette.family(of: relation.type).color)
                        .frame(width: 14, height: 3)
                    Text(relation.type == "co_occurs" ? L("co-occurs") : GraphRenderer.relationName(relation.type))
                        .font(.callout.weight(.semibold))
                    Spacer()
                    Text(L("weight %@", String(format: "%.1f", relation.weight)))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                Text(direction(of: relation, in: edge))
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                if !relation.description.isEmpty {
                    Text(relation.description)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if relation.validFrom != nil || relation.validTo != nil {
                    Text(L("valid %@ – %@", relation.validFrom ?? "…", relation.validTo ?? "…"))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
            }
            .padding(11)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 9))
            .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.07)) }
        }
    }

    /// A directed relation reads source → target; an undirected one joins the two ends.
    private func direction(of relation: GraphEdge, in edge: GraphScene.Bundle) -> String {
        let name = { (id: String) in scene.byID[id]?.name ?? id }
        return GraphPalette.undirected.contains(relation.type)
            ? "\(name(edge.a)) ↔ \(name(edge.b))"
            : "\(name(relation.source)) → \(name(relation.target))"
    }

    /// Mentions in an overview; in a search also the relevance to the query, which is what ranked the node.
    private func numbers(_ node: GraphNode) -> String {
        var parts = [L("%@ mentions", String(node.mentionCount)), L("degree %@", String(scene.degree(of: node)))]
        if isSearch { parts.insert(L("relevance %@", String(format: "%.2f", node.score)), at: 0) }
        return parts.joined(separator: " · ")
    }

    /// A neighbour's relations, short: the first two, then how many more.
    private func relationSummary(_ edge: GraphScene.Bundle) -> String {
        let names = edge.relations.map { $0.type == "co_occurs" ? L("co-occurs") : $0.type }
        return names.count > 2 ? names.prefix(2).joined(separator: " · ") + " +\(names.count - 2)" : names.joined(separator: " · ")
    }

    @ViewBuilder
    private func neighbourList(_ node: GraphNode) -> some View {
        let neighbours = scene.neighbours[node.id] ?? []
        Text(neighbours.isEmpty ? L("No neighbours in view") : L("%@ neighbours in view", String(neighbours.count)))
            .font(.headline)
        ForEach(Array(neighbours.prefix(40).enumerated()), id: \.offset) { _, item in
            Button { selectedNodeID = item.node.id } label: {
                HStack(spacing: 8) {
                    RouteBadge(label: item.node.type, color: nodeColor(item.node.type))
                    Text(item.node.name)
                        .font(.callout)
                        .lineLimit(1)
                    Spacer()
                    Capsule()
                        .fill(GraphPalette.family(of: item.edge.type).color)
                        .frame(width: 10, height: 2)
                    Text(String(format: "%@ %.1f", relationSummary(item.bundle), item.bundle.weight))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                }
                .padding(9)
                .contentShape(Rectangle())
                .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 9))
                .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.07)) }
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func claimList(_ node: GraphNode) -> some View {
        let claims = claims(for: node).prefix(5)
        if !claims.isEmpty {
            Divider().padding(.vertical, 8)
            Text(L("Claims")).font(.headline)
            ForEach(Array(claims)) { claim in
                Label(claim.statement, systemImage: "seal")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(3)
            }
        }
    }

    /// The islands on the canvas, largest first: a click brings one into view.
    @ViewBuilder
    private var clusterList: some View {
        let clusters = scene.communities
        if !clusters.isEmpty {
            Text(L("Clusters")).font(.headline)
            FlowLayout(spacing: 6) {
                ForEach(clusters) { island in
                    Button { shownIsland = IslandRequest(id: island.id, tick: shownIsland.tick + 1) } label: {
                        Text("\(island.label.count > 22 ? String(island.label.prefix(21)) + "…" : island.label) · \(island.nodeIDs.count)")
                            .font(.caption)
                            .lineLimit(1)
                            .fixedSize()
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(Color.white.opacity(0.04), in: Capsule())
                            .overlay { Capsule().stroke(Color.white.opacity(0.1)) }
                            .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .help(L("Show this cluster"))
                }
            }
            Divider().padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func topList(_ response: GraphResponse) -> some View {
        clusterList
        HStack {
            Text(L("Entities")).font(.headline)
            Spacer()
            Text(L("%@ nodes · %@ relations", String(scene.nodes.count), String(scene.edges.count)))
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
        }
        ForEach(scene.nodes.prefix(40)) { node in
            Button { selectedNodeID = node.id } label: {
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        RouteBadge(label: node.type, color: nodeColor(node.type))
                        Text(node.name).font(.callout.weight(.semibold)).lineLimit(1)
                        Spacer()
                    }
                    Text(numbers(node))
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                    if !node.description.isEmpty {
                        Text(node.description).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                    }
                    ForEach(claims(for: node).prefix(2)) { claim in
                        Label(claim.statement, systemImage: "seal")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                .padding(11)
                .contentShape(Rectangle())
                .background(Color.white.opacity(0.025), in: RoundedRectangle(cornerRadius: 9))
                .overlay { RoundedRectangle(cornerRadius: 9).stroke(Color.white.opacity(0.07)) }
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private func chunkList(_ chunks: [SearchResult]) -> some View {
        var seen = Set<String>()
        let paths = chunks.map(\.path).filter { seen.insert($0).inserted }
        Divider().padding(.vertical, 8)
        Text(L("Grounded in")).font(.headline)
        ForEach(paths, id: \.self) { path in
            Button { model.openFile(path) } label: {
                Label(path, systemImage: "doc.text")
                    .font(.caption.monospaced())
                    .lineLimit(1)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .buttonStyle(.plain)
            .foregroundStyle(Color.knodeCyan)
        }
    }

    private func claims(for node: GraphNode) -> [Claim] {
        (response?.claims ?? []).filter { $0.subject == node.name }
    }

    /* -------------------------------- data -------------------------------- */

    /// A preference changed: keep it, then do the least that shows it.
    private func apply(_ old: GraphSettings, _ new: GraphSettings) {
        settingsJSON = new.json
        guard response != nil else { return }
        if new.needsRefetch(from: old, overview: !isSearch) {
            Task { await loadGraph() }
            return
        }
        // islands are sized by the node size and the link distance: a change to either, or to whether there are any, places them again
        let islandsMove = new.islandsDiffer(from: old) && (new.cluster != old.cluster || !scene.islands.isEmpty)
        if new.filtersDiffer(from: old) {
            rebuildScene(alpha: 0.3)
        } else if islandsMove {
            rebuildScene(alpha: new.cluster != old.cluster || new.linkDistance != old.linkDistance ? 0.6 : 0.2)
            // islands take more room than the single layout: bring them all into view when they appear
            if new.cluster && !old.cluster && !scene.islands.isEmpty { generation += 1 }
        } else if new.nodeSize != old.nodeSize {
            let scene = scene
            sim.resize { node in scene.byID[node.id].map { scene.radius(of: $0, nodeSize: new.nodeSize) } ?? node.r }
            sim.reheat(0.2)
            heat += 1
        }
        if new.forces != old.forces {
            sim.forces = new.forces
            sim.reheat(0.6)
            heat += 1
        }
    }

    /// The visible subset under the current filters; positions carry over, so a toggle does not scatter the view.
    private func rebuildScene(alpha: Double) {
        guard let response else { return }
        scene = GraphScene(response: response, settings: settings)
        sim.load(nodes: scene.nodeSpecs(nodeSize: settings.nodeSize), links: scene.linkSpecs, islands: scene.islandSpecs, alpha: alpha)
        if let selectedNodeID, scene.byID[selectedNodeID] == nil { self.selectedNodeID = nil }
        // a selected edge stays while its pair still has a relation in view, showing what is left of it
        if let selectedEdgeID, scene.bundle(selectedEdgeID) == nil { self.selectedEdgeID = nil }
        heat += 1
    }

    private func loadGraph() async {
        isLoading = true
        defer { isLoading = false }
        let text = query.trimmingCharacters(in: .whitespacesAndNewlines)
        do {
            // the co-occurrence join is the slow part of an overview: skip it when it will not be drawn
            let reply = try await model.client().graph(
                query: text,
                depth: depth,
                limit: settings.limit,
                edges: text.isEmpty && !settings.cooccur ? "typed" : nil
            )
            mode = text.isEmpty ? .overview : .search(text)
            response = reply
            selectedNodeID = nil
            selectedEdgeID = nil
            sim.reset()
            rebuildScene(alpha: 1)
            // a local graph opens on the entity it was asked for
            if !text.isEmpty {
                selectedNodeID = scene.nodes.first { $0.name.caseInsensitiveCompare(text) == .orderedSame }?.id ?? scene.nodes.first?.id
            }
            generation += 1
            await model.refreshStats()
        } catch {
            response = nil
            selectedNodeID = nil
            selectedEdgeID = nil
            model.showError(error, prefix: "Graph failed")
        }
    }

    private func loadInsights() async {
        isLoading = true
        defer { isLoading = false }
        do {
            insights = try await model.client().graphInsights()
            showingInsights = true
        } catch {
            model.showError(error, prefix: "Insights failed")
        }
    }
}

/// A request to bring one island into view.
private struct IslandRequest: Equatable {
    var id: Int
    var tick: Int
}

/* ================================ canvas ================================ */

/**
 * The drawing and the pointer. A `TimelineView` drives the simulation one
 * tick a frame until it settles, then pauses, so a still graph costs nothing;
 * a drag, a filter or a slider resumes it, and so does a focused node or
 * edge while glow is on, whose lines carry moving particles. `GraphRenderer`
 * draws each frame in screen points. The pointer finds a node first, on its
 * disc or just round it, and otherwise the nearest edge. A fresh graph
 * opens at the origin at scale 1, or, with islands, with all of them in view.
 */
private struct GraphCanvas: View {
    let scene: GraphScene
    let sim: GraphSimulation
    let settings: GraphSettings
    let generation: Int
    let heat: Int
    let shownIsland: IslandRequest
    @Binding var selectedID: String?
    /// A bundle id: the relations between one pair of nodes.
    @Binding var selectedEdgeID: String?
    /// A double-click on a node: open the local graph around it.
    let onOpen: (GraphNode) -> Void

    @State private var scale: CGFloat = 1
    /// Where the world's origin sits, relative to the canvas centre.
    @State private var pan = CGSize.zero
    @State private var hoveredID: String?
    @State private var hoveredEdgeID: String?
    @State private var paused = false
    @State private var drag: DragState?
    @State private var magnifyStart: CGFloat?
    @State private var lastTap: (id: String, at: Date)?
    @State private var metrics = GraphLabelMetrics()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private enum DragState {
        case node(String)
        case pan(CGSize)
    }

    private static let zoomRange: ClosedRange<CGFloat> = 0.15...8

    /// Particles flow along a focused node's or edge's lines while glow is on: the timeline keeps running after the layout settles.
    private var flowing: Bool {
        settings.glow && !reduceMotion && (hoveredID ?? selectedID ?? hoveredEdgeID ?? selectedEdgeID) != nil
    }

    var body: some View {
        GeometryReader { geometry in
            let size = geometry.size
            TimelineView(.animation(paused: paused)) { timeline in
                Canvas(rendersAsynchronously: false) { context, size in
                    step()
                    renderer(time: timeline.date.timeIntervalSinceReferenceDate).draw(in: context, size: size)
                }
            }
            .background(ScrollWheelCatcher { event in handleScroll(event, size: size) })
            .onAppear { home(size) }
            .onChange(of: generation) {
                home(size)
                hoveredID = nil
                hoveredEdgeID = nil
                paused = false
            }
            .onChange(of: shownIsland) { _, request in show(island: request.id, size: size) }
            .contentShape(Rectangle())
            .gesture(dragGesture(size: size))
            .simultaneousGesture(magnifyGesture(size: size))
            .onContinuousHover(coordinateSpace: .local) { phase in
                switch phase {
                case .active(let point):
                    let id = nodeID(at: point, size)
                    if id != hoveredID { hoveredID = id }
                    let edge = id == nil ? edgeID(at: point, size) : nil
                    if edge != hoveredEdgeID { hoveredEdgeID = edge }
                case .ended:
                    hoveredID = nil
                    hoveredEdgeID = nil
                }
            }
        }
        .background(GraphRenderer.background)
        .onChange(of: heat) { paused = false }
        .onChange(of: flowing) { _, now in if now { paused = false } }
    }

    /// Where a fresh graph opens: the islands all in view when there are any, else the origin at scale 1.
    private func home(_ size: CGSize) {
        let discs = scene.communities
        guard !discs.isEmpty, size.width > 0, size.height > 0 else {
            scale = 1
            pan = .zero
            return
        }
        // an island's title sits above its rim: leave room for it
        var x0 = discs.map { $0.x - $0.radius }.min() ?? 0
        var x1 = discs.map { $0.x + $0.radius }.max() ?? 0
        var y0 = discs.map { $0.y - $0.radius - 18 }.min() ?? 0
        var y1 = discs.map { $0.y + $0.radius }.max() ?? 0
        for node in sim.nodes {
            x0 = min(x0, node.x - node.r)
            x1 = max(x1, node.x + node.r)
            y0 = min(y0, node.y - node.r)
            y1 = max(y1, node.y + node.r)
        }
        let fit = 0.9 / max((x1 - x0) / size.width, (y1 - y0) / size.height)
        scale = min(max(fit, Self.zoomRange.lowerBound), 1)
        pan = CGSize(width: -(x0 + x1) / 2 * scale, height: -(y0 + y1) / 2 * scale)
    }

    /// Bring one island into the canvas.
    private func show(island id: Int, size: CGSize) {
        guard let island = scene.islands.first(where: { $0.id == id }), size.width > 0, size.height > 0 else { return }
        let fit = 0.8 / max(2 * island.radius / size.width, 2 * island.radius / size.height)
        withAnimation(.easeInOut(duration: 0.4)) {
            scale = min(max(fit, Self.zoomRange.lowerBound), 2.5)
            pan = CGSize(width: -island.x * scale, height: -island.y * scale)
        }
    }

    /// One tick a frame while there is heat; the frame after it settles, pause, unless particles are flowing.
    private func step() {
        guard !paused else { return }
        if sim.settled {
            if !flowing { DispatchQueue.main.async { paused = true } }
        } else {
            sim.tick()
        }
    }

    private func renderer(time: Double) -> GraphRenderer {
        GraphRenderer(
            scene: scene, nodes: sim.nodes, settings: settings, scale: scale, pan: pan,
            hoveredID: hoveredID, selectedID: selectedID, hoveredEdgeID: hoveredEdgeID, selectedEdgeID: selectedEdgeID,
            time: time, reduceMotion: reduceMotion, metrics: metrics
        )
    }

    /* ------------------------------- pointer ------------------------------ */

    private func world(_ point: CGPoint, _ size: CGSize) -> CGPoint {
        CGPoint(x: (point.x - size.width / 2 - pan.width) / scale, y: (point.y - size.height / 2 - pan.height) / scale)
    }

    /// Where each node is drawn now, for hit testing against what is on screen.
    private func position(_ size: CGSize) -> (String) -> CGPoint? {
        { id in sim.node(id).map { GraphRenderer.point(of: $0, scale: scale, pan: pan, size: size) } }
    }

    private func nodeID(at point: CGPoint, _ size: CGSize) -> String? {
        scene.node(near: point, scale: scale, nodeSize: settings.nodeSize, position: position(size))?.id
    }

    private func edgeID(at point: CGPoint, _ size: CGSize) -> String? {
        scene.bundle(near: point, position: position(size))?.id
    }

    /// A press on a node drags it (pinned, with the layout kept warm); a press elsewhere pans. A press that did not move is a click.
    private func dragGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { value in
                if drag == nil {
                    let start = world(value.startLocation, size)
                    if let id = nodeID(at: value.startLocation, size) {
                        drag = .node(id)
                        sim.pin(id, at: start)
                        sim.alphaTarget = 0.3
                        paused = false
                    } else {
                        drag = .pan(pan)
                    }
                }
                switch drag {
                case .node(let id):
                    sim.pin(id, at: world(value.location, size))
                case .pan(let start):
                    pan = CGSize(width: start.width + value.translation.width, height: start.height + value.translation.height)
                case nil:
                    break
                }
            }
            .onEnded { value in
                let moved = hypot(value.translation.width, value.translation.height)
                switch drag {
                case .node(let id):
                    sim.alphaTarget = 0
                    if !settings.pin { sim.unpin(id) }
                    if moved < 3 { tap(id) }
                case .pan:
                    if moved < 3 { tap(nil, at: value.location, size: size) }
                case nil:
                    break
                }
                drag = nil
            }
    }

    /**
     * A click on a node selects it, and a second one within 0.4 s opens its
     * local graph; a click off every node selects the edge nearest the point,
     * if one is within reach; a click on nothing clears.
     */
    private func tap(_ id: String?, at point: CGPoint? = nil, size: CGSize = .zero) {
        guard let id else {
            lastTap = nil
            if let point, let edge = edgeID(at: point, size) {
                selectedEdgeID = edge
                selectedID = nil
            } else {
                selectedID = nil
                selectedEdgeID = nil
            }
            return
        }
        if let last = lastTap, last.id == id, Date().timeIntervalSince(last.at) < 0.4 {
            lastTap = nil
            if let node = scene.byID[id] { onOpen(node) }
            return
        }
        lastTap = (id, Date())
        selectedID = id
        selectedEdgeID = nil
    }

    private func magnifyGesture(size: CGSize) -> some Gesture {
        MagnifyGesture()
            .onChanged { value in
                let start = magnifyStart ?? scale
                magnifyStart = start
                zoom(to: start * value.magnification, about: value.startLocation, size: size)
            }
            .onEnded { _ in magnifyStart = nil }
    }

    /// Change the scale while the world point under `anchor` stays put.
    private func zoom(to target: CGFloat, about anchor: CGPoint, size: CGSize) {
        let next = min(max(target, Self.zoomRange.lowerBound), Self.zoomRange.upperBound)
        let fixed = world(anchor, size)
        scale = next
        pan = CGSize(width: anchor.x - size.width / 2 - fixed.x * next, height: anchor.y - size.height / 2 - fixed.y * next)
    }

    /// Plain scrolling pans; ⌘-scrolling zooms about the pointer.
    private func handleScroll(_ event: ScrollWheelEvent, size: CGSize) {
        if event.command {
            zoom(to: scale * pow(2, event.deltaY * (event.precise ? 0.01 : 0.1)), about: event.location, size: size)
        } else {
            let unit: CGFloat = event.precise ? 1 : 12
            pan = CGSize(width: pan.width + event.deltaX * unit, height: pan.height + event.deltaY * unit)
        }
    }
}

/* ============================= scroll wheel ============================= */

struct ScrollWheelEvent {
    var deltaX: CGFloat
    var deltaY: CGFloat
    /// Trackpad deltas are in points; a mouse wheel's are in lines.
    var precise: Bool
    var command: Bool
    /// Where the pointer is, from the catcher's top-left corner.
    var location: CGPoint
}

/**
 * Takes the scroll wheel over the view it backs: SwiftUI has no scroll
 * gesture of its own on the Mac, so a local event monitor — the way the model
 * picker watches for clicks outside its list — hands over the wheel events
 * that land inside this view's frame, consumed. It never takes a click.
 */
private struct ScrollWheelCatcher: NSViewRepresentable {
    let onScroll: (ScrollWheelEvent) -> Void

    func makeNSView(context: Context) -> CatcherView {
        let view = CatcherView()
        view.onScroll = onScroll
        view.install()
        return view
    }

    func updateNSView(_ view: CatcherView, context: Context) {
        view.onScroll = onScroll
    }

    static func dismantleNSView(_ view: CatcherView, coordinator: ()) {
        view.uninstall()
    }

    final class CatcherView: NSView {
        var onScroll: ((ScrollWheelEvent) -> Void)?
        private var monitor: Any?

        override var isFlipped: Bool { true }

        override func hitTest(_ point: NSPoint) -> NSView? { nil }

        func install() {
            monitor = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] event in
                let taken = MainActor.assumeIsolated { self?.take(event) ?? false }
                return taken ? nil : event
            }
        }

        func uninstall() {
            if let monitor { NSEvent.removeMonitor(monitor) }
            monitor = nil
        }

        /// Whether the event landed on this view and was handed over.
        private func take(_ event: NSEvent) -> Bool {
            guard let window, event.window === window else { return false }
            let point = convert(event.locationInWindow, from: nil)
            guard bounds.contains(point) else { return false }
            onScroll?(ScrollWheelEvent(
                deltaX: event.scrollingDeltaX,
                deltaY: event.scrollingDeltaY,
                precise: event.hasPreciseScrollingDeltas,
                command: event.modifierFlags.contains(.command),
                location: point
            ))
            return true
        }
    }
}

/* =============================== settings =============================== */

/// The popover behind the toolbar's Settings button: filters, display and the forces, each a live control.
private struct GraphSettingsPanel: View {
    @Binding var settings: GraphSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Eyebrow(text: L("Filters"), color: .knodeViolet)
            Picker(L("Nodes"), selection: $settings.limit) {
                ForEach(GraphSettings.nodeCounts, id: \.self) { n in Text(String(n)).tag(n) }
            }
            Toggle(L("Co-occurrence edges"), isOn: $settings.cooccur)
            Toggle(L("Hide orphans"), isOn: $settings.hideOrphans)
            SettingSlider(label: L("Min edge weight"), value: $settings.minWeight, range: 0...5, step: 0.1, digits: 1)
            Divider()
            Eyebrow(text: L("Display"), color: .knodeViolet)
            Toggle(L("Clusters as islands"), isOn: $settings.cluster)
            Toggle(L("Glow"), isOn: $settings.glow)
            SettingSlider(label: L("Node size"), value: $settings.nodeSize, range: 0.5...2, step: 0.05, digits: 2)
            SettingSlider(label: L("Link thickness"), value: $settings.linkWidth, range: 0.5...3, step: 0.1, digits: 1)
            SettingSlider(label: L("Text fade"), value: $settings.textFade, range: 0.4...2.5, step: 0.05, digits: 2)
            Toggle(L("Arrows on typed edges"), isOn: $settings.arrows)
            Toggle(L("Keep dragged nodes where dropped"), isOn: $settings.pin)
            Divider()
            Eyebrow(text: L("Forces"), color: .knodeViolet)
            SettingSlider(label: L("Center"), value: $settings.center, range: 0...0.3, step: 0.01, digits: 2)
            SettingSlider(label: L("Repel"), value: $settings.repel, range: 50...600, step: 10, digits: 0)
            SettingSlider(label: L("Link distance"), value: $settings.linkDistance, range: 30...250, step: 5, digits: 0)
            HStack {
                Spacer()
                Button(L("Reset")) { settings = GraphSettings() }
            }
        }
        .padding(16)
        .frame(width: 300)
    }
}

private struct SettingSlider: View {
    let label: String
    @Binding var value: Double
    let range: ClosedRange<Double>
    let step: Double
    let digits: Int

    var body: some View {
        VStack(spacing: 2) {
            HStack {
                Text(label).font(.caption)
                Spacer()
                Text(value.formatted(.number.precision(.fractionLength(digits))))
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
            }
            Slider(value: $value, in: range, step: step)
        }
    }
}

/* =============================== insights =============================== */

private struct InsightsSheet: View {
    let insights: GraphInsights?
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                VStack(alignment: .leading, spacing: 4) {
                    Eyebrow(text: L("Graph health"), color: .knodeViolet)
                    Text(L("Knowledge graph insights")).font(.title.bold())
                }
                Spacer()
                Button(L("Done")) { dismiss() }.keyboardShortcut(.defaultAction)
            }
            if let insights {
                HStack(spacing: 12) {
                    InsightMetric(value: insights.totals.entities, label: L("Entities"))
                    InsightMetric(value: insights.totals.relations, label: L("Relations"))
                    InsightMetric(value: insights.totals.mentions, label: L("Mentions"))
                }
                HStack(alignment: .top, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(L("Hubs")).font(.headline)
                        ForEach(insights.hubs) { hub in
                            HStack { Text(hub.name); Spacer(); Text(L("degree %@", String(hub.degree))).font(.caption.monospaced()).foregroundStyle(.secondary) }
                        }
                    }
                    .knodeCard()
                    VStack(alignment: .leading, spacing: 8) {
                        Text(L("Entity types")).font(.headline)
                        ForEach(insights.typeCounts) { item in
                            HStack { RouteBadge(label: item.type, color: nodeColor(item.type)); Spacer(); Text(item.n.formatted()).monospacedDigit() }
                        }
                    }
                    .knodeCard()
                }
                if !insights.isolated.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(L("Isolated entities")).font(.headline)
                        Text(insights.isolated.map(\.name).joined(separator: " · "))
                            .font(.callout)
                            .foregroundStyle(.secondary)
                    }
                    .knodeCard()
                }
            } else {
                ProgressView()
            }
        }
        .padding(26)
        .frame(width: 720)
    }
}

private struct InsightMetric: View {
    let value: Int
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(value.formatted()).font(.system(size: 28, weight: .bold, design: .rounded))
            Text(label).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .knodeCard()
    }
}
