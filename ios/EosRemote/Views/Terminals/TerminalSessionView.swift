import SwiftUI
import EosRemoteKit

// One daemon PTY session (Terminals → row), driven from the phone like Claude Code's Remote
// Control. Claude panes open on a native Chat face — the pane's transcript in the worker message
// views, a composer, and the pending question / plan card — with the raw Terminal mirror one
// segment away. Shell panes are Terminal-only. Pops when the pane exits.
struct TerminalSessionView: View {
    @EnvironmentObject private var model: AppModel
    let sessionId: String

    var body: some View {
        // Wrapper so the session model StateObject can capture AppModel at init (NewSessionView idiom).
        TerminalSessionContent(app: model, sessionId: sessionId)
    }
}

private enum Face: String, CaseIterable {
    case chat = "Chat", terminal = "Terminal"
}

private struct TerminalSessionContent: View {
    @ObservedObject var app: AppModel
    let sessionId: String

    @StateObject private var session: TerminalSessionModel
    @StateObject private var reveal = RevealLedger()
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var faceNamespace

    @State private var face: Face
    @State private var draft = ""
    @FocusState private var composerFocused: Bool
    @StateObject private var keyboard = MirrorKeyboard()
    // Bumped on reconnect: the mirror missed output while offline, so it replays from a clean screen.
    @State private var syncKey = 0
    @StateObject private var tail = TranscriptTailFollow()
    @State private var errorToast: String?
    @State private var viewedFile: ViewedFile?

    init(app: AppModel, sessionId: String) {
        self.app = app
        self.sessionId = sessionId
        _session = StateObject(wrappedValue: TerminalSessionModel(app: app, sessionId: sessionId))
        let isClaude = app.ptySessions.first { $0.id == sessionId }?.isClaude ?? true
        _face = State(initialValue: isClaude ? .chat : .terminal)
    }

    private var pty: PtySession? { app.ptySessions.first { $0.id == sessionId } }

    var body: some View {
        Group {
            switch face {
            case .chat: chatFace
            case .terminal: terminalFace
            }
        }
        .background(EosColor.bg.ignoresSafeArea().ignoresSafeArea(.keyboard, edges: .bottom))
        .safeAreaInset(edge: .top) { header }
        .task {
            reveal.bind(sessionId: "pty:\(sessionId)")
            session.start()
            try? await Task.sleep(nanoseconds: 350_000_000)
            reveal.markEntrySettled()
        }
        .onDisappear { session.stop() }
        .onChange(of: app.connected) { _, connected in
            guard connected else { return }
            syncKey += 1
            Task { await session.refresh() }
        }
        .onChange(of: app.ptySessions) {
            if app.ptySessionsLoaded && pty == nil { dismiss() }
        }
        .environment(\.openFile) { viewedFile = ViewedFile(path: $0) }
        .sheet(item: $viewedFile) { file in
            FileViewerSheet(path: file.path).environmentObject(app)
        }
    }

    // MARK: header — back · title/folder · Chat|Terminal switch (claude panes)

