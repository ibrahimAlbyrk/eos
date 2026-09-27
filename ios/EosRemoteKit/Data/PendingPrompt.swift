import Foundation

// The Claude Code dialog a claude pane is blocked on: an AskUserQuestion the phone can answer, or an
// ExitPlanMode plan it can approve (POST /pty/:id/answer). Read from the conversation response's
// `pending: {toolUseId, name, input} | null`, not the rows — Claude Code may write the tool_use to
// its transcript only after the question is answered.
public enum PendingPrompt: Equatable, Sendable {
    case questions(toolUseId: String, [PendingQuestion])
    case plan(toolUseId: String, markdown: String)

    public var toolUseId: String {
        switch self {
        case .questions(let id, _), .plan(let id, _): return id
        }
    }

    public init?(pending: JSONValue?) {
        guard let pending, let id = pending["toolUseId"]?.stringValue else { return nil }
        let input = pending["input"] ?? .object([:])
        switch pending["name"]?.stringValue {
        case "ExitPlanMode":
            self = .plan(toolUseId: id, markdown: input["plan"]?.stringValue ?? "")
        case "AskUserQuestion":
            let questions = (input["questions"]?.arrayValue ?? []).compactMap(PendingQuestion.init(raw:))
            guard !questions.isEmpty else { return nil }
            self = .questions(toolUseId: id, questions)
        default:
            return nil
        }
    }
}

// One AskUserQuestion entry: `{header, question, multiSelect, options:[{label, description}]}`.
public struct PendingQuestion: Equatable, Sendable {
    public struct Option: Equatable, Sendable {
        public let label: String
        public let description: String?
    }

    public let header: String?
    public let question: String
    public let multiSelect: Bool
    public let options: [Option]
}

extension PendingQuestion {
    init?(raw: JSONValue) {
        guard let question = raw["question"]?.stringValue else { return nil }
        self.question = question
        header = raw["header"]?.stringValue
        multiSelect = raw["multiSelect"]?.boolValue ?? false
        options = (raw["options"]?.arrayValue ?? []).compactMap { o in
            o["label"]?.stringValue.map { Option(label: $0, description: o["description"]?.stringValue) }
        }
    }
}

// One `answers` entry of POST /pty/:id/answer, per question in order. Free text is single-select only.
public enum PendingAnswer: Equatable, Sendable {
    case options([Int])   // 0-based option indices; exactly one for single-select
    case text(String)     // the "Other" free-text answer

    public var json: JSONValue {
        switch self {
        case .options(let indices): return .object(["options": .array(indices.map { .number(Double($0)) })])
        case .text(let text): return .object(["text": .string(text)])
        }
    }
}
