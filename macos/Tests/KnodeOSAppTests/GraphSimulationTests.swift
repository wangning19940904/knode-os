import CoreGraphics
import Foundation
import XCTest
@testable import KnodeOSApp

final class GraphSimulationTests: XCTestCase {
    /// A hub with forty spokes and a loose ring through everything: the shape an overview has.
    @MainActor
    private func fixture() -> GraphSimulation {
        let sim = GraphSimulation()
        var nodes: [GraphSimulation.NodeSpec] = []
        var links: [GraphSimulation.LinkSpec] = []
        for i in 0..<150 {
            nodes.append(.init(id: "n\(i)", rank: i, degree: i == 0 ? 40 : 2, radius: i == 0 ? 17 : 6))
        }
        for i in 1...40 {
            links.append(.init(source: "n0", target: "n\(i)", weight: 2, coOccurs: false))
        }
        for i in 1..<150 {
            links.append(.init(source: "n\(i)", target: "n\((i * 7) % 150)", weight: 1, coOccurs: i % 3 == 0))
        }
        sim.load(nodes: nodes, links: links, alpha: 1)
        return sim
    }

    @MainActor
    func testSettlesWithinTheTicksD3TakesAndKeepsTheHubCentral() {
        let sim = fixture()
        let ticks = sim.settle(maxTicks: 600)
        XCTAssertTrue(sim.settled)
        // alpha falls from 1 to 0.001 at 2.5 % a tick: 273 ticks, a few seconds at 60 a second
        XCTAssertEqual(ticks, 273)
        for node in sim.nodes {
            XCTAssertTrue(node.x.isFinite && node.y.isFinite, node.id)
        }
        let hub = sim.node("n0")!
        let mean = sim.nodes.map { hypot($0.x, $0.y) }.reduce(0, +) / Double(sim.nodes.count)
        XCTAssertLessThan(hypot(hub.x, hub.y), mean)
        // spokes stay within reach of the hub, so the neighbourhood reads as one
        for link in sim.links where link.a == 0 {
            let spoke = sim.nodes[link.b]
            XCTAssertLessThan(hypot(spoke.x - hub.x, spoke.y - hub.y), 300, spoke.id)
        }
    }

    @MainActor
    func testSeedIsASpiralByRankWithRankZeroInTheMiddle() {
        let sim = GraphSimulation()
        sim.load(nodes: (0..<5).map { .init(id: "n\($0)", rank: $0, degree: 0, radius: 5) }, links: [], alpha: 1)
        XCTAssertEqual(sim.node("n0")!.point, .zero)
        let radii = sim.nodes.map { hypot($0.x, $0.y) }
        XCTAssertEqual(radii, radii.sorted())
        XCTAssertEqual(radii[4], 28, accuracy: 0.001)
    }

    @MainActor
    func testADragPinsTheNodeAndKeepsTheLayoutWarmUntilReleased() {
        let sim = fixture()
        sim.settle()
        sim.pin("n5", at: CGPoint(x: 300, y: -200))
        sim.alphaTarget = 0.3
        for _ in 0..<50 { sim.tick() }
        XCTAssertFalse(sim.settled)
        XCTAssertEqual(sim.node("n5")!.point, CGPoint(x: 300, y: -200))
        sim.alphaTarget = 0
        sim.unpin("n5")
        sim.settle()
        XCTAssertTrue(sim.settled)
        XCTAssertNotEqual(sim.node("n5")!.point, CGPoint(x: 300, y: -200))
    }

    @MainActor
    func testAReloadKeepsPositionsAndReheatingResumes() {
        let sim = fixture()
        sim.settle()
        let before = sim.node("n3")!.point
        sim.load(
            nodes: [.init(id: "n3", rank: 0, degree: 1, radius: 6), .init(id: "new", rank: 1, degree: 1, radius: 6)],
            links: [.init(source: "n3", target: "new", weight: 1, coOccurs: false)],
            alpha: 0.3
        )
        XCTAssertEqual(sim.nodes.count, 2)
        XCTAssertEqual(sim.node("n3")!.point, before)
        XCTAssertEqual(sim.alpha, 0.3)
        sim.settle()
        XCTAssertTrue(sim.settled)
        sim.reheat(0.6)
        XCTAssertEqual(sim.alpha, 0.6)
        XCTAssertFalse(sim.settled)
        // a force slider changes every link's rest length at once
        sim.forces.linkDistance = 180
        XCTAssertEqual(sim.links[0].distance, 180 / (0.6 + 0.4 / 3), accuracy: 0.001)
    }

