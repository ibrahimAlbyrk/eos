import Foundation

// A Page's button on the phone (05 Q10, 07 §4.8): the document route writes each button as an
// `eos-action:<issueId>/<button>/<index>` link, with an empty index for a button outside a repeat. The phone intercepts it, asks the user natively,
// and sends it to `POST /api/actions/run`, where the Mac's gate and the phone's tier decide.
public struct EosAction: Equatable, Sendable {
    public let issueId: String
    public let button: String
    /// The item of the repeat the button sits in; nil outside a repeat.
    public let index: Int?

    public init(issueId: String, button: String, index: Int?) {
        self.issueId = issueId; self.button = button; self.index = index
    }

    /// The button an `eos-action:` link names; nil for any other link.
    public static func parse(_ url: URL) -> EosAction? {
        guard url.scheme == "eos-action" else { return nil }
        let rest = url.absoluteString.dropFirst("eos-action:".count)
        let parts = rest.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard parts.count == 3, !parts[0].isEmpty, !parts[1].isEmpty,
              let issue = parts[0].removingPercentEncoding, let button = parts[1].removingPercentEncoding
        else { return nil }
        var index: Int?
        if !parts[2].isEmpty {
            guard let n = Int(parts[2]), n >= 0 else { return nil }
            index = n
        }
        return EosAction(issueId: issue, button: button, index: index)
    }

    /// The request; `confirm` and `typed` repeat it after Eos's own confirmation.
    public func request(clientId: String, confirm: String? = nil, typed: String? = nil) -> JSONValue {
        var body: [String: JSONValue] = [
            "issueId": .string(issueId),
            "button": .string(button),
            "clientId": .string(clientId),
        ]
        if let index { body["index"] = .number(Double(index)) }
        if let confirm { body["confirm"] = .string(confirm) }
        if let typed { body["typed"] = .string(typed) }
        return .object(body)
    }
}

/// What `POST /api/actions/run` answers.
public enum EosActionAnswer: Equatable, Sendable {
    case done
    /// Eos asks again in its own words; the repeat carries `token`, and the name typed when asked.
    case confirm(token: String, prompt: String, typeToConfirm: String?)
    /// Waits in Needs you.
    case held(itemId: String)
    case refused(String)

    public init(_ body: JSONValue?) {
        switch body?["status"]?.stringValue {
        case "done": self = .done
        case "confirm":
            self = .confirm(token: body?["token"]?.stringValue ?? "", prompt: body?["prompt"]?.stringValue ?? "",
                            typeToConfirm: body?["typeToConfirm"]?.stringValue)
        case "held": self = .held(itemId: body?["itemId"]?.stringValue ?? "")
        case "refused": self = .refused(body?["reason"]?.stringValue ?? "Refused.")
        default: self = .refused(body?["error"]?.stringValue ?? "The Mac refused it.")
        }
    }
}
