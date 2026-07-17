// Ingestion layer — turns the network into [AgentSnapshot]. Knows HTTP/SSE;
// knows nothing about icons or queues. Exposed only as the AgentStatusSource
// port (DIP), so a mock can feed the domain in tests with zero networking.

import Foundation

// SOURCE port. The coordinator/domain depend on this abstraction, not URLSession.
protocol AgentStatusSource: AnyObject {
    var onSnapshot: (([AgentSnapshot]) -> Void)? { get set }
    var onConnectivity: ((Bool) -> Void)? { get set }
    func start()
    func stop()
}

// Live source: mirrors the web's proven SSE-ping → REST-refetch loop
// (app/ui/src/hooks/useLive.js) in Swift. The /stream frame is treated as an
// invalidation hint only; the authoritative state is always the refetched
// /workers array. Opens its own loopback stream (one extra reader) so the
// status item is independent of the notification SSE consumer in AppDelegate.
final class SSEAgentStatusSource: NSObject, AgentStatusSource, URLSessionDataDelegate {
    private let base: String
    private let refetchDebounce: TimeInterval = 0.12   // collapse a burst of worker:* frames
    private let pollInterval: TimeInterval = 4.0       // safety net for a missed frame

    var onSnapshot: (([AgentSnapshot]) -> Void)?
    var onConnectivity: ((Bool) -> Void)?

    private var sseSession: URLSession?
    private var sseTask: URLSessionDataTask?
    private var sseBuffer = Data()
    // Consumed-prefix offset into sseBuffer (O(1) amortized line drain — see
    // urlSession(_:dataTask:didReceive:)).
    private var sseScan = 0
    // SSE delegate callbacks run here, OFF main; only refetch scheduling and the
    // connectivity/snapshot delivery hop to main. Serial to preserve line order
    // and single-threaded buffer access.
    private let sseQueue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "com.ibrahimalbyrk.eos.sse.statusbar"
        return q
    }()
    private var pollTimer: Timer?
    private var debounceItem: DispatchWorkItem?
    private var reconnectBackoff: TimeInterval = 1.0
    private var started = false
    private var connected = false

    init(base: String = "http://127.0.0.1:7400") {
        self.base = base
        super.init()
    }

    func start() {
        guard !started else { return }
        started = true
        connectSSE()
        refetch()
        let timer = Timer(timeInterval: pollInterval, repeats: true) { [weak self] _ in self?.refetch() }
        RunLoop.main.add(timer, forMode: .common)
        pollTimer = timer
    }

    func stop() {
        started = false
        sseTask?.cancel(); sseTask = nil
        sseSession?.invalidateAndCancel(); sseSession = nil
        pollTimer?.invalidate(); pollTimer = nil
        debounceItem?.cancel(); debounceItem = nil
    }

    // MARK: - SSE stream (invalidation hints)

    private func connectSSE() {
        sseTask?.cancel()
        sseBuffer = Data()
        sseScan = 0
        guard let url = URL(string: "\(base)/stream") else { return }
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = TimeInterval(INT_MAX)
        cfg.timeoutIntervalForResource = TimeInterval(INT_MAX)
        sseSession = URLSession(configuration: cfg, delegate: self, delegateQueue: sseQueue)
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        sseTask = sseSession?.dataTask(with: req)
        sseTask?.resume()
    }

    // Runs on sseQueue (off main). This consumer only acts on reason "worker:*";
    // a raw-substring test (`"worker:` — the quoted JSON value) skips the JSON
    // parse for every other frame before any allocation.
    private func handleSSELine(_ line: String) {
        guard line.hasPrefix("data: "), line.contains("\"worker:") else { return }
        let json = String(line.dropFirst(6))
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let reason = obj["reason"] as? String,
              reason.hasPrefix("worker:") else { return }
        scheduleRefetch()
    }

    // debounceItem and the main-run-loop timer are main-affine, so the whole
    // schedule hops to main even though the caller runs on sseQueue.
    private func scheduleRefetch() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.debounceItem?.cancel()
            let item = DispatchWorkItem { [weak self] in self?.refetch() }
            self.debounceItem = item
            DispatchQueue.main.asyncAfter(deadline: .now() + self.refetchDebounce, execute: item)
        }
    }

    func urlSession(_: URLSession, dataTask _: URLSessionDataTask, didReceive data: Data) {
        sseBuffer.append(data)
        let lf = Data([0x0a])
        var lineStart = sseBuffer.startIndex + sseScan
        while let nl = sseBuffer.range(of: lf, in: lineStart..<sseBuffer.endIndex) {
            if nl.lowerBound > lineStart,
               let line = String(data: sseBuffer.subdata(in: lineStart..<nl.lowerBound), encoding: .utf8),
               !line.isEmpty {
                handleSSELine(line)
            }
            lineStart = nl.upperBound
        }
        // Advance the consumed offset; compact only once the dead prefix is large,
        // so a big line arriving in many chunks isn't re-shifted on every chunk.
        sseScan = lineStart - sseBuffer.startIndex
        if sseScan > 65_536 {
            sseBuffer.removeSubrange(sseBuffer.startIndex..<lineStart)
            sseScan = 0
        }
    }

    func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError _: Error?) {
        guard started else { return }
        // setConnected → onConnectivity drives the AppKit status item; backoff +
        // reconnect scheduling are main-affine too. Callback is on sseQueue now.
        DispatchQueue.main.async { [weak self] in
            guard let self = self, self.started else { return }
            self.setConnected(false)
            let delay = self.reconnectBackoff
            self.reconnectBackoff = min(self.reconnectBackoff * 2, 30)
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                guard let self = self, self.started else { return }
                self.connectSSE()
            }
        }
    }

    // MARK: - REST refetch (authoritative state)

    private func refetch() {
        guard let url = URL(string: "\(base)/workers") else { return }
        var req = URLRequest(url: url); req.timeoutInterval = 6
        URLSession.shared.dataTask(with: req) { [weak self] data, resp, _ in
            guard let self = self else { return }
            guard (resp as? HTTPURLResponse)?.statusCode == 200,
                  let data = data,
                  let arr = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] else {
                return
            }
            let snapshots = arr.map(Self.snapshot(from:))
            DispatchQueue.main.async {
                self.reconnectBackoff = 1.0
                self.setConnected(true)
                self.onSnapshot?(snapshots)
            }
        }.resume()
    }

    private func setConnected(_ value: Bool) {
        guard connected != value else { return }
        connected = value
        onConnectivity?(value)
    }

    // MARK: - Decoding (snake_case /workers rows → AgentSnapshot)

    private static func snapshot(from row: [String: Any]) -> AgentSnapshot {
        let state = AgentState(rawValue: row["state"] as? String ?? "") ?? .idle
        return AgentSnapshot(
            id: row["id"] as? String ?? "",
            state: state,
            name: row["name"] as? String,
            isOrchestrator: num(row["is_orchestrator"])?.intValue == 1,
            parentId: row["parent_id"] as? String,
            startedAt: num(row["started_at"])?.doubleValue,
            endedAt: num(row["ended_at"])?.doubleValue,
            turnStartedAt: num(row["turn_started_at"])?.doubleValue,
            exitCode: num(row["exit_code"])?.intValue,
            role: row["agent_role"] as? String,
            definition: row["worker_definition"] as? String
        )
    }

    private static func num(_ any: Any?) -> NSNumber? {
        any as? NSNumber
    }
}