    private var header: some View {
        VStack(spacing: EosSpacing.xs) {
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: EosSpacing.sm) {
                    CircularIconButton(systemName: "chevron.backward", diameter: 40, glass: true,
                                       accessibilityLabel: "Back") { dismiss() }
                    Spacer()
                    VStack(spacing: 1) {
                        Text(pty?.displayTitle ?? "Terminal")
                            .font(EosFont.labelStrong)
                            .foregroundStyle(EosColor.ink)
                        if let cwd = pty?.cwd, !cwd.isEmpty {
                            Text(cwd.split(separator: "/").last.map(String.init) ?? cwd)
                                .font(EosFont.captionSmall)
                                .foregroundStyle(EosColor.inkTertiary)
                        }
                    }
                    .lineLimit(1)
                    Spacer()
                    Color.clear.frame(width: 40, height: 40)   // mirrors the back button; title centers
                }
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.top, EosSpacing.xs)
            if pty?.isClaude ?? true { faceSwitch }
            if !app.connected {
                OfflineChip(connecting: app.connecting, deviceLabel: app.activeDevice?.label)
            }
        }
        .padding(.bottom, EosSpacing.xs)
        .background {
            LinearGradient(colors: [EosColor.bg, EosColor.bg.opacity(0.9), EosColor.bg.opacity(0)],
                           startPoint: .top, endPoint: .bottom)
                .padding(.bottom, -16)         // §E1: fades 16pt past the bar row, no hard clip
                .ignoresSafeArea(edges: .top)
        }
    }

    // Glass segmented control; the selected segment is the FilterChip's soft-lifted capsule.
    private var faceSwitch: some View {
        HStack(spacing: 2) {
            ForEach(Face.allCases, id: \.self) { f in
                Button {
                    Haptics.tap()
                    composerFocused = false
                    withAnimation(reduceMotion ? nil : EosSpring.chip) { face = f }
                } label: {
                    Text(f.rawValue)
                        .font(EosFont.label)
                        .foregroundStyle(face == f ? EosColor.ink : EosColor.inkSecondary)
                        .padding(.horizontal, EosSpacing.md)
                        .padding(.vertical, 6)
                        .background {
                            if face == f {
                                Capsule().fill(EosColor.controlWash)
                                    .matchedGeometryEffect(id: "face", in: faceNamespace)
                            }
                        }
                        .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(face == f ? .isSelected : [])
            }
        }
        .padding(3)
        .glassEffect(.regular, in: .capsule)
    }

    // MARK: Chat face

    private var chatFace: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: EosSpacing.md) {
                    if session.loaded && session.blocks.isEmpty {
                        Text("No messages yet — send one to start.")
                            .font(EosFont.caption)
                            .foregroundStyle(EosColor.inkTertiary)
                            .frame(maxWidth: .infinity)
                            .padding(.top, EosSpacing.xxl)
                    }
                    ForEach(session.blocks) { MessageView(block: $0).id($0.id) }
                    ProcessingLineView(busy: session.running)
                        .padding(.top, EosSpacing.xxs)
                    Color.clear.frame(height: 1).id(TranscriptTailFollow.tailID)
                }
                .padding(.horizontal, EosSpacing.screenInset)
            }
            .environmentObject(reveal)
            .transcriptTailFollow(tail, proxy: proxy)
            .scrollDismissesKeyboard(.interactively)
            .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
            .safeAreaInset(edge: .bottom) { chatBottom }
        }
    }

    private var chatBottom: some View {
        VStack(spacing: EosSpacing.sm) {
            if let errorToast {
                Text(errorToast)
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.ink)
                    .padding(.horizontal, EosSpacing.sm)
                    .padding(.vertical, EosSpacing.xs)
                    .background(EosColor.surface3, in: Capsule())
                    .overlay(Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
                    .transition(.opacity)
            }
            if let prompt = session.prompt {
                PtyPromptCard(prompt: prompt,
                              onAnswer: { answers in
                                  let ok = await session.answer(prompt.toolUseId, answers)
                                  if !ok { showError("Couldn't send the answer") }
                                  return ok
                              },
                              onApprove: {
                                  let ok = await session.approvePlan(prompt.toolUseId)
                                  if !ok { showError("Couldn't approve the plan") }
                                  return ok
                              },
                              onAnswerInTerminal: { face = .terminal })
                    .id(prompt.toolUseId)
            }
            ChatComposer(text: $draft, placeholder: "Message Claude", trailing: trailingAction,
                         focused: $composerFocused)
        }
        .disabled(!app.connected)
        .opacity(app.connected ? 1 : 0.55)
        .padding(.horizontal, EosSpacing.screenInset)
        .padding(.bottom, EosSpacing.xs)
        .background {
            LinearGradient(colors: [.clear, EosColor.bg], startPoint: .top, endPoint: .bottom)
                .padding(.top, -24)             // §E2: 24pt overshoot above the stack
                .ignoresSafeArea(edges: .bottom)
        }
    }

    // D-15 idiom: running + empty field ⇒ interrupt (Esc); with text the message queues in Claude.
    private var trailingAction: ComposerAction {
        let trimmed = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        if session.running && trimmed.isEmpty {
            return .interrupt({ Haptics.tap(); session.interrupt() })
        }
        return .send(enabled: !trimmed.isEmpty, send)
    }

    private func send() {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        draft = ""
        composerFocused = false
        Haptics.success()
        Task {
            switch await session.send(text) {
            case .sent: break
            case .rejected:
                showError(session.prompt != nil ? "Answer Claude's question first"
                                                : "Claude isn't running in this terminal")
            case .failed: showError("Couldn't send the message")
            }
        }
    }

    // MARK: Terminal face

    private var terminalFace: some View {
        GeometryReader { geo in
            let cols = pty?.cols ?? 120
            let rows = pty?.rows ?? 32
            let fontSize = MirrorMetrics.fitSize(cols: cols, width: geo.size.width - 2 * EosSpacing.xs)
            let grid = MirrorMetrics.gridSize(cols: cols, rows: rows, fontSize: fontSize)
            // Taller than the viewport (landscape, keyboard up): the grid scrolls as a whole and the
            // emulator's own scrollback stays off — nested vertical scrolling can't hand off.
            let fits = grid.height <= geo.size.height
            ScrollView(.vertical) {
                TerminalMirrorView(session: session, cols: cols, rows: rows, fontSize: fontSize,
                                   scrollable: fits, syncKey: syncKey, keyboard: keyboard)
                    .frame(width: grid.width, height: grid.height)
                    .frame(maxWidth: .infinity)
            }
            .scrollDisabled(fits)
            .defaultScrollAnchor(.bottom)
        }
        .safeAreaInset(edge: .bottom) {
            TerminalKeyStrip(keyboard: keyboard) { session.sendInput($0) }
                .disabled(!app.connected)
                .opacity(app.connected ? 1 : 0.55)
        }
    }

    // MARK: helpers

    private func showError(_ message: String) {
        withAnimation(.easeOut(duration: 0.15)) { errorToast = message }
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if errorToast == message {
                withAnimation(.easeOut(duration: 0.15)) { errorToast = nil }
            }
        }
    }
}

