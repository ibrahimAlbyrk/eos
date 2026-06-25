// Presentation layer — the retained NSStatusItem, its two right-pinned faces,
// and the running animation. Conforms to CompletionPresenter so the domain
// queue drives it without knowing it is AppKit. The domain layer stays AppKit-
// free; everything visual lives here.

import Cocoa

// What the completion queue drives. Kept minimal so a headless renderer could
// stand in for tests.
protocol CompletionPresenter: AnyObject {
    func renderRunning(running: Bool, count: Int)
    func announce(_ completion: Completion, remaining: Int)
    func endAnnouncing(running: Bool, count: Int)
    func setConnected(_ connected: Bool)
}

// Semantic palette — monochrome bar tint + the app's accent/ok/err, resolved
// per light/dark menu bar (R-1). Colour appears only for meaning.
enum BarPalette {
    static func isDark(_ a: NSAppearance) -> Bool {
        a.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
    }
    static func barTint(_ a: NSAppearance) -> NSColor {
        isDark(a) ? NSColor(white: 1, alpha: 0.92) : NSColor(white: 0, alpha: 0.86)
    }
    static func ok(_ a: NSAppearance) -> NSColor {
        isDark(a) ? rgb(0x67, 0xc0, 0x84) : rgb(0x1a, 0x7f, 0x37)
    }
    static func err(_ a: NSAppearance) -> NSColor {
        isDark(a) ? rgb(0xd9, 0x76, 0x70) : rgb(0xcf, 0x22, 0x2e)
    }
    static func accent(_ a: NSAppearance) -> NSColor {
        isDark(a) ? rgb(0x6e, 0xa4, 0xe8) : rgb(0x09, 0x69, 0xda)
    }
    static func faint(_ a: NSAppearance) -> NSColor {
        isDark(a) ? NSColor(white: 1, alpha: 0.14) : NSColor(white: 0, alpha: 0.10)
    }
    static func rgb(_ r: Int, _ g: Int, _ b: Int) -> NSColor {
        NSColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
    }
}

// The real Eos dawn-star, monochrome template form — 8 rounded spokes + a core,
// drawn from the same geometry as the brand SVG (design 04). Symmetric, so the
// flipped-view y-axis is a no-op.
enum DawnStar {
    static func path(size: CGFloat) -> CGPath {
        let combined = CGMutablePath()
        let spoke = CGPath(roundedRect: CGRect(x: -11, y: -96, width: 22, height: 84),
                           cornerWidth: 11, cornerHeight: 11, transform: nil)
        for deg in stride(from: 0, to: 360, by: 45) {
            let rot = CGAffineTransform(rotationAngle: CGFloat(deg) * .pi / 180)
            combined.addPath(spoke, transform: rot)
        }
        combined.addEllipse(in: CGRect(x: -20, y: -20, width: 40, height: 40))
        let scale = size / 240
        var bake = CGAffineTransform(translationX: size / 2, y: size / 2).scaledBy(x: scale, y: scale)
        return combined.copy(using: &bake) ?? combined
    }

    // ✓ / ✗ stroke (design CHECK / CROSS), 16-unit space scaled to `size`.
    static func checkPath(size: CGFloat) -> CGPath {
        let p = CGMutablePath()
        let s = size / 16
        p.move(to: CGPoint(x: 3.4 * s, y: 8.5 * s))
        p.addLine(to: CGPoint(x: 6.6 * s, y: 11.4 * s))
        p.addLine(to: CGPoint(x: 12.6 * s, y: 4.8 * s))
        return p
    }
    static func crossPath(size: CGFloat) -> CGPath {
        let p = CGMutablePath()
        let s = size / 16
        p.move(to: CGPoint(x: 5 * s, y: 5 * s)); p.addLine(to: CGPoint(x: 11 * s, y: 11 * s))
        p.move(to: CGPoint(x: 11 * s, y: 5 * s)); p.addLine(to: CGPoint(x: 5 * s, y: 11 * s))
        return p
    }
}

