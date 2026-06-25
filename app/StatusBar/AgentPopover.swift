// Presentation layer — the native liquid-glass NSPopover that lists agents.
// Built from the latest /workers snapshot (same stream that drives the icon, so
// it updates live while open). A row click focuses that agent in Eos via the
// AgentNavigator port — the proven deep-link path, never a second web runtime.

import Cocoa

// One agent as the popover renders it — derived from an AgentSnapshot.
private struct AgentRowModel {
    enum Kind { case running, failed, done, idle, suspended, killing }
    let id: String
    let name: String
    let activity: String
    let kind: Kind
    let startMs: Double?
    let busy: Bool
    let endMs: Double?
    var rank: Int { kind == .running ? 0 : (kind == .failed ? 1 : 2) }

    func elapsedSeconds(now: Double) -> Int {
        let start = startMs ?? now
        let end = busy ? now : (endMs ?? now)
        return max(0, Int((end - start) / 1000))
    }
}

private func mmss(_ s: Int) -> String { String(format: "%d:%02d", s / 60, s % 60) }

final class AgentPopover: NSObject, NSPopoverDelegate {
    private let WIDTH: CGFloat = 296
    private let rowH: CGFloat = 46
    private let maxListH: CGFloat = 230
    private let pad: CGFloat = 7

    private let popover = NSPopover()
    private let brandImage: NSImage?

    // Wired to the navigator by the coordinator.
    var onFocus: ((String) -> Void)?

    private let container = FlippedView()
    private let glass = NSVisualEffectView()
    private let titleMeta = NSTextField(labelWithString: "")
    private let chipsLabel = NSTextField(labelWithString: "")
    private let listDoc = FlippedView()
    private let scroll = NSScrollView()
    private let emptyLabel = NSTextField(labelWithString: "No active agents · quiet on the fleet")

    private var models: [AgentRowModel] = []
    private var rowViews: [AgentRowView] = []
    private var selection = -1
    private var keyMonitor: Any?
    private var elapsedTimer: Timer?

    var isShown: Bool { popover.isShown }

    init(brandImage: NSImage?) {
        self.brandImage = brandImage
        super.init()
        buildChrome()
        popover.behavior = .transient
        popover.delegate = self
        let vc = NSViewController()
        vc.view = glass
        popover.contentViewController = vc
        layoutChrome(listHeight: 0, hasRows: false)
    }

    // MARK: - Public

    func update(snapshots: [AgentSnapshot]) {
        models = order(snapshots.map(rowModel(from:)))
        renderHeader(snapshots)
        renderRows()
        if selection >= models.count { selection = models.count - 1 }
        highlight()
    }

