import SwiftUI
import EosRemoteKit

// Top-of-transcript task card (spec 03 §1 MessageTask, port of MessageTask.jsx). Shown above the
// transcript when the worker has a parent_id (+ boot prompt): an accent-tinted card with a task icon,
// "Task from **{AgentLink}**", and the boot prompt verbatim (URL-linkified only — a Markdown pass here
// would mangle literal <tags> the orchestrator wrote). Rendered by WorkerDetailView.
struct TaskFromView: View {
    let prompt: String
    let parent: AgentRef

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "doc.text")
                    .font(.system(size: 13)).foregroundStyle(EosColor.coral.opacity(0.7))   // .msg-task-icon accent .7 (§10)
                (Text("Task from ").foregroundStyle(EosColor.ink))
                    .font(EosFont.label)
                AgentLinkView(ref: parent)
            }
            Text(TextSegmenter.urlLinkified(prompt))
                .font(EosFont.body).foregroundStyle(EosColor.ink).lineSpacing(3)             // .msg-task-body text-base 1.6 (§10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)                                      // .msg-task pad 12×16 (§10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.coral.opacity(0.06), in: RoundedRectangle(cornerRadius: 10, style: .continuous))  // accent@6% (§10)
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(EosColor.coral.opacity(0.12), lineWidth: 1))
    }
}