// Drives the breathing dawn-star: a slow, low-amplitude pulse whose tempo
// tightens as more agents run (design applyIcon: breath = max(1.25, 1.9-rc*.09)).
final class RunningAnimator {
    private weak var layer: CALayer?
    init(layer: CALayer) { self.layer = layer }

    func start(count: Int) {
        guard let layer = layer else { return }
        layer.removeAnimation(forKey: "breath")
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            layer.opacity = 1.0
            return
        }
        let breath = max(1.25, 1.9 - Double(count) * 0.09)
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0.9; scale.toValue = 1.06
        let op = CABasicAnimation(keyPath: "opacity")
        op.fromValue = 0.78; op.toValue = 1.0
        let group = CAAnimationGroup()
        group.animations = [scale, op]
        group.duration = breath / 2
        group.autoreverses = true
        group.repeatCount = .infinity
        group.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(group, forKey: "breath")
    }

    func stop() { layer?.removeAnimation(forKey: "breath") }
}

// The custom view hosted in the status button. Two mutually exclusive faces,
// both laid out left→right inside a tight button so the menu-bar item grows
// (and the glyph anchor stays put) rather than reflowing neighbours. Click
// passes through to the button (hitTest → nil) so the status action fires.
final class BarStatusView: NSView {
    enum Mode { case icon, pill }

    private let glyph: CGFloat = 15
    private let check: CGFloat = 14
    private let hPad: CGFloat = 6
    private let gap: CGFloat = 5

    let starLayer = CAShapeLayer()
    private let countLayer = CATextLayer()
    private let checkLayer = CAShapeLayer()
    private let nameLayer = CATextLayer()
    private let doneLayer = CATextLayer()
    private let badgeBg = CALayer()
    private let badgeLayer = CATextLayer()
    private let drainLayer = CALayer()

    private(set) var contentWidth: CGFloat = 26