    // positioningRect is the visible dawn-star's frame in `button` coordinates,
    // so the caret points at the star's centre (not the button centre — which is
    // offset left whenever a running count sits to the glyph's left).
    func show(from button: NSStatusBarButton, positioningRect: NSRect) {
        selection = -1
        popover.show(relativeTo: positioningRect, of: button, preferredEdge: .minY)
        installKeyMonitor()
        elapsedTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            self?.refreshTimes()
        }
        highlight()
    }

    func close() { popover.close() }

    func popoverDidClose(_ notification: Notification) {
        if let m = keyMonitor { NSEvent.removeMonitor(m); keyMonitor = nil }
        elapsedTimer?.invalidate(); elapsedTimer = nil
        selection = -1
    }

    // MARK: - Chrome

    private func buildChrome() {
        glass.material = .popover
        glass.blendingMode = .behindWindow
        glass.state = .active
        glass.wantsLayer = true
        glass.layer?.cornerRadius = 12
        glass.layer?.masksToBounds = true
        glass.layer?.borderWidth = 1
        glass.layer?.borderColor = NSColor(white: 1, alpha: 0.10).cgColor

        container.autoresizingMask = [.width, .height]
        glass.addSubview(container)

        if let img = brandImage {
            let mark = NSImageView(frame: NSRect(x: pad + 1, y: pad + 1, width: 19, height: 19))
            mark.image = img
            mark.imageScaling = .scaleProportionallyUpOrDown
            mark.wantsLayer = true
            mark.tag = 901
            container.addSubview(mark)
        }
        let title = NSTextField(labelWithString: "Eos")
        title.font = .systemFont(ofSize: 14, weight: .bold)
        title.textColor = .labelColor
        title.frame = NSRect(x: pad + 27, y: pad + 1, width: 80, height: 19)
        container.addSubview(title)

        titleMeta.font = .monospacedSystemFont(ofSize: 11, weight: .regular)
        titleMeta.textColor = .secondaryLabelColor
        titleMeta.alignment = .right
        container.addSubview(titleMeta)

        chipsLabel.font = .monospacedSystemFont(ofSize: 10.5, weight: .semibold)
        chipsLabel.textColor = .secondaryLabelColor
        container.addSubview(chipsLabel)

        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = listDoc
        container.addSubview(scroll)

        emptyLabel.font = .systemFont(ofSize: 12.5)
        emptyLabel.textColor = .tertiaryLabelColor
        emptyLabel.alignment = .center
        emptyLabel.isHidden = true
        container.addSubview(emptyLabel)

        let foot = NSTextField(labelWithString: "↑↓ select   ↵ focus in Eos   esc close")
        foot.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
        foot.textColor = .tertiaryLabelColor
        foot.tag = 902
        container.addSubview(foot)
    }

    private func layoutChrome(listHeight: CGFloat, hasRows: Bool) {
        let headerH: CGFloat = 30, chipsH: CGFloat = 24, sepGap: CGFloat = 8, footH: CGFloat = 22
        let listH = hasRows ? listHeight : 56
        let total = pad + headerH + chipsH + sepGap + listH + footH + pad
        glass.frame = NSRect(x: 0, y: 0, width: WIDTH, height: total)
        container.frame = glass.bounds
        let innerW = WIDTH - pad * 2

        titleMeta.frame = NSRect(x: WIDTH - pad - 130, y: pad + 2, width: 130, height: 16)
        chipsLabel.frame = NSRect(x: pad + 1, y: pad + headerH, width: innerW, height: chipsH - 6)

        let listY = pad + headerH + chipsH + sepGap
        scroll.frame = NSRect(x: pad - 1, y: listY, width: innerW + 2, height: listH)
        listDoc.frame = NSRect(x: 0, y: 0, width: scroll.contentSize.width, height: max(listH, CGFloat(models.count) * rowH))
        emptyLabel.frame = NSRect(x: pad, y: listY + 18, width: innerW, height: 20)
        emptyLabel.isHidden = hasRows

        if let foot = container.viewWithTag(902) {
            foot.frame = NSRect(x: pad + 1, y: total - pad - footH + 4, width: innerW, height: 16)
        }
        popover.contentSize = NSSize(width: WIDTH, height: total)
    }

    // MARK: - Rendering

    private func renderHeader(_ snapshots: [AgentSnapshot]) {
        let run = snapshots.filter { $0.state.isBusy }.count
        let failed = snapshots.filter { $0.state == .done && ($0.exitCode ?? 0) != 0 }.count
        let done = snapshots.filter { ($0.state == .done && ($0.exitCode ?? 0) == 0) || $0.state == .idle }.count
        titleMeta.stringValue = run > 0 ? "\(run) running" : (snapshots.isEmpty ? "idle" : "all settled")
        var parts = ["● \(run) running", "✓ \(done) done"]
        if failed > 0 { parts.append("✕ \(failed) failed") }
        chipsLabel.stringValue = parts.joined(separator: "   ")
    }

    private func renderRows() {
        for v in rowViews { v.removeFromSuperview() }
        rowViews.removeAll()
        let now = Date().timeIntervalSince1970 * 1000
        let listW = scroll.contentSize.width
        for (i, m) in models.enumerated() {
            let row = AgentRowView(frame: NSRect(x: 0, y: CGFloat(i) * rowH, width: listW, height: rowH))
            row.configure(name: m.name, activity: m.activity, kind: m.kind,
                          time: mmss(m.elapsedSeconds(now: now)))
            row.onClick = { [weak self] in self?.focus(index: i) }
            row.onHover = { [weak self] in self?.selection = i; self?.highlight() }
            listDoc.addSubview(row)
            rowViews.append(row)
        }
        let listVisible = min(CGFloat(models.count) * rowH, maxListH)
        layoutChrome(listHeight: listVisible, hasRows: !models.isEmpty)
        listDoc.frame = NSRect(x: 0, y: 0, width: listW, height: max(listVisible, CGFloat(models.count) * rowH))
    }

    private func refreshTimes() {
        let now = Date().timeIntervalSince1970 * 1000
        for (i, m) in models.enumerated() where i < rowViews.count {
            rowViews[i].setTime(mmss(m.elapsedSeconds(now: now)))
        }
    }

    private func highlight() {
        for (i, v) in rowViews.enumerated() { v.setSelected(i == selection) }
    }

    // MARK: - Interaction

    private func focus(index: Int) {
        guard index >= 0, index < models.count else { return }
        onFocus?(models[index].id)
        close()
    }

    private func installKeyMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self = self, self.popover.isShown else { return event }
            switch event.keyCode {
            case 126: self.move(-1); return nil          // up
            case 125: self.move(1); return nil           // down
            case 36, 76: self.focus(index: self.selection); return nil   // return / enter
            case 53: self.close(); return nil            // esc
            default: return event
            }
        }
    }

    private func move(_ delta: Int) {
        guard !models.isEmpty else { return }
        if selection < 0 { selection = delta > 0 ? 0 : models.count - 1 }
        else { selection = max(0, min(models.count - 1, selection + delta)) }
        highlight()
        if selection < rowViews.count { scroll.contentView.scrollToVisible(rowViews[selection].frame) }
    }

    // MARK: - Model derivation

    private func rowModel(from s: AgentSnapshot) -> AgentRowModel {
        let kind: AgentRowModel.Kind
        let activity: String
        switch s.state {
        case .spawning: kind = .running; activity = "Spawning…"
        case .working:  kind = .running; activity = s.definition.map { "Working · \($0)" } ?? "Working"
        case .ending:   kind = .running; activity = "Wrapping up…"
        case .idle:     kind = .idle;    activity = "Idle · awaiting input"
        case .done:
            if (s.exitCode ?? 0) != 0 { kind = .failed; activity = "Stopped · needs attention" }
            else { kind = .done; activity = "Finished · changes ready" }
        case .suspended: kind = .suspended; activity = "Suspended · resumable"
        case .killing:   kind = .killing;   activity = "Stopping…"
        }
        let act = s.isOrchestrator ? "Orchestrator · \(activity)" : activity
        return AgentRowModel(id: s.id, name: s.displayName, activity: act, kind: kind,
                             startMs: s.turnStartedAt ?? s.startedAt, busy: s.state.isBusy, endMs: s.endedAt)
    }

    private func order(_ rows: [AgentRowModel]) -> [AgentRowModel] {
        let now = Date().timeIntervalSince1970 * 1000
        return rows.sorted {
            $0.rank != $1.rank ? $0.rank < $1.rank
                               : $0.elapsedSeconds(now: now) > $1.elapsedSeconds(now: now)
        }
    }
}

