import Foundation

// Live streaming thinking/text (design §5.2, port of thinkingStore.js). Buffer keyed
// (workerId, blockId); channels text = live assistant text, reasoning = thinking. A buffer is
// dropped ONLY when the durable canonical block with the same blockId arrives → flicker-free.
public actor ThinkingBuffers {
    public enum Channel: String, Sendable { case text, reasoning }
    public struct Buffer: Sendable { public var channel: Channel; public var content: String; public var active: Bool }

    private var buffers: [String: Buffer] = [:]   // key = workerId|blockId
    public init() {}

    private func key(_ w: String, _ b: String) -> String { "\(w)|\(b)" }

    // from an `agent:delta` event payload.
    public func applyDelta(workerId: String, blockId: String, channel: Channel, chunk: String, start: Bool, stop: Bool) {
        let k = key(workerId, blockId)
        var buf = buffers[k] ?? Buffer(channel: channel, content: "", active: true)
        if start { buf = Buffer(channel: channel, content: "", active: true) }
        buf.content += chunk
        if stop { buf.active = false }
        buffers[k] = buf
    }

    // Durable block with the same blockId landed → drop the live buffer (no flicker).
    public func dropOnDurable(workerId: String, blockId: String) { buffers[key(workerId, blockId)] = nil }

    public func buffer(workerId: String, blockId: String) -> Buffer? { buffers[key(workerId, blockId)] }
    public func active(workerId: String) -> [Buffer] {
        buffers.filter { $0.key.hasPrefix("\(workerId)|") && $0.value.active }.map(\.value)
    }
}

// Live terminal chunks (port of terminalStore.js): terminal:chunk appends, terminal:done closes
// + triggers an afterId backfill (the caller pages the durable tail via control GET).
public actor TerminalBuffers {
    public struct Run: Sendable { public var runId: String; public var content: String; public var done: Bool; public var lastId: Int }
    private var runs: [String: Run] = [:]
    public init() {}

    public func applyChunk(runId: String, chunk: String, id: Int) {
        var r = runs[runId] ?? Run(runId: runId, content: "", done: false, lastId: 0)
        r.content += chunk
        r.lastId = max(r.lastId, id)
        runs[runId] = r
    }
    public func applyDone(runId: String) -> Int? {
        guard var r = runs[runId] else { return nil }
        r.done = true; runs[runId] = r
        return r.lastId   // afterId cursor for the backfill GET
    }
    public func run(_ runId: String) -> Run? { runs[runId] }
}

// Transcript paging window (port of eventsStore.js): newest-first (order:desc limit 500), older
// via beforeId, live via afterId; an id-keyed union merge sorted by (ts, id). Pulled via tunneled
// control GET /workers/:id/events, not a snapshot field.
public actor EventsWindow {
    private var byId: [String: Block] = [:]
    public private(set) var workerId: String
    public init(workerId: String) { self.workerId = workerId }

    public func merge(_ blocks: [Block]) {
        for b in blocks { byId[b.id] = b }
    }
    // Sorted (ts, id) ascending for display.
    public var ordered: [Block] {
        byId.values.sorted { $0.ts != $1.ts ? $0.ts < $1.ts : $0.id < $1.id }
    }
    public var oldestId: String? { ordered.first?.id }
    public var newestId: String? { ordered.last?.id }
    public func cap(_ max: Int) {
        guard byId.count > max else { return }
        let keep = Set(ordered.suffix(max).map(\.id))
        byId = byId.filter { keep.contains($0.key) }
    }
}

// Message-send retry dedup (design §5.2): clientMsgId dedups across reconnects.
public actor Outbox {
    private var sent: Set<String> = []
    public init() {}
    public func freshId() -> String { UUID().uuidString }
    public func shouldSend(_ clientMsgId: String) -> Bool {
        if sent.contains(clientMsgId) { return false }
        sent.insert(clientMsgId); return true
    }
    public func ack(_ clientMsgId: String) { /* keep for idempotency window */ }
}
