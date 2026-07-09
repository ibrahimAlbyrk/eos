import SwiftUI
import EosRemoteKit

// Drawer contents (spec 02 §3.2): serif "Eos" wordmark, nav rows (Fleet / Pending / Devices /
// Settings), a "Recents" list of recent workers, and a footer avatar + "Spawn worker" pill.
struct SidebarView: View {
    @EnvironmentObject var model: AppModel
    @EnvironmentObject var sidebar: SidebarState
    @AccessibilityFocusState private var wordmarkFocused: Bool

    // Callbacks owned by RootView (navigation + sheet presentation live there).
    let onOpenWorker: (String) -> Void
    let onSpawn: () -> Void

    // Most-recent-first, capped. Higher id ≈ more recently created.
    private var recentWorkers: [Worker] {
        Array(model.workers.sorted { $0.id > $1.id }.prefix(12))
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("Eos")
                .font(EosFont.titleSerif)
                .foregroundStyle(EosColor.ink)
                .padding(.horizontal, EosSpacing.md)
                .padding(.top, EosSpacing.xl)
                .padding(.bottom, EosSpacing.xs)
                .accessibilityAddTraits(.isHeader)
                .accessibilityFocused($wordmarkFocused)

            if let device = model.activeDevice {
                CurrentDeviceChip(label: device.label,
                                  state: model.connectionState(for: device.id)) { select(.devices) }
                    .padding(.horizontal, EosSpacing.md)
                    .padding(.bottom, EosSpacing.lg)
            } else {
                Color.clear.frame(height: EosSpacing.lg)
            }

            Group {
                SidebarRow("square.stack.3d.up", "Fleet", isSelected: sidebar.section == .fleet) { select(.fleet) }
                SidebarRow("exclamationmark.bubble", "Pending", isSelected: sidebar.section == .pending,
                           badge: model.pending.count) { select(.pending) }
                SidebarRow("laptopcomputer", "Devices", isSelected: sidebar.section == .devices) { select(.devices) }
                SidebarRow("gearshape", "Settings", isSelected: sidebar.section == .settings) { select(.settings) }
            }
            .padding(.horizontal, EosSpacing.xs)

            SectionCaption("Recents")
                .padding(.horizontal, EosSpacing.xs)

            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    ForEach(recentWorkers) { w in
                        SidebarRecentRow(name: w.name, state: w.state) {
                            onOpenWorker(w.id)
                            sidebar.isOpen = false
                        }
                    }
                }
                .padding(.horizontal, EosSpacing.xs)
            }

            Spacer(minLength: 0)

            HStack {
                Avatar(initials: AccountLabel.initials)
                Spacer()
                PillButton("Spawn worker", systemImage: "plus", style: .primary) {
                    onSpawn()
                    sidebar.isOpen = false
                }
            }
            .padding(EosSpacing.md)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .background(EosColor.bg)          // same paper; the shadow from MAIN separates them
        .onChange(of: sidebar.isOpen) { _, open in if open { wordmarkFocused = true } }
    }

    private func select(_ s: SidebarSection) {
        sidebar.section = s
        sidebar.isOpen = false
    }
}

// Compact active-device chip under the wordmark (spec 02 §3.2 Devices) — the label + a live StateDot
// + a chevron, so the user always sees which Mac they control and can jump to Devices to switch.
// Subtle and caption-scale to sit quietly beneath the "Eos" mark.
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

// A plain sans row for a recent worker — a state dot + name (spec 02 §3.2).
struct SidebarRecentRow: View {
    let name: String
    let state: String
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
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(name), \(EosRunState.from(state).label)")
    }
}
