import Foundation
import XCTest
@testable import KnodeOSApp

final class GraphSceneTests: XCTestCase {
    private func node(_ id: String, _ type: String, degree: Int? = nil) -> GraphNode {
        GraphNode(id: id, name: id.uppercased(), type: type, description: "", score: 1, mentionCount: 3, degree: degree, wikiPath: nil)
    }

    private func edge(_ a: String, _ b: String, _ type: String = "works_at", weight: Double = 1) -> GraphEdge {
        GraphEdge(source: a, target: b, type: type, description: "", weight: weight)
    }

    private var reply: GraphResponse {
        GraphResponse(
            nodes: [node("a", "person", degree: 9), node("b", "organization"), node("c", "concept"), node("d", "concept"), node("lone", "person")],
            edges: [edge("a", "b", weight: 2), edge("b", "c", "co_occurs", weight: 0.5), edge("a", "c", weight: 0.2), edge("c", "d", weight: 1)],
            chunks: [],
            claims: nil
        )
    }

    func testTheWholeReplyWithTheLegendAndAdjacency() {
        let scene = GraphScene(response: reply, settings: GraphSettings())
        XCTAssertEqual(scene.nodes.map(\.id), ["a", "b", "c", "d", "lone"])
        XCTAssertEqual(scene.edges.count, 4)
        XCTAssertEqual(scene.typeCounts.map(\.type), ["concept", "person", "organization"])
        XCTAssertEqual(scene.typeCounts.map(\.count), [2, 2, 1])
        // strongest neighbour first; the edge's own direction is kept
        XCTAssertEqual(scene.neighbours["a"]?.map(\.node.id), ["b", "c"])
        XCTAssertEqual(scene.neighbours["c"]?.map(\.node.id), ["d", "b", "a"])
        XCTAssertEqual(scene.neighbours["c"]?.map(\.outgoing), [true, false, false])
        XCTAssertEqual(scene.highlight(around: "b"), ["b", "a", "c"])
        XCTAssertEqual(scene.nodeSpecs(nodeSize: 1).map(\.rank), [0, 1, 2, 3, 4])
    }

    func testSizesFollowTheGlobalDegreeOrWhatIsInView() {
        let scene = GraphScene(response: reply, settings: GraphSettings())
        // a: the service's degree 9 → 3 + 2.2·3; b: no degree sent, two edges in view
        XCTAssertEqual(scene.radius(of: scene.byID["a"]!, nodeSize: 1), 9.6, accuracy: 0.001)
        XCTAssertEqual(scene.radius(of: scene.byID["b"]!, nodeSize: 1), 3 + 2.2 * 2.0.squareRoot(), accuracy: 0.001)
        XCTAssertEqual(scene.radius(of: scene.byID["lone"]!, nodeSize: 2), 6, accuracy: 0.001)
        XCTAssertEqual(scene.radius(of: node("hub", "person", degree: 400), nodeSize: 1), 22)
        XCTAssertTrue(scene.largest.contains("a"))
    }

    func testDrawnSizesSpreadTheLogOfTheDegreeOverWhatIsInView() {
        let scene = GraphScene(response: reply, settings: GraphSettings())
        // log(1 + degree) runs from lone's 0 to a's log 10: the ends map to 4 and 18
        XCTAssertEqual(scene.displayRadius(of: scene.byID["a"]!, nodeSize: 1), 18, accuracy: 0.001)
        XCTAssertEqual(scene.displayRadius(of: scene.byID["lone"]!, nodeSize: 1), 4, accuracy: 0.001)
        XCTAssertEqual(scene.displayRadius(of: scene.byID["b"]!, nodeSize: 1), 4 + 14 * log1p(2.0) / log1p(9.0), accuracy: 0.001)
        XCTAssertEqual(scene.displayRadius(of: scene.byID["a"]!, nodeSize: 2), 36, accuracy: 0.001)
        // the layout keeps the older size, so nodes keep their spacing
        XCTAssertEqual(scene.radius(of: scene.byID["a"]!, nodeSize: 1), 9.6, accuracy: 0.001)
        XCTAssertEqual(scene.degree(ofID: "c"), 3)
    }