// A top-left-origin container so the popover lays out top-down.
final class FlippedView: NSView { override var isFlipped: Bool { true } }

// MARK: - Status dot (spinner / check / cross / dim)

private final class DotView: NSView {
    private let shape = CAShapeLayer()
    override var isFlipped: Bool { true }
    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        shape.fillColor = nil
        shape.lineCap = .round
        layer?.addSublayer(shape)
    }
    required init?(coder: NSCoder) { fatalError() }

    func configure(kind: AgentRowModel.Kind, appearance: NSAppearance) {
        shape.removeAnimation(forKey: "spin")
        let ok = BarPalette.ok(appearance).cgColor
        let err = BarPalette.err(appearance).cgColor
        let dim = NSColor.tertiaryLabelColor.cgColor
        let c = bounds.width / 2
        switch kind {
        case .running:
            shape.path = ringPath(center: c, radius: 6, gapStart: 0.18, gapEnd: 0.95)
            shape.strokeColor = ok; shape.fillColor = nil; shape.lineWidth = 1.7
            let spin = CABasicAnimation(keyPath: "transform.rotation.z")
            spin.fromValue = 0; spin.toValue = 2 * Double.pi
            spin.duration = 1.15; spin.repeatCount = .infinity
            shape.frame = bounds
            shape.add(spin, forKey: "spin")
        case .failed:
            shape.path = DawnStar.crossPath(size: 14)
            shape.strokeColor = err; shape.fillColor = nil; shape.lineWidth = 2
            shape.frame = NSRect(x: c - 7, y: c - 7, width: 14, height: 14)
        case .done, .idle:
            shape.path = DawnStar.checkPath(size: 14)
            shape.strokeColor = ok; shape.fillColor = nil; shape.lineWidth = 2
            shape.frame = NSRect(x: c - 7, y: c - 7, width: 14, height: 14)
        case .suspended, .killing:
            shape.path = CGPath(ellipseIn: CGRect(x: c - 3, y: c - 3, width: 6, height: 6), transform: nil)
            shape.fillColor = dim; shape.strokeColor = nil
            shape.frame = bounds
        }
    }

    private func ringPath(center: CGFloat, radius: CGFloat, gapStart: CGFloat, gapEnd: CGFloat) -> CGPath {
        let p = CGMutablePath()
        p.addArc(center: CGPoint(x: center, y: center), radius: radius,
                 startAngle: CGFloat(gapStart) * 2 * .pi, endAngle: CGFloat(gapEnd) * 2 * .pi, clockwise: false)
        return p
    }
}