    private var mode: Mode = .icon
    private var count = 0
    private var running = false
    private var connected = true
    private var pillName = ""
    private var pillSuffix = "done"
    private var pillFailed = false
    private var pillRemaining = 0

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        let scale = NSScreen.main?.backingScaleFactor ?? 2
        for t in [countLayer, nameLayer, doneLayer, badgeLayer] { t.contentsScale = scale }
        starLayer.path = DawnStar.path(size: glyph)
        starLayer.anchorPoint = CGPoint(x: 0.5, y: 0.5)
        for l in [starLayer, checkLayer] { l.fillColor = nil }
        checkLayer.fillColor = nil
        checkLayer.lineWidth = 2
        checkLayer.lineCap = .round
        checkLayer.lineJoin = .round
        badgeBg.cornerRadius = 7
        for sub in [starLayer, countLayer, checkLayer, nameLayer, doneLayer, badgeBg, badgeLayer, drainLayer] {
            layer?.addSublayer(sub)
        }
        badgeBg.addSublayer(badgeLayer)
    }

    required init?(coder: NSCoder) { fatalError() }

    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    override func viewDidChangeEffectiveAppearance() {
        super.viewDidChangeEffectiveAppearance()
        render()
    }

    override func layout() {
        super.layout()
        render()
    }

    func showIcon(count: Int, running: Bool, connected: Bool) {
        mode = .icon; self.count = count; self.running = running; self.connected = connected
        render()
    }

    func showPill(name: String, suffix: String, failed: Bool, remaining: Int, dwell: TimeInterval) {
        mode = .pill; pillName = name; pillSuffix = suffix; pillFailed = failed; pillRemaining = remaining
        render()
        runDrain(dwell: dwell, failed: failed)
    }

    func setConnected(_ value: Bool) { connected = value; render() }

    private func attr(_ s: String, _ font: NSFont, _ color: NSColor) -> NSAttributedString {
        NSAttributedString(string: s, attributes: [.font: font, .foregroundColor: color])
    }

    private func render() {
        let app = effectiveAppearance
        let tint = BarPalette.barTint(app)
        let h = bounds.height > 0 ? bounds.height : 22
        let iconLayers = [starLayer, countLayer]
        let pillLayers: [CALayer] = [checkLayer, nameLayer, doneLayer, badgeBg, drainLayer]

        if mode == .icon {
            for l in pillLayers { l.isHidden = true }
            for l in iconLayers { l.isHidden = false }
            renderIcon(tint: tint, h: h)
        } else {
            for l in iconLayers { l.isHidden = true }
            for l in pillLayers { l.isHidden = false }
            renderPill(app: app, h: h)
        }
    }

    private func renderIcon(tint: NSColor, h: CGFloat) {
        let countFont = NSFont.monospacedSystemFont(ofSize: 11, weight: .semibold)
        var x = hPad
        var width = hPad
        if running && count > 0 {
            let a = attr("\(count)", countFont, tint.withAlphaComponent(connected ? 0.7 : 0.4))
            let sz = a.size()
            countLayer.isHidden = false
            countLayer.string = a
            countLayer.frame = CGRect(x: x, y: (h - sz.height) / 2, width: ceil(sz.width), height: ceil(sz.height))
            x += ceil(sz.width) + gap
            width += ceil(sz.width) + gap
        } else {
            countLayer.isHidden = true
        }
        starLayer.fillColor = tint.cgColor
        if !running { starLayer.opacity = connected ? 0.6 : 0.3 }
        else if connected { starLayer.opacity = 1.0 }
        starLayer.bounds = CGRect(x: 0, y: 0, width: glyph, height: glyph)
        starLayer.position = CGPoint(x: x + glyph / 2, y: h / 2)
        width += glyph + hPad
        contentWidth = width
    }

    private func renderPill(app: NSAppearance, h: CGFloat) {
        let semantic = pillFailed ? BarPalette.err(app) : BarPalette.ok(app)
        let tint = BarPalette.barTint(app)
        let nameFont = NSFont.monospacedSystemFont(ofSize: 12, weight: .semibold)
        let doneFont = NSFont.monospacedSystemFont(ofSize: 11.5, weight: .regular)
        let badgeFont = NSFont.monospacedSystemFont(ofSize: 10, weight: .bold)

        var x = hPad
        checkLayer.strokeColor = semantic.cgColor
        checkLayer.path = pillFailed ? DawnStar.crossPath(size: check) : DawnStar.checkPath(size: check)
        checkLayer.frame = CGRect(x: x, y: (h - check) / 2, width: check, height: check)
        x += check + gap

        let nameAttr = attr(pillName, nameFont, tint)
        let nameSz = nameAttr.size()
        nameLayer.string = nameAttr
        nameLayer.frame = CGRect(x: x, y: (h - nameSz.height) / 2, width: ceil(nameSz.width), height: ceil(nameSz.height))
        x += ceil(nameSz.width) + gap

        let doneAttr = attr(pillSuffix, doneFont, tint.withAlphaComponent(0.5))
        let doneSz = doneAttr.size()
        doneLayer.string = doneAttr
        doneLayer.frame = CGRect(x: x, y: (h - doneSz.height) / 2, width: ceil(doneSz.width), height: ceil(doneSz.height))
        x += ceil(doneSz.width)

        if pillRemaining > 0 {
            badgeBg.isHidden = false
            let bAttr = attr("+\(pillRemaining)", badgeFont, tint)
            let bSz = bAttr.size()
            let bw = ceil(bSz.width) + 10
            x += gap
            badgeBg.backgroundColor = BarPalette.faint(app).cgColor
            badgeBg.frame = CGRect(x: x, y: (h - 14) / 2, width: bw, height: 14)
            badgeLayer.string = bAttr
            badgeLayer.frame = CGRect(x: (bw - ceil(bSz.width)) / 2, y: (14 - bSz.height) / 2, width: ceil(bSz.width), height: ceil(bSz.height))
            x += bw
        } else {
            badgeBg.isHidden = true
        }
        x += hPad

        drainLayer.backgroundColor = semantic.cgColor
        drainLayer.cornerRadius = 1
        drainLayer.anchorPoint = CGPoint(x: 0, y: 0.5)
        drainLayer.frame = CGRect(x: hPad, y: h - 3, width: x - hPad * 2, height: 1.5)
        contentWidth = x
    }

    private func runDrain(dwell: TimeInterval, failed: Bool) {
        drainLayer.removeAnimation(forKey: "drain")
        guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
        let anim = CABasicAnimation(keyPath: "transform.scale.x")
        anim.fromValue = 1.0
        anim.toValue = 0.0
        anim.duration = dwell
        anim.timingFunction = CAMediaTimingFunction(name: .linear)
        anim.fillMode = .forwards
        anim.isRemovedOnCompletion = false
        drainLayer.add(anim, forKey: "drain")
    }
}

