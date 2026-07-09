import SwiftUI

// Type roles (spec 02 §1.3). Serif = New York via design: .serif (display + prose); SF Pro for UI
// labels/captions; SF Mono for code/ids/cost. Every role derives from a Dynamic Type text style so
// the whole app scales with the user's setting. `display` takes -0.4 tracking at the call site.
enum EosFont {
    static let display        = Font.system(.largeTitle, design: .serif).weight(.regular)
    static let titleSerif     = Font.system(.title2,     design: .serif).weight(.semibold)
    static let heading        = Font.system(.title3,     design: .serif).weight(.semibold)
    static let bodySerif      = Font.system(.body,       design: .serif)
    static let bodySerifEmph  = Font.system(.body,       design: .serif).weight(.semibold)
    static let label          = Font.system(.subheadline, design: .default).weight(.medium)
    static let labelStrong    = Font.system(.headline,   design: .default)
    static let body           = Font.system(.body,       design: .default)
    static let caption        = Font.system(.footnote,   design: .default)
    static let captionSmall   = Font.system(.caption2,   design: .default)
    static let mono           = Font.system(.footnote,   design: .monospaced)

    // Code font (spec 03 §5.4). Bundled JetBrains Mono (the Mac's code font) so code cards read 1:1;
    // Font.custom degrades gracefully to SF Mono if the .ttf isn't registered. `code` = pre/inline
    // fence body (text-sm 13pt), `codeSmall` = diff/id meta (text-xs 12pt). Both scale with Dynamic
    // Type via `relativeTo`.
    static let code      = Font.custom("JetBrainsMono-Regular", size: 13, relativeTo: .footnote)
    static let codeSmall = Font.custom("JetBrainsMono-Regular", size: 12, relativeTo: .caption)

    // Whether the bundled family actually registered — drives the fallback flag surfaced in DEBUG.
    static var codeFontIsJetBrains: Bool {
        UIFont(name: "JetBrainsMono-Regular", size: 13) != nil
    }
}
