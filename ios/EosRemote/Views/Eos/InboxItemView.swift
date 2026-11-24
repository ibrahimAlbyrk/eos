import SwiftUI
import EosRemoteKit

// One Needs-you item (07 §4.8): a draft's parts as native text, edited in place where its kind
// allows; a Page issue through its document; the choices of the item's kind. Every answer names the
// revision it was given on and goes through the outbox: the Mac's gate and revision check decide,
// and an item that moved on there answers "changed". What cannot be answered here says so.
struct InboxItemView: View {
    @ObservedObject var feed: EosFeed
    let itemId: String
    let onOpenPage: (EosItemView) -> Void

    @State private var detail: JSONValue?
    @State private var doc: ResultDocument?
    @State private var edited = false

    private var item: EosInboxItem? { feed.inbox.first { $0.id == itemId } }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EosSpacing.md) {
                if let item {
                    Text(item.title).font(EosFont.heading).foregroundStyle(EosColor.ink)
                    if !item.summary.isEmpty {
                        Text(item.summary).font(EosFont.body).foregroundStyle(EosColor.inkSecondary)
                    }
                    if let line = InboxStatus.line(item: item, feed: feed) {
                        Text(line).font(EosFont.caption).foregroundStyle(EosColor.State.waitingDot)
                    }
                    if let view = item.view {
                        PillButton("Open the page", systemImage: "doc.richtext", style: .ghost) { onOpenPage(view) }
                    }
                    if item.kind == "draft" { draft(item) } else { choices(item) }
                } else {
                    Text("This item is no longer waiting.").font(EosFont.body).foregroundStyle(EosColor.inkSecondary)
                }
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.vertical, EosSpacing.lg)
        }
        .background(EosColor.bg)
        .task(id: item?.rev) { await load() }
    }

    private func load() async {
        detail = await feed.itemDetail(itemId)
        if !edited { doc = ResultDocument.of(detail: detail) }
    }

    @ViewBuilder private func draft(_ item: EosInboxItem) -> some View {
        if let current = doc, current.editable {
            ForEach(current.parts) { part in
                EosCard {
                    HStack {
                        Text(part.role.capitalized).font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
                        Spacer()
                        if ResultDocument.removable(part) {
                            Button("Remove") { change { $0.parts.removeAll { $0.key == part.key } } }
                                .font(EosFont.caption)
                        }
                    }
                    TextField("", text: Binding(
                        get: { doc?.parts.first { $0.key == part.key }?.text ?? "" },
                        set: { text in change { doc in
                            if let i = doc.parts.firstIndex(where: { $0.key == part.key }) { doc.parts[i].text = text }
                        } }), axis: .vertical)
                        .font(EosFont.body)
                }
            }
        } else if doc != nil {
            Text("Edit on your Mac.").font(EosFont.caption).foregroundStyle(EosColor.inkTertiary)
        }
        let stale = feed.outcomes[item.id].map { if case .stale = $0 { true } else { false } } ?? false
        HStack {
            PillButton(stale ? "Send anyway" : "Send", systemImage: "paperplane.fill", style: .primary) {
                feed.answer(.send(item: item.id, rev: item.rev, doc: edited ? doc : nil, confirmStale: stale))
                edited = false
            }
            PillButton("Later", style: .ghost) { feed.answer(.later(item: item.id)) }
            PillButton("Discard", style: .ghost) { feed.answer(.discard(item: item.id, rev: item.rev)) }
        }
    }

    @ViewBuilder private func choices(_ item: EosInboxItem) -> some View {
        let offered = InboxChoices.of(kind: item.kind)
        if offered.isEmpty {
            Text("Answer this on your Mac.").font(EosFont.caption).foregroundStyle(EosColor.inkTertiary)
        } else {
            HStack {
                ForEach(offered, id: \.choice) { offer in
                    PillButton(offer.label, style: offer == offered.first ? .primary : .ghost) {
                        feed.answer(.answer(item: item.id, rev: item.rev, kind: item.kind, choice: offer.choice))
                    }
                }
            }
        }
        PillButton("Later", style: .ghost) { feed.answer(.later(item: item.id)) }
    }

    private func change(_ edit: (inout ResultDocument) -> Void) {
        guard var current = doc else { return }
        edit(&current)
        doc = current
        edited = true
    }
}

// The choices each kind of item offers on the phone (eos-contracts `InboxAnswer`). Installing a
// capability is never done from the phone (06 G29), and a question, a permission ask or a
// suggestion about the user is answered on the Mac.
enum InboxChoices {
    struct Offer: Equatable { let choice: String; let label: String }

    static func of(kind: String) -> [Offer] {
        switch kind {
        case "run_start": return [Offer(choice: "run", label: "Run"), Offer(choice: "skip", label: "Skip")]
        case "routine_alert":
            return [Offer(choice: "resume", label: "Resume"), Offer(choice: "keep_paused", label: "Keep paused")]
        case "freedom_offer":
            return [Offer(choice: "accept", label: "Accept"), Offer(choice: "not_now", label: "Not now"),
                    Offer(choice: "never", label: "Never")]
        case "confirm_change": return [Offer(choice: "confirm", label: "Confirm"), Offer(choice: "reject", label: "Reject")]
        case "delivery_problem":
            return [Offer(choice: "retry", label: "Try again"), Offer(choice: "mark_sent", label: "I sent it"),
                    Offer(choice: "discard", label: "Discard")]
        case "suggestion": return [Offer(choice: "make_it", label: "Make it"), Offer(choice: "no", label: "No")]
        case "notice": return [Offer(choice: "act", label: "Do it"), Offer(choice: "dismiss", label: "Dismiss")]
        default: return []
        }
    }
}