// Owns the retained status item, the bar view, and the animator.
final class StatusItemController: NSObject, CompletionPresenter {
    private let statusItem: NSStatusItem
    private let barView: BarStatusView
    private let animator: RunningAnimator
    private let dwell: TimeInterval
    private let onQuit: () -> Void
    private let onOpenWindow: () -> Void

    private var lastRunning = false
    private var lastCount = 0
    private var connected = true

    init(dwell: TimeInterval,
         onQuit: @escaping () -> Void, onOpenWindow: @escaping () -> Void) {
        self.dwell = dwell
        self.onQuit = onQuit
        self.onOpenWindow = onOpenWindow
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        barView = BarStatusView(frame: NSRect(x: 0, y: 0, width: 26, height: 22))
        animator = RunningAnimator(layer: barView.starLayer)
        super.init()

        if let button = statusItem.button {
            button.image = nil
            button.title = ""
            barView.frame = button.bounds
            barView.autoresizingMask = [.width, .height]
            button.addSubview(barView)
            button.target = self
            button.action = #selector(statusClicked)
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
            button.toolTip = "Eos agents"
        }
        renderRunning(running: false, count: 0)
    }

    // MARK: - CompletionPresenter

    func renderRunning(running: Bool, count: Int) {
        lastRunning = running; lastCount = count
        barView.showIcon(count: count, running: running, connected: connected)
        statusItem.length = barView.contentWidth
        if running && connected { animator.start(count: count) } else { animator.stop() }
    }

    func announce(_ completion: Completion, remaining: Int) {
        animator.stop()
        let suffix = completion.failed ? "failed" : "done"
        barView.showPill(name: completion.name, suffix: suffix, failed: completion.failed,
                         remaining: remaining, dwell: dwell)
        statusItem.length = barView.contentWidth
    }

    func endAnnouncing(running: Bool, count: Int) {
        renderRunning(running: running, count: count)
    }

    func setConnected(_ value: Bool) {
        connected = value
        barView.setConnected(value)
        if !value { animator.stop() }
        else if lastRunning { animator.start(count: lastCount) }
        statusItem.length = barView.contentWidth
    }

    // MARK: - Interaction

    @objc private func statusClicked() {
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            showMenu()
        } else {
            onOpenWindow()
        }
    }

    // Right-click / control-click → the conventional menu-bar affordance with a
    // Quit control (product decision #1: the app keeps running in the menu bar).
    private func showMenu() {
        let menu = NSMenu()
        let open = NSMenuItem(title: "Open Eos", action: #selector(openWindowAction), keyEquivalent: "")
        open.target = self
        menu.addItem(open)
        menu.addItem(.separator())
        let quit = NSMenuItem(title: "Quit Eos", action: #selector(quitAction), keyEquivalent: "q")
        quit.target = self
        menu.addItem(quit)
        statusItem.menu = menu
        statusItem.button?.performClick(nil)
        statusItem.menu = nil
    }

    @objc private func openWindowAction() { onOpenWindow() }
    @objc private func quitAction() { onQuit() }
}
