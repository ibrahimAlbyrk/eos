import SwiftUI
import EosRemoteKit

// Diff hunk rendering (spec 03 §5.8, port of diff.jsx row markup). Each DiffHunk row → an HStack:
// line# (ed-num width 28 right) + sign (ed-sign width 14) + text (mono) with the changed span wrapped
// in an inline highlight. Row background: add → ok@13% (runningSoft-ish), del → err@13% (failedSoft),
// ctx → clear. The inline highlight span uses ed-hl-add ok@30% / ed-hl-del err@30%.
struct DiffHunksView: View {
    let hunks: [DiffHunk]

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(hunks.enumerated()), id: \.offset) { _, hunk in
                HStack(alignment: .top, spacing: 0) {
                    Text("\(hunk.num)")
                        .font(EosFont.code)
                        .foregroundStyle(numColor(hunk.type))
                        .frame(width: 28, alignment: .trailing)                    // ed-num width 28 (§10)
                    Text(sign(hunk.type))
                        .font(EosFont.code)
                        .foregroundStyle(numColor(hunk.type))
                        .frame(width: 14, alignment: .center)                      // ed-sign width 14 (§10)
                    Text(lineText(hunk))
                        .font(EosFont.code)
                        .foregroundStyle(EosColor.ink)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .lineSpacing(3)                                                    // line-height 1.65 (§10)
                .padding(.vertical, 1)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(rowFill(hunk.type))
            }
        }
        .padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        // One AX element for the whole diff (VoiceOver: "diff, 3 added, 1 removed" then the
        // content on demand — instead of 3 swipe stops per line, which is unusable at 200 lines
        // and was the worst XCUITest tree multiplier when an Edit card is expanded).
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(axLabel)
        .accessibilityValue(axValue)
    }

    private var axLabel: String {
        let adds = hunks.filter { $0.type == .add }.count
        let dels = hunks.filter { $0.type == .del }.count
        return "diff, \(adds) added, \(dels) removed"
    }
    private var axValue: String {
        clampText(hunks.map { "\(sign($0.type)) \($0.text)" }.joined(separator: "\n"), 4000)
    }

    // Text with the word-level changed span highlighted (ed-hl-add/del wash on the changed run).
    private func lineText(_ hunk: DiffHunk) -> AttributedString {
        guard let segments = hunk.segments, !segments.isEmpty else { return AttributedString(hunk.text) }
        var out = AttributedString()
        for seg in segments {
            var run = AttributedString(seg.text)
            if seg.highlighted {
                run.backgroundColor = (hunk.type == .add ? EosColor.State.runningDot : EosColor.State.failedDot)
                    .opacity(0.30)                                                 // ed-hl-add/del @30% (§10)
            }
            out += run
        }
        return out
    }

    private func sign(_ type: DiffHunk.Kind) -> String {
        switch type { case .add: return "+"; case .del: return "-"; case .ctx: return " " }
    }
    // num + sign color: add ok, del err, ctx faint (§10 .ed-line.ed-add/.ed-del num+sign).
    private func numColor(_ type: DiffHunk.Kind) -> Color {
        switch type {
        case .add: return EosColor.State.runningDot
        case .del: return EosColor.State.failedDot
        case .ctx: return EosColor.inkTertiary
        }
    }
    // Row bg: add → ok@13%, del → err@13%, ctx → clear (§10; spec §5.8 add→runningSoft / del→failedSoft).
    private func rowFill(_ type: DiffHunk.Kind) -> Color {
        switch type {
        case .add: return EosColor.State.runningDot.opacity(0.13)
        case .del: return EosColor.State.failedDot.opacity(0.13)
        case .ctx: return .clear
        }
    }
}
