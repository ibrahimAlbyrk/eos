import Foundation

// Git verb detection + group summaries (spec 03 §4.7, port of messageParser.js). Bash rows get
// git-aware labels ("Committed {sha}", "Pushed", "Viewed 2 diffs") and toolGroup summaries count git
// verbs. buildSummary (generic lane) / buildWorkerSummary (worker lane) produce the group strings.

let GIT_VERBS: [String: String] = [
    "commit": "Committed", "push": "Pushed", "pull": "Pulled", "merge": "Merged",
    "rebase": "Rebased", "fetch": "Fetched", "clone": "Cloned", "checkout": "Checked out",
    "switch": "Switched to", "stash": "Stashed", "cherry-pick": "Cherry-picked",
    "revert": "Reverted", "reset": "Reset", "restore": "Restored", "tag": "Tagged",
    "add": "Staged", "diff": "Viewed diff", "apply": "Applied", "am": "Applied",
]

// Matches `git [global flags] <subcommand> <rest until ; & |>` outside quoted strings.
private let gitCmdRe = try! NSRegularExpression(
    pattern: "\\bgit\\s+(?:-[cC]\\s+\\S+\\s+|--?[\\w-]+(?:=\\S+)?\\s+)*([a-z][\\w-]*)([^;&|]*)")
private let quotedRe = try! NSRegularExpression(pattern: "\"(?:[^\"\\\\]|\\\\.)*\"|'[^']*'")
private let flagRe = try! NSRegularExpression(pattern: "--?[\\w-]+(?:=\\S+)?")
private let redirRe = try! NSRegularExpression(pattern: "\\S*[<>]\\S*")
private let shaRe = try! NSRegularExpression(pattern: "\\[[^\\]\\n]*\\b([0-9a-f]{7,40})\\]")

public struct GitAction: Sendable, Equatable {
    public let sub: String
    public let verb: String
    public let detail: String
    public var shas: [String]?
    public init(sub: String, verb: String, detail: String, shas: [String]? = nil) {
        self.sub = sub; self.verb = verb; self.detail = detail; self.shas = shas
    }
}

private func replaceAll(_ re: NSRegularExpression, in s: String, with template: String) -> String {
    let ns = s as NSString
    return re.stringByReplacingMatches(in: s, range: NSRange(location: 0, length: ns.length), withTemplate: template)
}

public func gitActions(_ tool: Tool) -> [GitAction] {
    guard tool.name == "Bash", tool.result?.isError != true else { return [] }
    let command = tool.input["command"]?.stringValue ?? ""
    // Blank out quoted strings so a git word inside a message isn't matched.
    let cmd = replaceAll(quotedRe, in: command, with: "\"\"")
    var actions: [GitAction] = []
    let ns = cmd as NSString
    for m in gitCmdRe.matches(in: cmd, range: NSRange(location: 0, length: ns.length)) {
        let sub = ns.substring(with: m.range(at: 1))
        guard let verb = GIT_VERBS[sub] else { continue }
        var detail = ns.substring(with: m.range(at: 2))
        detail = replaceAll(flagRe, in: detail, with: "")
        detail = replaceAll(redirRe, in: detail, with: "")
        detail = detail.replacingOccurrences(of: "\"\"", with: "")
        detail = detail.trimmingCharacters(in: .whitespaces)
        detail = String(detail.prefix(60))
        actions.append(GitAction(sub: sub, verb: verb, detail: detail))
    }
    if actions.contains(where: { $0.sub == "commit" }) {
        let text = tool.result?.text ?? ""
        let tns = text as NSString
        let shas = shaRe.matches(in: text, range: NSRange(location: 0, length: tns.length))
            .map { tns.substring(with: $0.range(at: 1)) }
        for i in actions.indices where actions[i].sub == "commit" { actions[i].shas = shas }
    }
    return actions
}

public func gitVerbLabel(_ verb: String, _ n: Int) -> String {
    if n == 1 { return verb }
    if verb == "Viewed diff" { return "Viewed \(n) diffs" }
    return "\(verb) ×\(n)"
}

