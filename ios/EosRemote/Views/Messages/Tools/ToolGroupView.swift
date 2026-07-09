import SwiftUI
import EosRemoteKit

// Tool group (spec 03 §1 #4, port of ToolGroup.jsx). A disclosure header showing the group summary
// string ("Read 3 files, Edited 2 files, ran 1 shell command"), inkSecondary; expanded → a bordered
// card (surface, r=10, pad 4×12) listing the member ToolItemViews. Default-open is the Mac's persisted
// setting; here it defaults collapsed (a dense transcript stays scannable).
struct ToolGroupView: View {
    let summary: String
    let tools: [Tool]

    @State private var open = false

    var body: some View {
        DisclosureRowView(open: $open) {
            Text(summary.isEmpty ? "\(tools.count) tools" : summary)
                .font(EosFont.body)                                            // .tool-group-header text-base (§10)
                .foregroundStyle(EosColor.inkSecondary)                        // fg-dim (§10)
                .multilineTextAlignment(.leading)
        } content: {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(tools) { tool in ToolItemView(tool: tool) }
            }
            .padding(.horizontal, 12).padding(.vertical, 4)                    // .tool-group-list pad 4×12 (§10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(EosColor.surface)                                      // bg surface (§10)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(EosColor.hairline, lineWidth: 1))               // border 1 (§10)
            .padding(.top, 4)                                                  // margin-top 4 (§10)
        }
        .padding(.vertical, 4)                                                 // pad-block 9-ish header rhythm (§10)
    }
}
