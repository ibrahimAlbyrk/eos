import SwiftUI
import EosRemoteKit

// Pairing flow shell (design §4.3): scan the QR → decode (§6) → generate the SE device key → run
// the PAIR handshake (Face ID) → store {bearer, devId} + first ticket. The transport choreography
// is driven by HandshakeDriver; this view is the entry/scan/status surface.
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
        }
    }

    private func handleScan(_ value: String) {
        scanning = false
        status = "Validating pairing code…"
        do {
            let qr = try QRPayload.decode(Data(value.utf8), now: Date().timeIntervalSince1970)
            status = "Paired transport found (\(qr.relay != nil ? "relay" : "LAN")). "
                + "Generating Secure-Enclave key and starting handshake…"
            // The full PAIR handshake runs here against HandshakeDriver + the relay/daemon.
            // Wired to the live transport in the relay-first milestone (design §8 Faz 1).
        } catch {
            status = "Invalid or expired QR: \(error)"
            scanning = true
        }
    }
}
