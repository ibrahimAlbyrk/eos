import SwiftUI
import EosRemoteKit

// Drawer contents (contract §C1, ref IMG_4423 — no avatar, no spawn pill): serif wordmark, the
// active-device chip (opens the device switcher), Code / Devices nav rows, a Recents list of the
// active device's workers, and a floating "New agent" pill bottom-right. Full-height edge-to-edge
// (§E3): the opaque bg ignores the safe area while the content stays inside it (reading
// geo.safeAreaInsets under .ignoresSafeArea() returns zeros and lands content in the status-bar/
// home strips). Navigation + sheet presentation live in RootView (callbacks).
struct DrawerView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var sidebar: SidebarState
    @AccessibilityFocusState private var wordmarkFocused: Bool

    // The conversation currently on top of the nav stack, nil on root screens — its Recents row
    // gets the selected wash so the drawer stays oriented when opened from inside a chat.
    let selectedWorkerId: String?
    let onSelectSection: (SidebarSection) -> Void
    let onOpenWorker: (String) -> Void
    let onNewSession: () -> Void
    let onDeviceChip: () -> Void

    // Last 12 workers of the active device, most recently active first (§C1.4, recency per D-5);
    // id desc breaks ties for a stable order. Orchestrators and workers both appear, flat.
    private var recentWorkers: [Worker] {
        Array(model.workers
            .sorted { ($0.recencyKey, $0.id) > ($1.recencyKey, $1.id) }
            .prefix(12))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("eos")
                .font(EosFont.titleSerif)
                .tracking(-0.5)
                .foregroundStyle(EosColor.ink)
                .padding(.top, EosSpacing.lg)
                .padding(.horizontal, EosSpacing.md)
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($wordmarkFocused)

            // Hidden when no devices — the pairing sheet auto-presents instead (§C1.2).
            if let device = model.activeDevice {
                CurrentDeviceChip(label: device.label,
                                  state: model.connectionState(for: device.id),
                                  action: onDeviceChip)
                    .padding(.top, EosSpacing.xs)
                    .padding(.horizontal, EosSpacing.md)
            }

            VStack(spacing: 0) {
                SidebarRow("chevron.left.forwardslash.chevron.right", "Code",
                           isSelected: sidebar.section == .code) { select(.code) }
                SidebarRow("laptopcomputer", "Devices",
                           isSelected: sidebar.section == .devices) { select(.devices) }
            }
            .padding(.top, EosSpacing.md)
            .padding(.horizontal, EosSpacing.xs)

            if recentWorkers.isEmpty {
                Spacer(minLength: 0)
            } else {
                SectionCaption("Recents")
                    .padding(.horizontal, EosSpacing.xs)
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(recentWorkers) { w in
                            SidebarRecentRow(name: w.name, state: w.state,
                                             isSelected: w.id == selectedWorkerId) {
                                onOpenWorker(w.id)
                                sidebar.isOpen = false
                            }
                        }
                    }
                    .padding(.horizontal, EosSpacing.xs)
                    .padding(.bottom, 72)   // clear the floating pill
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .overlay(alignment: .bottomTrailing) {
            newSessionPill
                .padding(.trailing, EosSpacing.md)
                .padding(.bottom, EosSpacing.md)
        }
        // bgSunken, not bg: the drawer is the RECESSED surface under the elevated content card
        // (ref IMG_4423 — the card reads lighter than the drawer behind it).
        .background(EosColor.bgSunken.ignoresSafeArea())
        .onChange(of: sidebar.isOpen) { _, open in if open { wordmarkFocused = true } }
    }

    // Light-on-dark pill (ref IMG_4423 "New chat"): ink fill, black label/icon (§C1.5).
    private var newSessionPill: some View {
        Button {
            sidebar.isOpen = false
            onNewSession()
        } label: {
            HStack(spacing: EosSpacing.xs) {
                Image(systemName: "plus")
                    .font(.system(size: 15, weight: .semibold))
                Text("New agent")
                    .font(EosFont.labelStrong)
            }
            .padding(.horizontal, EosSpacing.lg)
            .padding(.vertical, EosSpacing.sm)
            .foregroundStyle(EosColor.black)
            .background(EosColor.ink, in: Capsule())
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("New agent")
    }

    private func select(_ s: SidebarSection) {
        onSelectSection(s)
        sidebar.isOpen = false
    }
}

// Compact active-device chip under the wordmark — label + live StateDot + chevron, so the user
// always sees which Mac they control. Tap opens the device switcher sheet (§C1.2, was: jump to
// Devices). Label reads from `model.devices` upstream (§C11 — never DeviceConnection.device.label).
struct CurrentDeviceChip: View {
    let label: String
    let state: DeviceConnState
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: EosSpacing.xs) {
                StateDot(state: state.dotState)
                Text(label)
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.inkSecondary)
                    .lineLimit(1)
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(EosColor.inkTertiary)
                Spacer(minLength: 0)
            }
            .padding(.vertical, EosSpacing.xxs)
            .padding(.horizontal, EosSpacing.xs)
            .background(EosColor.surface, in: Capsule())
            .overlay(Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .fixedSize(horizontal: true, vertical: false)
        .accessibilityLabel("Current device: \(label), \(state.label)")
        .accessibilityHint("Switch devices")
    }
}

// A plain sans row for a recent worker — a state dot + name (§C1.4). Selected (= the open
// conversation) gets the same wash the SidebarRow section rows use — no new chrome.
struct SidebarRecentRow: View {
    let name: String
    let state: String
    var isSelected = false
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: EosSpacing.sm) {
                StateDot(state: state)
                Text(name)
                    .font(EosFont.label)
                    .foregroundStyle(EosColor.ink)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.vertical, EosSpacing.xs)
            .padding(.horizontal, EosSpacing.xs)
            .background(isSelected ? EosColor.coralWash : .clear,
                        in: RoundedRectangle(cornerRadius: EosRadius.chip))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name), \(EosRunState.from(state).label)")
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }
}
