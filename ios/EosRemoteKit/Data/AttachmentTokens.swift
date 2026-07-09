import Foundation

// The attachment-token text format — ports of the Mac's lib/attachmentTokens.js makeLabel /
// buildAttachmentSuffix / parseAttachmentMessage. Writer and reader live together so the wire
// suffix ("\n\nattachments:\n- [label] (kind): /abs/path") never drifts between composer and
// message bubble.
public enum AttachmentTokens {
    private static let maxNameChars = 24

    // "[report.pdf]"; same-named files disambiguate with an n suffix ("[a.txt 2]"). Brackets and
    // newlines are stripped so the label stays a parseable token; 24-char cap with ellipsis.
    public static func makeLabel(_ name: String?, n: Int = 1) -> String {
        var clean = name ?? ""
        clean.removeAll { $0 == "[" || $0 == "]" || $0 == "\n" }
        clean = clean.trimmingCharacters(in: .whitespacesAndNewlines)
        if clean.isEmpty { clean = "file" }
        let short = clean.count > maxNameChars ? String(clean.prefix(maxNameChars)) + "…" : clean
        return n > 1 ? "[\(short) \(n)]" : "[\(short)]"
    }

    // The wire suffix appended verbatim to the sent text. Labels with no resolved path are
    // skipped; the "(kind)" annotation lets the bubble pick the right chip icon on re-parse.
    public static func buildAttachmentSuffix(labels: [String], paths: [String: String],
                                             kinds: [String: String] = [:]) -> String {
        var lines: [String] = []
        for label in labels {
            guard let path = paths[label] else { continue }
            if let kind = kinds[label] { lines.append("- \(label) (\(kind)): \(path)") }
            else { lines.append("- \(label): \(path)") }
        }
        return lines.isEmpty ? "" : "\n\nattachments:\n" + lines.joined(separator: "\n")
    }

    public struct ParsedAttachment: Sendable, Equatable {
        public let label: String?
        public let kind: String     // image | file | folder
        public let path: String
        public init(label: String?, kind: String, path: String) {
            self.label = label; self.kind = kind; self.path = path
        }
    }

    public struct ParsedMessage: Sendable, Equatable {
        public let display: String
        public let attachments: [ParsedAttachment]
        public init(display: String, attachments: [ParsedAttachment]) {
            self.display = display; self.attachments = attachments
        }
    }

    private static let imageExts: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg"]

    private static func kindFromExt(_ path: String) -> String {
        let ext = path.split(separator: ".").last.map { $0.lowercased() } ?? ""
        return imageExts.contains(ext) ? "image" : "file"
    }

    // Inverse of buildAttachmentSuffix: split the "attachments:" suffix off a sent message into
    // the display text + a typed list. Tolerates the legacy "{image #1}" and bare "image:" forms
    // and infers kind from the extension when the "(kind)" annotation is absent.
    public static func parseAttachmentMessage(_ text: String) -> ParsedMessage {
        let marker = "\n\nattachments:\n"
        guard let range = text.range(of: marker) else {
            return ParsedMessage(display: text, attachments: [])
        }
        let display = String(text[..<range.lowerBound])
        let attachments = text[range.upperBound...]
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map { line -> String in
                var s = String(line)
                if s.hasPrefix("- ") { s.removeFirst(2) }
                return s.trimmingCharacters(in: .whitespacesAndNewlines)
            }
            .filter { !$0.isEmpty }
            .map(parseLine)
        return ParsedMessage(display: display, attachments: attachments)
    }

    private static func parseLine(_ raw: String) -> ParsedAttachment {
        if let m = raw.firstMatch(of: /^(\[[^\]]+\])(?:\s+\((image|file|folder)\))?:\s*(.+)$/) {
            let path = String(m.3)
            return ParsedAttachment(label: String(m.1),
                                    kind: m.2.map(String.init) ?? kindFromExt(path), path: path)
        }
        if let m = raw.firstMatch(of: /^(\{(image|file|folder) #\d+\}):\s*(.+)$/) {
            return ParsedAttachment(label: String(m.1), kind: String(m.2), path: String(m.3))
        }
        if let m = raw.firstMatch(of: /^(folder|file|image):\s*(.+)$/) {
            return ParsedAttachment(label: nil, kind: String(m.1), path: String(m.2))
        }
        return ParsedAttachment(label: nil, kind: kindFromExt(raw), path: raw)
    }
}
