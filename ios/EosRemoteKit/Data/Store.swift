import Foundation

// The live store (design §5.2): a Swift actor holding `workers` and `pending` as id-keyed
// dicts. The server PUSHES snapshot/patch/event — there is no refetch-on-nudge — so applying
// frames here is the whole state machine. A detected seq gap asks for a fresh snapshot.
public actor Store {
    public private(set) var workers: [String: Worker] = [:]
    public private(set) var pending: [String: Pending] = [:]
    public private(set) var lastSeq: Int = 0
    public private(set) var lastContentId: Int = 0
    // Flips true on the first patch/snapshot — the daemon speaks §5.4.2/3, so the
    // event-driven list refetch fallback (pre-patch daemons) can stand down.
    public private(set) var serverPushesState = false

    // Continuation-style change notification for the @MainActor view model.
    private var onChange: (@Sendable () -> Void)?
    public func setOnChange(_ cb: @escaping @Sendable () -> Void) { onChange = cb }

    public init() {}

    public enum ApplyResult: Sendable { case ok, seqGap }

    // Cold-start bootstrap from READ-control GET arrays (also the fallback list
    // refresh path for daemons that don't push patch/snapshot frames yet).
    public func applyBootstrap(workers wkrs: [JSONValue], pending pend: [JSONValue]) {
        workers = Dictionary(uniqueKeysWithValues: wkrs.map { let w = Worker(raw: $0); return (w.id, w) })
        pending = Dictionary(uniqueKeysWithValues: pend.map { let p = Pending(raw: $0); return (p.id, p) })
        notify()
    }

    // Fallback list refresh (workers only) — same replace semantics as bootstrap
    // without touching pending (the two lists refresh on independent triggers).
    public func applyWorkers(_ rows: [JSONValue]) {
        workers = Dictionary(uniqueKeysWithValues: rows.map { let w = Worker(raw: $0); return (w.id, w) })
        notify()
    }

    public func applyPending(_ rows: [JSONValue]) {
        pending = Dictionary(uniqueKeysWithValues: rows.map { let p = Pending(raw: $0); return (p.id, p) })
        notify()
    }

    public func applySnapshot(_ snap: SnapshotFrame) {
        workers = Dictionary(uniqueKeysWithValues: snap.workers.map { let w = Worker(raw: $0); return (w.id, w) })
        pending = Dictionary(uniqueKeysWithValues: snap.pending.map { let p = Pending(raw: $0); return (p.id, p) })
        // max(): an in-flight patch/event can outrun the snapshot being built;
        // going backwards here would fake a gap on the very next frame.
        lastSeq = max(lastSeq, snap.seq)
        serverPushesState = true
        notify()
    }

    public func applyPatch(_ patch: PatchFrame) -> ApplyResult {
        let gap = patch.seq > lastSeq + 1 && lastSeq != 0
        lastSeq = max(lastSeq, patch.seq)
        serverPushesState = true
        switch patch.resource {
        case "workers":
            let w = Worker(raw: patch.data)
            if patch.op == "remove" { workers[w.id] = nil } else { workers[w.id] = w }
        case "pending":
            let p = Pending(raw: patch.data)
            if patch.op == "remove" { pending[p.id] = nil } else { pending[p.id] = p }
        default: break
        }
        notify()
        return gap ? .seqGap : .ok
    }

    // `event` frames are the live channels (agent:delta, terminal:chunk, etc.). The durable
    // state still arrives via patch/snapshot; events drive the streaming buffers + content cursor.
    public func applyEvent(_ ev: EventFrame) -> ApplyResult {
        let gap = ev.seq > lastSeq + 1 && lastSeq != 0
        lastSeq = max(lastSeq, ev.seq)
        if let cid = ev.payload?["contentId"]?.intValue { lastContentId = max(lastContentId, cid) }
        return gap ? .seqGap : .ok
    }

    public var workerList: [Worker] { Array(workers.values) }
    public var pendingList: [Pending] { Array(pending.values) }

    private func notify() { onChange?() }
}
