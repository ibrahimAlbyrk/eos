import SwiftUI

// Derives the greeting name + avatar initials from the device label (spec 02 §2.7/§3.3). The device
// name is the only account-ish string the app has; AppModel reads UIDevice.current.name during
// pairing but does not surface it, so we read it here for presentation only.
@MainActor
enum AccountLabel {
    static var deviceName: String { UIDevice.current.name }

    // First token of the device label; "there" when it is empty or a generic "iPhone".
    static var firstName: String {
        let name = deviceName.trimmingCharacters(in: .whitespaces)
        guard let first = name.split(separator: " ").first, first != "iPhone" else { return "there" }
        // "Ibrahim's iPhone" → "Ibrahim"
        return String(first).replacingOccurrences(of: "'s", with: "")
    }

    // Up to two initials for the sidebar monogram; "IA" fallback.
    static var initials: String {
        let letters = deviceName.split(separator: " ").prefix(2).compactMap { $0.first }
        let joined = String(letters).uppercased()
        return joined.isEmpty ? "IA" : joined
    }
}
