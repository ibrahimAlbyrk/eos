import SwiftUI
import EosRemoteKit

// The Eos tab (07 §4.8): Needs you first, then the routines with their trigger line and last run.
// Shown only for a Mac that serves routines (cap `eos`); while that Mac is away it shows what was
// last read, and says when.
struct EosTabView: View {
    @ObservedObject var feed: EosFeed
    let connected: Bool
    let onOpenItem: (EosInboxItem) -> Void
    let onRun: (EosRoutine) -> Void
    let onOpenRun: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EosSpacing.lg) {
                if !connected && feed.seenAt > 0 {
                    Text("Your Mac is away. As it was \(Date(timeIntervalSince1970: feed.seenAt).formatted(.relative(presentation: .named))).")
                        .font(EosFont.caption)
                        .foregroundStyle(EosColor.inkTertiary)
                }
                SectionHeader("Needs you")
                InboxView(feed: feed, onOpenItem: onOpenItem)
                SectionHeader("Routines")
                ForEach(feed.routines) { routine in routineRow(routine) }
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.top, EosSpacing.lg)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(EosColor.bg)
        .refreshable { await feed.reloadInbox(); await feed.reloadRoutines() }
    }

    private func routineRow(_ routine: EosRoutine) -> some View {
        EosCard {
            HStack(alignment: .firstTextBaseline) {
                Text(routine.name).font(EosFont.label).foregroundStyle(EosColor.ink)
                Spacer()
                if routine.state == "active" {
                    PillButton("Run", style: .ghost) { onRun(routine) }
                } else {
                    Text(routine.state.capitalized).font(EosFont.caption).foregroundStyle(EosColor.inkTertiary)
                }
            }
            if let line = routine.triggerLine {
                Text(line).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
            }
            if let last = routine.lastRun {
                Button { onOpenRun(last.id) } label: {
                    Text("Last run: \(last.headline ?? last.itemTitle ?? last.state.replacingOccurrences(of: "_", with: " "))")
                        .font(EosFont.caption)
                        .foregroundStyle(EosColor.inkTertiary)
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
            }
        }
    }
}
