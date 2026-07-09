import SwiftUI
import EosRemoteKit

// The tool-view descriptor + the `getToolView(name)` registry (spec 03 §2, port of toolViews.jsx VIEWS).
// A descriptor supplies the header label (done + running), an optional dim arg-summary, an optional
// file-chip path / AgentLink, an optional diff-stats chip, whether it expands, and the detail body.
// BASE = "Used {humanized}" + GenericToolCard; FALLBACK = BASE + argsSummary. ANY tool not registered
// resolves to FALLBACK — so every unknown MCP tool still renders "what it acted on" + the generic card.

struct HeaderBadge: Equatable { let text: String; let fg: Color; let bg: Color }

struct ToolDescriptor {
    // (verb, file) for the collapsed header — done vs. running variants.
    var label: (Tool) -> (verb: String, file: String)
    var runningLabel: (Tool) -> (verb: String, file: String)
    var summary: (Tool) -> String?          // dim args hint after the file
    var filePath: (Tool) -> String?         // makes `file` a tappable file chip
    var agentRef: (Tool) -> AgentRef?       // makes `file` a tappable AgentLink
    var headerBadge: (Tool) -> HeaderBadge? // right-edge pill
    var stats: (Tool) -> (add: Int, del: Int)?  // +add/-del chip
    var expandable: (Tool) -> Bool
    var detail: (Tool) -> AnyView

    init(label: @escaping (Tool) -> (verb: String, file: String),
         runningLabel: ((Tool) -> (verb: String, file: String))? = nil,
         summary: @escaping (Tool) -> String? = { _ in nil },
         filePath: @escaping (Tool) -> String? = { _ in nil },
         agentRef: @escaping (Tool) -> AgentRef? = { _ in nil },
         headerBadge: @escaping (Tool) -> HeaderBadge? = { _ in nil },
         stats: @escaping (Tool) -> (add: Int, del: Int)? = { _ in nil },
         expandable: @escaping (Tool) -> Bool = { _ in true },
         detail: @escaping (Tool) -> AnyView) {
        self.label = label
        self.runningLabel = runningLabel ?? label
        self.summary = summary; self.filePath = filePath; self.agentRef = agentRef
        self.headerBadge = headerBadge; self.stats = stats; self.expandable = expandable; self.detail = detail
    }
}

// The Tier-1 registry. Read/Edit/MultiEdit/Write/Bash get bespoke labels + detail bodies; everything
// else falls to the generic FALLBACK descriptor.
func getToolView(_ name: String) -> ToolDescriptor {
    switch name {
    case "Read":      return readDescriptor()
    case "Edit":      return editDescriptor()
    case "MultiEdit": return multiEditDescriptor()
    case "Write":     return writeDescriptor()
    case "Bash":      return bashDescriptor()
    default:          return fallbackDescriptor()
    }
}

// MARK: - descriptors

private func readDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in
        let path = filePathOf(t)
        // A read of a SKILL.md → "{skill} SKILL" (§2.1).
        if path.hasSuffix("SKILL.md") {
            let skill = (path as NSString).deletingLastPathComponent
            return ("Read", "\((skill as NSString).lastPathComponent) SKILL")
        }
        return ("Read", basename(path))
    },
    runningLabel: { t in ("Reading", basename(filePathOf(t))) },
    filePath: { t in filePathOf(t).isEmpty ? nil : filePathOf(t) },
    detail: { AnyView(ReadDetailView(tool: $0)) }) }

private func editDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Edit", basename(filePathOf(t))) },
    runningLabel: { t in ("Editing", basename(filePathOf(t))) },
    filePath: { t in filePathOf(t).isEmpty ? nil : filePathOf(t) },
    stats: { editDiffStats($0) },
    detail: { AnyView(EditDetailView(tool: $0)) }) }

private func multiEditDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Edit", basename(filePathOf(t))) },
    runningLabel: { t in ("Editing", basename(filePathOf(t))) },
    filePath: { t in filePathOf(t).isEmpty ? nil : filePathOf(t) },
    stats: { multiEditDiffStats($0) },
    detail: { AnyView(MultiEditDetailView(tool: $0)) }) }

private func writeDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Write", basename(filePathOf(t))) },
    runningLabel: { t in ("Writing", basename(filePathOf(t))) },
    filePath: { t in filePathOf(t).isEmpty ? nil : filePathOf(t) },
    detail: { AnyView(WriteDetailView(tool: $0)) }) }

// Bash — git-aware done label ("Committed {sha}", "Pushed", "Viewed 2 diffs") else "Ran {cmd≤60}".
private func bashDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("", bashLabel(t)) },
    runningLabel: { t in ("", "Running \(clampCmd(commandOf(t)))") },
    detail: { AnyView(BashDetailView(tool: $0)) }) }

// FALLBACK — "Used {humanized}" + argsSummary; GenericToolCard body. Expandable only when there's a
// body to show (params/output/failure).
private func fallbackDescriptor() -> ToolDescriptor { ToolDescriptor(
    label: { t in ("Used", humanizeToolName(t.name)) },
    runningLabel: { t in ("Running", humanizeToolName(t.name)) },
    summary: { argsSummary($0.input) },
    expandable: { t in
        (t.input.objectValue?.isEmpty == false) || (t.result?.text.isEmpty == false) || failureKind(t) != nil
    },
    detail: { AnyView(GenericToolCardView(tool: $0)) }) }

// MARK: - label helpers (bashLabel / humanizeToolName / argsSummary are pure → kit's ToolViewModel)

func filePathOf(_ tool: Tool) -> String {
    tool.input["file_path"]?.stringValue ?? tool.input["path"]?.stringValue ?? ""
}
private func commandOf(_ tool: Tool) -> String { tool.input["command"]?.stringValue ?? "" }
private func clampCmd(_ cmd: String) -> String { cmd.count > 60 ? String(cmd.prefix(60)) + "…" : cmd }
