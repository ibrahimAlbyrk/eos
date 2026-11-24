import Foundation
import EosRemoteKit

// The share sheet's run (07 §4.8): the shared thing, a paired Mac (the one the app shows), the
// routines that take it, a note, Run. With the Mac there, the routines come from its match read
// and the run starts at once; with it away, they come from the list the app last read, and the run
// waits in that Mac's outbox until the app is next connected to it.
@MainActor
final class ShareModel: ObservableObject {
    enum Phase: Equatable {
        case loading
        /// The routines to pick from; `live` when the Mac answered.
        case ready(live: Bool)
        case finished(String)
        case failed(String)
    }

    @Published private(set) var phase: Phase = .loading
    @Published private(set) var routines: [EosRoutine] = []
    @Published private(set) var thing: SharedThing?
    @Published private(set) var devices: [Device] = []
    @Published private(set) var device: Device?
    @Published var picked: String?
    @Published var note = ""
    @Published private(set) var starting = false
    @Published private(set) var refusal: String?

    private let cache = EosCache.shared()
    private var link: ShareLink?
    // One id per sheet: a second press answers the run the first one made.
    private let requestId = UUID().uuidString

    func load(_ thing: SharedThing?) async {
        let store = DeviceStore()
        devices = store.load()
        guard let thing else { phase = .failed("Eos can run a link or a text."); return }
        self.thing = thing
        guard let first = devices.first(where: { $0.id == store.activeId() }) ?? devices.first else {
            phase = .failed("Pair a Mac in the Eos app first.")
            return
        }
        await choose(first)
    }

    func choose(_ device: Device) async {
        guard let thing else { return }
        self.device = device
        phase = .loading
        picked = nil
        refusal = nil
        await link?.close()
        link = await ShareLink.open(device)
        if let link, let listed = await Self.routines(link),
           case let (status, answer)? = await link.call("POST", "/api/routines/match-item", thing.matchRequest),
           (200..<300).contains(status), let matched = SharedThing.matched(answer, among: listed) {
            routines = matched
            phase = .ready(live: true)
        } else {
            let cached = cache.load(device: device.id)?.routines ?? []
            routines = thing.offlineMatches(cached)
            phase = .ready(live: false)
        }
        picked = routines.first?.id
    }

    func run() async {
        guard let thing, let device, let routine = routines.first(where: { $0.id == picked }) else { return }
        starting = true
        refusal = nil
        defer { starting = false }
        let body = thing.start(routine, note: note, requestId: requestId)
        if let link, case let (status, answer)? = await link.call("POST", "/api/runs", body) {
            switch AnswerOutbox.result(status: status, body: answer) {
            case .sent: phase = .finished("\(routine.name) started on \(device.label).")
            case .changed(let why), .stale(let why), .refused(let why): refusal = why
            }
            return
        }
        AnswerOutbox.shared(device: device.id).add(.start(body))
        phase = .finished("\(routine.name) starts when the Eos app next reaches \(device.label).")
    }

    func close() async {
        await link?.close()
        link = nil
    }

    /// The routines a run can be started for, as the Eos tab lists them.
    private static func routines(_ link: ShareLink) async -> [EosRoutine]? {
        guard case let (status, body)? = await link.call("GET", "/api/routines", .object([:])), (200..<300).contains(status),
              let body, let data = try? JSONEncoder().encode(body),
              let rows = try? JSONDecoder().decode([EosRoutine].self, from: data)
        else { return nil }
        return rows.filter { $0.kind == "standing" || $0.kind == "project" }
    }
}
