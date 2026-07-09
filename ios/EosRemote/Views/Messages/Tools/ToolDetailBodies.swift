import SwiftUI
import EosRemoteKit

// The core tool detail bodies (spec 03 §2.1, §2.7). Each is the expanded body a ToolItemView shows
// under its header. Read/Write preview source lines; Edit/MultiEdit render diff hunks (§5.8); Bash
// shows the command + output; the generic FALLBACK card renders parameters/output/raw for every
// unregistered tool. Geometry from §10 (tool-detail-bodies).

private let previewLimit = 5   // first 5 source lines (§2.1 Read/Write)
private let outputCap = 4000   // Bash/generic output clamp (§2.1/§2.7)

// Read — file-path bar + first 5 lines with line numbers, heading lines highlighted, "Reading…" while
// running. path from input.file_path; preview from result text (stripCatLineNumbers).
struct ReadDetailView: View {
    let tool: Tool
    var body: some View {
        let path = tool.input["file_path"]?.stringValue ?? tool.input["path"]?.stringValue ?? ""
        let lines = stripCatLineNumbers(tool.result?.text)
        ToolBodyCard {
            if !path.isEmpty { FilePathBar(path: tildeShorten(path)) }
            if !path.isEmpty && (tool.running || !lines.isEmpty) {
                CodePreview(lines: lines, limit: previewLimit, running: tool.running)
                    .toolSectionSeparator()
            }
        }
    }
}

// Write — failure banner + file-path bar + first 5 lines of `content`.
struct WriteDetailView: View {
    let tool: Tool
    var body: some View {
        let path = tool.input["file_path"]?.stringValue ?? ""
        let content = tool.input["content"]?.stringValue ?? ""
        let lines = stripCatLineNumbers(content)
        ToolBodyCard {
            if let kind = failureKind(tool) { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
            if !path.isEmpty { FilePathBar(path: tildeShorten(path)).toolSectionSeparator() }
            if !lines.isEmpty {
                CodePreview(lines: lines, limit: previewLimit).toolSectionSeparator()
            }
        }
    }
}

// Edit — failure banner + filepath + diff hunks. Prefer result.patch (absolute line #s) else LCS of
// old_string/new_string (relative). (§2.1)
struct EditDetailView: View {
    let tool: Tool
    var body: some View {
        let path = tool.input["file_path"]?.stringValue ?? ""
        ToolBodyCard {
            if let kind = failureKind(tool) { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
            if !path.isEmpty { FilePathBar(path: tildeShorten(path)).toolSectionSeparator() }
            let hunks = editHunks(tool)
            if !hunks.isEmpty { DiffHunksView(hunks: hunks).toolSectionSeparator() }
        }
    }
}

// MultiEdit — same as Edit; if result.patch present → one file-wide diff, else one diff block per edit
// in edits[]. (§2.1)
struct MultiEditDetailView: View {
    let tool: Tool
    var body: some View {
        let path = tool.input["file_path"]?.stringValue ?? ""
        ToolBodyCard {
            if let kind = failureKind(tool) { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
            if !path.isEmpty { FilePathBar(path: tildeShorten(path)).toolSectionSeparator() }
            if let patch = tool.result?.patch, !patchToHunks(patch).isEmpty {
                DiffHunksView(hunks: patchToHunks(patch)).toolSectionSeparator()
            } else {
                let edits = tool.input["edits"]?.arrayValue ?? []
                ForEach(Array(edits.enumerated()), id: \.offset) { _, edit in
                    let hunks = buildDiffHunks(splitToolLines(edit["old_string"]?.stringValue ?? ""),
                                               splitToolLines(edit["new_string"]?.stringValue ?? ""))
                    if !hunks.isEmpty { DiffHunksView(hunks: hunks).toolSectionSeparator() }
                }
            }
        }
    }
}

// Bash — "Bash" label + `$`command + output (≤4000, "Running…"/"(no output)") + failure banner. (§2.1)
struct BashDetailView: View {
    let tool: Tool
    var body: some View {
        let command = tool.input["command"]?.stringValue ?? ""
        ToolBodyCard {
            Text("Bash")
                .font(EosFont.caption).fontWeight(.semibold)                       // bash-label 600 (§10)
                .foregroundStyle(EosColor.inkSecondary)
                .padding(.horizontal, 14).padding(.top, 8)
            HStack(alignment: .top, spacing: 6) {
                Text("$").font(EosFont.code).foregroundStyle(EosColor.inkTertiary) // bash-prompt fg-faint (§10)
                Text(command).font(EosFont.code).foregroundStyle(EosColor.State.runningDot) // bash-cmd-text ok (§10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 14).padding(.bottom, 4)
            bashOutput
            if let kind = failureKind(tool) { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        }
    }

    @ViewBuilder private var bashOutput: some View {
        let text = tool.result?.text ?? ""
        if tool.running && text.isEmpty {
            Text("Running…").font(EosFont.code).italic().foregroundStyle(EosColor.inkTertiary)
                .padding(.horizontal, 14).padding(.vertical, 6).toolSectionSeparator()
        } else if !text.isEmpty {
            Text(clampText(text, outputCap))
                .font(EosFont.code).foregroundStyle(EosColor.inkSecondary)         // bash-output fg-dim (§10)
                .lineSpacing(3)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 14).padding(.vertical, 6)                    // bash-output pad 6×14 (§10)
                .toolSectionSeparator()
        }
    }
}

// Generic FALLBACK card (§2.7) — Parameters (key:val rows) + Output + collapsed Raw-payload disclosure,
// each copyable. Renders nothing if empty & not failed. This is what EVERY unregistered tool falls to.
struct GenericToolCardView: View {
    let tool: Tool
    @State private var rawOpen = false

