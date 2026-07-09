import SwiftUI
import EosRemoteKit

// Root shell (spec 05 §3.1): the existing NavigationStack wrapped in a SidebarContainer drawer, with
// glass circular top chrome replacing the system toolbar. Deep-link routing (eos://worker/… ,
// eos://pending), scene-phase resume, and the sheet presentations are preserved. The old "Not
// connected" connection banner is removed (bug 4) — connection surfaces via the drawer device-chip dot.
struct RootView: View {
    @StateObject private var model = AppModel()
    @StateObject private var sidebar = SidebarState()
    @Environment(\.scenePhase) private var scenePhase
    @State private var path = NavigationPath()
    @State private var showPairing = false
    @State private var showSpawn = false

    var body: some View {
        SidebarContainer {
            SidebarView(onOpenWorker: { openWorker($0) }, onSpawn: { showSpawn = true })
                .environmentObject(model)
                .environmentObject(sidebar)
        } content: {
            NavigationStack(path: $path) {
                rootContent
                    .navigationBarHidden(true)
                    .navigationDestination(for: String.self) { id in
                        if id == "__pending__" {
                            PendingListView().eosTopChrome { EmptyView() }.navigationBarHidden(true)
                        } else {
                            WorkerDetailView(workerId: id).navigationBarHidden(true)
                                // AgentLink taps (spec 03 §9) push the referenced worker onto the stack.
                                .environment(\.selectWorker) { openWorker($0) }
                        }
                    }
            }
        }
        .environmentObject(model)
        .environmentObject(sidebar)
        // Sheets are hosted in a separate environment and do NOT inherit the .environmentObject
        // applied above — inject it explicitly, or @EnvironmentObject reads inside them trap.
        .sheet(isPresented: $showPairing) { PairingView().environmentObject(model) }
        .sheet(isPresented: $showSpawn) { SpawnSheet().environmentObject(model) }
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

    // Root surface selected by the drawer (spec 02 §3.2). Home is the Fleet section (greeting +
    // composer + fleet list); the top chrome trailing is context-specific per screen.
    @ViewBuilder private var rootContent: some View {
        switch sidebar.section {
        case .fleet:
            HomeView(onOpenWorker: { openWorker($0) }, onSpawnSheet: { showSpawn = true })
                .eosTopChrome { pendingTrailing }
        case .pending:
            PendingListView().eosTopChrome { EmptyView() }
        case .devices:
            DevicesView(onSwitched: { sidebar.section = .fleet }).eosTopChrome { EmptyView() }
        case .settings:
            SettingsView().eosTopChrome { EmptyView() }
        }
    }

    // Top-right on Home (spec 02 §3.4): Pending decisions with a coral badge dot when pending > 0.
    private var pendingTrailing: some View {
        ZStack(alignment: .topTrailing) {
            CircularIconButton(systemName: "exclamationmark.bubble", diameter: 40, glass: true,
                               accessibilityLabel: "Pending decisions") { sidebar.section = .pending }
            if model.pending.count > 0 {
                Circle().fill(EosColor.coral).frame(width: 9, height: 9)
                    .overlay(Circle().strokeBorder(EosColor.bg, lineWidth: 1.5))
                    .offset(x: 1, y: -1)
                    .accessibilityHidden(true)
            }
        }
    }

    private func openWorker(_ id: String) {
        sidebar.section = .fleet
        path.append(id)
    }

    private func route(_ url: URL) {
        guard url.scheme == "eos" else { return }
        switch url.host {
        case "worker": if let id = url.pathComponents.dropFirst().first { sidebar.section = .fleet; path.append(id) }
        case "pending": path.append("__pending__")
        default: break
        }
    }
}
