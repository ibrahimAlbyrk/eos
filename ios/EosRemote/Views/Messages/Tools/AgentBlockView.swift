import SwiftUI
import EosRemoteKit

// Sub-agent run (spec 03 §1 #6, port of AgentBlock.jsx + AgentViewer.jsx). Two states:
// - done + result → a one-line "Ran agent {model} {desc}" (fg-dim), tap opens the viewer.
// - running / no result → a header ("Running agent" / "Background agent started") + a card with a
//   shimmering title, "· N tools", and a chevron; tap opens the AgentViewerSheet.
// The viewer is the prompt bubble + the inner ToolItemViews + the serif result.
struct AgentBlockView: View {
    let run: AgentRun
    @State private var showViewer = false
    // Sheets don't inherit the environment — re-inject the model + navigation for the inner
    // ToolItemViews (AgentLinks close the viewer first, then push; RootView pattern).
    @EnvironmentObject private var model: AppModel
    @Environment(\.selectWorker) private var selectWorker

    private var isDone: Bool { run.status != "running" && run.status != "started" }
    private var hasResult: Bool { !(run.result ?? "").isEmpty }

    var body: some View {
        Group {
            if isDone && hasResult { doneLine } else { runningCard }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .sheet(isPresented: $showViewer) {
            AgentViewerSheet(run: run)
                .environmentObject(model)
                .environment(\.selectWorker) { id in
                    showViewer = false
                    selectWorker(id)
                }
        }
    }

    // .agent-done-text: one line, tap to open the viewer.
    private var doneLine: some View {
        Button { showViewer = true } label: {
            HStack(spacing: 6) {
                Image(systemName: "sparkles").font(.caption).foregroundStyle(EosColor.coral.opacity(0.8))
                Text(doneTitle)
                    .font(EosFont.body).foregroundStyle(EosColor.inkSecondary)  // agent-done-text fg-dim (§10)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
        }
        .buttonStyle(.plain)
    }

    private var doneTitle: String {
        var parts = ["Ran agent"]
        if let m = run.model, !m.isEmpty { parts.append(m) }
        if !run.description.isEmpty { parts.append(run.description) }
        return parts.joined(separator: " ")
    }

    // .agent-card (running): surface-2 fill, r=12, pad 12×16, gap 12; title shimmers while running.
    private var runningCard: some View {
        Button { showViewer = true } label: {
            HStack(spacing: 12) {
                Sunburst().fill(EosColor.coral).frame(width: 18, height: 18)
                    .opacity(0.85).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 2) {
                    ShimmerText(text: cardTitle, font: EosFont.heading, base: EosColor.ink,
                                active: !isDone)                               // agent-card-title shimmer (§6.4)
                    Text(statusText)
                        .font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)  // agent-card-status (§10)
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(EosColor.inkTertiary)
            }
            .padding(.horizontal, 16).padding(.vertical, 12)                    // pad 12×16 (§10)
            .frame(maxWidth: 420, alignment: .leading)                         // max-width 420 (§10)
            .background(EosColor.bgSunken)                                     // surface-2 (§10)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous)) // radius 12 (§10)
        }
        .buttonStyle(.plain)
    }

    private var cardTitle: String {
        if run.background { return "Background agent started" }
        return run.description.isEmpty ? "Running agent" : run.description
    }
    private var statusText: String {
        let n = run.tools.count
        let toolsPart = n > 0 ? "· \(n) tool\(n > 1 ? "s" : "")" : ""
        return [run.model, toolsPart].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
    }
}

// The agent viewer (spec §1 #6): prompt bubble + inner ToolItemViews + serif result. av-prompt-bubble /
// av-output-bubble: surface fill, r=10, pad 12×14, text-base fg-dim.
struct AgentViewerSheet: View {
    let run: AgentRun
    @Environment(\.dismiss) private var dismiss
    @EnvironmentObject private var model: AppModel
    // Inner tool cards' file affordances present HERE (a second sheet can't stack on the
    // conversation's host while this one is up).
    @State private var viewedFile: ViewedFile?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: EosSpacing.md) {
                    if !run.prompt.isEmpty { promptBubble }
                    if !run.tools.isEmpty {
                        VStack(alignment: .leading, spacing: 0) {
                            ForEach(run.tools) { ToolItemView(tool: $0) }
                        }
                    }
                    if let result = run.result, !result.isEmpty { resultBubble(result) }
                }
                .padding(EosSpacing.screenInset)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(EosColor.bg)
            .navigationTitle(run.description.isEmpty ? "Agent" : run.description)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .environment(\.openFile) { viewedFile = ViewedFile(path: $0) }
        .sheet(item: $viewedFile) { file in
            FileViewerSheet(path: file.path).environmentObject(model)
        }
    }

    private var promptBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Prompt").font(EosFont.captionSmall).fontWeight(.semibold)
                .foregroundStyle(EosColor.inkTertiary).textCase(.uppercase)
            Text(run.prompt)
                .font(EosFont.body).foregroundStyle(EosColor.inkSecondary)     // text-base fg-dim (§10)
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 12)               // pad 12×14 (§10)
                .background(EosColor.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }

    // The result renders in serif prose (§1 #6 "serif result").
    private func resultBubble(_ result: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Result").font(EosFont.captionSmall).fontWeight(.semibold)
                .foregroundStyle(EosColor.inkTertiary).textCase(.uppercase)
            MarkdownView(source: result)
                .padding(.horizontal, 14).padding(.vertical, 12)
                .background(EosColor.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}
