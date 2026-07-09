import SwiftUI
import EosRemoteKit

// Report / directive / peer-request row (spec 03 §1 #7/8/9, port of MessageReport.jsx). A collapsible
// tool-item-style row: a label ("Report from" / "Message from" / "Peer request from") + a bold AgentLink
// + chevron; expanded → the plain-text body (report-detail). The three kinds share this chrome and
// differ only in the label + which agent the link points to.
struct MessageReportView: View {
    enum Mode { case report, directive, peerRequest }
    let mode: Mode
    let text: String
    let agent: AgentRef

    @State private var open = false

    private var label: String {
        switch mode {
        case .report: return "Report from"
        case .directive: return "Message from"
        case .peerRequest: return "Peer request from"
        }
    }

    var body: some View {
        DisclosureRowView(open: $open) {
            HStack(spacing: 5) {
                Text(label)
                    .font(EosFont.label).foregroundStyle(EosColor.inkSecondary) // fg-dim label (§10)
                AgentLinkView(ref: agent)
            }
        } content: {
            if !text.isEmpty {
                Text(text)
                    .font(EosFont.body).foregroundStyle(EosColor.ink)           // report-detail body (§10)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