// MARK: - One agent row

private final class AgentRowView: NSView {
    var onClick: (() -> Void)?
    var onHover: (() -> Void)?

    private let dot = DotView(frame: NSRect(x: 8, y: 14, width: 17, height: 17))
    private let nameLabel = NSTextField(labelWithString: "")
    private let actLabel = NSTextField(labelWithString: "")
    private let timeLabel = NSTextField(labelWithString: "")
    private let chevron = NSTextField(labelWithString: "›")
    private var kind: AgentRowModel.Kind = .running
    private var selected = false

    override var isFlipped: Bool { true }

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        layer?.cornerRadius = 7

        nameLabel.font = .monospacedSystemFont(ofSize: 12.5, weight: .semibold)
        nameLabel.textColor = .labelColor
        nameLabel.lineBreakMode = .byTruncatingTail
        actLabel.font = .systemFont(ofSize: 11.5)
        actLabel.textColor = .secondaryLabelColor
        actLabel.lineBreakMode = .byTruncatingTail
        timeLabel.font = .monospacedSystemFont(ofSize: 11.5, weight: .regular)
        timeLabel.textColor = .secondaryLabelColor
        timeLabel.alignment = .right
        chevron.font = .systemFont(ofSize: 13)
        chevron.textColor = .tertiaryLabelColor
        chevron.alphaValue = 0
        for v in [dot, nameLabel, actLabel, timeLabel, chevron] { addSubview(v) }
        layoutPieces()
    }
    required init?(coder: NSCoder) { fatalError() }

    override func layout() { super.layout(); layoutPieces() }

    private func layoutPieces() {
        let w = bounds.width
        dot.frame = NSRect(x: 8, y: (rowHeight - 17) / 2, width: 17, height: 17)
        chevron.frame = NSRect(x: w - 16, y: 14, width: 12, height: 18)
        timeLabel.frame = NSRect(x: w - 16 - 6 - 46, y: 14, width: 46, height: 18)
        let bodyX: CGFloat = 35
        let bodyW = timeLabel.frame.minX - 8 - bodyX
        nameLabel.frame = NSRect(x: bodyX, y: 7, width: bodyW, height: 16)
        actLabel.frame = NSRect(x: bodyX, y: 24, width: bodyW, height: 15)
    }

    private var rowHeight: CGFloat { bounds.height }

    func configure(name: String, activity: String, kind: AgentRowModel.Kind, time: String) {
        self.kind = kind
        nameLabel.stringValue = name
        actLabel.stringValue = activity
        timeLabel.stringValue = time
        timeLabel.textColor = kind == .failed ? BarPalette.err(effectiveAppearance)
                            : (kind == .done ? BarPalette.ok(effectiveAppearance) : .secondaryLabelColor)
        dot.configure(kind: kind, appearance: effectiveAppearance)
        ensureTracking()
    }

    func setTime(_ t: String) { timeLabel.stringValue = t }

    func setSelected(_ value: Bool) {
        selected = value
        chevron.alphaValue = value ? 0.7 : 0
        if value {
            layer?.backgroundColor = NSColor(white: 0.5, alpha: 0.12).cgColor
            layer?.borderWidth = 1
            layer?.borderColor = BarPalette.accent(effectiveAppearance).withAlphaComponent(0.55).cgColor
        } else {
            layer?.backgroundColor = NSColor.clear.cgColor
            layer?.borderWidth = 0
        }
    }

    private func ensureTracking() {
        for t in trackingAreas { removeTrackingArea(t) }
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
    }
    override func mouseEntered(with event: NSEvent) { onHover?() }
    override func mouseUp(with event: NSEvent) { onClick?() }
}
