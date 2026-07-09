import SwiftUI
import EosRemoteKit

// User-interaction + misc harness detail bodies (spec 03 §2.2/§2.6, port of the Ask/Notify/Skill/
// Datetime/ToolSearch/ScheduleWakeup/TaskOutput entries in ToolDetail.jsx). These are the standalone /
// low-frequency tools whose Detail is a small purpose-built card.

// MARK: - §2.2 AskUserQuestion (folded answers from the trailing "My answers…" user message)

// Q→A list; each question's answer parsed from a following "My answers…"/"…have been answered…" user
// message (§4.8, folded by the parser into the tool's result text).
struct AskUserQuestionDetailView: View {
    let tool: Tool
    private var questions: [String] {
        (tool.input["questions"]?.arrayValue ?? []).map {
            $0["question"]?.stringValue ?? $0["text"]?.stringValue ?? $0.stringValue ?? ""
        }
    }
    var body: some View {
        let answers = parseAskAnswers(questions, tool.result?.text)
        ToolQAView(items: questions.enumerated().map { i, q in
            .init(question: q, answer: i < answers.count ? answers[i] : nil)
        })
    }
}

// MARK: - §2.2 ask_user (orchestrator MCP — answers from the tool's own JSON)

// Same Q→A chrome; answers from the tool's own JSON {answers:{question:label}}. A dismissed / stale
// result (non-JSON) shows a plain sentence under the questions.
struct AskUserDetailView: View {
    let tool: Tool
    private var questions: [(question: String, header: String?)] {
        (tool.input["questions"]?.arrayValue ?? []).map {
            ($0["question"]?.stringValue ?? "", $0["header"]?.stringValue)
        }
    }
    private var answers: [String: JSONValue]? {
        guard let res = toolResultJSON(tool), let a = res["answers"]?.objectValue else { return nil }
        return a
    }
    private var resultText: String { tool.result?.text ?? "" }

    var body: some View {
        let ans = answers
        let items = questions.map { q -> ToolQAView.Item in
            let a: JSONValue? = {
                guard let ans else { return nil }
                return ans[q.question] ?? q.header.flatMap { ans[$0] }
            }()
            return .init(question: q.question, answer: answerString(a))
        }
        // Pending marker only while there's no result at all; a non-JSON result renders as the note.
        ToolQAView(items: items,
                   note: (ans == nil && !resultText.isEmpty) ? resultText : nil,
                   showPendingWhenEmpty: resultText.isEmpty)
    }
    private func answerString(_ v: JSONValue?) -> String? {
        guard let v else { return nil }
        if let s = v.stringValue { return s }
        if let arr = v.arrayValue { return arr.compactMap { $0.stringValue }.joined(separator: ", ") }
        return nil
    }
}

// MARK: - §2.2 notify_user (STANDALONE)

// Bell + title + body (the notification the orchestrator surfaced).
struct NotifyDetailView: View {
    let tool: Tool
    private var title: String { tool.input["title"]?.stringValue ?? "" }
    private var bodyText: String { tool.input["body"]?.stringValue ?? "" }
    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let kind = failureKind(tool) { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
            HStack(spacing: 6) {
                Image(systemName: "bell").font(.system(size: 12)).foregroundStyle(EosColor.inkTertiary)  // .nd-bell (§10)
                Text(title).font(EosFont.body).fontWeight(.medium).foregroundStyle(EosColor.ink)         // .nd-title text-base 500 (§10)
            }
            if !bodyText.isEmpty {
                Text(bodyText).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)              // .nd-body fg-dim (§10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, 4)
    }
}

// MARK: - §2.2 Skill (STANDALONE)

// If an injected SKILL.md body parsed → file-path bar (`~`-shortened) + copy + first 5 lines w/ line
// numbers; else fall back to the generic card (the sdk lane has no body).
struct SkillDetailView: View {
    let tool: Tool
    private let previewLimit = 5
    private var parsed: ParsedSkillBody { parseSkillBody(tool.skillBody) }

