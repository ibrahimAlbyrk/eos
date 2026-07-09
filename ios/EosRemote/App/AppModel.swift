import Foundation
import SwiftUI
import OSLog
import EosRemoteKit

// Surfaced in Console.app / `log stream --predicate 'subsystem == "dev.eos.remote"'`.
private let eosLog = Logger(subsystem: "dev.eos.remote", category: "connect")

// A device's live connection state as the Devices UI needs it (Phase 5b). `dotState` maps onto the
// StateDot vocabulary so the same paper palette drives the device dots (connected→green, connecting→
// amber, error→brick, disconnected→gray).
enum DeviceConnState {
    case connected, connecting, disconnected, error

    var dotState: String {
        switch self {
        case .connected:    return "RUNNING"
        case .connecting:   return "WAITING"
        case .error:        return "FAILED"
        case .disconnected: return "IDLE"
        }
    }

    var label: String {
        switch self {
        case .connected:    return "Connected"
        case .connecting:   return "Connecting…"
        case .error:        return "Error"
        case .disconnected: return "Disconnected"
        }
    }
}

// The @MainActor coordinator over N paired Macs (Phase 5a). Each device has its own live
// DeviceConnection (its own WS connection + Store + transcript pipeline + backoff); AppModel holds
// them keyed by id and MIRRORS the ACTIVE device's fields into the @Published arrays the screens
// observe. All paired devices' connections stay alive in the background, so switchDevice(id) is
// instant — the target's Store is already live and just becomes the mirror source.
//
// The control-action + transcript API (sendMessage/interrupt/openWorker/…) is preserved 1:1 — each
// method forwards to the active DeviceConnection, so RootView/FleetView/WorkerDetailView are
// unchanged. `needsPairing` now means "no devices at all"; a single device with bad creds surfaces
// as that device's lastError, not global needsPairing.
@MainActor
final class AppModel: ObservableObject {
    // Mirror of the active device (published to the views).
    @Published var workers: [Worker] = []
    @Published var pending: [Pending] = []
    @Published var connected = false
    @Published var connecting = false
    @Published var needsPairing = false
    @Published var lastError: String?
    @Published var transcript: [Block] = []
    @Published var loadingOlder = false

    // Devices UI surface (Phase 5b consumes these). `devices` is the ordered paired list;
    // `activeDeviceId` selects which device the mirror + all control actions target.
    @Published private(set) var devices: [Device] = []
    @Published private(set) var activeDeviceId: String?

    private(set) var hasOlder = false

    // The active device row (Phase 5b) — the sidebar chip + Devices highlight read it.
    var activeDevice: Device? { activeDeviceId.flatMap { id in devices.first { $0.id == id } } }

    private let deviceStore: DeviceStore
    private var connections: [String: DeviceConnection] = [:]

    private var active: DeviceConnection? { activeDeviceId.flatMap { connections[$0] } }

    init(deviceStore: DeviceStore = DeviceStore()) {
        self.deviceStore = deviceStore
    }

    // MARK: bootstrap — load the paired list (migrating the legacy single device on first launch)

    // Called once on launch (RootView.task) and every foreground. Loads persisted devices, folds the
    // legacy single-device creds into a Device the first time, spins up a live connection per device,
    // and connects them all so switching is immediate.
    func resumeIfPossible() async {
        _ = deviceStore.migrateLegacyIfNeeded()
        reloadDevices()
        guard !devices.isEmpty else {
            eosLog.info("connect: no paired devices → show QR")
            needsPairing = true
            return
        }
        needsPairing = false
        if activeDeviceId == nil { activeDeviceId = deviceStore.activeId() ?? devices.first?.id }
        for device in devices { ensureConnection(for: device) }
        mirrorActive()
        // Connect every device (idempotent) so all paired Macs are live in the background.
        for conn in connections.values { await conn.connect() }
        mirrorActive()
    }

    // Rebuild `devices` from the store; prune connections for devices that are gone.
    private func reloadDevices() {
        devices = deviceStore.load()
        let ids = Set(devices.map(\.id))
        for id in Array(connections.keys) where !ids.contains(id) {
            let conn = connections.removeValue(forKey: id)
            Task { await conn?.teardown() }
        }
    }

    @discardableResult
    private func ensureConnection(for device: Device) -> DeviceConnection {
        if let existing = connections[device.id] { return existing }
        let conn = DeviceConnection(device: device)
        conn.onChange = { [weak self, weak conn] in
            guard let self, let conn else { return }
            if conn.deviceId == self.activeDeviceId {
                self.mirrorActive()
            } else {
                // A background device's connection state changed — the Devices list + sidebar chip
                // show its live dot, so re-publish even though it is not the mirror source.
                self.objectWillChange.send()
            }
        }
        connections[device.id] = conn
        return conn
    }

    // Copy the active device's fields into the published mirror. Called on activation + on any
    // active-device change (via onChange). Devices with no active member fall back to empty/needsPairing.
    private func mirrorActive() {
        guard let a = active else {
            workers = []; pending = []; transcript = []
            connected = false; connecting = false; lastError = nil
            hasOlder = false; loadingOlder = false
            needsPairing = devices.isEmpty
            return
        }
        workers = a.workers
        pending = a.pending
        connected = a.connected
        connecting = a.connecting
        lastError = a.lastError
        transcript = a.transcript
        hasOlder = a.hasOlder
        loadingOlder = a.loadingOlder
        needsPairing = false
    }

