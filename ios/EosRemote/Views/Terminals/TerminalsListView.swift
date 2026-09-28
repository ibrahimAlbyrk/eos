import SwiftUI
import EosRemoteKit

// Terminals root (drawer section): the daemon's PTY sessions — the desktop Code view's panes —
// grouped by folder like the desktop sidebar. Tap opens TerminalSessionView; swipe closes the
// pane (DELETE /pty/:id); "+" starts a new one (NewTerminalSheet). Kept live by pty:session /
// pty:exit; refetched on every connect and on pull-to-refresh.
struct TerminalsListView: View {
    @EnvironmentObject var model: AppModel
    let onOpen: (String) -> Void

    @State private var showNew = false
    // Opening a fresh session chains through the sheet's onDismiss (push after it has animated out).
    @State private var openAfterSheet: String?

    private struct FolderGroup: Identifiable {
        let path: String
        var sessions: [PtySession]
        var id: String { path }
    }

    // Folders in order of their first session (sessions are sorted by number).
    private var groups: [FolderGroup] {
        var out: [FolderGroup] = []
        for s in model.ptySessions {
            if let i = out.firstIndex(where: { $0.path == s.cwd }) { out[i].sessions.append(s) }
            else { out.append(FolderGroup(path: s.cwd, sessions: [s])) }
        }
        return out
    }

    var body: some View {
        VStack(spacing: 0) {
            if !model.connected { OfflineChip(connecting: model.connecting,
                                              deviceLabel: model.activeDevice?.label) }
            List { content }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
                .refreshable {
                    if model.connected { await model.fetchPtySessions() } else { await model.reconnect() }
                }
        }
        .background(EosColor.bg)
        .eosTopChrome(title: "Terminals") {
            CircularIconButton(systemName: "plus", diameter: 40, filled: true,
                               accessibilityLabel: "New terminal") { showNew = true }
        }
        .sheet(isPresented: $showNew, onDismiss: {
            if let id = openAfterSheet { openAfterSheet = nil; onOpen(id) }
        }) {
            NewTerminalSheet { openAfterSheet = $0 }.environmentObject(model)
        }
    }

    @ViewBuilder private var content: some View {
        if !model.ptySessionsLoaded {
            skeletonRows
        } else if groups.isEmpty {
            VStack(spacing: EosSpacing.lg) {
                DawnStar(size: 40)
                Text("No terminals open")
                    .font(EosFont.label)
                    .foregroundStyle(EosColor.inkSecondary)
                PillButton("New terminal", style: .ghost) { showNew = true }
            }
            .frame(maxWidth: .infinity)
            .padding(.top, EosSpacing.xxl)
            .listRowBackground(EosColor.bg)
            .listRowSeparator(.hidden)
        } else {
            ForEach(groups) { group in
                Section {
                    ForEach(group.sessions) { row($0) }
                } header: {
                    Text(group.path.split(separator: "/").last.map(String.init) ?? group.path)
                        .font(EosFont.heading)
                        .foregroundStyle(EosColor.inkTertiary)
                        .textCase(nil)
                }
            }
        }
    }

    private func row(_ session: PtySession) -> some View {
        Button { onOpen(session.id) } label: { TerminalRow(session: session) }
            .buttonStyle(.plain)
            .listRowBackground(EosColor.bg)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: EosSpacing.xxs, leading: EosSpacing.screenInset,
                                      bottom: EosSpacing.xxs, trailing: EosSpacing.screenInset))
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if model.connected {
                    Button { close(session.id) } label: { Label("Close", systemImage: "xmark") }
                        .tint(EosColor.danger)
                }
            }
    }

    private func close(_ id: String) {
        Haptics.warning()
        Task { _ = await model.killPty(id) }
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

// Session card (OrchestratorRow chrome): kind glyph (Claude asterisk / shell prompt, the desktop's
// KindGlyph), title, short cwd.
private struct TerminalRow: View {
    let session: PtySession

    var body: some View {
        HStack(spacing: EosSpacing.sm) {
            Image(systemName: session.isClaude ? "asterisk" : "terminal")
                .font(.system(size: 15, weight: .medium))
                .foregroundStyle(session.isClaude ? EosColor.coral : EosColor.inkSecondary)
                .frame(width: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(session.displayTitle)
                    .font(EosFont.label)
                    .foregroundStyle(EosColor.ink)
                Text(shortPath(session.cwd))
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.inkTertiary)
                    .truncationMode(.head)
            }
            .lineLimit(1)
            Spacer(minLength: EosSpacing.xs)
            if !session.alive {
                Text("exited")
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.inkTertiary)
            }
        }
        .padding(.horizontal, EosSpacing.sm)
        .padding(.vertical, EosSpacing.xs)
        .frame(minHeight: 44)
        .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous)
            .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }

    // "/Users/x/dev/eos" → "~/dev/eos".
    private func shortPath(_ path: String) -> String {
        let comps = path.split(separator: "/")
        guard comps.count >= 2, comps[0] == "Users" else { return path }
        return (["~"] + comps.dropFirst(2)).joined(separator: "/")
    }
}
