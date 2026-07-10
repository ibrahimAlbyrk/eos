import SwiftUI
import EosRemoteKit

// Code list — the sessions root (contract §C2, ref IMG_4434 anatomy + IMG_4428 floating pills;
// replaces HomeView). Filter chips All/Running/Archived over the agents tree (§D); Archived shows
// month sections from archived_at. Swipe: Archive (trailing, live roots) / Restore (leading,
// archived). List(.plain) hosts the tree so the swipe actions are native — rows are restyled to
// read as the reference's LazyVStack cards.
//
// P3 seam: hosted as the NavigationStack root under `.eosTopChrome(title: "Code", trailing:)`;
// pushes route through the two callbacks (RootView owns the NavigationPath).
struct CodeListView: View {
    @EnvironmentObject var model: AppModel
    let onOpenWorker: (String) -> Void
    let onNewSession: () -> Void

    init(onOpenWorker: @escaping (String) -> Void, onNewSession: @escaping () -> Void) {
        self.onOpenWorker = onOpenWorker
        self.onNewSession = onNewSession
        // Launch restoration (round 7): the chip starts on the active device's saved filter.
        let saved = UIStateStore().state(for: DeviceStore().activeId())
        _filter = State(initialValue: saved.filter.flatMap(Filter.init(rawValue:)) ?? .all)
    }

    private enum Filter: String, CaseIterable { case all = "All", running = "Running", archived = "Archived" }
    @State private var filter: Filter
    // Collapsed root ids — session-local. Persisting would grow RestorableUIState (EosRemoteKit,
    // outside the round-11 row-rework scope), so deliberately not stored.
    @State private var collapsed: Set<String> = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var archivedLoading = false

    private var roots: [AgentNode] { AgentTree.buildTree(model.workers) }
    // Running shows only running nodes plus their parent context — idle siblings pruned (§C2).
    private var runningRoots: [AgentNode] { AgentTree.pruneRunning(roots) }
    // Direct pending-ask counts by worker id; rows show the subtree sum (§D3).
    private var directPending: [String: Int] {
        var out: [String: Int] = [:]
        for p in model.pending { if let id = p.workerId { out[id, default: 0] += 1 } }
        return out
    }

    var body: some View {
        VStack(spacing: 0) {
            if !model.connected { OfflineChip(connecting: model.connecting,
                                              deviceLabel: model.activeDevice?.label) }
            filterRow
            list
        }
        .background(EosColor.bg)
        .eosTopChrome(title: "Code") {
            CircularIconButton(systemName: "plus", diameter: 40, filled: true,
                               accessibilityLabel: "New session") { onNewSession() }
        }
        // A restored Archived chip lands before the connection is up — fetch once it connects.
        .task { if filter == .archived { refreshArchived() } }
        .onChange(of: model.connected) { _, connected in
            if connected && filter == .archived { refreshArchived() }
        }
        .onChange(of: filter) { _, f in
            if f == .archived { refreshArchived() }
            model.saveUIState { $0.filter = f.rawValue }
        }
        // Device switch: the incoming device's own saved filter applies (round 7 per-device state).
        .onChange(of: model.activeDeviceId) {
            filter = model.savedUIState().filter.flatMap(Filter.init(rawValue:)) ?? .all
        }
    }

