import SwiftUI

// Paper palette (spec 02 §1.2). Colors are defined in code so the whole palette is diffable and
// greppable in one file; the asset catalog keeps only AppIcon. A future dark theme becomes a value
// swap here, not a call-site edit.
enum EosColor {
    // surfaces
    static let bg         = Color(hex: 0xF5F4EF)
    static let bgSunken   = Color(hex: 0xEFEEE7)
    static let surface    = Color(hex: 0xFBFAF7)
    static let surfaceHi  = Color(hex: 0xFFFFFF)
    // ink
    static let ink          = Color(hex: 0x1F1E1C)
    static let inkSecondary = Color(hex: 0x6B6862)
    static let inkTertiary  = Color(hex: 0x9C988F)
    static let hairline     = Color(hex: 0xE4E2DA)
    // accent
    static let coral        = Color(hex: 0xD97757)
    static let coralPressed = Color(hex: 0xC25E3E)
    static let coralWash    = Color(hex: 0xF3E4DC)
    // pill / on-dark
    static let black  = Color(hex: 0x111110)
    static let onDark = Color(hex: 0xF7F6F2)
    // actions
    static let danger    = Color(hex: 0xC0392B)
    static var focusRing: Color { coral.opacity(0.4) }

    // run-state (dot = saturated, soft = wash)
    enum State {
        static let runningDot = Color(hex: 0x3E9E6E); static let runningSoft = Color(hex: 0xE1F0E8)
        static let idleDot    = Color(hex: 0x9C988F); static let idleSoft    = Color(hex: 0xECEAE3)
        static let failedDot  = Color(hex: 0xC7513A); static let failedSoft  = Color(hex: 0xF4E0DA)
        static let waitingDot = Color(hex: 0xC08A2D); static let waitingSoft = Color(hex: 0xF3E9D5)
        static let infoDot    = Color(hex: 0x4A76B8); static let infoSoft    = Color(hex: 0xE1E8F2)
    }
}

extension Color {
    init(hex: UInt32, alpha: Double = 1) {
        self.init(.sRGB,
                  red:   Double((hex >> 16) & 0xFF) / 255,
                  green: Double((hex >> 8)  & 0xFF) / 255,
                  blue:  Double(hex & 0xFF) / 255,
                  opacity: alpha)
    }
}

// One place resolves the raw Worker.state string into a dot + soft wash + label (spec 02 §1.2).
// Kept next to the palette so the switch and the state vocabulary live together.
struct EosRunState {
    let dot: Color, soft: Color, label: String
    static func from(_ state: String) -> EosRunState {
        switch state {
        case "RUNNING", "WORKING": return .init(dot: EosColor.State.runningDot, soft: EosColor.State.runningSoft, label: "Running")
        case "IDLE", "DONE":       return .init(dot: EosColor.State.idleDot,    soft: EosColor.State.idleSoft,    label: "Idle")
        case "FAILED", "ERROR":    return .init(dot: EosColor.State.failedDot,  soft: EosColor.State.failedSoft,  label: "Failed")
        case "WAITING", "INPUT":   return .init(dot: EosColor.State.waitingDot, soft: EosColor.State.waitingSoft, label: "Waiting")
        default:                   return .init(dot: EosColor.State.infoDot,    soft: EosColor.State.infoSoft,    label: state.capitalized)
        }
    }
}
