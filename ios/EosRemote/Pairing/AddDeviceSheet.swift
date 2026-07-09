import SwiftUI
import EosRemoteKit

// "Add device" scan flow (spec 02 §3.2) — the multi-device sibling of PairingView. Reuses the same
// QRScannerView and decode, but routes the decoded QR through AppModel.addDevice (which mints the
// Device, connects it, and makes it active) instead of the first-pair path. Dismisses once the new
// Mac connects; surfaces scan errors and already-paired duplicates without leaving the sheet.
struct AddDeviceSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    @State private var status = "Scan the QR in an Eos Mac app's Settings → Remote."
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
                    .font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
                    .multilineTextAlignment(.center).padding()
            }
            .background(EosColor.bg)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .principal) {
                    Text("Add device").font(EosFont.titleSerif).foregroundStyle(EosColor.ink)
                }
                ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } }
            }
        }
    }

    private func handleScan(_ value: String) {
        scanning = false
        status = "Validating pairing code…"
        do {
            let qr = try QRPayload.decode(Data(value.utf8), now: Date().timeIntervalSince1970)
            // Already paired? The room capability is the device identity — match on it so re-scanning a
            // Mac already in the list is a friendly no-op rather than a duplicate row.
            if model.devices.contains(where: { $0.room == qr.room }) {
                status = "This Mac is already paired."
                scanning = true
                return
            }
            status = "Pairing over relay…"
            Task {
                await model.addDevice(qr: qr)
                if model.connected {
                    dismiss()
                } else {
                    status = model.lastError ?? "Pairing did not complete."
                    scanning = true
                }
            }
        } catch {
            status = "Invalid or expired QR: \(error)"
            scanning = true
        }
    }
}
