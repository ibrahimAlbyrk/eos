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
    @StateObject private var sidebar = SidebarState()
    @Environment(\.scenePhase) private var scenePhase
    @State private var path = NavigationPath()
    @State private var showPairing = false
    @State private var showAddDevice = false
    @State private var showDeviceSwitcher = false
    // "Pair new Mac…" chains through onDismiss — presenting a sibling sheet while the switcher is
    // still animating out gets dropped by SwiftUI.
    @State private var pairAfterSwitcher = false

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

    // Section selection pops any pushed screens so the root actually shows.
    private func select(_ s: SidebarSection) {
        sidebar.section = s
        path = NavigationPath()
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
