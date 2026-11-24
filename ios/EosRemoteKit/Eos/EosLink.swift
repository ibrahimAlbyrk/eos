import Foundation

// The `eos://` links for routines (07 §3 G4, §4.8), beside the app's `worker` and `pending`:
// `eos://run/<routine>?item=&note=&show-only=1` fills a run form (it never starts a run),
// `eos://runs/<run-id>` opens a run, `eos://inbox/<item-id>` an item of Needs you (`eos://inbox`
// alone, the list; `?device=` names the paired Mac, as a tapped push does).
public enum EosLink: Equatable, Sendable {
    case runForm(routine: String, item: String?, note: String?, showOnly: Bool)
    case run(String)
    case inbox(item: String?, device: String?)

    public static func parse(_ url: URL) -> EosLink? {
        guard url.scheme == "eos", let host = url.host else { return nil }
        let first = url.pathComponents.dropFirst().first.flatMap { $0.isEmpty ? nil : $0 }
        let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems ?? []
        let value = { (name: String) in query.first { $0.name == name }?.value.flatMap { $0.isEmpty ? nil : $0 } }
        switch host {
        case "run":
            guard let routine = first else { return nil }
            return .runForm(routine: routine, item: value("item"), note: value("note"),
                            showOnly: value("show-only") == "1")
        case "runs":
            return first.map(EosLink.run)
        case "inbox":
            return .inbox(item: first, device: value("device"))
        default:
            return nil
        }
    }
}
