import SwiftUI
import EosRemoteKit

// Push destinations for the root NavigationStack (contract §B1) — a typed Route replaces the old
// bare-String path.
enum Route: Hashable {
    case conversation(String)   // workerId
    case newSession
}

// Root shell (contract §B1): SidebarContainer { DrawerView | NavigationStack }. Stack root is the
// Code list or Devices per the drawer section; conversations and the new-session screen push. Owns
// the app-level sheets (PairingView, AddDeviceSheet, DeviceSwitcherSheet), deep-link routing
// (eos://worker/… , eos://pending), and scene-phase resume.
struct RootView: View {
    @StateObject private var model = AppModel()
    @StateObject private var sidebar: SidebarState
    @Environment(\.scenePhase) private var scenePhase
    // Typed path (not NavigationPath) so write-on-change persistence can see what's on top.
    @State private var path: [Route]
    @State private var showPairing = false
    @State private var showAddDevice = false
    @State private var showDeviceSwitcher = false
    // "Pair new Mac…" chains through onDismiss — presenting a sibling sheet while the switcher is
    // still animating out gets dropped by SwiftUI.
    @State private var pairAfterSwitcher = false

    // Launch restoration (round 7): reopen exactly as closed — the saved drawer section, and the
    // conversation that was open pushed IMMEDIATELY (no waiting for bootstrap; the transcript
    // loads in as usual, and WorkerDetailView pops back silently if the id turns out stale).
    // State is scoped to the persisted active device; a half-typed new-session is ephemeral and
    // relaunches to the Code list (its slot saves as nil).
    init() {
        let store = UIStateStore()
        #if DEBUG
        // UITest hook (-eosGallery pattern): start from a clean Code-list root.
        if CommandLine.arguments.contains("-eosResetUIState") { store.clearAll() }
        #endif
        let saved = store.state(for: DeviceStore().activeId())
        _sidebar = StateObject(wrappedValue: SidebarState(
            section: saved.section.flatMap(SidebarSection.init(rawValue:)) ?? .code))
        _path = State(initialValue: saved.openWorkerId.map { [Route.conversation($0)] } ?? [])
    }

    var body: some View {
        SidebarContainer {
            DrawerView(onSelectSection: { select($0) },
                       onOpenWorker: { openWorker($0) },
                       onNewSession: { path.append(Route.newSession) },
                       onDeviceChip: { showDeviceSwitcher = true })
                .environmentObject(model)
                .environmentObject(sidebar)
        } content: {
            NavigationStack(path: $path) {
                rootContent
                    .navigationBarHidden(true)
                    .navigationDestination(for: Route.self) { route in
                        switch route {
                        case .conversation(let id):
                            WorkerDetailView(workerId: id)
                                .navigationBarHidden(true)
                                // AgentLink taps push the referenced worker onto the stack.
                                .environment(\.selectWorker) { openWorker($0) }
                        case .newSession:
                            NewSessionView(onDeviceTap: { showDeviceSwitcher = true },
                                           onSpawned: { replaceWithConversation($0) })
                                .navigationBarHidden(true)
                        }
                    }
            }
        }
        .environmentObject(model)
        .environmentObject(sidebar)
        // Sheets are hosted in a separate environment and do NOT inherit the .environmentObject
        // applied above — inject it explicitly, or @EnvironmentObject reads inside them trap.
        .sheet(isPresented: $showPairing) { PairingView().environmentObject(model) }
        .sheet(isPresented: $showAddDevice) { AddDeviceSheet().environmentObject(model) }
        .sheet(isPresented: $showDeviceSwitcher, onDismiss: {
            if pairAfterSwitcher { pairAfterSwitcher = false; showAddDevice = true }
        }) {
            DeviceSwitcherSheet(onPairNew: { pairAfterSwitcher = true },
                                onManage: { select(.devices) })
                .environmentObject(model)
        }
        .onOpenURL { url in route(url) }
        // Drag-to-open only on root screens — pushed screens keep the edge back-swipe.
        // Persist what relaunch should reopen on every stack change (round 7).
        .onChange(of: path) { _, p in
            sidebar.canDragOpen = p.isEmpty
            model.saveUIState { $0.openWorkerId = Self.restorableWorkerId(in: p) }
        }
        .onChange(of: sidebar.section) { _, s in
            model.saveUIState { $0.section = s.rawValue }
        }
        .task { await model.resumeIfPossible() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: Task { await model.enterForeground() }
            case .background: Task { await model.enterBackground() }
            default: break
            }
        }
        .onChange(of: model.needsPairing) { _, needs in if needs { showPairing = true } }
    }

    // Root surface selected by the drawer (§B1): Code list or Devices.
    @ViewBuilder private var rootContent: some View {
        switch sidebar.section {
        case .code:
            CodeListView(onOpenWorker: { openWorker($0) },
                         onNewSession: { path.append(Route.newSession) })
        case .devices:
            DevicesView(onSwitched: { select(.code) })
                .eosTopChrome { EmptyView() }
        }
    }

    // What relaunch should reopen given this stack: a conversation on top persists; the Code
    // list or a new-session screen persists nothing.
    private static func restorableWorkerId(in path: [Route]) -> String? {
        guard case .conversation(let id)? = path.last else { return nil }
        return id
    }

    // Section selection pops any pushed screens so the root actually shows.
    private func select(_ s: SidebarSection) {
        sidebar.section = s
        path = []
    }

    private func openWorker(_ id: String) {
        sidebar.section = .code
        path.append(Route.conversation(id))
    }

    // §C4.3: swap the New-session entry for the fresh conversation (no flash of the list).
    private func replaceWithConversation(_ id: String) {
        if !path.isEmpty { path.removeLast() }
        path.append(Route.conversation(id))
    }

    private func route(_ url: URL) {
        guard url.scheme == "eos" else { return }
        switch url.host {
        case "worker":
            if let id = url.pathComponents.dropFirst().first { openWorker(id) }
        case "pending":
            // Permission asks live as banners in conversations now (D-19) — land on the Code list;
            // its waiting indicators guide the user in.
            select(.code)
        default: break
        }
    }
}