    func testRelationFamiliesFilterEdgesAndFeedTheLegend() {
        var settings = GraphSettings()
        settings.hiddenRelations = ["cooperation"]
        var scene = GraphScene(response: reply, settings: settings)
        // works_at is cooperation & people: only the co-occurrence edge is left
        XCTAssertEqual(scene.edges.map(\.type), ["co_occurs"])
        // the legend counts the reply, before any family is hidden, in the palette's order
        XCTAssertEqual(scene.familyCounts.map(\.family.id), ["cooperation", "cooccur"])
        XCTAssertEqual(scene.familyCounts.map(\.count), [3, 1])

        // co-occurrence stays listed with nothing of it in the reply: its chip switches the fetch back on
        let typedOnly = GraphResponse(nodes: reply.nodes, edges: reply.edges.filter { $0.type != "co_occurs" }, chunks: [], claims: nil)
        scene = GraphScene(response: typedOnly, settings: GraphSettings())
        XCTAssertEqual(scene.familyCounts.map(\.family.id), ["cooperation", "cooccur"])
        XCTAssertEqual(scene.familyCounts.last?.count, 0)
        XCTAssertEqual(scene.linkSpecs.map(\.type), ["works_at", "works_at", "works_at"])
    }

    func testTheRelationsBetweenOnePairFoldIntoOneEdge() {
        let pair = GraphResponse(
            nodes: [node("a", "organization", degree: 4), node("b", "organization", degree: 2), node("c", "product")],
            edges: [
                edge("a", "b", "works_at", weight: 2),
                edge("b", "a", "invested_in", weight: 1.5),
                edge("a", "b", "co_occurs", weight: 3),
                edge("a", "b", "works_at", weight: 0.5),
                edge("b", "a", "related_to", weight: 1),
                edge("a", "b", "related_to", weight: 0.8),
                edge("a", "c", "produces", weight: 1),
            ],
            chunks: [],
            claims: nil
        )
        let scene = GraphScene(response: pair, settings: GraphSettings())
        XCTAssertEqual(scene.bundles.count, 2)
        let ab = scene.bundle(GraphScene.Bundle.id("b", "a"))!
        // a type once per direction at its strongest reading, an undirected type once either way, most specific first
        XCTAssertEqual(ab.relations.map(\.type), ["works_at", "invested_in", "related_to", "co_occurs"])
        XCTAssertEqual(ab.relations.first?.weight, 2)
        XCTAssertEqual(ab.relations.first { $0.type == "related_to" }?.weight, 1)
        XCTAssertEqual([ab.a, ab.b], ["a", "b"])
        XCTAssertTrue(ab.forward)
        XCTAssertTrue(ab.backward)
        XCTAssertEqual(ab.weight, 3)
        // one neighbour per pair, carrying every relation between them
        XCTAssertEqual(scene.neighbours["a"]?.map(\.node.id), ["b", "c"])
        XCTAssertEqual(scene.neighbours["a"]?.first?.bundle.relations.count, 4)
        XCTAssertEqual(scene.neighbours["b"]?.map(\.node.id), ["a"])
        XCTAssertEqual(scene.neighbours["b"]?.first?.outgoing, false)
        // the layout still pulls along every relation
        XCTAssertEqual(scene.linkSpecs.count, 7)
        // hiding capital leaves the pair what is left of it, running one way only
        var settings = GraphSettings()
        settings.hiddenRelations = ["capital"]
        let narrowed = GraphScene(response: pair, settings: settings).bundle(ab.id)!
        XCTAssertEqual(narrowed.relations.map(\.type), ["works_at", "related_to", "co_occurs"])
        XCTAssertFalse(narrowed.backward)
    }

    func testThePointerFindsANodeOnItsDiscElseTheNearestEdge() {
        let scene = GraphScene(response: reply, settings: GraphSettings())
        // a square in screen points: a–b along the top, c–d along the bottom, b–c across, a–c down the left
        let at: [String: CGPoint] = ["a": CGPoint(x: 0, y: 0), "b": CGPoint(x: 100, y: 0), "c": CGPoint(x: 0, y: 100), "d": CGPoint(x: 100, y: 100), "lone": CGPoint(x: 500, y: 500)]
        let position = { (id: String) in at[id] }
        // a is drawn at 18 points: its disc and 5 points round it count, no further
        XCTAssertEqual(scene.node(near: CGPoint(x: 22, y: 0), scale: 1, nodeSize: 1, position: position)?.id, "a")
        XCTAssertNil(scene.node(near: CGPoint(x: 50, y: 4), scale: 1, nodeSize: 1, position: position))
        // off every node, the line passing nearest, within 6 points
        XCTAssertEqual(scene.bundle(near: CGPoint(x: 50, y: 4), position: position)?.id, GraphScene.Bundle.id("a", "b"))
        XCTAssertNil(scene.bundle(near: CGPoint(x: 50, y: 9), position: position))
        XCTAssertEqual(scene.bundle(near: CGPoint(x: 60, y: 103), position: position)?.id, GraphScene.Bundle.id("c", "d"))
    }

