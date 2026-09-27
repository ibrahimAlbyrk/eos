import SwiftUI
import UIKit
import SwiftTerm
import EosRemoteKit

// Terminal face: a SwiftTerm emulator mirroring a daemon PTY. The phone never resizes the PTY — the
// emulator runs at the PTY's cols×rows and the font is sized so `cols` fits the width
// (MirrorMetrics). Attach = subscribe to pty:data, replay GET /pty/:id/buffer, then live frames past
// the buffer's seq (PtyReplayGate); bumping `syncKey` re-runs it from a clean screen (reconnect).
// Keystrokes go out through the session's coalesced input queue.
struct TerminalMirrorView: UIViewRepresentable {
    let session: TerminalSessionModel
    let cols: Int
    let rows: Int
    let fontSize: CGFloat
    let scrollable: Bool
    let syncKey: Int
    let keyboard: MirrorKeyboard

    // The desktop Code view's ANSI palette (TermGrid.jsx), so panes read the same on both.
    private static let palette: [SwiftTerm.Color] = [
        0x1c1c1c, 0xc47f79, 0x6fae86, 0xc9a163, 0x6ea4e8, 0xc8a2ff, 0x5cb8c4, 0xcccccc,
        0x6b6b6b, 0xe0958e, 0x8cc9a2, 0xe3bd7e, 0x8ab9f0, 0xdcbfff, 0x7fd0da, 0xf5f5f5,
    ].map { (hex: UInt32) in
        // 16-bit channels: 0xff × 257 = 0xffff.
        SwiftTerm.Color(red: UInt16(hex >> 16 & 0xff) * 257, green: UInt16(hex >> 8 & 0xff) * 257,
                        blue: UInt16(hex & 0xff) * 257)
    }

    func makeCoordinator() -> Coordinator { Coordinator(session: session) }

    func makeUIView(context: Context) -> MirrorTerminalView {
        let view = MirrorTerminalView(frame: .zero)
        view.terminalDelegate = context.coordinator
        view.inputAccessoryView = nil               // TerminalKeyStrip replaces SwiftTerm's accessory
        view.allowMouseReporting = false            // a tap focuses the mirror, it never clicks the desktop app
        view.keyboardAppearance = .dark
        view.backgroundColor = UIColor(EosColor.bg)
        view.nativeBackgroundColor = UIColor(EosColor.bg)
        view.nativeForegroundColor = UIColor(EosColor.ink)
        view.caretColor = UIColor(EosColor.coral)
        view.installColors(Self.palette)
        view.grid = (cols, rows)
        view.onFocusChange = { [weak keyboard] up in
            // Responder changes can land mid view-update (e.g. removal) — publish on the next turn.
            DispatchQueue.main.async { keyboard?.isUp = up }
        }
        keyboard.view = view
        context.coordinator.view = view
        context.coordinator.syncKey = syncKey
        context.coordinator.attach()
        return view
    }

    func updateUIView(_ view: MirrorTerminalView, context: Context) {
        let coordinator = context.coordinator
        if view.font.pointSize != fontSize { view.setFonts(MirrorMetrics.fontSet(fontSize)) }
        view.grid = (cols, rows)
        view.isScrollEnabled = scrollable
        if coordinator.syncKey != syncKey {
            coordinator.syncKey = syncKey
            coordinator.attach()
        }
    }

    static func dismantleUIView(_ view: MirrorTerminalView, coordinator: Coordinator) {
        coordinator.detach()
    }

    @MainActor
    final class Coordinator: NSObject, @preconcurrency TerminalViewDelegate {
        let session: TerminalSessionModel
        weak var view: MirrorTerminalView?
        var syncKey = 0
        private var gate = PtyReplayGate()
        private var attachId = 0

        init(session: TerminalSessionModel) { self.session = session }

        // (Re)attach: stream on → buffer replay, live frames held by the gate meanwhile. A re-sync
        // starts from a clean screen since the replay redraws everything.
        func attach() {
            attachId += 1
            let id = attachId
            gate = PtyReplayGate()
            if id > 1 { view?.getTerminal().resetToInitialState() }
            session.onOutput = { [weak self] seq, data in
                guard let self else { return }
                self.write(self.gate.frame(seq: seq, data: data))
            }
            Task {
                await session.setStreaming(true)
                let buffer = await session.fetchBuffer()
                guard id == attachId else { return }
                write(gate.replay(seq: buffer?.seq ?? 0, data: buffer?.data ?? ""))
            }
        }

        func detach() {
            attachId += 1
            session.onOutput = nil
            Task { await session.setStreaming(false) }
        }

        private func write(_ chunks: [String]) {
            for chunk in chunks { view?.feed(text: chunk) }
        }

