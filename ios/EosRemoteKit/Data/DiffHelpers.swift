import Foundation

// Diff-hunk helpers (spec 03 §5.8, port of diff.jsx). Pure data model + LCS/patch pipelines the
// Phase-4b Edit/MultiEdit renderer consumes. `inlineDiff` returns segment arrays (not JSX) so the
// renderer wraps the changed span in an inline highlight.

// One diff row: a context / deletion / addition line, its (absolute or snippet-relative) line number,
// the text, and — for a paired del/add line — the char-level inline segments.
public struct DiffHunk: Sendable, Equatable {
    public enum Kind: String, Sendable { case ctx, del, add }
    public let type: Kind
    public let num: Int
    public let text: String
    public var segments: [InlineSeg]?
    public init(type: Kind, num: Int, text: String, segments: [InlineSeg]? = nil) {
        self.type = type; self.num = num; self.text = text; self.segments = segments
    }
}

// A char-run of a diff line: `highlighted` marks the word-level changed span (ed-hl-add / ed-hl-del).
public struct InlineSeg: Sendable, Equatable {
    public let text: String
    public let highlighted: Bool
    public init(text: String, highlighted: Bool) { self.text = text; self.highlighted = highlighted }
}

// LCS over lines → a del-then-add hunk list with snippet-relative line numbers. Paired del/add rows
// get inline word-level segments, same as patchToHunks.
public func buildDiffHunks(_ oldLines: [String], _ newLines: [String]) -> [DiffHunk] {
    var hunks: [DiffHunk] = []
    let maxCtx = max(oldLines.count, newLines.count)
    if maxCtx == 0 { return hunks }

    let lcs = computeLCS(oldLines, newLines)
    var oi = 0, ni = 0, li = 0
    var lineNum = 1

    while oi < oldLines.count || ni < newLines.count {
        if li < lcs.count && oi < oldLines.count && ni < newLines.count
            && oldLines[oi] == lcs[li] && newLines[ni] == lcs[li] {
            hunks.append(DiffHunk(type: .ctx, num: lineNum, text: lcs[li]))
            oi += 1; ni += 1; li += 1; lineNum += 1
        } else {
            let delStart = hunks.count
            while oi < oldLines.count && (li >= lcs.count || oldLines[oi] != lcs[li]) {
                hunks.append(DiffHunk(type: .del, num: oi + 1, text: oldLines[oi]))
                oi += 1
            }
            let addStart = hunks.count
            while ni < newLines.count && (li >= lcs.count || newLines[ni] != lcs[li]) {
                hunks.append(DiffHunk(type: .add, num: ni + 1, text: newLines[ni]))
                ni += 1; lineNum += 1
            }
            let delCount = addStart - delStart
            let addCount = hunks.count - addStart
            let pairCount = min(delCount, addCount)
            for p in 0..<max(pairCount, 0) {
                let (dSegs, aSegs) = inlineDiff(hunks[delStart + p].text, hunks[addStart + p].text)
                hunks[delStart + p].segments = dSegs
                hunks[addStart + p].segments = aSegs
            }
        }
    }
    return hunks
}

// A structured `patch` (Edit/Write tool_result) → the same row shape as buildDiffHunks, but with the
// ABSOLUTE file line numbers the patch carries (oldStart/newStart). Numbering restarts per hunk so
// the gap between hunks is honored.
public func patchToHunks(_ structuredPatch: JSONValue?) -> [DiffHunk] {
    guard let arr = structuredPatch?.arrayValue else { return [] }
    var rows: [DiffHunk] = []
    for h in arr {
        var oldNum = h["oldStart"]?.intValue ?? 1
        var newNum = h["newStart"]?.intValue ?? 1
        let lines = h["lines"]?.arrayValue?.compactMap { $0.stringValue } ?? []
        var i = 0
        while i < lines.count {
            let ch = lines[i].first
            if ch == "\\" { i += 1; continue }   // "\ No newline at end of file"
            if ch == "-" || ch == "+" {
                let delStart = rows.count
                while i < lines.count && lines[i].first == "-" {
                    rows.append(DiffHunk(type: .del, num: oldNum, text: String(lines[i].dropFirst())))
                    oldNum += 1; i += 1
                }
                let addStart = rows.count
                while i < lines.count && lines[i].first == "+" {
                    rows.append(DiffHunk(type: .add, num: newNum, text: String(lines[i].dropFirst())))
                    newNum += 1; i += 1
                }
                let pairCount = min(addStart - delStart, rows.count - addStart)
                for p in 0..<max(pairCount, 0) {
                    let (dSegs, aSegs) = inlineDiff(rows[delStart + p].text, rows[addStart + p].text)
                    rows[delStart + p].segments = dSegs
                    rows[addStart + p].segments = aSegs
                }
            } else {
                rows.append(DiffHunk(type: .ctx, num: newNum, text: String(lines[i].dropFirst())))
                oldNum += 1; newNum += 1; i += 1
            }
        }
    }
    return rows
}

// Longest common subsequence — used over lines (diff) and chars (inline). Uses Character arrays for
// the string overloads so it matches JS's per-char behavior.
public func computeLCS<T: Equatable>(_ a: [T], _ b: [T]) -> [T] {
    let m = a.count, n = b.count
    var dp = Array(repeating: Array(repeating: 0, count: n + 1), count: m + 1)
    for i in 1...max(m, 1) where i <= m {
        for j in 1...max(n, 1) where j <= n {
            dp[i][j] = a[i - 1] == b[j - 1] ? dp[i - 1][j - 1] + 1 : max(dp[i - 1][j], dp[i][j - 1])
        }
    }
    var result: [T] = []
    var i = m, j = n
    while i > 0 && j > 0 {
        if a[i - 1] == b[j - 1] { result.append(a[i - 1]); i -= 1; j -= 1 }
        else if dp[i - 1][j] >= dp[i][j - 1] { i -= 1 }
        else { j -= 1 }
    }
    return result.reversed()
}

