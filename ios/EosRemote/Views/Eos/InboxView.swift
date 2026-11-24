import SwiftUI
import EosRemoteKit

// Needs you on the phone (07 §4.8): the items that wait, natively, each with what became of the
// answer given here: waiting for the Mac, or changed there first.
struct InboxView: View {
    @ObservedObject var feed: EosFeed
    let onOpenItem: (EosInboxItem) -> Void

    var body: some View {
        let open = feed.inbox.filter { $0.state == "open" || $0.state == "later" }
        if open.isEmpty {
            Text("Nothing waits for you.").font(EosFont.body).foregroundStyle(EosColor.inkSecondary)
        } else {
            ForEach(open) { item in
                Button { onOpenItem(item) } label: { row(item) }.buttonStyle(.plain)
            }
        }
    }

    private func row(_ item: EosInboxItem) -> some View {
        EosCard {
            Text(item.title).font(EosFont.label).foregroundStyle(EosColor.ink)
            if !item.summary.isEmpty {
                Text(item.summary).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary).lineLimit(2)
            }
            if let line = InboxStatus.line(item: item, feed: feed) {
                Text(line).font(EosFont.captionSmall).foregroundStyle(EosColor.State.waitingDot)
            }
        }
    }
}

enum InboxStatus {
    @MainActor static func line(item: EosInboxItem, feed: EosFeed) -> String? {
        if feed.waiting.contains(item.id) { return "Sends when your Mac is back" }
        switch feed.outcomes[item.id] {
        case .changed(let why)?: return "Changed on your Mac: \(why)"
        case .stale(let why)?: return why
        case .refused(let why)?: return why
        case .sent?, nil: break
        }
        return item.staleAt != nil ? "Its subject changed since" : nil
    }
}
