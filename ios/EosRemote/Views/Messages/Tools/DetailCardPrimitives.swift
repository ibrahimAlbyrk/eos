import SwiftUI
import EosRemoteKit

// Shared chrome for the Tier-2 detail bodies (spec 03 §2.3/§2.5/§2.6/§3, port of the .wd-card /
// .wd-sec / .wd-chip / .task-badge / .tool-qa / .wf-status markup in styles.css §10). The worker
// blueprint, task, workflow, available-workers, tool-search and datetime cards all read like one
// another because they share these building blocks. Reuses the 4b `ToolBodyCard` for the outer
// radius-10 surface shell; adds the `.wd-sec` section stack (pad 9×14, top-hairline between sections)
// and the pill/badge/QA atoms on top.

// A vertical stack of `.wd-sec` sections inside the shared ToolBodyCard: each section pads 9×14 and
// separates from the previous with a top hairline (.wd-sec + .wd-sec border-top).
struct WdCard<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        ToolBodyCard { _VariadicView.Tree(WdSectionLayout()) { content() } }
    }
}

// Lays out its (section) subviews vertically, inserting a top hairline before every section after the
// first — the SwiftUI equivalent of `.wd-sec + .wd-sec { border-top }`.
private struct WdSectionLayout: _VariadicView.MultiViewRoot {
    @ViewBuilder func body(children: _VariadicView.Children) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(children) { child in
                child
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.vertical, 9)          // .wd-sec pad 9×14 (§10)
                    .overlay(alignment: .top) {
                        if child.id != children.first?.id {
                            Rectangle().fill(EosColor.hairline).frame(height: 1)  // .wd-sec + .wd-sec border-top (§10)
                        }
                    }
            }
        }
    }
}