public func computeLCS(_ a: String, _ b: String) -> [Character] {
    computeLCS(Array(a), Array(b))
}

public struct InlineRanges: Sendable, Equatable {
    public let delStart: Int, delEnd: Int, addStart: Int, addEnd: Int
}

// Char offsets of the changed span on each side (common prefix/suffix trimmed). Offsets index into
// the Character arrays of each side.
public func inlineDiffRanges(_ oldText: String, _ newText: String) -> InlineRanges {
    let o = Array(oldText), nw = Array(newText)
    var prefix = 0
    while prefix < o.count && prefix < nw.count && o[prefix] == nw[prefix] { prefix += 1 }
    var suffixO = o.count, suffixN = nw.count
    while suffixO > prefix && suffixN > prefix && o[suffixO - 1] == nw[suffixN - 1] { suffixO -= 1; suffixN -= 1 }
    return InlineRanges(delStart: prefix, delEnd: suffixO, addStart: prefix, addEnd: suffixN)
}

// Common-prefix / changed-span / common-suffix as segment arrays for each side. The changed span
// carries highlighted=true (empty spans are dropped, mirroring the JSX `&&` guard).
public func inlineDiff(_ oldText: String, _ newText: String) -> (del: [InlineSeg], add: [InlineSeg]) {
    let r = inlineDiffRanges(oldText, newText)
    let o = Array(oldText), nw = Array(newText)
    let common1 = String(o[0..<r.delStart])
    let delPart = String(o[r.delStart..<r.delEnd])
    let addPart = String(nw[r.addStart..<r.addEnd])
    let common2 = String(o[r.delEnd...].prefix(o.count - r.delEnd))

    var del: [InlineSeg] = [InlineSeg(text: common1, highlighted: false)]
    if !delPart.isEmpty { del.append(InlineSeg(text: delPart, highlighted: true)) }
    del.append(InlineSeg(text: common2, highlighted: false))

    var add: [InlineSeg] = [InlineSeg(text: common1, highlighted: false)]
    if !addPart.isEmpty { add.append(InlineSeg(text: addPart, highlighted: true)) }
    add.append(InlineSeg(text: common2, highlighted: false))

    return (del, add)
}

// A single Read/Write source-preview line: the real line number (from `cat -n`) and its text.
public struct PreviewLine: Sendable, Equatable {
    public let num: Int
    public let text: String
    public init(num: Int, text: String) { self.num = num; self.text = text }
}

// Read/Write previews: strip `cat -n` "\d+\t" prefixes, keeping the real line numbers; fall back to
// sequential numbering for plain text.
public func stripCatLineNumbers(_ text: String?) -> [PreviewLine] {
    guard let text, !text.isEmpty else { return [] }
    let lines = text.components(separatedBy: "\n")
    let hasCatNums = lines.count > 1 && lines[0].range(of: "^\\s*\\d+\\t", options: .regularExpression) != nil
    if !hasCatNums {
        return lines.enumerated().map { PreviewLine(num: $0.offset + 1, text: $0.element) }
    }
    return lines.map { line in
        if let m = line.range(of: "^\\s*(\\d+)\\t", options: .regularExpression) {
            let numStr = line[m].trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "\t", with: "")
            let num = Int(numStr) ?? 0
            return PreviewLine(num: num, text: String(line[m.upperBound...]))
        }
        return PreviewLine(num: 0, text: line)
    }
}

// AskUserQuestion answer parsing (spec 03 §4.8). Correlates each question to its answer from the two
// result formats: the "My answers …" arrow list and the "have been answered" quoted pairs. Falls
// back to substring correlation; nil for an unmatched question.
public func parseAskAnswers(_ questions: [String], _ resultText: String?) -> [String?] {
    guard let resultText, !resultText.isEmpty, !questions.isEmpty else { return [] }

    var answerMap: [(key: String, value: String)] = []
    func setAnswer(_ k: String, _ v: String) {
        if let idx = answerMap.firstIndex(where: { $0.key == k }) { answerMap[idx].value = v }
        else { answerMap.append((k, v)) }
    }

    if let msgRange = resultText.range(of: "My answers to your questions:\n") {
        let rest = String(resultText[msgRange.upperBound...])
        for line in rest.components(separatedBy: "\n") where !line.isEmpty {
            if let arrow = line.range(of: " → ") {
                setAnswer(String(line[..<arrow.lowerBound]).trimmingCharacters(in: .whitespaces),
                          String(line[arrow.upperBound...]).trimmingCharacters(in: .whitespaces))
            }
        }
    }

    // Format: Your questions have been answered: "Q1"="A1", "Q2"="A2". <boilerplate>
    if let ansRange = resultText.range(of: "Your questions have been answered:") {
        let rest = String(resultText[ansRange.upperBound...])
        let pairRe = try! NSRegularExpression(pattern: "\"([^\"]+)\"\\s*=\\s*\"([^\"]*)\"")
        let ns = rest as NSString
        for m in pairRe.matches(in: rest, range: NSRange(location: 0, length: ns.length)) {
            let k = ns.substring(with: m.range(at: 1)).trimmingCharacters(in: .whitespaces)
            let v = ns.substring(with: m.range(at: 2)).trimmingCharacters(in: .whitespaces)
            setAnswer(k, v)
        }
    }

    return questions.map { qText in
        if let hit = answerMap.first(where: { $0.key == qText }) { return hit.value }
        for pair in answerMap where qText.contains(pair.key) || pair.key.contains(qText) { return pair.value }
        return nil
    }
}
