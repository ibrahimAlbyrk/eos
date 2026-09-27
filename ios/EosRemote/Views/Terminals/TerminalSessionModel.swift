import Foundation
import EosRemoteKit

// One terminal screen's live state: the claude pane's transcript (GET /pty/:id/conversation,
// rendered by the worker message views), the question/plan it is blocked on, and the coalesced
// keystroke sender both faces share. Owned by TerminalSessionView; talks to the daemon through
// AppModel and receives this session's pty:conversation / pty:data while started.
@MainActor
final class TerminalSessionModel: ObservableObject {
    let sessionId: String

    @Published private(set) var blocks: [Block] = []
    @Published private(set) var prompt: PendingPrompt?
    @Published private(set) var running = false
    @Published private(set) var loaded = false

    // The Terminal face's sink for live pty:data (seq, data); nil while that face is hidden.
    var onOutput: ((Int, String) -> Void)?

    private let app: AppModel
    private var transcript = PtyTranscript()
    private var durable: [Block] = []
    private var optimistic: [(id: String, text: String, ts: Double)] = []
    private var fetching = false
    private var fetchAgain = false
    private var inputBuffer = ""
    private var sendingInput = false

    init(app: AppModel, sessionId: String) {
        self.app = app
        self.sessionId = sessionId
    }

    func start() {
        app.setPtyListener(sessionId) { [weak self] event in self?.handle(event) }
        Task { await refresh() }
    }

    func stop() {
        app.setPtyListener(sessionId, nil)
        Task { await app.setPtySubscription([]) }
    }

    private func handle(_ event: EventFrame) {
        switch event.reason {
        case "pty:conversation":
            Task { await refresh() }
        case "pty:data":
            guard let seq = event.payload?["seq"]?.intValue,
                  let data = event.payload?["data"]?.stringValue else { return }
            onOutput?(seq, data)
        default:
            break
        }
    }

    // Serialized: nudges landing mid-fetch collapse into one trailing refetch.
    func refresh() async {
        if fetching { fetchAgain = true; return }
        fetching = true
        defer { fetching = false }
        repeat {
            fetchAgain = false
            let after = transcript.newestId
            guard let body = await app.ptyConversation(sessionId, afterId: after) else { break }
            switch transcript.apply(body, afterId: after) {
            case .changed: rebuild()
            case .refetch: fetchAgain = true
            case .unchanged: break
            }
        } while fetchAgain
        loaded = true
    }

    private func rebuild() {
        durable = MessageNormalizer.buildBlocks(evs: transcript.evs, workerId: sessionId)
        prompt = transcript.pending
        running = transcript.running
        publish()
    }

    // Durable blocks + optimistic user bubbles still waiting for their transcript row.
    private func publish() {
        let landed = Set(durable.compactMap { b -> String? in
            if case let .user(text, _) = b.payload { return text.trimmingCharacters(in: .whitespacesAndNewlines) }
            return nil
        })
        optimistic.removeAll { landed.contains($0.text) }
        blocks = sortBlocksByTs(durable + optimistic.map {
            Block(id: "optimistic:\($0.id)", workerId: sessionId, ts: $0.ts,
                  payload: .user(text: $0.text, optimistic: true))
        })
    }

    // MARK: actions

    func send(_ text: String) async -> DeviceConnection.PtyMessageResult {
        let id = UUID().uuidString
        optimistic.append((id, text, Date().timeIntervalSince1970 * 1000))
        publish()
        let result = await app.ptyMessage(sessionId, text: text)
        if result != .sent {
            optimistic.removeAll { $0.id == id }
            publish()
        }
        return result
    }

    // A rejected answer usually means the dialog moved on (409: already answered elsewhere) —
    // refetch so a stale card goes away.
    func answer(_ toolUseId: String, _ answers: [PendingAnswer]) async -> Bool {
        let ok = await app.ptyAnswer(sessionId, toolUseId: toolUseId, answers: answers)
        if !ok { await refresh() }
        return ok
    }

    func approvePlan(_ toolUseId: String) async -> Bool {
        let ok = await app.ptyApprovePlan(sessionId, toolUseId: toolUseId)
        if !ok { await refresh() }
        return ok
    }

    // Esc — what interrupts a running Claude Code turn.
    func interrupt() { sendInput("\u{1b}") }

    // Keystrokes coalesce like the desktop terminal's send queue: one POST in flight, whatever is
    // typed meanwhile rides the next — ordered, without a relay round trip per key.
    func sendInput(_ data: String) {
        inputBuffer += data
        flushInput()
    }

    private func flushInput() {
        guard !sendingInput, !inputBuffer.isEmpty else { return }
        let payload = inputBuffer
        inputBuffer = ""
        sendingInput = true
        Task {
            _ = await app.ptyInput(sessionId, data: payload)
            sendingInput = false
            flushInput()
        }
    }

    // MARK: terminal mirror

    func setStreaming(_ on: Bool) async { await app.setPtySubscription(on ? [sessionId] : []) }
    func fetchBuffer() async -> (seq: Int, data: String)? { await app.ptyBuffer(sessionId) }
}
