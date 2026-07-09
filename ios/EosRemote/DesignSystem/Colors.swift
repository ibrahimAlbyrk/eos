import SwiftUI

// Dark palette (spec 05 §1.1) — the Eos Mac dashboard's dark tokens, mobile-adapted. Colors are
// defined in code so the whole palette is diffable and greppable in one file; the asset catalog keeps
// only AppIcon. A future warm-cream light theme becomes a value swap here (+ a colorScheme branch),
// not a call-site edit.
//
// NOTE: `coral` is the accent token; its v2 value is cornflower blue #6EA4E8 (dawn-star), not coral.
// Name kept (with coralWash/coralPressed) to avoid a 40-call-site rename across the built renderer.
enum EosColor {
    // surfaces
    static let bg         = Color(hex: 0x1A1A1A)   // near-black app background; bleeds under the notch
    static let bgSunken   = Color(hex: 0x151515)   // recessed wells / scrim base
    static let surface    = Color(hex: 0x1F1F1F)   // cards, tool-group / terminal fill, opaque rows
    static let surface2   = Color(hex: 0x252525)   // inline code, chip fills, nested card fill
    static let surface3   = Color(hex: 0x2C2C2C)   // table header, pressed/hover, popover pop
    static let surfaceHi  = Color(hex: 0x2C2C2C)   // pressed/active surface (alias of surface3)
    // ink
    static let ink          = Color(hex: 0xEBEBEB) // primary text
    static let inkSecondary = Color(hex: 0xC4C4C4) // secondary text, worker-row meta
    static let inkTertiary  = Color(hex: 0x8A8A8A) // placeholders, arg hints, timestamps, tool verbs
    static let inkFaint     = Color(hex: 0x5A5A5A) // faintest — disabled, spacer glyphs, (definition)
    static let hairline       = Color(hex: 0x262626) // card borders, separators, composer/pill outline
    static let hairlineStrong = Color(hex: 0x353535) // emphasized borders, focused field
    // accent (cornflower blue — dawn-star; see NOTE above)
    static let coral        = Color(hex: 0x6EA4E8)
    static let coralPressed = Color(hex: 0x8AB9F0) // accent hover/pressed (lighter on dark)
    static let coralWash    = Color(hex: 0x212B35) // accent-tinted fill — desaturated blue-slate
    static let onAccent     = Color(hex: 0x0A0A0A) // text/glyph ON the accent fill
    // pill / on-dark
    static let black  = Color(hex: 0x0A0A0A)       // deepest fill (FAB/pill base when a solid is needed)
    static let onDark = Color(hex: 0xEBEBEB)       // text on the (now rarely used) solid pill — matches ink
    // actions
    static let danger    = Color(hex: 0xD97670)    // destructive (Kill, Deny) — aligns to state-failed red
    static var focusRing: Color { coral.opacity(0.45) }
    // attention dot — agent stopped with unviewed output; matches Mac .ag-notify blue
    static let attention = State.queuedDot

    // run-state (dot = saturated, soft = dark tinted fill) — spec 05 §1.1. "Soft" on dark is the dot
    // hue baked over #1a1a1a at low alpha, kept as literals for grep-ability.
    enum State {
        static let runningDot = Color(hex: 0x67C084); static let runningSoft = Color(hex: 0x1C2A22)
        static let idleDot    = Color(hex: 0x8A8A8A); static let idleSoft    = Color(hex: 0x242424)
        static let failedDot  = Color(hex: 0xD97670); static let failedSoft  = Color(hex: 0x2E1F1E)
        static let waitingDot = Color(hex: 0xD4A55A); static let waitingSoft = Color(hex: 0x2B2417)
        static let infoDot    = Color(hex: 0x6EA4E8); static let infoSoft    = Color(hex: 0x212B35)
        static let violetDot  = Color(hex: 0xC8A2FF); static let violetSoft  = Color(hex: 0x241E33)
        static let queuedDot  = Color(hex: 0x0099FF); static let queuedSoft  = Color(hex: 0x212B35)
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

// One place resolves the raw Worker.state string into a dot + soft wash + label. Aligned to the Mac's
// statusFromState vocabulary (spec 05 §1.5): boot reads as running; ending/killing/suspended map. Kept
// next to the palette so the switch and the state vocabulary live together. Labels are lowercase to
// match the Mac's ag-status chip.
struct EosRunState {
    let dot: Color, soft: Color, label: String
    static func from(_ state: String) -> EosRunState {
        switch state {
        case "WORKING", "SPAWNING":         return .init(dot: EosColor.State.runningDot, soft: EosColor.State.runningSoft, label: "running")
        case "IDLE", "SUSPENDED", "DRAFT":  return .init(dot: EosColor.State.idleDot,    soft: EosColor.State.idleSoft,    label: "idle")
        case "ENDING":                      return .init(dot: EosColor.State.idleDot,    soft: EosColor.State.idleSoft,    label: "ending")
        case "DONE":                        return .init(dot: EosColor.State.idleDot,    soft: EosColor.State.idleSoft,    label: "done")
        case "KILLING":                     return .init(dot: EosColor.State.queuedDot,  soft: EosColor.State.queuedSoft,  label: "killing")
        case "FAILED", "ERROR":             return .init(dot: EosColor.State.failedDot,  soft: EosColor.State.failedSoft,  label: "failed")
        case "WAITING", "INPUT":            return .init(dot: EosColor.State.waitingDot, soft: EosColor.State.waitingSoft, label: "waiting")
        default:                            return .init(dot: EosColor.State.infoDot,    soft: EosColor.State.infoSoft,    label: state.lowercased())
        }
    }
}
