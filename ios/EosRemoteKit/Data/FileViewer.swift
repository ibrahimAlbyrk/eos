import Foundation

// Pure logic behind the transcript file viewer (round 4): the GET /fs/read payload decode, the
// image-route predicate, the extension → highlight.js language map, and the line splitter the
// viewer's gutter uses. UI-free so it stays testable in EosRemoteKitTests.
public enum FileViewer {
    // Client-side fetch caps. The relay envelope is 5 MB (§4.1) and /fs/read ships up to 8 MB of
    // JSON, so cap BEFORE fetching: text beyond this degrades to a size note (contract idiom),
    // images beyond it would overflow the asset frame's base64 (4/3 expansion + headroom).
    public static let textFetchCap = 2 * 1024 * 1024
    public static let imageFetchCap = 3 * 1024 * 1024
    // Whole-file syntax highlighting is JavaScriptCore-backed — keep it to sources it can chew
    // through quickly; bigger files render plain mono.
    public static let highlightCap = 256 * 1024

    // GET /fs/read's three shapes (contract FsReadResponseSchema): text, binary-sniffed, large.
    public enum ReadPayload: Equatable, Sendable {
        case text(content: String, lines: Int)
        case binary(size: Int)
        case large(size: Int)
    }

    public static func parseReadPayload(_ raw: JSONValue) -> ReadPayload? {
        if let content = raw["content"]?.stringValue {
            return .text(content: content, lines: raw["lines"]?.intValue ?? 0)
        }
        if raw["binary"]?.boolValue == true { return .binary(size: raw["size"]?.intValue ?? 0) }
        if raw["large"]?.boolValue == true { return .large(size: raw["size"]?.intValue ?? 0) }
        return nil
    }

    // Mirrors the daemon's IMAGE_MIME extension set (manager/routes/fs-shared.ts) minus svg —
    // svg is XML text, better served by /fs/read + highlighting than UIImage (which can't decode
    // it). heic/heif added: the route falls back to octet-stream but UIImage decodes the bytes.
    private static let imageExts: Set<String> = [
        "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "heic", "heif",
    ]

    public static func isImagePath(_ path: String) -> Bool {
        imageExts.contains((path as NSString).pathExtension.lowercased())
    }

    // Extension → highlight.js language id; nil → auto-detect (CodeHighlighter's contract).
    public static func languageForPath(_ path: String) -> String? {
        switch (path as NSString).pathExtension.lowercased() {
        case "swift":                 return "swift"
        case "ts", "tsx", "mts":      return "typescript"
        case "js", "jsx", "mjs", "cjs": return "javascript"
        case "py":                    return "python"
        case "rb":                    return "ruby"
        case "go":                    return "go"
        case "rs":                    return "rust"
        case "java":                  return "java"
        case "kt", "kts":             return "kotlin"
        case "c", "h":                return "c"
        case "cpp", "cc", "cxx", "hpp": return "cpp"
        case "m", "mm":               return "objectivec"
        case "cs":                    return "csharp"
        case "sh", "zsh", "bash":     return "bash"
        case "yml", "yaml":           return "yaml"
        case "json":                  return "json"
        case "md", "markdown":        return "markdown"
        case "html", "htm":           return "html"
        case "css":                   return "css"
        case "xml", "svg", "plist", "storyboard", "xib": return "xml"
        case "sql":                   return "sql"
        default:                      return nil
        }
    }

    // Split a highlighted file into per-line runs for the numbered gutter, preserving attributes.
    // A trailing newline yields a final empty line — mirrors how editors count lines.
    public static func splitLines(_ attr: AttributedString) -> [AttributedString] {
        var out: [AttributedString] = []
        let chars = attr.characters
        var lineStart = chars.startIndex
        var idx = chars.startIndex
        while idx < chars.endIndex {
            if chars[idx] == "\n" {
                out.append(AttributedString(attr[lineStart..<idx]))
                idx = chars.index(after: idx)
                lineStart = idx
            } else {
                idx = chars.index(after: idx)
            }
        }
        out.append(AttributedString(attr[lineStart..<chars.endIndex]))
        return out
    }

    public static func formatSize(_ bytes: Int) -> String {
        ByteCountFormatter.string(fromByteCount: Int64(bytes), countStyle: .file)
    }
}
