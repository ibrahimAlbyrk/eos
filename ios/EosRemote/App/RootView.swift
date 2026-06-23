import SwiftUI
import EosRemoteKit

// Navigation stack (design §5.3) — not a 3-pane desktop layout. Deep links eos://worker/<id>
// and eos://pending/<id> route into the stack.
struct RootView: View {
    @StateObject private var model = AppModel()
    @Environment(\.scenePhase) private var scenePhase
    @State private var path = NavigationPath()
    @State private var showPairing = false
    @State private var showSpawn = false

    var body: some View {
        NavigationStack(path: $path) {
            FleetView(showSpawn: $showSpawn)
                .navigationTitle("Eos")
                .navigationDestination(for: String.self) { id in
                    if id == "__pending__" { PendingListView() }
                    else { WorkerDetailView(workerId: id) }
                }
                .toolbar {
                    ToolbarItem(placement: .topBarLeading) {
                        Menu {
                            Button { showPairing = true } label: { Label("Pair / reconnect", systemImage: "qrcode.viewfinder") }
                            if model.connected || model.connecting {
                                Button(role: .destructive) { Task { await model.disconnect() } } label: {
                                    Label("Disconnect", systemImage: "bolt.slash")
                                }
                            }
                        } label: { Image(systemName: "qrcode.viewfinder") }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showSpawn = true } label: { Image(systemName: "plus") }
                    }
                }
        }
        .environmentObject(model)
        // Sheets are hosted in a separate environment and do NOT inherit the .environmentObject
        // applied above — inject it explicitly, or @EnvironmentObject reads inside them trap
        // ("No ObservableObject of type AppModel found"). Device-only: the Simulator never opened these.
        .sheet(isPresented: $showPairing) { PairingView().environmentObject(model) }
        .sheet(isPresented: $showSpawn) { SpawnSheet().environmentObject(model) }
        .onOpenURL { url in route(url) }
        .overlay(alignment: .bottom) { connectionBanner }
        // Auto-resume on launch; reconnect/drop with the foreground/background transitions.
        .task { await model.resumeIfPossible() }
        .onChange(of: scenePhase) { _, phase in
            switch phase {
            case .active: Task { await model.enterForeground() }
            case .background: Task { await model.enterBackground() }
            default: break
            }
        }
        // No usable credentials (never paired / ticket expired-or-rejected) → present Pair, don't sit dead.
        .onChange(of: model.needsPairing) { _, needs in if needs { showPairing = true } }
    }

    @ViewBuilder private var connectionBanner: some View {
        if model.connected {
            EmptyView()
        } else if model.needsPairing {
            banner("Not connected — tap to pair") { showPairing = true }
        } else if model.connecting {
            banner("Connecting…", action: nil)
        } else {
            // Cold-connect / resume failed transiently (network or a cancelled Face ID) — retry
            // without a QR. enterForeground() resets backoff and re-runs resume → cold connect.
            banner(model.lastError ?? "Disconnected — tap to reconnect") { Task { await model.enterForeground() } }
        }
    }

    @ViewBuilder private func banner(_ text: String, action: (() -> Void)?) -> some View {
        let label = Text(text).font(.caption).padding(8)
            .frame(maxWidth: .infinity).background(.thinMaterial)
        if let action { Button(action: action) { label } } else { label }
    }

    private func route(_ url: URL) {
        guard url.scheme == "eos" else { return }
        switch url.host {
        case "worker": if let id = url.pathComponents.dropFirst().first { path.append(id) }
        case "pending": path.append("__pending__")
        default: break
        }
    }
}
