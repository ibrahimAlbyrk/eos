import Foundation

// A draft's result (eos-contracts `ResultDoc`): its parts as the phone edits them in place where
// the kind allows. A Page issue is edited on its page, never in parts.
public struct ResultPart: Codable, Sendable, Equatable, Identifiable {
    public let key: String
    /// `summary`, `comment`, `paragraph`, …
    public let role: String
    public var text: String
    public let meta: [String: JSONValue]?
    public var id: String { key }
}

public struct ResultDocument: Codable, Sendable, Equatable {
    public let kind: String
    public let channel: String
    public let action: String
    public var parts: [ResultPart]

    /// The kind a Page issue's draft has; its parts are not edited here.
    public static let pageIssue = "page.issue"

    public var editable: Bool { kind != Self.pageIssue }

    /// A part the user may take out (a review's line comment); the rest only change their text.
    public static func removable(_ part: ResultPart) -> Bool { part.role == "comment" }

    /// The draft a Needs-you item holds: the user's saved edits, else the result as it was held.
    public static func of(detail: JSONValue?) -> ResultDocument? {
        guard let source = detail?["working"] ?? detail?["payload"]?["doc"],
              let data = try? JSONEncoder().encode(source) else { return nil }
        return try? JSONDecoder().decode(ResultDocument.self, from: data)
    }
}