// Glass key strip under the mirror (rides above the keyboard): the keys a phone keyboard lacks,
// plus the keyboard toggle.
private struct TerminalKeyStrip: View {
    @ObservedObject var keyboard: MirrorKeyboard
    let onKey: (String) -> Void

    private struct Key {
        let label: String
        let symbol: String?
        let bytes: String
        let name: String
    }

    private static let keys: [Key] = [
        Key(label: "esc", symbol: nil, bytes: "\u{1b}", name: "Escape"),
        Key(label: "tab", symbol: nil, bytes: "\t", name: "Tab"),
        Key(label: "⇧tab", symbol: nil, bytes: "\u{1b}[Z", name: "Shift-Tab"),
        Key(label: "", symbol: "arrow.up", bytes: "\u{1b}[A", name: "Up arrow"),
        Key(label: "", symbol: "arrow.down", bytes: "\u{1b}[B", name: "Down arrow"),
        Key(label: "", symbol: "arrow.left", bytes: "\u{1b}[D", name: "Left arrow"),
        Key(label: "", symbol: "arrow.right", bytes: "\u{1b}[C", name: "Right arrow"),
        Key(label: "⌃C", symbol: nil, bytes: "\u{3}", name: "Control-C"),
        Key(label: "", symbol: "return", bytes: "\r", name: "Return"),
    ]

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            GlassEffectContainer(spacing: 6) {
                HStack(spacing: 6) {
                    key(symbol: keyboard.isUp ? "keyboard.chevron.compact.down" : "keyboard",
                        name: keyboard.isUp ? "Hide keyboard" : "Show keyboard") { keyboard.toggle() }
                    ForEach(Self.keys, id: \.bytes) { k in
                        key(label: k.label, symbol: k.symbol, name: k.name) { onKey(k.bytes) }
                    }
                }
                .padding(.horizontal, EosSpacing.screenInset)
            }
        }
        .scrollClipDisabled()
        .padding(.vertical, EosSpacing.xs)
    }

    private func key(label: String = "", symbol: String? = nil, name: String,
                     action: @escaping () -> Void) -> some View {
        Button {
            Haptics.tap()
            action()
        } label: {
            Group {
                if let symbol {
                    Image(systemName: symbol).font(.system(size: 14, weight: .medium))
                } else {
                    Text(label).font(EosFont.code)
                }
            }
            .foregroundStyle(EosColor.ink)
            .frame(minWidth: 40, minHeight: 36)
            .padding(.horizontal, 4)
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: .capsule)
        .accessibilityLabel(name)
    }
}
