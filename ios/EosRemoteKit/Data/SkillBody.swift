import Foundation

// The skill body is the SKILL.md content Claude injects on launch, carried in the transcript (the
// only source that works for built-in/plugin skills). It opens with an orienting line ("Base
// directory for this skill: <path>") and may carry the SKILL.md frontmatter. Port of skillBody.js —
// the single owner of that injected format.
public struct ParsedSkillBody: Sendable, Equatable {
    public let path: String?
    public let body: String
}

public func parseSkillBody(_ raw: String?) -> ParsedSkillBody {
    var text = stripFrontmatter(raw ?? "")
    let baseDir = try! NSRegularExpression(pattern: "^Base directory for this skill: (.*)\\r?\\n+")
    let ns = text as NSString
    var path: String? = nil
    if let m = baseDir.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)) {
        path = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
        text = stripFrontmatter((text as NSString).substring(from: m.range.location + m.range.length))
    }
    return ParsedSkillBody(path: (path?.isEmpty == true) ? nil : path, body: text)
}

private func stripFrontmatter(_ text: String) -> String {
    let fm = try! NSRegularExpression(pattern: "^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?")
    let ns = text as NSString
    var out = text
    if let m = fm.firstMatch(in: text, range: NSRange(location: 0, length: ns.length)), m.range.location == 0 {
        out = ns.substring(from: m.range.length)
    }
    // .replace(/^\s*\n+/, "")
    if let lead = out.range(of: "^\\s*\\n+", options: .regularExpression) {
        out = String(out[lead.upperBound...])
    }
    return out
}
