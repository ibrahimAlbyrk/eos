import Foundation

// Orders a terminal mirror's reattach (port of the desktop's replayGate.js). The live pty:data
// subscription and the GET /pty/:id/buffer fetch race: frames arriving before the buffer lands are
// held so the scrollback always writes first, then every frame the buffer already covers
// (seq <= its seq) is dropped. Returns the chunks to write, in order.
public struct PtyReplayGate: Sendable {
    private var replayed = false
    private var lastSeq = 0
    private var held: [(seq: Int, data: String)] = []

    public init() {}

    // A live pty:data frame.
    public mutating func frame(seq: Int, data: String) -> [String] {
        guard replayed else {
            held.append((seq, data))
            return []
        }
        return accept(seq, data).map { [$0] } ?? []
    }

    // The fetched ring buffer — seq 0 / "" when it was unavailable, so every held frame writes
    // through. A second call is ignored.
    public mutating func replay(seq: Int, data: String) -> [String] {
        guard !replayed else { return [] }
        replayed = true
        lastSeq = seq
        var out = data.isEmpty ? [] : [data]
        for f in held {
            if let d = accept(f.seq, f.data) { out.append(d) }
        }
        held = []
        return out
    }

    private mutating func accept(_ seq: Int, _ data: String) -> String? {
        guard seq > lastSeq else { return nil }
        lastSeq = seq
        return data
    }
}
