import SwiftUI
import EosRemoteKit

// Thin Devices stub (spec 02 §3.2) — paper screen showing connection status + Pair/Disconnect from
// AppModel. Real fill-in (paired-Macs list, per-device detail) is a later phase.
struct DevicesView: View {
    @EnvironmentObject var model: AppModel
    let onPair: () -> Void

    private var statusLabel: String {
        if model.connected { return "Connected" }
        if model.connecting { return "Connecting…" }
        if model.needsPairing { return "Not paired" }
        return "Disconnected"
    }
    private var statusState: String {
        if model.connected { return "RUNNING" }
        if model.connecting { return "WAITING" }
        return "FAILED"
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EosSpacing.lg) {
                SectionHeader("Devices")

                HStack(spacing: EosSpacing.sm) {
                    StateDot(state: statusState)
                    Text(statusLabel).font(EosFont.body).foregroundStyle(EosColor.ink)
                    Spacer()
                }
                .padding(EosSpacing.md)
                .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous)
                    .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))

                HStack(spacing: EosSpacing.sm) {
                    PillButton("Pair device", systemImage: "qrcode.viewfinder", style: .primary, action: onPair)
                    if model.connected || model.connecting {
                        PillButton("Disconnect", style: .ghost) { Task { await model.disconnect() } }
                    }
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.top, EosSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(EosColor.bg)
    }
}
