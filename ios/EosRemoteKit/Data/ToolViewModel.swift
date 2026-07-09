import Foundation

// Pure header-label + diff-stat helpers for the tool chrome (spec 03 §2/§5.3, port of the non-JSX
// parts of toolViews.jsx). These are UI-agnostic (Tool/JSONValue only), so they live in the kit and are
// unit-tested; the SwiftUI ToolItemView/registry consume them. Diff-stat counts feed the +add/-del
// header chip (singleEditStats/multiEditStats); the label helpers drive the Bash git-aware label and
// the FALLBACK "Used {name}" + argsSummary hint.

// The diff hunks for an Edit: result.patch (absolute line #s) preferred, else LCS of old/new (relative).
public func editHunks(_ tool: Tool) -> [DiffHunk] {
    if let patch = tool.result?.patch {
        let hunks = patchToHunks(patch)
        if !hunks.isEmpty { return hunks }
    }
    return buildDiffHunks(splitToolLines(tool.input["old_string"]?.stringValue ?? ""),
                          splitToolLines(tool.input["new_string"]?.stringValue ?? ""))
}

// add/del counts across an Edit's hunks → the header +add/-del chip. nil when there's nothing to show.
public func editDiffStats(_ tool: Tool) -> (add: Int, del: Int)? {
    countHunks(editHunks(tool))
}

// add/del summed across a MultiEdit: patch-wide if present, else per-edit in edits[].
public func multiEditDiffStats(_ tool: Tool) -> (add: Int, del: Int)? {
    if let patch = tool.result?.patch {
        let hunks = patchToHunks(patch)
        if !hunks.isEmpty { return countHunks(hunks) }
    }
    var add = 0, del = 0
    for edit in tool.input["edits"]?.arrayValue ?? [] {
        let hunks = buildDiffHunks(splitToolLines(edit["old_string"]?.stringValue ?? ""),
                                   splitToolLines(edit["new_string"]?.stringValue ?? ""))
        add += hunks.filter { $0.type == .add }.count
        del += hunks.filter { $0.type == .del }.count
    }
    return (add == 0 && del == 0) ? nil : (add, del)
}

private func countHunks(_ hunks: [DiffHunk]) -> (add: Int, del: Int)? {
    guard !hunks.isEmpty else { return nil }
    let add = hunks.filter { $0.type == .add }.count
    let del = hunks.filter { $0.type == .del }.count
    return (add == 0 && del == 0) ? nil : (add, del)
}

public func splitToolLines(_ s: String) -> [String] { s.components(separatedBy: "\n") }
public func clampText(_ s: String, _ n: Int) -> String { s.count > n ? String(s.prefix(n)) : s }
private func clampCommand(_ cmd: String) -> String { cmd.count > 60 ? String(cmd.prefix(60)) + "…" : cmd }

// Git-aware Bash label (§2.1/§4.7): the first git verb + its detail/shas, else "Ran {cmd≤60}".
public func bashLabel(_ tool: Tool) -> String {
    let actions = gitActions(tool)
    if let a = actions.first {
        if a.sub == "commit", let shas = a.shas, !shas.isEmpty { return "Committed \(shas.joined(separator: ", "))" }
        let n = actions.filter { $0.verb == a.verb }.count
        let label = gitVerbLabel(a.verb, n)
        return a.detail.isEmpty ? label : "\(label) \(a.detail)"
    }
    return "Ran \(clampCommand(tool.input["command"]?.stringValue ?? ""))"
}

// Humanize an MCP/tool name for the FALLBACK header ("mcp__orchestrator__spawn_worker" → "spawn worker").
public func humanizeToolName(_ name: String) -> String {
    if name.hasPrefix("mcp__"), let last = name.components(separatedBy: "__").last {
        return last.replacingOccurrences(of: "_", with: " ")
    }
    return name
}

// A one-line dim args hint for the FALLBACK header (argsSummary): a descriptive scalar param, or the
// first scalar, clamped to one line.
public func argsSummary(_ input: JSONValue) -> String? {
    guard let obj = input.objectValue, !obj.isEmpty else { return nil }
    for key in ["query", "pattern", "prompt", "name", "url", "command", "path", "file_path"] {
        if let v = obj[key]?.stringValue, !v.isEmpty { return clampText(v.replacingOccurrences(of: "\n", with: " "), 80) }
    }
    for (_, v) in obj.sorted(by: { $0.key < $1.key }) {
        if let s = v.stringValue, !s.isEmpty { return clampText(s.replacingOccurrences(of: "\n", with: " "), 80) }
    }
    return nil
}