    @MainActor
    func testLinksTakeTheirRestLengthAndPullFromTheEdge() {
        let sim = GraphSimulation()
        sim.load(
            nodes: [.init(id: "a", rank: 0, degree: 1, radius: 5), .init(id: "b", rank: 1, degree: 2, radius: 5), .init(id: "c", rank: 2, degree: 1, radius: 5)],
            links: [.init(source: "a", target: "b", weight: 3, coOccurs: false), .init(source: "b", target: "c", weight: 1, coOccurs: true)],
            alpha: 1
        )
        let typed = sim.links[0]
        XCTAssertEqual(typed.distance, 90, accuracy: 0.001)
        XCTAssertEqual(typed.strength, 0.5, accuracy: 0.001)
        XCTAssertEqual(typed.bias, 1.0 / 3, accuracy: 0.001)
        let co = sim.links[1]
        XCTAssertEqual(co.distance, 135 / (0.6 + 0.4 / 3), accuracy: 0.001)
        XCTAssertEqual(co.strength, 0.12 * 0.75, accuracy: 0.001)
        // a link between nodes the view does not hold is dropped, as is a self-link
        sim.load(nodes: [.init(id: "a", rank: 0, degree: 0, radius: 5)], links: [.init(source: "a", target: "a", weight: 1, coOccurs: false), .init(source: "a", target: "zz", weight: 1, coOccurs: false)], alpha: 1)
        XCTAssertTrue(sim.links.isEmpty)
    }

    @MainActor
    func testHitTestTakesTheNearestNodeWithinReachOrItsOwnDisc() {
        let sim = GraphSimulation()
        sim.load(nodes: [.init(id: "a", rank: 0, degree: 0, radius: 5), .init(id: "b", rank: 1, degree: 0, radius: 20)], links: [], alpha: 1)
        XCTAssertEqual(sim.node(at: .zero, hit: 3)?.id, "a")
        let b = sim.node("b")!
        XCTAssertEqual(sim.node(at: CGPoint(x: b.x + 15, y: b.y), hit: 3)?.id, "b")
        XCTAssertNil(sim.node(at: CGPoint(x: 400, y: 400), hit: 18))
    }

    /// Two islands of twelve nodes, each a hub with spokes, and one relation between the hubs.
    @MainActor
    private func islands() -> (sim: GraphSimulation, discs: [GraphSimulation.IslandSpec]) {
        let discs: [GraphSimulation.IslandSpec] = [.init(x: -150, y: 0, radius: 90), .init(x: 150, y: 20, radius: 90)]
        var nodes: [GraphSimulation.NodeSpec] = []
        var links: [GraphSimulation.LinkSpec] = []
        for i in 0..<24 {
            nodes.append(.init(id: "n\(i)", rank: i, degree: i < 2 ? 11 : 1, radius: i < 2 ? 12 : 5, island: i % 2))
            if i >= 2 { links.append(.init(source: "n\(i)", target: "n\(i % 2)", weight: 1, coOccurs: false)) }
        }
        links.append(.init(source: "n0", target: "n1", weight: 1, coOccurs: false))
        let sim = GraphSimulation()
        sim.load(nodes: nodes, links: links, islands: discs, alpha: 1)
        return (sim, discs)
    }

    @MainActor
    func testWithIslandsEveryNodeStartsAndSettlesInsideItsOwn() {
        let (sim, discs) = islands()
        for node in sim.nodes {
            let home = discs[node.island!]
            XCTAssertLessThanOrEqual(hypot(node.x - home.x, node.y - home.y), home.radius, node.id)
        }
        XCTAssertEqual(sim.settle(maxTicks: 600), 273)
        for node in sim.nodes {
            let home = discs[node.island!]
            // the rim holds a node's whole disc, give or take the last tick's push
            XCTAssertLessThan(hypot(node.x - home.x, node.y - home.y) + node.r, home.radius + 6, node.id)
        }
    }

    @MainActor
    func testARelationBetweenIslandsBarelyPulls() {
        let (sim, _) = islands()
        let inside = sim.links[0]
        let across = sim.links.last!
        XCTAssertEqual(inside.strength, 0.5 * 0.75, accuracy: 0.001)
        XCTAssertEqual(across.strength, 0.5 * 0.75 * 0.03, accuracy: 0.0001)
        XCTAssertEqual(across.distance, inside.distance, accuracy: 0.001)
    }

    @MainActor
    func testWithoutIslandsALoadIsTheSingleLayout() {
        let (sim, _) = islands()
        sim.load(nodes: (0..<24).map { .init(id: "n\($0)", rank: $0, degree: 1, radius: 5) }, links: [.init(source: "n0", target: "n1", weight: 1, coOccurs: false)], alpha: 0.3)
        XCTAssertTrue(sim.islands.isEmpty)
        XCTAssertTrue(sim.nodes.allSatisfy { $0.island == nil })
        XCTAssertEqual(sim.links[0].strength, 0.5 * 0.75, accuracy: 0.001)
    }
}
