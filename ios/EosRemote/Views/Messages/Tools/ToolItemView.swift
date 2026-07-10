import SwiftUI
import EosRemoteKit

// The universal tool chrome (spec 03 §5.3, port of ToolItem.jsx). Header is a DisclosureRowView:
// [verb][file-chip | AgentLink][arg-summary][headerBadge][failure-badge][diff-stats][chevron]; the
// body is the descriptor's Detail when expanded. The verb shimmers while running (§6.4); a failed tool
// tints the whole row (failedSoft) and shows a denied/failed badge, striking through the file. The
// file chip taps open the FileViewerSheet (via \.openFile); an AgentLink taps select the worker.
struct ToolItemView: View {
    let tool: Tool

    @State private var open = false
    @Environment(\.openFile) private var openFile

    private var descriptor: ToolDescriptor { getToolView(tool.name) }
    private var failure: FailureKind? { failureKind(tool) }
    private var labelPair: (verb: String, file: String) {
        tool.running ? descriptor.runningLabel(tool) : descriptor.label(tool)
    }
    private var expandable: Bool { descriptor.expandable(tool) }

    var body: some View {
        DisclosureRowView(open: $open, showChevron: expandable) {
            header
        } content: {
            descriptor.detail(tool)
        }
        .padding(.vertical, 5)                                                  // .tool-item-header pad-block 5 (§10)
        .padding(.horizontal, failure != nil ? 8 : 0)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(failure != nil ? EosColor.State.failedSoft : .clear)     // .ti-failed-state bg (§10)
        )
        .opacity(tool.running ? 0.7 : 1)                                        // .ti-running opacity 0.7 (§6.4)
    }

    private var header: some View {
        HStack(spacing: 5) {                                                    // gap 5 (§10)
            // verb — inkSecondary, shimmers while running (§6.4). Bash has an empty verb (label carries all).
            if !labelPair.verb.isEmpty {
                ShimmerText(text: labelPair.verb, base: EosColor.inkSecondary, active: tool.running)
            }
            fileOrAgent
            if let summary = descriptor.summary(tool), !summary.isEmpty {
                Text(summary)
                    .font(EosFont.caption).foregroundStyle(EosColor.inkTertiary) // .ti-arg-summary fg-faint (§10)
                    .lineLimit(1).truncationMode(.tail)
            }
            Spacer(minLength: 0)
            if let badge = descriptor.headerBadge(tool) { headerBadgeView(badge) }
            if let failure { failureBadge(failure) }
            if let stats = descriptor.stats(tool) { diffStats(stats) }
        }
    }

    // file chip (tap → \.openFile viewer) OR AgentLink (tap → select worker) OR plain file text.
    @ViewBuilder private var fileOrAgent: some View {
        if let ref = descriptor.agentRef(tool) {
            AgentLinkView(ref: ref)
        } else if !labelPair.file.isEmpty {
            let path = descriptor.filePath(tool)
            Text(labelPair.file)
                .font(EosFont.label).fontWeight(.semibold)
                .foregroundStyle(EosColor.ink)                                  // .ti-file 600 fg (§10)
                .strikethrough(failure != nil, color: EosColor.State.failedDot) // .ti-failed-state line-through err (§10)
                .underline(path != nil, pattern: .solid)                        // .ti-link (§10)
                .onTapGesture { if let path { openFile(path) } }
        }
    }

    // .ti-loop-badge / status chip / task badge — mono text-xs, radius 4 pill.
    private func headerBadgeView(_ badge: HeaderBadge) -> some View {
        Text(badge.text)
            .font(EosFont.codeSmall)
            .foregroundStyle(badge.fg)
            .padding(.horizontal, 5).padding(.vertical, 2)                      // pad 2×5 (§10)
            .background(badge.bg, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }

    // .ti-failed: text-xs uppercase 600; denied → err@18% bg + err; failed → warn@18% bg + warn.
    private func failureBadge(_ kind: FailureKind) -> some View {
        let (fg, bg) = kind == .denied
            ? (EosColor.State.failedDot, EosColor.State.failedDot.opacity(0.18))
            : (EosColor.State.waitingDot, EosColor.State.waitingDot.opacity(0.18))
        return Text(kind.rawValue.uppercased())
            .font(EosFont.captionSmall).fontWeight(.semibold)
            .foregroundStyle(fg)
            .padding(.horizontal, 6).padding(.vertical, 1)                      // pad 1×6 (§10)
            .background(bg, in: RoundedRectangle(cornerRadius: 3, style: .continuous))
    }

    // .ti-stats: +add ok / -del err (§10).
    private func diffStats(_ stats: (add: Int, del: Int)) -> some View {
        HStack(spacing: 4) {
            if stats.add > 0 { Text("+\(stats.add)").foregroundStyle(EosColor.State.runningDot) }
            if stats.del > 0 { Text("-\(stats.del)").foregroundStyle(EosColor.State.failedDot) }
        }
        .font(EosFont.caption)
    }
}
