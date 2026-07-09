import XCTest
@testable import EosRemoteKit

// AgentTree (§D): build/nesting, the running-first root comparator, recency keys, and the
// attention policy — pure functions over Worker rows.
final class AgentTreeTests: XCTestCase {

    private func worker(_ id: String, state: String = "IDLE", parent: String? = nil,
                        started: Double = 0, turnStarted: Double? = nil,
                        tokensIn: Int = 0, tokensOut: Int = 0, toolCalls: Int = 0,
                        cost: Double = 0) -> Worker {
        var o: [String: JSONValue] = [
            "id": .string(id),
            "state": .string(state),
            "started_at": .number(started),
            "tokens_in": .number(Double(tokensIn)),
            "tokens_out": .number(Double(tokensOut)),
            "tool_calls": .number(Double(toolCalls)),
            "cost_usd": .number(cost),
        ]
        if let parent { o["parent_id"] = .string(parent) }
        if let turnStarted { o["turn_started_at"] = .number(turnStarted) }
        return Worker(raw: .object(o))
    }

    // MARK: build + nesting (§D1)

    func testBuildNestsChildrenUnderParents() {
        let tree = AgentTree.buildTree([
            worker("o1", started: 10),
            worker("w1", parent: "o1", started: 20),
            worker("w2", parent: "o1", started: 30),
            worker("g1", parent: "w1", started: 40),
        ])
        XCTAssertEqual(tree.count, 1)
        let root = tree[0]
        XCTAssertEqual(root.id, "o1")
        XCTAssertEqual(root.children.map(\.id), ["w1", "w2"])
        XCTAssertEqual(root.children[0].children.map(\.id), ["g1"])
        XCTAssertEqual(root.subtreeSize, 4)
    }

    func testMissingParentBecomesRoot() {
        let tree = AgentTree.buildTree([
            worker("a", started: 10),
            worker("orphan", parent: "ghost", started: 20),
        ])
        XCTAssertEqual(Set(tree.map(\.id)), ["a", "orphan"])
    }

    func testChildrenSortedByStartedAtAscending() {
        let tree = AgentTree.buildTree([
            worker("o1", started: 1),
            worker("c", parent: "o1", started: 30),
            worker("a", parent: "o1", started: 10),
            worker("b", parent: "o1", started: 20),
        ])
        XCTAssertEqual(tree[0].children.map(\.id), ["a", "b", "c"])
    }

    // MARK: root comparator (§D2)

    func testRunningRootsSortFirst() {
        // "b" is running but far older — running still wins over recency.
        let tree = AgentTree.buildTree([
            worker("a", state: "IDLE", started: 9000),
            worker("b", state: "WORKING", started: 100),
        ])
        XCTAssertEqual(tree.map(\.id), ["b", "a"])
    }

    func testKillingCountsAsRunning() {
        XCTAssertTrue(AgentTree.isRunningState("KILLING"))
        let tree = AgentTree.buildTree([
            worker("a", state: "DONE", started: 9000),
            worker("b", state: "KILLING", started: 100),
        ])
        XCTAssertEqual(tree.map(\.id), ["b", "a"])
    }

    func testRunningChildLiftsIdleRoot() {
        // Root "quiet" is newer, but "busy"'s subtree has a WORKING child → busy first.
        let tree = AgentTree.buildTree([
            worker("quiet", state: "IDLE", started: 9000),
            worker("busy", state: "IDLE", started: 100),
            worker("kid", state: "WORKING", parent: "busy", started: 200),
        ])
        XCTAssertEqual(tree.map(\.id), ["busy", "quiet"])
    }

    func testIdleRootsOrderBySubtreeMaxRecencyDesc() {
        // "a" itself is old but its child's turn clock (500) beats "b" (300).
        let tree = AgentTree.buildTree([
            worker("a", started: 100),
            worker("kid", parent: "a", started: 150, turnStarted: 500),
            worker("b", started: 300),
        ])
        XCTAssertEqual(tree.map(\.id), ["a", "b"])
    }

    func testRecencyKeyIsMaxOfTurnAndStart() {
        XCTAssertEqual(AgentTree.recencyKey(worker("w", started: 100, turnStarted: 900)), 900)
        XCTAssertEqual(AgentTree.recencyKey(worker("w", started: 100, turnStarted: 50)), 100)
        XCTAssertEqual(AgentTree.recencyKey(worker("w", started: 100)), 100)
    }

    func testIdenticalKeysBreakByIdDesc() {
        let tree = AgentTree.buildTree([
            worker("a", started: 100),
            worker("b", started: 100),
        ])
        XCTAssertEqual(tree.map(\.id), ["b", "a"])
    }

    // MARK: attention policy (§D4)

    func testSigOfComposition() {
        let w = worker("w", tokensIn: 10, tokensOut: 5, toolCalls: 2, cost: 0.5)
        XCTAssertEqual(AgentTree.sigOf(w), "15|2|0.5")
    }

    func testNeverFlagsUnseededWorkers() {
        let stopped = worker("w", state: "IDLE", tokensIn: 100)
        XCTAssertFalse(AgentTree.needsAttention(lastViewedSig: nil, worker: stopped))
    }

    func testNoAttentionWhileRunning() {
        let before = worker("w", state: "WORKING", tokensIn: 10)
        let after = worker("w", state: "WORKING", tokensIn: 999)
        XCTAssertFalse(AgentTree.needsAttention(lastViewedSig: AgentTree.sigOf(before), worker: after))
    }

    func testFlagsStoppedWorkerWithNewOutput() {
        let before = worker("w", state: "WORKING", tokensIn: 10)
        let after = worker("w", state: "IDLE", tokensIn: 500, toolCalls: 3)
        XCTAssertTrue(AgentTree.needsAttention(lastViewedSig: AgentTree.sigOf(before), worker: after))
    }

    func testNoFlagWhenViewedSigMatches() {
        let w = worker("w", state: "DONE", tokensIn: 500)
        XCTAssertFalse(AgentTree.needsAttention(lastViewedSig: AgentTree.sigOf(w), worker: w))
    }
}
