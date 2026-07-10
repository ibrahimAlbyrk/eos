import XCTest
@testable import EosRemoteKit

// Store frame application (Bug-B regression, round 3): the §5.4.2/§5.4.3 push
// frames must actually mutate the live lists — worker state (isBusy/thinking),
// pending asks, and the seq-gap signal all hang off this.
final class StoreFrameTests: XCTestCase {

    private func worker(_ id: String, state: String) -> JSONValue {
        .object(["id": .string(id), "state": .string(state)])
    }
    private func pending(_ id: String, workerId: String) -> JSONValue {
        .object(["id": .string(id), "workerId": .string(workerId)])
    }

    func testWorkersPatchUpsertsAndRemoves() async {
        let store = Store()
        await store.applyBootstrap(workers: [worker("w-1", state: "IDLE")], pending: [])

        var result = await store.applyPatch(PatchFrame(t: "patch", seq: 1, resource: "workers",
                                                       op: "upsert", data: worker("w-1", state: "WORKING")))
        XCTAssertEqual(result, .ok)
        var state = await store.workers["w-1"]?.state
        XCTAssertEqual(state, "WORKING", "upsert patch must flip the live worker state")

        result = await store.applyPatch(PatchFrame(t: "patch", seq: 2, resource: "workers",
                                                   op: "remove", data: .object(["id": .string("w-1")])))
        XCTAssertEqual(result, .ok)
        state = await store.workers["w-1"]?.state
        XCTAssertNil(state, "remove patch must drop the row")
        let pushes = await store.serverPushesState
        XCTAssertTrue(pushes, "a patch proves the daemon pushes state")
    }

    func testPendingPatchLifecycle() async {
        let store = Store()
        _ = await store.applyPatch(PatchFrame(t: "patch", seq: 1, resource: "pending",
                                              op: "upsert", data: pending("p-1", workerId: "w-1")))
        var count = await store.pendingList.count
        XCTAssertEqual(count, 1)

        _ = await store.applyPatch(PatchFrame(t: "patch", seq: 2, resource: "pending",
                                              op: "remove", data: .object(["id": .string("p-1")])))
        count = await store.pendingList.count
        XCTAssertEqual(count, 0)
    }

    func testSnapshotReplacesStateAndNeverRewindsSeq() async {
        let store = Store()
        _ = await store.applyEvent(EventFrame(t: "event", seq: 10, reason: "worker:change", ts: 0, payload: nil))
        // An in-flight event can outrun the snapshot being built — seq must not rewind.
        await store.applySnapshot(SnapshotFrame(t: "snapshot", seq: 8,
                                                workers: [worker("w-2", state: "WORKING")],
                                                pending: [pending("p-2", workerId: "w-2")]))
        let seq = await store.lastSeq
        XCTAssertEqual(seq, 10, "snapshot seq below the cursor must not rewind it")
        let workers = await store.workerList.map(\.id)
        XCTAssertEqual(workers, ["w-2"])
        let pendingIds = await store.pendingList.map(\.id)
        XCTAssertEqual(pendingIds, ["p-2"])
    }

    func testSeqGapIsReportedOncePastTheFirstFrame() async {
        let store = Store()
        var r = await store.applyEvent(EventFrame(t: "event", seq: 100, reason: "worker:change", ts: 0, payload: nil))
        XCTAssertEqual(r, .ok, "first frame seeds the cursor (mid-stream join is not a gap)")
        r = await store.applyEvent(EventFrame(t: "event", seq: 101, reason: "worker:change", ts: 0, payload: nil))
        XCTAssertEqual(r, .ok)
        r = await store.applyEvent(EventFrame(t: "event", seq: 105, reason: "worker:change", ts: 0, payload: nil))
        XCTAssertEqual(r, .seqGap, "a skipped seq must surface so the client can re-snapshot")
    }

    func testApplyWorkersRefreshesListWithoutTouchingPending() async {
        let store = Store()
        await store.applyBootstrap(workers: [worker("w-1", state: "IDLE")],
                                   pending: [pending("p-1", workerId: "w-1")])
        await store.applyWorkers([worker("w-1", state: "WORKING"), worker("w-2", state: "IDLE")])
        let state = await store.workers["w-1"]?.state
        XCTAssertEqual(state, "WORKING")
        let workerCount = await store.workerList.count
        XCTAssertEqual(workerCount, 2)
        let pendingCount = await store.pendingList.count
        XCTAssertEqual(pendingCount, 1, "workers refresh must not clobber pending")
        let pushes = await store.serverPushesState
        XCTAssertFalse(pushes, "a GET-driven refresh is not server push")
    }
}