    func testEveryRelationTypeHasAFamily() {
        XCTAssertEqual(GraphPalette.family(of: "supplies_to").id, "value")
        XCTAssertEqual(GraphPalette.family(of: "subsidiary_of").id, "structure")
        XCTAssertEqual(GraphPalette.family(of: "invested_in").id, "capital")
        XCTAssertEqual(GraphPalette.family(of: "competes_with").id, "competition")
        XCTAssertEqual(GraphPalette.family(of: "founded").id, "cooperation")
        XCTAssertEqual(GraphPalette.family(of: "co_occurs").id, "cooccur")
        // generic, system and unknown predicates draw as "other typed"
        XCTAssertEqual(GraphPalette.family(of: "related_to").id, "other")
        XCTAssertEqual(GraphPalette.family(of: "links_to").id, "other")
        XCTAssertEqual(GraphPalette.family(of: "something_new").id, "other")
        XCTAssertEqual(Set(GraphPalette.families.flatMap(\.types)).count, GraphPalette.families.flatMap(\.types).count)
    }

    func testFiltersNarrowNodesAndEdgesTogether() {
        var settings = GraphSettings()
        settings.hiddenTypes = ["organization"]
        var scene = GraphScene(response: reply, settings: settings)
        XCTAssertEqual(scene.nodes.map(\.id), ["a", "c", "d", "lone"])
        XCTAssertEqual(scene.edges.count, 2)
        // the legend still lists the hidden type, so it can be shown again
        XCTAssertEqual(scene.typeCounts.map(\.type), ["concept", "person", "organization"])

        settings = GraphSettings()
        settings.cooccur = false
        settings.minWeight = 0.5
        settings.hideOrphans = true
        scene = GraphScene(response: reply, settings: settings)
        XCTAssertEqual(scene.edges.map { "\($0.source)-\($0.target)" }, ["a-b", "c-d"])
        XCTAssertEqual(scene.nodes.map(\.id), ["a", "b", "c", "d"])
        XCTAssertEqual(scene.linkSpecs.map(\.coOccurs), [false, false])
    }

