import SwiftUI
import EosRemoteKit

// Device switcher (contract §C10, master 8): a compact sheet listing every paired Mac with a live
// per-row connection dot (background connections stay alive), the relay host, and a coral check on
// the active device. Tapping switches the mirror instantly. Footer rows pair a new Mac or jump to
// the Devices manage screen. Presentation is owned by RootView; the pair-new flow must chain through
// RootView's sheet state (a sheet can't present its sibling while it is still dismissing), so both
// footer callbacks fire BEFORE dismiss and RootView acts on .sheet onDismiss.
struct DeviceSwitcherSheet: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss

    let onPairNew: () -> Void
    let onManage: () -> Void

    // §C10: .height(min(72*n + 160, 420)).
    private var detentHeight: CGFloat { min(72 * CGFloat(model.devices.count) + 160, 420) }

    var body: some View {
        VStack(spacing: 0) {
            EosSheetHeader("Devices") { dismiss() }
            ScrollView {
                VStack(spacing: 0) {
                    ForEach(model.devices) { device in
                        DeviceSwitchRow(device: device,
                                        state: model.connectionState(for: device.id),
                                        isActive: device.id == model.activeDeviceId) {
                            switchTo(device)
                        }
                    }
                    SelectRow(icon: "qrcode.viewfinder", title: "Pair new Mac…", selected: false) {
                        onPairNew()
                        dismiss()
                    }
                    SelectRow(icon: "gearshape", title: "Manage devices…", selected: false) {
                        onManage()
                        dismiss()
                    }
                }
                .padding(.horizontal, EosSpacing.screenInset)
            }
        }
        .eosSheet(detents: [.height(detentHeight)])
    }

    // The switch itself is instant (the target's Store is already live and just becomes the mirror
    // source); the awaited tail is only a cold reconnect / ui-config refetch — don't hold the sheet.
    private func switchTo(_ device: Device) {
        Haptics.tap()
        Task { await model.switchDevice(device.id) }
        dismiss()
    }
}

// One paired-Mac row: live dot + label + relay host caption + coral check when active (§C10).
private struct DeviceSwitchRow: View {
    let device: Device
    let state: DeviceConnState
    let isActive: Bool
    let action: () -> Void

    private var relayHost: String { URL(string: device.relayUrl)?.host ?? device.relayUrl }

    var body: some View {
        Button(action: action) {
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
                }
            }
            .padding(.horizontal, EosSpacing.md)
            .padding(.vertical, 14)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .bottom) {
            // Hairline inset to the text edge (dot width + gap), matching the SelectRow anatomy.
            Rectangle()
                .fill(EosColor.hairline)
                .frame(height: EosLine.hairline)
                .padding(.leading, EosSpacing.md + 8 + EosSpacing.sm)
        }
        .accessibilityLabel("\(device.label), \(state.label)\(isActive ? ", active" : "")")
        .accessibilityHint(isActive ? "Current device" : "Switch to this Mac")
        .accessibilityAddTraits(isActive ? .isSelected : [])
    }
}