    // MARK: device management (Phase 5b API)

    // Switch the active device. INSTANT: the target's connection is already live, so we just re-point
    // the mirror at its cached state (no reconnect, no reload). Re-opens the same worker if one is open.
    func switchDevice(_ id: String) async {
        guard id != activeDeviceId, connections[id] != nil else { return }
        // Remember what the outgoing device had open so we can hand focus to the incoming one cleanly.
        activeDeviceId = id
        deviceStore.setActiveId(id)
        mirrorActive()
        // Ensure the target is connecting if it dropped while backgrounded.
        if let conn = active, !conn.connected, !conn.connecting { await conn.connect() }
    }

    // Pair a NEW device from a scanned v3 QR: mint a Device, persist it, connect, append, make active.
    func addDevice(qr: QRPayload) async {
        guard let relayURL = qr.relayURL else { lastError = "pairing failed: no relay url"; return }
        let device = Device(id: Device.newId(), label: Device.label(fromRelay: qr.relay),
                            relayUrl: relayURL.absoluteString, room: qr.room, bearer: qr.bearer,
                            lastActive: Date().timeIntervalSince1970)
        deviceStore.upsert(device)
        deviceStore.setActiveId(device.id)
        reloadDevices()
        activeDeviceId = device.id
        let conn = ensureConnection(for: device)
        needsPairing = false
        mirrorActive()
        await conn.connect()
        deviceStore.touch(device.id)
        mirrorActive()
    }

    // Remove a device: tear down its connection, wipe its creds, drop it. If it was active, fall back
    // to another device (or needsPairing when none remain).
    func removeDevice(_ id: String) async {
        if let conn = connections.removeValue(forKey: id) { await conn.teardown() }
        let newActive = deviceStore.remove(id)
        reloadDevices()
        if activeDeviceId == id { activeDeviceId = newActive }
        if devices.isEmpty { needsPairing = true }
        mirrorActive()
    }

    // The first-device pairing entry point used by the existing Pair sheet. Identical UX to before:
    // scan → this adds the FIRST device and connects it. (addDevice covers subsequent devices too.)
    func startPairing(qr: QRPayload) async { await addDevice(qr: qr) }

    // The live connection state of one device (Phase 5b) — the Devices list dot + sidebar chip read
    // this per row, since only the ACTIVE device is mirrored into `connected`/`connecting`. Reads the
    // background connection kept alive by 5a; unknown ids read as disconnected.
    func connectionState(for id: String) -> DeviceConnState {
        guard let conn = connections[id] else { return .disconnected }
        if conn.connected { return .connected }
        if conn.authRejected { return .error }
        if conn.connecting { return .connecting }
        if conn.lastError != nil { return .error }
        return .disconnected
    }

    // MARK: scene lifecycle — fan out to every device

    func enterForeground() async {
        _ = deviceStore.migrateLegacyIfNeeded()
        reloadDevices()
        guard !devices.isEmpty else { needsPairing = true; mirrorActive(); return }
        needsPairing = false
        if activeDeviceId == nil { activeDeviceId = deviceStore.activeId() ?? devices.first?.id }
        for device in devices { ensureConnection(for: device) }
        for conn in connections.values { await conn.enterForeground() }
        mirrorActive()
    }

    func enterBackground() async {
        for conn in connections.values { await conn.enterBackground() }
        mirrorActive()
    }

    // MARK: forwarded control actions (target the active device)

    var orchestrators: [Worker] { active?.orchestrators ?? [] }
    var plainWorkers: [Worker] { active?.plainWorkers ?? [] }
    func isBusy(_ id: String) -> Bool { active?.isBusy(id) ?? false }

    func sendMessage(to id: String, text: String, queueWhenBusy: Bool = true) async {
        await active?.sendMessage(to: id, text: text, queueWhenBusy: queueWhenBusy)
    }
    func interrupt(_ id: String) async { await active?.interrupt(id) }
    func answerQuestion(workerId: String, toolUseId: String, answers: [String]) async {
        await active?.answerQuestion(workerId: workerId, toolUseId: toolUseId, answers: answers)
    }
    func kill(_ id: String) async { await active?.kill(id) }
    @discardableResult
    func rewind(workerId: String, text: String) async -> Bool {
        await active?.rewind(workerId: workerId, text: text) ?? false
    }
    func spawnWorker(body: JSONValue) async { await active?.spawnWorker(body: body) }
    func approve(pendingId: String, allow: Bool) async { await active?.approve(pendingId: pendingId, allow: allow) }

    // MARK: forwarded transcript actions (target the active device)

    func openWorker(_ id: String) async { await active?.openWorker(id); mirrorActive() }
    func closeWorker(_ id: String) { active?.closeWorker(id) }
    func loadOlder() async { await active?.loadOlder(); mirrorActive() }
    func activeGoalCheck(for id: String) -> LoopCheckProgress? { active?.activeGoalCheck(for: id) }
    func loopHistory(for id: String) -> [LoopCheck] { active?.loopHistory(for: id) ?? [] }
}