// .wd-sec-label: text-xs 700 uppercase letter-spacing .4 fg-faint — the section caption.
struct WdSectionLabel: View {
    let text: String
    var body: some View {
        Text(text)
            .font(EosFont.captionSmall).fontWeight(.bold).textCase(.uppercase)
            .kerning(0.4).foregroundStyle(EosColor.inkTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// .wd-desc: fg-dim text-sm (the muted description body).
struct WdDesc: View {
    let text: String
    var body: some View {
        Text(text).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// .wd-text: fg text-sm pre-wrap (the readable instruction/prompt body).
struct WdText: View {
    let text: String
    var body: some View {
        Text(text).font(EosFont.caption).foregroundStyle(EosColor.ink).lineSpacing(2)
            .frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
    }
}

// .wd-chip: a "{k} {value}" or flag pill — surface-2 fill, radius 6, mono-ish caption. `keyLabel` is the
// faint prefix (.wd-chip-k); a flag has no key.
struct WdChip: View {
    var keyLabel: String? = nil
    let value: String
    var flag: Bool = false
    var body: some View {
        HStack(spacing: 5) {
            if let k = keyLabel { Text(k).foregroundStyle(EosColor.inkTertiary) }   // .wd-chip-k fg-faint (§10)
            Text(value).foregroundStyle(flag ? EosColor.inkSecondary : EosColor.ink) // flag → fg-dim (§10)
        }
        .font(EosFont.caption)
        .padding(.horizontal, 8).padding(.vertical, 2)                              // pad 2×8 (§10)
        .background(EosColor.bgSunken, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
    }
}

// A flow row of chips/pills that wraps (the .wd-chips / .wd-tools / .task-deps containers, gap 6).
struct WrapRow<Data: RandomAccessCollection, Content: View>: View where Data.Element: Hashable {
    let items: Data
    var spacing: CGFloat = 6
    @ViewBuilder let content: (Data.Element) -> Content
    var body: some View {
        FlowLayout(spacing: spacing) { ForEach(Array(items), id: \.self) { content($0) } }
    }
}

// A minimal flow layout (wrap-when-full) for the chip rows — SwiftUI has no built-in flex-wrap.
struct FlowLayout: Layout {
    var spacing: CGFloat = 6
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxW = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > maxW, x > 0 { x = 0; y += rowH + spacing; rowH = 0 }
            x += s.width + spacing; rowH = max(rowH, s.height)
        }
        return CGSize(width: maxW == .infinity ? x : maxW, height: y + rowH)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, rowH: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x + s.width > bounds.maxX, x > bounds.minX { x = bounds.minX; y += rowH + spacing; rowH = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing; rowH = max(rowH, s.height)
        }
    }
}

// .task-badge: mono text-xs pill, colored by status (pending→neutral, in_progress→accent,
// completed→ok, deleted→err). A "in progress" label maps the underscore form.
struct TaskBadge: View {
    let status: String
    private static let labels = ["pending": "pending", "in_progress": "in progress",
                                 "completed": "completed", "deleted": "deleted"]
    private var colors: (fg: Color, bg: Color) {
        switch status {
        case "in_progress": return (EosColor.coral, EosColor.coral.opacity(0.18))
        case "completed":   return (EosColor.State.runningDot, EosColor.State.runningDot.opacity(0.16))
        case "deleted":     return (EosColor.State.failedDot, EosColor.State.failedDot.opacity(0.16))
        default:            return (EosColor.inkSecondary, EosColor.inkTertiary.opacity(0.20))  // pending
        }
    }
    var body: some View {
        Text(Self.labels[status] ?? status)
            .font(EosFont.codeSmall).fontWeight(.semibold).kerning(0.3)
            .foregroundStyle(colors.fg)
            .padding(.horizontal, 7).padding(.vertical, 1)                          // pad 1×7 (§10)
            .background(colors.bg, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }
}

// A dependency pill (.task-dep): "blocks #3" (surface-2) / "blocked by #1" (warn-tinted, bordered).
struct TaskDepPill: View {
    let text: String
    var blocked: Bool = false
    var body: some View {
        Text(text)
            .font(EosFont.codeSmall)
            .foregroundStyle(blocked ? EosColor.State.waitingDot : EosColor.inkSecondary)
            .padding(.horizontal, 8).padding(.vertical, 2)
            .background(blocked ? EosColor.State.waitingDot.opacity(0.10) : EosColor.bgSunken,
                        in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(EosColor.hairline, lineWidth: 1))
    }
}

// .tool-qa — the Q→A list shared by AskUserQuestion / ask_user / ask_peer. Each item: the question
// (fg-dim) + the answer ("→ {a}", accent arrow) or an italic "Waiting…" pending marker. An optional
// trailing note renders a dismissed/stale sentence (ask_user only).
struct ToolQAView: View {
    struct Item: Identifiable { let id = UUID(); let question: String; let answer: String? }
    let items: [Item]
    var note: String? = nil
    var showPendingWhenEmpty: Bool = true

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(items) { item in
                VStack(alignment: .leading, spacing: 2) {
                    Text(item.question)
                        .font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)   // .tool-qa-q fg-dim (§10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    answerLine(item)
                }
            }
            if let note, !note.isEmpty {
                Text(note).font(EosFont.caption).italic().foregroundStyle(EosColor.inkTertiary)  // .tool-qa-pending (§10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 8)                                // .tool-qa pad 8×14 (§10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.surface)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))             // radius 10 (§10)
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(EosColor.hairline, lineWidth: 1))
        .padding(.top, 4).padding(.bottom, 8)                                          // margin 4 0 8 (§10)
    }

    @ViewBuilder private func answerLine(_ item: Item) -> some View {
        if let a = item.answer, !a.isEmpty {
            (Text("→ ").foregroundStyle(EosColor.coral) + Text(a).foregroundStyle(EosColor.ink))  // .tool-qa-arrow accent (§10)
                .font(EosFont.caption)
                .frame(maxWidth: .infinity, alignment: .leading)
        } else if showPendingWhenEmpty {
            Text("Waiting…").font(EosFont.caption).italic().foregroundStyle(EosColor.inkTertiary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }
}

// .wf-status / task run-status chip — passed→ok, failed→err, running→accent, stopped→warn,
// pending→neutral. Mono uppercase-ish pill; shared by the workflow tool detail + the workflow report.
struct WorkflowStatusChip: View {
    let status: String?
    private var colors: (fg: Color, bg: Color)? {
        switch status {
        case "passed":  return (EosColor.State.runningDot, EosColor.State.runningDot.opacity(0.16))
        case "failed":  return (EosColor.State.failedDot, EosColor.State.failedDot.opacity(0.18))
        case "running": return (EosColor.coral, EosColor.coral.opacity(0.16))
        case "stopped": return (EosColor.State.waitingDot, EosColor.State.waitingDot.opacity(0.18))
        case "pending": return (EosColor.inkSecondary, EosColor.inkTertiary.opacity(0.20))
        default:        return nil
        }
    }
    var body: some View {
        if let status, let c = colors {
            Text(status)
                .font(EosFont.codeSmall).kerning(0.3)
                .foregroundStyle(c.fg)
                .padding(.horizontal, 7).padding(.vertical, 1)                        // pad 1×7 (§10)
                .background(c.bg, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
        }
    }
}

// A monospace run-id / workflow-id chip (.wf-id) shown after the header verb.
struct MonoIdText: View {
    let id: String
    var body: some View {
        Text(id).font(EosFont.code).fontWeight(.semibold).foregroundStyle(EosColor.ink)
    }
}

// The report-detail plain-text body reused by message/peer/worker bodies (fg text pre-wrap). A thin
// wrapper so those cards don't each repeat the geometry.
struct ReportDetailText: View {
    let text: String
    var body: some View {
        Text(text)
            .font(EosFont.body).foregroundStyle(EosColor.ink).lineSpacing(3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
            .textSelection(.enabled)
    }
}
