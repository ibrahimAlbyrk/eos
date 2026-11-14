import AppKit
import CoreText
import QuartzCore

// The time and date in the bottom-left corner, in Eos's own faces (Geist and
// IBM Plex Mono, bundled). Set to the design's metrics — 96 / 12 pt on a
// 900-pt-tall screen, scaled to this one — and faded in once the ignition has played.
final class SaverClock: NSView {
    private static let fontsRegistered: Void = {
        for name in ["Geist", "IBMPlexMono"] {
            guard let url = Bundle(for: SaverClock.self).url(forResource: name, withExtension: "woff2") else { continue }
            CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
        }
    }()

    private let timeFormat = DateFormatter()
    private let dateFormat = DateFormatter()
    private var shownAt = CACurrentMediaTime()
    private var shownTime = ""

    // One design point on this screen.
    private var unit: CGFloat { min(bounds.width, bounds.height) / 900 }

    override init(frame: NSRect) {
        _ = Self.fontsRegistered
        super.init(frame: frame)
        let twelveHour = DateFormatter.dateFormat(fromTemplate: "j", options: 0, locale: .current)?.contains("a") ?? false
        timeFormat.locale = Locale(identifier: "en_US_POSIX")
        timeFormat.dateFormat = twelveHour ? "h:mm" : "HH:mm"
        dateFormat.locale = Locale(identifier: "en_GB")
        dateFormat.dateFormat = "EEEE d MMMM"
        alphaValue = 0
    }

    required init?(coder: NSCoder) { nil }

    func restart() {
        shownAt = CACurrentMediaTime()
        alphaValue = 0
    }

    // Every animation frame: new text on the minute; fade in and rise 10 pt from 4.4 s to 5.8 s.
    func tick() {
        let time = timeFormat.string(from: Date())
        if time != shownTime {
            shownTime = time
            needsDisplay = true
        }
        let x = min(max((CACurrentMediaTime() - shownAt - 4.4) / 1.4, 0), 1)
        let eased = x >= 1 ? 1 : 1 - pow(2, -10 * x)
        alphaValue = eased
        setFrameOrigin(NSPoint(x: 0, y: -(1 - eased) * 10 * unit))
    }

    override func draw(_ dirtyRect: NSRect) {
        guard let context = NSGraphicsContext.current?.cgContext else { return }
        let k = unit
        let timeFont = Self.font("Geist-ExtraLight", size: 96 * k, tabular: true)
            ?? .systemFont(ofSize: 96 * k, weight: .ultraLight)
        let dateFont = Self.font("IBMPlexMono-Regular", size: 12 * k, tabular: false)
            ?? .monospacedSystemFont(ofSize: 12 * k, weight: .regular)
        let date = dateFormat.string(from: Date()).uppercased(with: dateFormat.locale)

        // The design's CSS line boxes: the date's (line-height 1) sits 84 pt up, the time's (0.86) 16 pt above it.
        context.textMatrix = .identity
        Self.drawLine(date, font: dateFont, color: CGColor(srgbRed: 0x8B / 255, green: 0x98 / 255, blue: 0xAD / 255, alpha: 1),
                      kern: 0.24 * 12 * k, at: CGPoint(x: 96 * k, y: 84 * k + Self.baseline(in: 12 * k, font: dateFont)), in: context)
        Self.drawLine(shownTime, font: timeFont, color: CGColor(srgbRed: 0xE3 / 255, green: 0xE9 / 255, blue: 0xF4 / 255, alpha: 1),
                      kern: -0.04 * 96 * k, at: CGPoint(x: 96 * k, y: 112 * k + Self.baseline(in: 0.86 * 96 * k, font: timeFont)), in: context)
    }

    private static func font(_ name: String, size: CGFloat, tabular: Bool) -> NSFont? {
        guard let font = NSFont(name: name, size: size) else { return nil }
        guard tabular else { return font }
        let tabularFigures = font.fontDescriptor.addingAttributes([.featureSettings: [[
            NSFontDescriptor.FeatureKey.typeIdentifier: kNumberSpacingType,
            NSFontDescriptor.FeatureKey.selectorIdentifier: kMonospacedNumbersSelector,
        ]]])
        return NSFont(descriptor: tabularFigures, size: size) ?? font
    }

    // Where CSS puts the baseline in a line box of `height`: the glyph box centred, then its descent.
    private static func baseline(in height: CGFloat, font: NSFont) -> CGFloat {
        (height - (font.ascender - font.descender)) / 2 - font.descender
    }

    private static func drawLine(_ text: String, font: NSFont, color: CGColor, kern: CGFloat, at point: CGPoint, in context: CGContext) {
        let attributes: [NSAttributedString.Key: Any] = [
            .font: font,
            .kern: kern,
            NSAttributedString.Key(kCTForegroundColorAttributeName as String): color,
        ]
        context.textPosition = point
        CTLineDraw(CTLineCreateWithAttributedString(NSAttributedString(string: text, attributes: attributes)), context)
    }
}
