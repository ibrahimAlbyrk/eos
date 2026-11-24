import Foundation

// What the share sheet hands Eos (07 §4.8): a web page's link or a text. Someone else wrote it, so
// it is outside text wherever it goes: the item is untrusted, and the run's door is `phone_share`,
// which the Mac marks as outside too.
public struct SharedThing: Equatable, Sendable {
    /// The door a run started from the share sheet names.
    public static let door = "phone_share"
    /// The longest value the Mac's match read takes (eos-contracts `INTENT_TEXT_MAX`).
    public static let matchMax = 2_000

    public let item: EosItem

    /// A link when one was shared or the text is one; else the text. Nothing when both are empty.
    public static func of(url: URL?, text: String?, title: String?) -> SharedThing? {
        let title = title?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        if let url, let scheme = url.scheme?.lowercased(), ["http", "https"].contains(scheme) {
            return SharedThing(item: EosItem(kind: "link", title: title, url: url.absoluteString, untrusted: true))
        }
        guard let typed = text.flatMap(EosItem.typed) else { return nil }
        var item = typed
        item.untrusted = true
        item.title = title
        return SharedThing(item: item)
    }

    /// What the match read and the patterns look at.
    public var value: String { String((item.url ?? item.text ?? "").prefix(Self.matchMax)) }

    /// `POST /api/routines/match-item`.
    public var matchRequest: JSONValue {
        .object(["item": .object(["kind": .string(item.kind), "value": .string(value)])])
    }

    /// The routines the Mac's match read named, in its order: the ones of `routines` it chose to run.
    public static func matched(_ answer: JSONValue?, among routines: [EosRoutine]) -> [EosRoutine]? {
        guard let choices = answer?["choices"]?.arrayValue else { return nil }
        let ids = choices.filter { $0["intent"]?.stringValue == "run" }.compactMap { $0["routineId"]?.stringValue }
        return ids.compactMap { id in routines.first { $0.id == id } }
    }

    /// With the Mac away, from the routines last read: those that take this kind, or whose patterns
    /// recognise its value, as the Mac's match read decides. The Mac checks the start again.
    public func offlineMatches(_ routines: [EosRoutine]) -> [EosRoutine] {
        let value = self.value
        return routines.filter { routine in
            routine.takes.kind == item.kind || (routine.takes.itemPatterns ?? []).contains { pattern in
                guard let re = try? NSRegularExpression(pattern: pattern) else { return false }
                return re.firstMatch(in: value, range: NSRange(value.startIndex..., in: value)) != nil
            }
        }
    }

    /// `POST /api/runs` for `routine` on this, with its note, as usual.
    public func start(_ routine: EosRoutine, note: String?, requestId: String) -> JSONValue {
        EosRequests.startRun(routineId: routine.id, item: item, options: [:], note: note, showOnly: false,
                             requestId: requestId, door: Self.door)
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
