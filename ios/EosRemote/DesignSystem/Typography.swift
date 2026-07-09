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
}
