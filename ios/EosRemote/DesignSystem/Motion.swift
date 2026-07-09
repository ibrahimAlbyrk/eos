import SwiftUI
import UIKit

// Motion + haptics vocabulary (contract §A5). Springs are plain constants; call sites gate them on
// @Environment(\.accessibilityReduceMotion) — `reduceMotion ? .none : EosSpring.x` — the existing
// SidebarContainer pattern.
enum EosSpring {
    static let drawer = Animation.interactiveSpring(response: 0.35, dampingFraction: 0.86)
    static let sheet  = Animation.spring(response: 0.4, dampingFraction: 0.9)   // sheet content transitions
    static let chip   = Animation.spring(response: 0.3, dampingFraction: 0.8)   // chip insert/remove, banner shuffle
}

// One-line haptic verbs so call sites don't juggle generator instances. tap = chip select /
// mode·model pick / menu open; success·warning = permission Allow / Deny, send, archive.
@MainActor
enum Haptics {
    static func tap()     { UIImpactFeedbackGenerator(style: .light).impactOccurred() }
    static func success() { UINotificationFeedbackGenerator().notificationOccurred(.success) }
    static func warning() { UINotificationFeedbackGenerator().notificationOccurred(.warning) }
}