    func testSettingsPersistAsJSONAndMissingKeysTakeDefaults() throws {
        var settings = GraphSettings()
        settings.limit = 300
        settings.hiddenTypes = ["event"]
        settings.repel = 420
        let restored = GraphSettings(json: settings.json)
        XCTAssertEqual(restored, settings)
        let partial = GraphSettings(json: #"{"limit":50,"arrows":true}"#)
        XCTAssertEqual(partial.limit, 50)
        XCTAssertTrue(partial.arrows)
        XCTAssertEqual(partial.linkDistance, 90)
        XCTAssertEqual(GraphSettings(json: "not json"), GraphSettings())
        XCTAssertEqual(GraphSettings(json: nil), GraphSettings())
        XCTAssertEqual(settings.forces, .init(center: 0.06, repel: 420, linkDistance: 90))
    }

    func testGlowIsOnByDefaultAndTheNewKeysPersist() {
        // a copy saved before these keys existed keeps working: glow on, every family shown
        let older = GraphSettings(json: #"{"limit":200,"hiddenTypes":["event"]}"#)
        XCTAssertTrue(older.glow)
        XCTAssertEqual(older.hiddenRelations, [])
        var settings = GraphSettings()
        settings.glow = false
        settings.hiddenRelations = ["capital", "competition"]
        XCTAssertEqual(GraphSettings(json: settings.json), settings)
        XCTAssertFalse(GraphSettings(json: #"{"glow":false}"#).glow)
    }

    func testAHiddenFamilyRefiltersAndGlowOnlyRedraws() {
        let old = GraphSettings()
        var new = old
        new.hiddenRelations = ["structure"]
        XCTAssertTrue(new.filtersDiffer(from: old))
        XCTAssertFalse(new.needsRefetch(from: old, overview: true))
        new = old
        new.glow = false
        XCTAssertFalse(new.filtersDiffer(from: old))
        XCTAssertFalse(new.needsRefetch(from: old, overview: true))
        XCTAssertEqual(new.forces, old.forces)
    }

    func testOnlyTheNodeCountAndAnOverviewsCoOccurrenceAskTheServiceAgain() {
        let old = GraphSettings()
        var new = old
        new.cooccur = false
        XCTAssertTrue(new.needsRefetch(from: old, overview: true))
        XCTAssertFalse(new.needsRefetch(from: old, overview: false))
        XCTAssertTrue(new.filtersDiffer(from: old))
        new = old
        new.limit = 400
        XCTAssertTrue(new.needsRefetch(from: old, overview: false))
        new = old
        new.nodeSize = 1.5
        new.center = 0.2
        XCTAssertFalse(new.needsRefetch(from: old, overview: true))
        XCTAssertFalse(new.filtersDiffer(from: old))
        XCTAssertNotEqual(new.forces, old.forces)
    }

    /// Three communities of 6, 4 and 2, a node in none, and the reply's own list of them.
    private var clustered: GraphResponse {
        var nodes: [GraphNode] = []
        var edges: [GraphEdge] = []
        for (c, n) in [6, 4, 2].enumerated() {
            for i in 0..<n {
                var member = node("c\(c)n\(i)", "concept", degree: i == 1 ? 9 : 1)
                member.community = c
                nodes.append(member)
                if i > 0 { edges.append(edge("c\(c)n\(i)", "c\(c)n0")) }
            }
        }
        nodes.append(node("lone", "person", degree: 0))
        edges.append(edge("c0n0", "c1n0", "partner_of"))
        return GraphResponse(
            nodes: nodes, edges: edges, chunks: [], claims: nil,
            communities: [6, 4, 2].enumerated().map { GraphCommunity(id: $0.offset, size: $0.element, hub: "c\($0.offset)n1", label: "C\($0.offset)N1") }
        )
    }

    func testCommunitiesInViewBecomeIslandsLargestFirstWithTheRestLast() {
        let scene = GraphScene(response: clustered, settings: GraphSettings())
        XCTAssertEqual(scene.islands.map(\.id), [0, 1, 2, -1])
        XCTAssertEqual(scene.islands.map(\.nodeIDs.count), [6, 4, 2, 1])
        XCTAssertEqual(scene.communities.map(\.label), ["C0N1", "C1N1", "C2N1"])
        XCTAssertEqual(scene.island(of: "c1n3")?.id, 1)
        XCTAssertEqual(scene.island(of: "lone")?.id, -1)
        // no two discs nearer than the gap, and a larger community has the larger disc
        for (i, a) in scene.islands.enumerated() {
            for b in scene.islands[(i + 1)...] {
                XCTAssertGreaterThanOrEqual(hypot(a.x - b.x, a.y - b.y), a.radius + b.radius + GraphScene.islandGap - 1e-6)
            }
        }
        XCTAssertGreaterThan(scene.islands[0].radius, scene.islands[1].radius)
        // a hub is named by its island's title, so it is not one of the nodes that always keep a label
        XCTAssertFalse(scene.largest.contains("c0n1"))
        XCTAssertEqual(scene.nodeSpecs(nodeSize: 1).first { $0.id == "c2n0" }?.island, 2)
        XCTAssertEqual(scene.islandSpecs.count, 4)
    }

    func testNoIslandsWithTheSettingOffOrFewerThanTwoCommunitiesInView() {
        var settings = GraphSettings()
        settings.cluster = false
        let flat = GraphScene(response: clustered, settings: settings)
        XCTAssertTrue(flat.islands.isEmpty)
        XCTAssertTrue(flat.nodeSpecs(nodeSize: 1).allSatisfy { $0.island == nil })
        var one = clustered
        one.nodes = one.nodes.filter { $0.community == 0 || $0.community == nil }
        XCTAssertTrue(GraphScene(response: one, settings: GraphSettings()).islands.isEmpty)
        // a service that sends no communities draws as it always has
        XCTAssertTrue(GraphScene(response: reply, settings: GraphSettings()).islands.isEmpty)
    }

    func testAHubTheFiltersHideGivesWayToTheLargestMemberLeft() {
        var response = clustered
        response.nodes = response.nodes.map { node in
            var node = node
            if node.id == "c0n1" { node.type = "event" }
            if node.id == "c0n4" { node.degree = 5 }
            return node
        }
        var settings = GraphSettings()
        settings.hiddenTypes = ["event"]
        let scene = GraphScene(response: response, settings: settings)
        XCTAssertEqual(scene.islands.first { $0.id == 0 }?.hub, "c0n4")
        XCTAssertEqual(scene.islands.first { $0.id == 0 }?.label, "C0N4")
    }

    func testClustersAreOnByDefaultAndMoveTheIslandsNotTheFilters() {
        XCTAssertTrue(GraphSettings(json: #"{"glow":false}"#).cluster)
        XCTAssertFalse(GraphSettings(json: #"{"cluster":false}"#).cluster)
        let old = GraphSettings()
        var new = old
        new.cluster = false
        XCTAssertTrue(new.islandsDiffer(from: old))
        XCTAssertFalse(new.filtersDiffer(from: old))
        XCTAssertFalse(new.needsRefetch(from: old, overview: true))
        XCTAssertEqual(GraphSettings(json: new.json), new)
        new = old
        new.glow = false
        XCTAssertFalse(new.islandsDiffer(from: old))
    }
}
