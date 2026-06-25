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
        guard let url = URL(string: "\(base)/stream") else { return }
        let cfg = URLSessionConfiguration.default
        cfg.timeoutIntervalForRequest = TimeInterval(INT_MAX)
        cfg.timeoutIntervalForResource = TimeInterval(INT_MAX)
        sseSession = URLSession(configuration: cfg, delegate: self, delegateQueue: .main)
        var req = URLRequest(url: url)
        req.setValue("text/event-stream", forHTTPHeaderField: "Accept")
        sseTask = sseSession?.dataTask(with: req)
        sseTask?.resume()
    }

    private func handleSSELine(_ line: String) {
        guard line.hasPrefix("data: ") else { return }
        let json = String(line.dropFirst(6))
        guard let data = json.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let reason = obj["reason"] as? String,
              reason.hasPrefix("worker:") else { return }
        scheduleRefetch()
    }

    private func scheduleRefetch() {
        debounceItem?.cancel()
        let item = DispatchWorkItem { [weak self] in self?.refetch() }
        debounceItem = item
        DispatchQueue.main.asyncAfter(deadline: .now() + refetchDebounce, execute: item)
    }

    func urlSession(_: URLSession, dataTask _: URLSessionDataTask, didReceive data: Data) {
        sseBuffer.append(data)
        while let range = sseBuffer.range(of: Data("\n".utf8)) {
            let lineData = sseBuffer.subdata(in: sseBuffer.startIndex..<range.lowerBound)
            sseBuffer.removeSubrange(sseBuffer.startIndex...range.lowerBound)
            if let line = String(data: lineData, encoding: .utf8), !line.isEmpty {
                handleSSELine(line)
            }
        }
    }

    func urlSession(_: URLSession, task _: URLSessionTask, didCompleteWithError _: Error?) {
        guard started else { return }
        setConnected(false)
        let delay = reconnectBackoff
        reconnectBackoff = min(reconnectBackoff * 2, 30)
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            guard let self = self, self.started else { return }
            self.connectSSE()
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
