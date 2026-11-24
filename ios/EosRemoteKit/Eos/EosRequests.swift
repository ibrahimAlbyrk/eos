import Foundation

// The requests the Eos tab sends, built the way the Mac's run form builds them (01's start route),
// so the same rules apply wherever a run starts.
public enum EosRequests {
    /// `POST /api/runs`: one run of `routine` on `item` (or none), with the options set here (an
    /// option left out takes its default), a note, and where the result goes.
    /// `door` is `phone`, or `link` when an `eos://run/…` link filled the form: the Mac then treats
    /// its item and note as outside text.
    public static func startRun(routineId: String, item: EosItem?, options: [String: JSONValue], note: String?,
                                showOnly: Bool, requestId: String, door: String = "phone") -> JSONValue {
        var input: [String: JSONValue] = [
            "options": .object(options),
            "result": .string(showOnly ? "showOnly" : "usual"),
        ]
        if let item, let encoded = try? JSONValue(encodable: item) { input["item"] = encoded }
        if let note = note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
            input["note"] = .string(note)
        }
        return .object([
            "routineId": .string(routineId),
            "input": .object(input),
            "door": .string(door),
            "clientRequestId": .string(requestId),
        ])
    }

    public static func message(_ text: String) -> JSONValue { .object(["text": .string(text)]) }
}

/// What the Eos tab reads again when the Mac announces a change (cap `eos`).
public enum EosRefresh: Equatable, Sendable {
    case routines
    case inbox
    case run(String)
    case none

    public static func of(topic: String, payload: JSONValue?) -> [EosRefresh] {
        switch topic {
        case "routine:change": return [.routines]
        case "inbox:change": return [.inbox]
        case "run:change":
            // A run's change moves its routine's last run too.
            return [.routines] + (payload?["runId"]?.stringValue.map { [.run($0)] } ?? [])
        case "runs:active": return [.routines]
        default: return [.none]
        }
    }
}

extension JSONValue {
    /// Any `Encodable` as JSON.
    public init(encodable: some Encodable) throws {
        self = try JSONDecoder().decode(JSONValue.self, from: JSONEncoder().encode(encodable))
    }
}