    private var filterRow: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: EosSpacing.xs) {
                FilterChip("All", count: roots.count, selected: filter == .all) { filter = .all }
                FilterChip("Running", count: runningRoots.count, selected: filter == .running) { filter = .running }
                FilterChip("Archived", count: model.archived.count, selected: filter == .archived) { filter = .archived }
            }
            .padding(.horizontal, EosSpacing.screenInset)
        }
        // No mask: a pressed chip's interactive-glass lens stretches past the row bounds; the
        // ScrollView's default clip cut it off mid-drag like a broken layer (round 8).
        .scrollClipDisabled()
        .padding(.vertical, EosSpacing.xs)
        // Above siblings: the unclipped lens still drew in VStack order, so a longer drag slid it
        // under the list / offline pill; keep the row's overflow on top (round 8b).
        .zIndex(1)
    }

    @ViewBuilder private var list: some View {
        List {
            switch filter {
            case .all: treeSection(roots)
            case .running: treeSection(runningRoots)
            case .archived: archivedSection
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
        .refreshable {
            if !model.connected { await model.enterForeground() }
            if filter == .archived { _ = await model.fetchArchived() }
        }
    }

    // MARK: live tree (All / Running)

    @ViewBuilder private func treeSection(_ nodes: [AgentNode]) -> some View {
        if nodes.isEmpty {
            emptyState
        } else {
            let direct = directPending
            ForEach(nodes) { node in
                rootRow(node, direct: direct)
                if !collapsed.contains(node.id) {
                    childRows(node, direct: direct)
                }
            }
        }
    }

    private func rootRow(_ node: AgentNode, direct: [String: Int]) -> some View {
        Button { onOpenWorker(node.id) } label: {
            OrchestratorRow(worker: node.worker,
                            workerCount: node.subtreeSize - 1,
                            attention: model.needsAttention(node.worker),
                            pendingCount: subtreePending(node, direct: direct),
                            isCollapsed: collapsed.contains(node.id),
                            onToggleCollapse: node.children.isEmpty ? nil : { toggleCollapse(node.id) })
        }
        .buttonStyle(.plain)
        .listRowBackground(EosColor.bg)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: EosSpacing.xxs, leading: EosSpacing.screenInset,
                                  bottom: EosSpacing.xxs, trailing: EosSpacing.screenInset))
        .swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if model.connected {
                Button { archive(node.id) } label: { Label("Archive", systemImage: "archivebox") }
                    .tint(EosColor.surface3)
            }
        }
    }

    // Descendants flattened depth-first, indented under the root card's name column — the
    // collapse control lives inline on the root row (round 11), so no gutter chevron here.
    @ViewBuilder private func childRows(_ node: AgentNode, direct: [String: Int]) -> some View {
        let entries = flattenChildren(node, direct: direct)
        ForEach(entries) { entry in
            Button { onOpenWorker(entry.worker.id) } label: {
                WorkerChildRow(worker: entry.worker,
                               attention: model.needsAttention(entry.worker),
                               pendingCount: entry.pendingCount)
                    .padding(.leading, 28 + CGFloat(entry.depth - 1) * 16)
            }
            .buttonStyle(.plain)
            .listRowBackground(EosColor.bg)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 0, leading: EosSpacing.screenInset,
                                      bottom: 0, trailing: EosSpacing.screenInset))
        }
    }

    private struct ChildEntry: Identifiable {
        let worker: Worker
        let depth: Int
        let pendingCount: Int
        var id: String { worker.id }
    }

    private func flattenChildren(_ node: AgentNode, direct: [String: Int]) -> [ChildEntry] {
        var out: [ChildEntry] = []
        func walk(_ children: [AgentNode], depth: Int) {
            for c in children {
                out.append(ChildEntry(worker: c.worker, depth: depth,
                                      pendingCount: subtreePending(c, direct: direct)))
                walk(c.children, depth: depth + 1)
            }
        }
        walk(node.children, depth: 1)
        return out
    }

    private func subtreePending(_ node: AgentNode, direct: [String: Int]) -> Int {
        node.children.reduce(direct[node.worker.id] ?? 0) { $0 + subtreePending($1, direct: direct) }
    }

    private func toggleCollapse(_ id: String) {
        withAnimation(reduceMotion ? nil : EosSpring.chip) {
            if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) }
        }
    }

    private func archive(_ id: String) {
        Haptics.warning()
        Task { _ = await model.archive(id) }   // the live list drops the root via the Store patch
    }

    // MARK: archived (month sections from archived_at desc — §C2, D-3)

    @ViewBuilder private var archivedSection: some View {
        if archivedLoading && model.archived.isEmpty {
            skeletonRows
        } else if model.archived.isEmpty {
            Text("Nothing archived")
                .font(EosFont.caption)
                .foregroundStyle(EosColor.inkTertiary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, EosSpacing.xxl)
                .listRowBackground(EosColor.bg)
                .listRowSeparator(.hidden)
        } else {
            ForEach(monthGroups) { group in
                Section {
                    ForEach(group.workers) { w in archivedRow(w) }
                } header: {
                    Text(group.title)
                        .font(EosFont.heading)
                        .foregroundStyle(EosColor.inkTertiary)
                        .textCase(nil)
                }
            }
        }
    }

    private func archivedRow(_ w: Worker) -> some View {
        Button { onOpenWorker(w.id) } label: {
            OrchestratorRow(worker: w, archived: true)
        }
        .buttonStyle(.plain)
        .listRowBackground(EosColor.bg)
        .listRowSeparator(.hidden)
        .listRowInsets(EdgeInsets(top: EosSpacing.xxs, leading: EosSpacing.screenInset,
                                  bottom: EosSpacing.xxs, trailing: EosSpacing.screenInset))
        .swipeActions(edge: .leading, allowsFullSwipe: false) {
            if model.connected {
                Button { restore(w.id) } label: { Label("Restore", systemImage: "arrow.uturn.backward") }
                    .tint(EosColor.coral)
            }
        }
    }

    private struct MonthGroup: Identifiable {
        let title: String
        let workers: [Worker]
        var id: String { title }
    }

    private var monthGroups: [MonthGroup] {
        let sorted = model.archived.sorted { ($0.archivedAt ?? 0) > ($1.archivedAt ?? 0) }
        let fmt = DateFormatter()
        let calendar = Calendar.current
        let thisYear = calendar.component(.year, from: Date())
        var out: [MonthGroup] = []
        for w in sorted {
            let date = Date(timeIntervalSince1970: (w.archivedAt ?? 0) / 1000)
            fmt.dateFormat = calendar.component(.year, from: date) == thisYear ? "MMMM" : "MMMM yyyy"
            let title = fmt.string(from: date)
            if let i = out.firstIndex(where: { $0.title == title }) {
                out[i] = MonthGroup(title: title, workers: out[i].workers + [w])
            } else {
                out.append(MonthGroup(title: title, workers: [w]))
            }
        }
        return out
    }

    private func restore(_ id: String) {
        Haptics.success()
        Task {
            if await model.restore(id) { _ = await model.fetchArchived() }
        }
    }

    private func refreshArchived() {
        archivedLoading = true
        Task {
            _ = await model.fetchArchived()
            archivedLoading = false
        }
    }

    // MARK: empty / loading states (§C2)

    // Empty tree: until the active device's FIRST workers fetch resolves the truth is
    // unknown — skeleton, never "No sessions yet" (round 5, item B). Covers first
    // launch, reconnect, and switching to a device that hasn't bootstrapped yet.
    @ViewBuilder private var emptyState: some View {
        if !model.workersLoaded {
            skeletonRows
        } else if filter == .running {
            Text("No running sessions")
                .font(EosFont.caption)
                .foregroundStyle(EosColor.inkTertiary)
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.top, EosSpacing.xxl)
                .listRowBackground(EosColor.bg)
                .listRowSeparator(.hidden)
        } else {
            VStack(spacing: EosSpacing.lg) {
                DawnStar(size: 40)
                Text("No sessions yet")
                    .font(EosFont.label)
                    .foregroundStyle(EosColor.inkSecondary)
                PillButton("New session", style: .ghost) { onNewSession() }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, EosSpacing.xxl)
            .listRowBackground(EosColor.bg)
            .listRowSeparator(.hidden)
        }
    }

    private var skeletonRows: some View {
        ForEach(0..<3, id: \.self) { _ in
            RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous)
                .fill(EosColor.surface)
                .frame(height: 50)
                .listRowBackground(EosColor.bg)
                .listRowSeparator(.hidden)
                .listRowInsets(EdgeInsets(top: EosSpacing.xxs, leading: EosSpacing.screenInset,
                                          bottom: EosSpacing.xxs, trailing: EosSpacing.screenInset))
                .accessibilityHidden(true)
        }
    }
}

// Thin connection chip under the top bar (§C common state rules) — content stays cached beneath.
struct OfflineChip: View {
    let connecting: Bool
    let deviceLabel: String?

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(connecting ? EosColor.State.waitingDot : EosColor.State.failedDot)
                .frame(width: 6, height: 6)
            Text(connecting ? "Reconnecting to \(deviceLabel ?? "device")…"
                            : "Not connected — pull to retry")
                .font(EosFont.captionSmall)
                .foregroundStyle(EosColor.inkSecondary)
        }
        .padding(.horizontal, EosSpacing.sm)
        .padding(.vertical, EosSpacing.xxs)
        .background(EosColor.surface2, in: Capsule())
        .overlay(Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
        .padding(.bottom, EosSpacing.xxs)
    }
}