    private var params: [(key: String, value: String)] {
        (tool.input.objectValue ?? [:]).sorted { $0.key < $1.key }.map { (k, v) in (k, scalarOrJSON(v)) }
    }
    private var outputText: String { tool.result?.text ?? "" }
    private var hasContent: Bool { !params.isEmpty || !outputText.isEmpty || failureKind(tool) != nil }

    var body: some View {
        if hasContent {
            ToolBodyCard {
                if !params.isEmpty { paramsSection }
                outputSection
                rawSection
            }
        }
    }

    private var paramsSection: some View {
        VStack(alignment: .leading, spacing: 3) {
            sectionHeader("Parameters", copyText: params.map { "\($0.key): \($0.value)" }.joined(separator: "\n"))
            ForEach(Array(params.enumerated()), id: \.offset) { _, kv in
                Text(paramLine(kv.key, kv.value))
                    .font(EosFont.code)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
    }

    @ViewBuilder private var outputSection: some View {
        if tool.running && outputText.isEmpty {
            Text("Running…").font(EosFont.code).italic().foregroundStyle(EosColor.inkTertiary)
                .padding(.horizontal, 14).padding(.vertical, 10).toolSectionSeparator()
        } else if !outputText.isEmpty {
            VStack(alignment: .leading, spacing: 3) {
                sectionHeader("Output", copyText: outputText)
                Text(clampText(outputText, outputCap))
                    .font(EosFont.code).foregroundStyle(EosColor.inkSecondary)     // gd-output-text fg-dim (§10)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if outputText.count > outputCap {
                    Text("+\(outputText.count - outputCap) more").font(EosFont.codeSmall)
                        .foregroundStyle(EosColor.inkTertiary).opacity(0.6)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10).toolSectionSeparator()
        }
    }

    // Collapsed raw-payload disclosure: full {input,result} JSON ≤8000, copyable (§2.7).
    private var rawSection: some View {
        let raw = rawPayloadJSON(tool)
        return VStack(alignment: .leading, spacing: 3) {
            DisclosureRowView(open: $rawOpen) {
                Text("RAW PAYLOAD").font(EosFont.captionSmall).fontWeight(.bold)
                    .foregroundStyle(EosColor.inkTertiary).textCase(.uppercase)    // gd-section (§10)
            } content: {
                Text(clampText(raw, 8000))
                    .font(EosFont.codeSmall).foregroundStyle(EosColor.inkSecondary)
                    .lineSpacing(2)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                    .textSelection(.enabled)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10).toolSectionSeparator()
    }

    // "key: value" as one attributed run — key fg-dim, value fg semibold (gd-key / gd-val, §10).
    private func paramLine(_ key: String, _ value: String) -> AttributedString {
        var k = AttributedString(key + ": "); k.foregroundColor = EosColor.inkSecondary
        var v = AttributedString(value); v.foregroundColor = EosColor.ink
        v.font = EosFont.code.weight(.semibold)
        return k + v
    }

    private func sectionHeader(_ title: String, copyText: String) -> some View {
        SectionCopyHeader(title: title, copyText: copyText)
    }
}

// The generic-card section header (Parameters / Output): a uppercase caption + a copy button. Kept as
// its own view so the copy button owns per-section `@State` — a shared `.constant(false)` binding would
// freeze it on `doc.on.doc` and never show the §6.5 checkmark.
private struct SectionCopyHeader: View {
    let title: String
    let copyText: String
    @State private var copied = false
    var body: some View {
        HStack {
            Text(title).font(EosFont.captionSmall).fontWeight(.bold)
                .foregroundStyle(EosColor.inkTertiary).textCase(.uppercase)        // gd-section text-xs 700 (§10)
            Spacer(minLength: 0)
            CopyButtonMini(text: copyText, copied: $copied)                        // real checkmark 1.5s (§6.5)
        }
    }
}

// MARK: - app-only render helpers (the pure diff-stat / label helpers live in the kit's ToolViewModel)

// Scalar → inline text; object/array → clamped pretty JSON (the generic Parameters value rule).
func scalarOrJSON(_ v: JSONValue) -> String {
    switch v {
    case .string(let s): return s
    case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
    case .bool(let b): return b ? "true" : "false"
    case .null: return "null"
    default: return clampText(prettyJSON(v), 400)
    }
}

func prettyJSON(_ v: JSONValue) -> String {
    guard let data = try? JSONEncoder.pretty.encode(v), let s = String(data: data, encoding: .utf8) else { return "" }
    return s
}

func rawPayloadJSON(_ tool: Tool) -> String {
    var obj: [String: JSONValue] = ["input": tool.input]
    if let r = tool.result { obj["result"] = .object(["text": .string(r.text), "isError": .bool(r.isError)]) }
    return prettyJSON(.object(obj))
}

extension JSONEncoder {
    static let pretty: JSONEncoder = {
        let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys]; return e
    }()
}
