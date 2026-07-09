import SwiftUI
import EosRemoteKit

// Devices (spec 02 §3.2) — the paired-Macs surface. A paper screen with a serif "Devices" title, a
// list of paired Macs (each: a live connection StateDot, the label, the relay host, and an active
// indicator), and an "Add device" primary that scans a Mac's Settings → Remote QR. Tapping a row
// switches the active Mac (5a keeps every connection live, so it is instant) and routes back to Fleet.
// All device storage lives in AppModel's 5a API — this view only reads `devices`/`activeDeviceId`
// and calls switchDevice/addDevice/removeDevice.
struct DevicesView: View {
    @EnvironmentObject var model: AppModel

    // Presenting the QR-scan flow, and routing back to Fleet after a switch (owned by RootView).
    let onSwitched: () -> Void

    @State private var showAdd = false
    @State private var removeTarget: Device?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EosSpacing.lg) {
                SectionHeader("Devices")

                if model.devices.isEmpty {
                    emptyState
                } else {
                    VStack(spacing: EosSpacing.sm) {
                        ForEach(model.devices) { device in
                            DeviceRow(device: device,
                                      state: model.connectionState(for: device.id),
                                      isActive: device.id == model.activeDeviceId,
                                      onTap: { switchTo(device) },
                                      onRemove: { removeTarget = device })
                        }
                    }
                    addButton
                }

                Spacer(minLength: 0)
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.top, EosSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(EosColor.bg)
        .sheet(isPresented: $showAdd) { AddDeviceSheet().environmentObject(model) }
        .confirmationDialog("Remove this device?",
                            isPresented: .constant(removeTarget != nil),
                            titleVisibility: .visible, presenting: removeTarget) { device in
            Button("Remove \(device.label)", role: .destructive) {
                let id = device.id
                removeTarget = nil
                Task { await model.removeDevice(id) }
            }
            Button("Cancel", role: .cancel) { removeTarget = nil }
        } message: { device in
            Text("Forgets \(device.label) and its pairing credentials. Pair again with its QR to reconnect.")
        }
    }

    private var addButton: some View {
        PillButton("Add device", systemImage: "plus", style: .primary) { showAdd = true }
            .padding(.top, EosSpacing.xs)
    }

    private var emptyState: some View {
        VStack(alignment: .leading, spacing: EosSpacing.md) {
            Text("No devices")
                .font(EosFont.heading)
                .foregroundStyle(EosColor.ink)
            Text("Scan the QR in an Eos Mac app's Settings → Remote to pair your first Mac.")
                .font(EosFont.body)
                .foregroundStyle(EosColor.inkSecondary)
            addButton
        }
        .padding(EosSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous)
            .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
    }

    private func switchTo(_ device: Device) {
        guard device.id != model.activeDeviceId else { onSwitched(); return }
        Task {
            await model.switchDevice(device.id)
            onSwitched()
        }
    }
}

// One paired-Mac row: live connection dot, label, relay host, and a coral check when active. The
// whole row is a switch button; a trailing remove button (and swipe-to-remove) forgets the device.
private struct DeviceRow: View {
    let device: Device
    let state: DeviceConnState
    let isActive: Bool
    let onTap: () -> Void
    let onRemove: () -> Void

    // The full relay host for the secondary line ("wss://mac.example.com/" → "mac.example.com").
    private var relayHost: String { URL(string: device.relayUrl)?.host ?? device.relayUrl }

    var body: some View {
        HStack(spacing: EosSpacing.sm) {
            Button(action: onTap) {
                HStack(spacing: EosSpacing.sm) {
                    StateDot(state: state.dotState)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(device.label)
                            .font(EosFont.label)
                            .foregroundStyle(EosColor.ink)
                            .lineLimit(1)
                        Text(relayHost)
                            .font(EosFont.caption)
                            .foregroundStyle(EosColor.inkSecondary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: EosSpacing.xs)
                    if isActive {
                        Image(systemName: "checkmark")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundStyle(EosColor.coral)
                            .accessibilityHidden(true)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(device.label), \(state.label)\(isActive ? ", active" : "")")
            .accessibilityHint(isActive ? "Shows this Mac" : "Switch to this Mac")

            // Trailing remove button — the discoverable path to forget a device (confirmed by the caller).
            Button(action: onRemove) {
                Image(systemName: "trash")
                    .font(.system(size: 15, weight: .regular))
                    .foregroundStyle(EosColor.inkSecondary)
                    .frame(width: 32, height: 32)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Remove \(device.label)")
        }
        .padding(EosSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(isActive ? EosColor.coralWash : EosColor.surface,
                    in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous)
            .strokeBorder(isActive ? EosColor.coral.opacity(0.35) : EosColor.hairline,
                          lineWidth: EosLine.hairline))
        .contextMenu {
            Button(role: .destructive, action: onRemove) { Label("Remove device", systemImage: "trash") }
        }
    }
}