public func buildSummary(_ tools: [Tool]) -> String {
    var reads = 0, edits = 0, skills = 0, notifies = 0, webSearches = 0, webFetches = 0, shells = 0, others = 0
    var gitVerbs: [(verb: String, n: Int)] = []
    var commitShas: [String] = []
    for t in tools {
        if t.name == "Read" { reads += 1 }
        else if t.verb == "edit" { edits += 1 }
        else if t.name == "Skill" { skills += 1 }
        else if t.name == "WebSearch" { webSearches += 1 }
        else if t.name == "WebFetch" { webFetches += 1 }
        else if t.name == "mcp__orchestrator__notify_user" { notifies += 1 }
        else if t.name == "Bash" {
            let actions = gitActions(t)
            if actions.isEmpty { shells += 1; continue }
            for a in actions {
                if a.sub == "commit" { commitShas.append(contentsOf: a.shas ?? []) }
                if let idx = gitVerbs.firstIndex(where: { $0.verb == a.verb }) { gitVerbs[idx].n += 1 }
                else { gitVerbs.append((verb: a.verb, n: 1)) }
            }
        }
        else { others += 1 }
    }
    var parts: [String] = []
    if reads > 0 { parts.append("Read \(reads) file\(reads > 1 ? "s" : "")") }
    if edits > 0 { parts.append("Edited \(edits) file\(edits > 1 ? "s" : "")") }
    if skills > 0 { parts.append("Used \(skills) skill\(skills > 1 ? "s" : "")") }
    if webSearches > 0 { parts.append("Searched the web\(webSearches > 1 ? " ×\(webSearches)" : "")") }
    if webFetches > 0 { parts.append("Fetched \(webFetches) page\(webFetches > 1 ? "s" : "")") }
    if notifies > 0 { parts.append("Notified user") }
    for (verb, n) in gitVerbs {
        if verb == "Committed" && !commitShas.isEmpty { parts.append("Committed \(commitShas.joined(separator: ", "))") }
        else { parts.append(gitVerbLabel(verb, n)) }
    }
    if shells > 0 { parts.append("ran \(shells) shell command\(shells > 1 ? "s" : "")") }
    if others > 0 { parts.append("used \(others) tool\(others > 1 ? "s" : "")") }
    return parts.joined(separator: ", ")
}

// Per-tool counts in first-appearance order; only the first part keeps its capitalized verb
// ("Spawned 2 workers, killed 1 worker").
public func buildWorkerSummary(_ tools: [Tool]) -> String {
    var order: [String] = []
    var counts: [String: Int] = [:]
    for t in tools {
        if counts[t.name] == nil { order.append(t.name) }
        counts[t.name, default: 0] += 1
    }
    var parts: [String] = []
    for name in order {
        guard let spec = WORKER_TOOL_SPECS[name] else { continue }
        let phrase = spec.summary(counts[name] ?? 0)
        if parts.isEmpty { parts.append(phrase) }
        else { parts.append(phrase.prefix(1).lowercased() + phrase.dropFirst()) }
    }
    return parts.joined(separator: ", ")
}

public func verbFor(_ name: String?) -> String {
    let n = (name ?? "").lowercased()
    if n.contains("bash") { return "bash" }
    if n.contains("edit") || n.contains("write") { return "edit" }
    return "read"
}

// Tools that never merge into a toolGroup — always standalone (spec 03 §4.4). "Agent" is here for the
// live hook-only window (mid-turn it only exists as a tool_running event).
let STANDALONE_TOOLS: Set<String> = [
    "Agent", "AskUserQuestion", "Skill", "EnterPlanMode", "ExitPlanMode",
    "mcp__orchestrator__notify_user", "mcp__worker__send_message_to_parent",
]

// Grouping lane: STANDALONE → nil (never groups), worker-tool → .worker, else .generic.
func laneOf(_ name: String) -> Block.Lane? {
    if STANDALONE_TOOLS.contains(name) { return nil }
    if isWorkerToolName(name) { return .worker }
    return .generic
}

func summarizeLane(_ lane: Block.Lane, _ tools: [Tool]) -> String {
    switch lane {
    case .generic: return buildSummary(tools)
    case .worker: return buildWorkerSummary(tools)
    }
}
