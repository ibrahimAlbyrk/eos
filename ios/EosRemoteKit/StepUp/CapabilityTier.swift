import Foundation

// Capability tiers (§8): the UI consults this to decide whether a control needs SE step-up and
// whether a route is reachable remotely at all. REFUSED routes are never sent. The daemon is the
// authority — this is a client-side mirror to avoid pointless round-trips and gate the UI.
public enum CapabilityTier: Sendable { case read, low, high, refused }

public enum RouteTier {
    // method+path → tier. Path matching is by template with `:id`-style segments wildcarded.
    public static func tier(method: String, path: String) -> CapabilityTier {
        let m = method.uppercased()
        let p = normalize(path)

        if refused.contains(where: { $0.matches(m, p) }) { return .refused }
        if high.contains(where: { $0.matches(m, p) }) { return .high }
        if low.contains(where: { $0.matches(m, p) }) { return .low }
        if m == "GET" { return .read }   // remaining GETs are reads (§8.1)
        return .high                      // unknown mutation → fail safe to step-up
    }

    private struct Pattern { let method: String; let segments: [String]
        func matches(_ m: String, _ path: String) -> Bool {
            guard method == m else { return false }
            let ps = path.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
            guard ps.count == segments.count else { return false }
            for (a, b) in zip(segments, ps) where a != "*" && a != b { return false }
            return true
        }
    }
    private static func pat(_ m: String, _ p: String) -> Pattern {
        Pattern(method: m, segments: p.split(separator: "/", omittingEmptySubsequences: true).map(String.init))
    }
    private static func normalize(_ p: String) -> String { p.split(separator: "?").first.map(String.init) ?? p }

    // §8.4 — never remote.
    private static let refused: [Pattern] = [
        pat("POST", "/workers/*/events"), pat("POST", "/policy/decide"),
        pat("POST", "/workers/*/question"), pat("GET", "/workers/*/question/*"),
        pat("POST", "/workers/*/peer-request"), pat("GET", "/workers/*/peer-request/*"),
        pat("POST", "/workers/*/peer-response"), pat("POST", "/workers/*/report"),
        pat("POST", "/workers/*/keystroke"), pat("GET", "/pick-directory"), pat("GET", "/pick-file"),
        pat("GET", "/stream"), pat("GET", "/fs/raw/*"),
    ]
    // §8.3 — per-action SE step-up (representative RCE / externally-visible verbs).
    private static let high: [Pattern] = [
        pat("POST", "/workers"), pat("POST", "/orchestrators"), pat("DELETE", "/workers/*"),
        pat("POST", "/workers/*/terminal"), pat("POST", "/terminal"), pat("POST", "/terminal/*/kill"),
        pat("POST", "/workers/*/action"), pat("POST", "/workers/*/push"), pat("POST", "/workers/*/pull"),
        pat("POST", "/pending/*/decision"), pat("PUT", "/workers/*/permission"), pat("PUT", "/workers/*/backend"),
        pat("POST", "/workers/*/open"), pat("POST", "/fs/open"), pat("POST", "/fs/reveal"),
        pat("POST", "/workers/*/rewind"), pat("POST", "/workers/*/try"),
        pat("POST", "/orchestrators/*/integrate"), pat("POST", "/workers/*/changes/discard"),
        pat("DELETE", "/workers/*/memory/*"), pat("PUT", "/api/settings"), pat("POST", "/api/policy/rule"),
    ]
    // §8.2 — non-RCE mutations, no step-up.
    private static let low: [Pattern] = [
        pat("POST", "/workers/*/message"), pat("POST", "/workers/*/question-answer"),
        pat("POST", "/workers/*/interrupt"), pat("POST", "/workers/*/resume"),
        pat("POST", "/workers/*/notify"), pat("POST", "/orchestrators/*/message"),
        pat("POST", "/orchestrators/*/loop"), pat("POST", "/loop/stop"),
        pat("DELETE", "/workers/*/queue/*"), pat("PUT", "/workers/*/name"),
        pat("PUT", "/workers/*/rename-intent"), pat("PUT", "/workers/*/model"),
        pat("POST", "/workers/*/conflicts/resolve"),
    ]
}
