import SwiftUI

// Rich-text segmentation for user bubbles (spec 03 §5.5, port of richText.jsx segment() + ordered
// rules). Each rule decorates one kind of segment and only ever touches the still-plain runs left by
// earlier rules — disjoint, order-independent for non-overlapping patterns. The output is an
// AttributedString (coral links, pill-styled tokens) that Text renders with tappable links.
//
// Rules, in order: (1) URLs → coral link; (2) {cwd}/ → "@"; (3) paste-pill tokens; (4) slash-command
// tokens. Attachment labels render as a chip ROW above the bubble (UserMessageView), not inline.
enum TextSegmenter {
    // http/https only; stops before trailing sentence punctuation/brackets (URL_RE, §5.5).
    private static let urlRE = try! NSRegularExpression(
        pattern: #"\bhttps?://[^\s<>]+[^\s<>.,;:!?'")\]}]"#)
    // [Pasted text #N +M line(s)] (PASTE_RE, pasteTokens.js).
    private static let pasteRE = try! NSRegularExpression(
        pattern: #"\[Pasted text #\d+ \+\d+ lines?\]"#)
    // A leading slash command token: "/name" at a boundary, to the next space/newline (slashTokens.js;
    // command-registry validation is 4b-ii — here any /word at a boundary is styled).
    private static let slashRE = try! NSRegularExpression(
        pattern: #"(?:(?<=^)|(?<=\s))/[A-Za-z][\w-]*"#)

    // Build the decorated string. `cwd` (when known) is shortened to "@" in the text (§5.5).
    static func attributed(_ raw: String, cwd: String?) -> AttributedString {
        let shortened = shortenCwd(raw, cwd: cwd)
        var segments: [Segment] = [.plain(shortened)]
        segments = apply(segments, regex: urlRE) { .link($0) }
        segments = apply(segments, regex: pasteRE) { .pill($0) }
        segments = apply(segments, regex: slashRE) { .pill($0) }
        return segments.reduce(into: AttributedString()) { $0.append($1.rendered) }
    }

    private static func shortenCwd(_ text: String, cwd: String?) -> String {
        guard let cwd, !cwd.isEmpty else { return text }
        let needle = cwd.hasSuffix("/") ? cwd : cwd + "/"
        return text.replacingOccurrences(of: needle, with: "@")
    }

    // MARK: segment machinery (mirrors applyRule — split plain runs on matches, keep decorated ones)

    private enum Segment {
        case plain(String)
        case link(String)
        case pill(String)

        var rendered: AttributedString {
            switch self {
            case let .plain(s):
                var a = AttributedString(s); a.font = EosFont.body; a.foregroundColor = EosColor.ink; return a
            case let .link(s):
                var a = AttributedString(s)
                a.font = EosFont.body; a.foregroundColor = EosColor.coral; a.underlineStyle = .single
                if let u = URL(string: s) { a.link = u }
                return a
            case let .pill(s):
                // .att-hl / .paste-pill (§10): coral text on a coral@14% wash. AttributedString has no
                // padding, so a hair-space inset + coralWash background approximates the pill.
                var a = AttributedString("\u{200A}\(s)\u{200A}")
                a.font = EosFont.body.weight(.medium)
                a.foregroundColor = EosColor.coral
                a.backgroundColor = EosColor.coralWash
                return a
            }
        }
    }

    private static func apply(_ segments: [Segment], regex: NSRegularExpression,
                              decorate: (String) -> Segment) -> [Segment] {
        segments.flatMap { seg -> [Segment] in
            guard case let .plain(text) = seg else { return [seg] }  // only touch still-plain runs
            let ns = text as NSString
            let matches = regex.matches(in: text, range: NSRange(location: 0, length: ns.length))
            guard !matches.isEmpty else { return [seg] }
            var out: [Segment] = []
            var last = 0
            for m in matches {
                if m.range.location > last {
                    out.append(.plain(ns.substring(with: NSRange(location: last, length: m.range.location - last))))
                }
                out.append(decorate(ns.substring(with: m.range)))
                last = m.range.location + m.range.length
            }
            if last < ns.length { out.append(.plain(ns.substring(from: last))) }
            return out
        }
    }
}
