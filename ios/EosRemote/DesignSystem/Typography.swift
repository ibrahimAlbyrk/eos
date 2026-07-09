import SwiftUI

// Type roles (spec 05 §1.3). Plus Jakarta Sans for UI + prose (drops the v1 New York serif); JetBrains
// Mono for code. Every role uses Font.custom(..., relativeTo:) so Dynamic Type still scales — the
// relativeTo: text style is what keeps scaling; point sizes are the .large reference rendering, kept
// matched to the old text-style sizes so layouts don't shift. `display` still takes -0.4 tracking at
// the call site. If a .ttf fails to register, Font.custom falls back to the system font.
//
// NOTE: `titleSerif`, `bodySerif`, `bodySerifEmph` are historical names — their v2 value is Plus
// Jakarta Sans, not serif. Names kept so repointing the values re-themes prose across the built
// renderer with zero call-site edits (a rename would be a churn-only diff).
enum EosFont {
    // display / headings — PJS, tight: the wordmark + hero + card headings
    static let display        = Font.custom("PlusJakartaSans-Bold",     size: 32, relativeTo: .largeTitle)
    static let titleSerif     = Font.custom("PlusJakartaSans-SemiBold", size: 22, relativeTo: .title2)   // name kept; PJS
    static let heading        = Font.custom("PlusJakartaSans-SemiBold", size: 20, relativeTo: .title3)
    // prose — PJS (was bodySerif); assistant transcript body
    static let bodySerif      = Font.custom("PlusJakartaSans-Regular",  size: 16, relativeTo: .body)      // name kept; PJS prose
    static let bodySerifEmph  = Font.custom("PlusJakartaSans-SemiBold", size: 16, relativeTo: .body)
    // UI labels / body / captions — PJS
    static let label          = Font.custom("PlusJakartaSans-Medium",   size: 15, relativeTo: .subheadline)
    static let labelStrong    = Font.custom("PlusJakartaSans-SemiBold", size: 17, relativeTo: .headline)
    static let body           = Font.custom("PlusJakartaSans-Regular",  size: 16, relativeTo: .body)
    static let caption        = Font.custom("PlusJakartaSans-Regular",  size: 13, relativeTo: .footnote)
    static let captionSmall   = Font.custom("PlusJakartaSans-Regular",  size: 11, relativeTo: .caption2)
    // meta mono (ids/cost) — keep SF Mono
    static let mono           = Font.system(.footnote,   design: .monospaced)

    // Code font (spec 03 §5.4). Bundled JetBrains Mono (the Mac's code font) so code cards read 1:1;
    // Font.custom degrades gracefully to SF Mono if the .ttf isn't registered. `code` = pre/inline
    // fence body (text-sm 13pt), `codeSmall` = diff/id meta (text-xs 12pt). Both scale with Dynamic
    // Type via `relativeTo`.
    static let code      = Font.custom("JetBrainsMono-Regular", size: 13, relativeTo: .footnote)
    static let codeSmall = Font.custom("JetBrainsMono-Regular", size: 12, relativeTo: .caption)

    // Whether the bundled families actually registered — drives the fallback flags surfaced in DEBUG.
    static var codeFontIsJetBrains: Bool {
        UIFont(name: "JetBrainsMono-Regular", size: 13) != nil
    }
    static var uiFontIsJakarta: Bool {
        UIFont(name: "PlusJakartaSans-Regular", size: 13) != nil
    }
}