        func send(source: TerminalView, data: ArraySlice<UInt8>) {
            session.sendInput(String(decoding: data, as: UTF8.self))
        }

        func requestOpenLink(source: TerminalView, link: String, params: [String: String]) {
            if let url = URL(string: link) { UIApplication.shared.open(url) }
        }

        func bell(source: TerminalView) {}   // replayed history is full of bells — stay quiet
        func sizeChanged(source: TerminalView, newCols: Int, newRows: Int) {}
        func setTerminalTitle(source: TerminalView, title: String) {}
        func hostCurrentDirectoryUpdate(source: TerminalView, directory: String?) {}
        func scrolled(source: TerminalView, position: Double) {}
        func rangeChanged(source: TerminalView, startY: Int, endY: Int) {}
        func clipboardCopy(source: TerminalView, content: Data) {}
    }
}

// The mirror's first-responder state for the key strip's keyboard toggle. A handle rather than a
// binding driving the responder: SwiftTerm focuses itself on tap, and a binding would race it.
@MainActor
final class MirrorKeyboard: ObservableObject {
    @Published fileprivate(set) var isUp = false
    fileprivate weak var view: UIView?

    func toggle() {
        guard let view else { return }
        _ = view.isFirstResponder ? view.resignFirstResponder() : view.becomeFirstResponder()
    }
}

// The SwiftTerm view with the mirror's guarantees layered on.
final class MirrorTerminalView: TerminalView {
    var grid = (cols: 120, rows: 32)
    var onFocusChange: ((Bool) -> Void)?

    // The emulator answers terminal queries (cursor position, device attributes, colors) on its
    // own — including every query in the replayed history. The desktop terminal already answers the
    // live ones, so a mirror forwarding these would type stray escape sequences into the PTY. User
    // keystrokes reach the delegate directly and are unaffected.
    override func send(source: SwiftTerm.Terminal, data: ArraySlice<UInt8>) {}

    // SwiftTerm derives cols/rows from the frame; pin them to the PTY's grid in case the frame
    // math rounds a cell off.
    override func layoutSubviews() {
        super.layoutSubviews()
        let terminal = getTerminal()
        if terminal.cols != grid.cols || terminal.rows != grid.rows {
            terminal.resize(cols: grid.cols, rows: grid.rows)
        }
    }

    override func becomeFirstResponder() -> Bool {
        let became = super.becomeFirstResponder()
        if became { onFocusChange?(true) }
        return became
    }

    override func resignFirstResponder() -> Bool {
        let resigned = super.resignFirstResponder()
        if resigned { onFocusChange?(false) }
        return resigned
    }
}

// Cell metrics computed exactly as the pinned SwiftTerm does (computeFontDimensions: the "W"
// advance, ceil'd line height), so a frame of cols×rows cells maps back to the PTY's grid.
enum MirrorMetrics {
    static func font(_ size: CGFloat, bold: Bool = false) -> UIFont {
        UIFont(name: bold ? "JetBrainsMono-Bold" : "JetBrainsMono-Regular", size: size)
            ?? .monospacedSystemFont(ofSize: size, weight: bold ? .bold : .regular)
    }

    static func fontSet(_ size: CGFloat) -> (UIFont, UIFont, UIFont, UIFont) {
        let regular = font(size), bold = font(size, bold: true)
        return (regular, bold, regular, bold)
    }

    static func cell(_ size: CGFloat) -> CGSize {
        let f = font(size)
        let height = ceil(CTFontGetAscent(f) + CTFontGetDescent(f) + CTFontGetLeading(f))
        let width = "W".size(withAttributes: [.font: f]).width
        return CGSize(width: max(1, width), height: max(1, height))
    }

    // Largest size (0.25pt steps) whose `cols` cells fit `width`.
    static func fitSize(cols: Int, width: CGFloat) -> CGFloat {
        var size = max(2, width / CGFloat(cols) / 0.6)
        while size > 2 && cell(size).width * CGFloat(cols) > width { size -= 0.25 }
        return size
    }

    // +0.5pt so SwiftTerm's Int(frame / cell) floors to exactly cols×rows.
    static func gridSize(cols: Int, rows: Int, fontSize: CGFloat) -> CGSize {
        let c = cell(fontSize)
        return CGSize(width: c.width * CGFloat(cols) + 0.5, height: c.height * CGFloat(rows) + 0.5)
    }
}

extension MirrorTerminalView {
    func setFonts(_ set: (UIFont, UIFont, UIFont, UIFont)) {
        setFonts(normal: set.0, bold: set.1, italic: set.2, boldItalic: set.3)
    }
}
