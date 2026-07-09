import SwiftUI
import EosRemoteKit

// One user-run shell command (spec 03 §1 #12 / §6.6, port of TerminalCard.jsx). A mono card:
//   head:  ❯ + command + (running: a tc-spin spinner + a stop button / done: ✓ or ✗ {code})
//   body:  the output block (max-height scroll; auto-tails to the newest line while live)
//   foot:  a note / "output truncated" line when present
// Live blocks stream from the terminal overlay while the command runs; the durable block renders from
// the single `terminal` event the daemon appends on completion. .terminal-card border 1 radius 10 bg
// surface mono text-sm; tc-prompt amber (→waiting), tc-cmd fg, tc-exit ok/err tinted, tc-out max-h 280 (§10).
struct TerminalCardView: View {
    let terminal: Terminal
    let isLive: Bool
    // Best-effort interrupt for the stop button — see the note in `stopButton`.
    var onStop: (() -> Void)? = nil

    private var running: Bool { isLive && !terminal.done }
    private var ok: Bool { terminal.exitCode == 0 }

    // The note/truncated footer text (joined like the Mac: "{note} · output truncated").
    private var footer: String? {
        let parts = [terminal.note, terminal.truncated ? "output truncated" : nil].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            head
            if !terminal.output.isEmpty {
                outputBlock
            } else if running {
                Text("…").font(EosFont.code).foregroundStyle(EosColor.inkTertiary)
                    .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 10)
            }
            if let footer {
                Text(footer)
                    .font(EosFont.codeSmall).foregroundStyle(EosColor.inkTertiary)  // .tc-note text-xs fg-faint (§10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 14).padding(.bottom, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.surface)                                              // bg surface (§10)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))         // radius 10 (§10)
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(EosColor.hairline, lineWidth: 1)) // border 1 (§10)
        .accessibilityElement(children: .contain)
    }

    // .tc-head: prompt + command + (spinner + stop / exit badge).
    private var head: some View {
        HStack(spacing: EosSpacing.xs) {
            Text("❯").foregroundStyle(EosColor.State.waitingDot)                   // .tc-prompt amber→waiting (§10)
            Text(terminal.command)
                .foregroundStyle(EosColor.ink)                                    // .tc-cmd fg (§10)
                .lineLimit(2).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            if running {
                TerminalSpinner()                                                 // .tc-spin (§6.6)
                stopButton
            } else {
                exitBadge
            }
        }
        .font(EosFont.code)
        .padding(.horizontal, 14).padding(.vertical, 8)
    }

    // .tc-exit.ok → ✓ (ok + ok@12%); .tc-exit.err → ✗ {code} (err + err@12%) (§10).
    private var exitBadge: some View {
        let color = ok ? EosColor.State.runningDot : EosColor.State.failedDot
        return Text(ok ? "✓" : "✗ \(terminal.exitCode)")
            .font(EosFont.code).foregroundStyle(color)
            .padding(.horizontal, 6).padding(.vertical, 1)
            .background(color.opacity(0.12), in: RoundedRectangle(cornerRadius: 4, style: .continuous))
    }

    // Stop button. The Mac calls api.killTerminal(runId) — a UI-token-gated REST route (POST
    // /terminal/{runId}/kill) that the iOS control tunnel (room-capability gated, not UI-token) does not
    // expose. There is no terminal-kill route on mobile, so the button is best-effort: it fires the
    // existing worker-interrupt path (AppModel.interrupt) when wired, and is a faithful no-op otherwise.
    @ViewBuilder private var stopButton: some View {
        if let onStop {
            Button(action: onStop) {
                RoundedRectangle(cornerRadius: 1.5, style: .continuous)
                    .fill(EosColor.inkSecondary)
                    .frame(width: 9, height: 9)                                   // the Mac's 9×9 stop glyph
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Stop command")
        }
    }

    // .tc-out: the output block, mono, max-height 280 scroll, pre-wrap. Auto-tails to the newest line
    // while live via a ScrollViewReader anchored on the output length (§6.6).
    private var outputBlock: some View {
        ScrollViewReader { proxy in
            ScrollView(.vertical) {
                Text(terminal.output)
                    .font(EosFont.code).foregroundStyle(EosColor.inkSecondary)    // .tc-out fg-dim (§10)
                    .lineSpacing(3)                                               // line-height 1.6 (§10)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Color.clear.frame(height: 1).id(Self.tailAnchor)                  // auto-tail target
            }
            .frame(maxHeight: 280)                                                // max-height 280 (§10)
            .padding(.horizontal, 14).padding(.top, 4).padding(.bottom, 10)       // pad 4/14/10 (§10)
            .onChange(of: terminal.output) { _, _ in
                guard running else { return }
                withAnimation(.easeOut(duration: 0.12)) { proxy.scrollTo(Self.tailAnchor, anchor: .bottom) }
            }
            .onAppear {
                if running { proxy.scrollTo(Self.tailAnchor, anchor: .bottom) }
            }
        }
    }

    private static let tailAnchor = "tc-tail"
}

// .tc-spin: a 10×10 ring spinning 0.7s linear infinite, amber border with an amber top arc (verify-spin).
// Reproduced as a trimmed Circle stroke rotating forever; the static-peak fallback under Reduce Motion.
private struct TerminalSpinner: View {
    @State private var spin = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle()
            .trim(from: 0, to: 0.7)                                               // amber ring w/ a bright top arc
            .stroke(EosColor.State.waitingDot, style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
            .frame(width: 10, height: 10)                                         // 10×10 (§10)
            .rotationEffect(.degrees(spin ? 360 : 0))
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.linear(duration: 0.7).repeatForever(autoreverses: false)) { spin = true }
            }
            .accessibilityLabel("running")
    }
}