    var body: some View {
        let body = parsed.body
        let path = tool.skillPath ?? parsed.path
        if body.isEmpty && path == nil {
            GenericToolCardView(tool: tool)          // sdk lane: no injected body → generic
        } else {
            let lines = body.isEmpty ? [] : body.components(separatedBy: "\n").enumerated()
                .map { PreviewLine(num: $0.offset + 1, text: $0.element) }
            ToolBodyCard {
                if let path, !path.isEmpty { FilePathBar(path: tildeShorten(path)) }
                if !lines.isEmpty {
                    CodePreview(lines: lines, limit: previewLimit)
                        .toolSectionSeparator()
                }
            }
        }
    }
}

// MARK: - §2.6 current_datetime

// One line: clock + the result's ready-to-show `formatted` string.
struct DatetimeDetailView: View {
    let tool: Tool
    private var formatted: String {
        guard failureKind(tool) == nil, let res = toolResultJSON(tool) else { return "" }
        return res["formatted"]?.stringValue ?? ""
    }
    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if !formatted.isEmpty {
            HStack(spacing: 6) {
                Image(systemName: "clock").font(.system(size: 12)).foregroundStyle(EosColor.inkTertiary)  // .dt-clock (§10)
                Text(formatted).font(EosFont.code).foregroundStyle(EosColor.ink)                          // .dt-value mono fg (§10)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 4)
        }
    }
}

// MARK: - §2.6 ToolSearch

// "N tools matched" + matched tool-name chips (parsed from the returned <function> blocks).
struct ToolSearchDetailView: View {
    let tool: Tool
    private var names: [String] { failureKind(tool) == nil ? parseToolSearchNames(tool.result?.text) : [] }
    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if !names.isEmpty {
            WdCard {
                VStack(alignment: .leading, spacing: 5) {
                    WdSectionLabel(text: "\(names.count) tool\(names.count == 1 ? "" : "s") matched")
                    WrapRow(items: names) { WdChip(value: $0) }
                }
            }
        }
    }
}

// MARK: - §2.6 ScheduleWakeup

// Reason heading + "in {delay}" chip + clamped wake prompt. Renders from input while running.
struct ScheduleWakeupDetailView: View {
    let tool: Tool
    private var delay: String { formatDelay(tool.input["delaySeconds"]?.doubleValue) }
    private var reason: String? { tool.input["reason"]?.stringValue }
    private var prompt: String? { tool.input["prompt"]?.stringValue }
    private var hasAny: Bool { !delay.isEmpty || reason != nil || prompt != nil }

    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if hasAny {
            WdCard {
                HStack(spacing: 8) {
                    Text(reason ?? "Scheduled wakeup")
                        .font(EosFont.caption).fontWeight(.semibold).foregroundStyle(EosColor.ink)  // .task-subject 600 (§10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if !delay.isEmpty { WdChip(keyLabel: "in", value: delay) }
                }
                if let prompt, !prompt.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        WdSectionLabel(text: "On wake")
                        WdText(text: clip(prompt, 200))
                    }
                }
            }
        }
    }
}

// MARK: - §2.6 TaskOutput

// The captured stdout (≤4000 chars + "+N more").
struct TaskOutputDetailView: View {
    let tool: Tool
    private let cap = 4000
    private var output: String { tool.result?.text ?? "" }
    var body: some View {
        if let kind = failureKind(tool) {
            ToolBodyCard { FailureBanner(kind: kind, text: tool.result?.text ?? "") }
        } else if !output.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            WdCard {
                VStack(alignment: .leading, spacing: 3) {
                    Text(clampText(output, cap))
                        .font(EosFont.code).foregroundStyle(EosColor.inkSecondary).lineSpacing(2)  // .gd-output-text (§10)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    if output.count > cap {
                        Text("+\(output.count - cap) more characters")
                            .font(EosFont.codeSmall).foregroundStyle(EosColor.inkTertiary)
                    }
                }
            }
        }
    }
}
