import SwiftUI
import Highlightr

// Syntax highlighting for code fences (spec 03 §5.4). Highlightr wraps highlight.js in JavaScriptCore
// — the SAME engine as the Mac — so tokenization matches. Highlighting runs OFF the main actor and is
// cached by (code, language); the SwiftUI card renders the resulting AttributedString.
//
// Theme note: the locked decision is github-dark-dimmed on a dark card, but Highlightr 2.2.0 does not
// bundle that theme by name. `atom-one-dark` is its closest bundled equivalent (same modern muted-dark
// GitHub/Atom lineage) and is used here on `codeCardBackground`. See CodeBlockView for the card fill.
enum CodeHighlighter {
    static let themeName = "atom-one-dark"
    // github-dark-dimmed's canvas (#22272e). The bundled atom-one-dark bg (#282c34) is close; we pin
    // the card to this exact value so the paper→dark inset reads 1:1 with the Mac regardless of theme.
    static let codeCardBackground = Color(hex: 0x22272E)
    static let codeCardText       = Color(hex: 0xADBAC7)   // github-dark-dimmed default fg
    static let codeCardBorder     = Color(hex: 0x2D333B)

    // One JavaScriptCore-backed instance per highlight thread would be ideal; a single shared instance
    // guarded by a serial queue is enough here (highlight is fast + cached). Created lazily.
    // Touched only inside `queue.async` (a serial queue) — the unsafe annotation opts out of the
    // Sendable check for the non-Sendable Highlightr instance.
    nonisolated(unsafe) private static let highlightr: Highlightr? = {
        let h = Highlightr()
        _ = h?.setTheme(to: themeName)
        return h
    }()
    private static let queue = DispatchQueue(label: "dev.eos.remote.highlight", qos: .userInitiated)

    private final class Box { let value: AttributedString; init(_ v: AttributedString) { value = v } }
    nonisolated(unsafe) private static let cache: NSCache<NSString, Box> = {
        let c = NSCache<NSString, Box>(); c.countLimit = 300; return c
    }()

    private static func key(_ code: String, _ language: String?) -> NSString {
        "\(language ?? "auto")\u{1}\(code)" as NSString
    }

    // Synchronous cache probe for the render pass — nil on a miss (renderer shows plain mono meanwhile).
    static func cached(code: String, language: String?) -> AttributedString? {
        cache.object(forKey: key(code, language))?.value
    }

    // Highlight off-main-actor, store in the cache, hand the result back on the main actor. `language`
    // is a highlight.js name (nil → auto-detect). Falls back to plain mono text if the engine is absent.
    static func highlight(code: String, language: String?) async -> AttributedString {
        let k = key(code, language)
        if let hit = cache.object(forKey: k)?.value { return hit }
        let result: AttributedString = await withCheckedContinuation { cont in
            queue.async {
                let out = render(code: code, language: language)
                cache.setObject(Box(out), forKey: k)
                cont.resume(returning: out)
            }
        }
        return result
    }

    // Runs on `queue`. Highlightr returns an NSAttributedString themed by the theme's CSS; we keep its
    // foreground colors and swap the font to JetBrains Mono (Highlightr's own font would be Courier).
    private static func render(code: String, language: String?) -> AttributedString {
        let mono = UIFont(name: "JetBrainsMono-Regular", size: 13)
            ?? UIFont.monospacedSystemFont(ofSize: 13, weight: .regular)
        guard let highlightr,
              let ns = highlightr.highlight(code, as: normalizedLanguage(language), fastRender: true)
        else {
            var plain = AttributedString(code)
            plain.font = Font(mono)
            plain.foregroundColor = codeCardText
            return plain
        }
        let mutable = NSMutableAttributedString(attributedString: ns)
        let full = NSRange(location: 0, length: mutable.length)
        mutable.addAttribute(.font, value: mono, range: full)
        return AttributedString(mutable)
    }

    // Map common fence tags to highlight.js language ids; unknown/empty → nil (auto-detect).
    private static func normalizedLanguage(_ raw: String?) -> String? {
        guard let raw = raw?.lowercased(), !raw.isEmpty else { return nil }
        switch raw {
        case "sh", "shell", "zsh", "console": return "bash"
        case "js", "mjs", "cjs":               return "javascript"
        case "ts":                             return "typescript"
        case "py":                             return "python"
        case "yml":                            return "yaml"
        case "objc", "objective-c":            return "objectivec"
        case "text", "plain", "txt":           return nil
        default:                               return raw
        }
    }
}
