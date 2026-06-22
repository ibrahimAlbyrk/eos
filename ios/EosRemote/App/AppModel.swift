import Foundation
import SwiftUI
import UIKit
import EosRemoteKit

// The @MainActor bridge between the live store/transport (EosRemoteKit) and SwiftUI. It is the
// WSConnection delegate: server frames land here, fold into the Store actor, and surface as
// @Published arrays the screens observe. Control actions tunnel REST over the WS.
@MainActor
final class AppModel: ObservableObject {
    @Published var workers: [Worker] = []
    @Published var pending: [Pending] = []
    @Published var connected = false
    @Published var lastError: String?

    let store = Store()
    private var connection: WSConnection?
    private var session: SessionState?
    private var identity: DeviceIdentity?

    init() {
        Task { await store.setOnChange { [weak self] in Task { @MainActor in await self?.refresh() } } }
    }

    private func refresh() async {
        workers = await store.workerList.sorted { $0.id < $1.id }
        pending = await store.pendingList.sorted { $0.id < $1.id }
    }

    var orchestrators: [Worker] { workers.filter { $0.isOrchestrator } }
    var plainWorkers: [Worker] { workers.filter { !$0.isOrchestrator } }

    // MARK: control actions (tunneled REST)

    func sendMessage(to id: String, text: String, queueWhenBusy: Bool = true) async {
        let body: JSONValue = .object([
            "text": .string(text),
            "clientMsgId": .string(UUID().uuidString),
            "queueWhenBusy": .bool(queueWhenBusy),
        ])
        await control("POST", "/workers/\(id)/message", body)
    }

    func interrupt(_ id: String) async { await control("POST", "/workers/\(id)/interrupt", .object([:])) }

    func answerQuestion(workerId: String, toolUseId: String, answers: [String]) async {
        let body: JSONValue = .object([
            "toolUseId": .string(toolUseId),
            "answers": .array(answers.map { .string($0) }),
        ])
        await control("POST", "/workers/\(workerId)/question-answer", body)
    }

    // High-risk verbs (kill/spawn/decision) require step-up; the UI calls these knowing a Face ID
    // prompt may appear (§7.3). The challenge round-trip is wired by stepUpControl().
    func kill(_ id: String) async { await stepUpControl("DELETE", "/workers/\(id)", .object([:])) }
    func spawnWorker(body: JSONValue) async { await stepUpControl("POST", "/workers", body) }
    func approve(pendingId: String, allow: Bool) async {
        await stepUpControl("POST", "/pending/\(pendingId)/decision",
                            .object(["decision": .string(allow ? "allow" : "deny")]))
    }

    // Serialize the body EXACTLY ONCE → these bytes are both transmitted (as the opaque body
    // string) and, for step-up, hashed. One serialization = nothing for the two ends to disagree on.
    private func encodeOnce(_ body: JSONValue) -> Data {
        (try? JSONEncoder().encode(body)) ?? Data("{}".utf8)
    }

    private func control(_ method: String, _ path: String, _ body: JSONValue) async {
        guard let connection else { lastError = "not connected"; return }
        do { _ = try await connection.sendControl(method: method, path: path, bodyData: encodeOnce(body)) }
        catch { lastError = error.localizedDescription }
    }

    // Obtain a fresh challenge, build the step-up field over the EXACT transmitted body bytes, send.
    private func stepUpControl(_ method: String, _ path: String, _ body: JSONValue) async {
        guard let connection, let session, let identity else { lastError = "not connected"; return }
        do {
            let bodyData = encodeOnce(body)
            let chReply = try await connection.sendControl(method: "POST", path: "/stepup/challenge",
                                                           bodyData: Data("{}".utf8))
            guard let nonceB64 = chReply.body?["challengeNonce"]?.stringValue,
                  let nonce = Bytes.fromB64u(nonceB64) else { lastError = "no challenge"; return }
            let coordinator = StepUpCoordinator(identity: identity, session: session)
            let ts = Int64(Date().timeIntervalSince1970)
            let field = try coordinator.field(method: method, path: path, bodyBytes: bodyData,
                                              challengeNonce: nonce, ts: ts, reason: "Authorize \(method) \(path)")
            _ = try await connection.sendControl(method: method, path: path, bodyData: bodyData, stepUp: field)
        } catch { lastError = error.localizedDescription }
    }

    // MARK: pairing + bootstrap

    // Run the cold PAIR choreography over a fresh relay connection, persist the durable bearer +
    // ticket, then bootstrap current state via READ controls (no snapshot-on-hello yet, daemon-side).
    func startPairing(qr: QRPayload, room: String, pairBearer: String) async {
        do {
            let relayURL = try relayWSURL(qr)
            let identity = try DeviceIdentityFactory.create()
            self.identity = identity
            let conn = WSConnection(url: relayURL, mode: .relay(bearer: pairBearer), delegate: self)
            let coordinator = PairingCoordinator(
                connection: conn, qr: qr, identity: identity, room: room, pairBearer: pairBearer,
                devId: UUID().uuidString, label: UIDevice.current.name)
            let result = try await coordinator.run()
            self.connection = conn
            self.session = result.session
            try? KeychainStore.set(KeychainStore.durableBearer, Data(result.durableBearer.utf8))
            try? KeychainStore.set(KeychainStore.ticket, JSONEncoder().encode(result.ticket))
            connected = true
            await bootstrap()
        } catch { lastError = "pairing failed: \(error)" }
    }

    // Cold-start state pull: READ-tier GETs feed a synthetic snapshot until snapshot-on-hello lands.
    private func bootstrap() async {
        guard let connection else { return }
        async let w = try? connection.sendControl(method: "GET", path: "/workers", bodyData: Data("{}".utf8))
        async let p = try? connection.sendControl(method: "GET", path: "/pending", bodyData: Data("{}".utf8))
        let workers = (await w)?.body?.arrayValue ?? []
        let pending = (await p)?.body?.arrayValue ?? []
        await store.applyBootstrap(workers: workers, pending: pending)
    }

    private func relayWSURL(_ qr: QRPayload) throws -> URL {
        guard let s = qr.relay?.url, let u = URL(string: s) else { throw PairingCoordinator.PairError.denied("no relay url") }
        return u
    }
}

// WSConnection delegate — fold incoming frames into the store on the main actor.
extension AppModel: WSConnectionDelegate {
    nonisolated func wsDidReceive(snapshot: SnapshotFrame) async { await store.applySnapshot(snapshot) }
    nonisolated func wsDidReceive(patch: PatchFrame) async { _ = await store.applyPatch(patch) }
    nonisolated func wsDidReceive(event: EventFrame) async { _ = await store.applyEvent(event) }
    nonisolated func wsDidReceive(challenge: ChallengeFrame) async { /* delivered inline via reply */ }
    nonisolated func wsDidReceive(error: ErrorFrame) async {
        await MainActor.run { self.lastError = "\(error.code): \(error.message ?? "")" }
    }
    nonisolated func wsConnectionStateChanged(connected: Bool) async {
        await MainActor.run { self.connected = connected }
    }
}
