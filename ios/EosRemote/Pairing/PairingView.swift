import SwiftUI
import EosRemoteKit

// Pairing flow shell (§6.1): scan the v3 QR → decode → store (relay, room, bearer) → run the
// collapsed open → join → live connector (no Face ID, no handshake). This view is the
// entry/scan/status surface.
struct PairingView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var status = "Scan the QR shown in the Eos Mac app."
    @State private var scanning = true

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                if scanning {
                    QRScannerView { value in handleScan(value) }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ProgressView().padding()
                }
                Text(status)
                    .font(.callout).foregroundStyle(.secondary)
                    .multilineTextAlignment(.center).padding()
            }
            .navigationTitle("Pair device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
            // Show why reconnect fell back to pairing (exact step + wire code), since on-device log
            // capture needs root. Reportable straight off the screen.
            .onAppear {
                if !model.connected, let e = model.lastError {
                    status = "\(e)\n\nScan the QR shown in the Eos Mac app to pair again."
                }
            }
        }
    }

    private func handleScan(_ value: String) {
        scanning = false
        status = "Validating pairing code…"
        do {
            let qr = try QRPayload.decode(Data(value.utf8), now: Date().timeIntervalSince1970)
            status = "Pairing over relay…"
            Task {
                await model.startPairing(qr: qr)
                if model.connected { dismiss() }
                else { status = model.lastError ?? "Pairing did not complete."; scanning = true }
            }
        } catch {
            status = "Invalid or expired QR: \(error)"
            scanning = true
        }
    }
}
