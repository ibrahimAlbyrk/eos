import SwiftUI
import EosRemoteKit

// Navigation stack (design §5.3) — not a 3-pane desktop layout. Deep links eos://worker/<id>
// and eos://pending/<id> route into the stack.
struct RootView: View {
    @StateObject private var model = AppModel()
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
                        Button { showPairing = true } label: { Image(systemName: "qrcode.viewfinder") }
                    }
                    ToolbarItem(placement: .topBarTrailing) {
                        Button { showSpawn = true } label: { Image(systemName: "plus") }
                    }
                }
        }
        .environmentObject(model)
        .sheet(isPresented: $showPairing) { PairingView() }
        .sheet(isPresented: $showSpawn) { SpawnSheet() }
        .onOpenURL { url in route(url) }
        .overlay(alignment: .bottom) { connectionBanner }
    }

    @ViewBuilder private var connectionBanner: some View {
        if !model.connected {
            Text("Disconnected — reconnecting…")
                .font(.caption).padding(8)
                .frame(maxWidth: .infinity)
                .background(.thinMaterial)
        }
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
