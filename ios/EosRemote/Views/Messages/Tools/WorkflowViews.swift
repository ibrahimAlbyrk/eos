import SwiftUI
import EosRemoteKit

// Workflow surfaces (spec 03 §2.6 + §3, port of WorkflowCard.jsx). Two entry points:
//   • WorkflowToolDetailView — the mcp__orchestrator__workflow tool's Detail: run id + status chip +
//     message + pretty-printed output.
//   • WorkflowReportView — a standalone report whose workerName == "workflow" (branched in MessageView):
//     "Workflow completed" + run id + status chip (parsed) + collapsible pretty result.
// Both reuse the .wd-card section stack + the WorkflowStatusChip; the report owns its own disclosure.

// MARK: - §2.6 workflow tool detail

struct WorkflowToolDetailView: View {
    let tool: Tool
    @State private var copied = false

    private var res: JSONValue? { toolResultJSON(tool) }
    private var isError: Bool { tool.result?.isError == true }
    private var id: String? {
        res?["runId"]?.stringValue ?? res?["name"]?.stringValue
            ?? tool.input["runId"]?.stringValue ?? tool.input["from"]?.stringValue
    }
    private var status: String? { res?["status"]?.stringValue }
    private var message: String? { res?["message"]?.stringValue }
    private var output: JSONValue? {
        guard let o = res?["output"] else { return nil }
        if case .null = o { return nil }
        if case .string(let s) = o, s.isEmpty { return nil }
        return o
    }

    var body: some View {
        if res != nil || isError || tool.running {
            WdCard {
                if let kind = failureKind(tool) { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
                if !isError, id != nil || status != nil {
                    HStack(spacing: 8) {
                        if let id { MonoIdText(id: id) }
                        WorkflowStatusChip(status: status)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if !isError, res == nil, tool.running {
                    Text("Running…").font(EosFont.caption).italic().foregroundStyle(EosColor.inkTertiary)
                }
                if let message, !message.isEmpty { WdDesc(text: message) }
                if let output { outputSection(prettyValueJSON(output)) }
            }
        }
    }

    private func outputSection(_ pretty: String) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                WdSectionLabel(text: "Output")
                Spacer(minLength: 0)
                CopyButtonMini(text: pretty, copied: $copied)
            }
            WorkflowResultText(text: pretty)
        }
    }
}

// MARK: - §3 workflow completion report (standalone)

// A report block whose workerName == "workflow" renders here (NOT MessageReportView). Standalone
// tool-item: "Workflow completed" + run id + status chip (parsed from the "[workflow {id}] completed
// (status: {s})" head) + collapsible pretty-printed result.
struct WorkflowReportView: View {
    let text: String
    var runIdFallback: String? = nil
    @State private var open = false
    @State private var copied = false

    private var completion: WorkflowCompletion { parseWorkflowCompletion(text, runIdFallback: runIdFallback) }

    var body: some View {
        let c = completion
        let pretty = prettyValueJSON(.string(c.body))
        DisclosureRowView(open: $open, showChevron: !pretty.isEmpty) {
            HStack(spacing: 5) {
                Text("Workflow completed").font(EosFont.label).foregroundStyle(EosColor.inkSecondary)  // .ti-verb (§10)
                if let id = c.runId { MonoIdText(id: id) }
                WorkflowStatusChip(status: c.status)
            }
        } content: {
            if !pretty.isEmpty {
                WdCard {
                    VStack(alignment: .leading, spacing: 5) {
                        HStack {
                            WdSectionLabel(text: "Result")
                            Spacer(minLength: 0)
                            CopyButtonMini(text: pretty, copied: $copied)
                        }
                        WorkflowResultText(text: pretty)
                    }
                }
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// .wf-result: mono text-sm, fg-dim, pre-wrap, max-height 360 scroll. The scroll cap keeps a giant
// result from taking over the transcript (the Mac caps at 360px).
struct WorkflowResultText: View {
    let text: String
    var body: some View {
        ScrollView(.vertical) {
            Text(text)
                .font(EosFont.code).foregroundStyle(EosColor.inkSecondary).lineSpacing(2)  // .wf-result (§10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .textSelection(.enabled)
        }
        .frame(maxHeight: 360)
        .scrollBounceBehavior(.basedOnSize)
    }
}
