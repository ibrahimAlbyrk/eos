import SwiftUI
import EosRemoteKit

// The shared action row for MESSAGE_ROW_KINDS (spec 03 §5.2, port of MessageRow.jsx). On the Mac it's
// hover-revealed; iOS has no hover, so the row is ALWAYS visible but muted beneath the message. It
// supplies: Copy (always → checkmark), Timestamp (relative; full datetime on long-press), and Rewind
// (user blocks only, and only if the worker's backend supports it — calls AppModel.rewind). Share/TTS/
// thumbs are omitted (not backed) — no dead buttons (§5.2 reconciliation).
struct MessageRowView<Content: View>: View {
    @EnvironmentObject private var model: AppModel

    let ts: Double
    let copyText: String
    var isUser: Bool = false
    var workerId: String? = nil
    /// Right-align the action row (user bubbles sit on the right).
    var trailing: Bool = false
    @ViewBuilder let content: () -> Content

    @State private var copied = false
    @State private var showFullTime = false
    @State private var rewinding = false
    @State private var rewindFailed = false

    private var worker: Worker? { workerId.flatMap { id in model.workers.first { $0.id == id } } }
    private var canRewind: Bool { isUser && BackendCaps.of(worker?.backendKind ?? "claude-cli").rewind }

    var body: some View {
        VStack(alignment: trailing ? .trailing : .leading, spacing: EosSpacing.xxs) {
            content()
            actionRow
        }
        .frame(maxWidth: .infinity, alignment: trailing ? .trailing : .leading)
    }

    private var actionRow: some View {
        HStack(spacing: EosSpacing.sm) {
            copyButton
            if canRewind { rewindButton }
            timestamp
        }
        .font(EosFont.captionSmall)
        .foregroundStyle(EosColor.inkTertiary)      // muted (.msg-action-btn fg-faint, §10)
    }

    private var copyButton: some View {
        Button {
            UIPasteboard.general.string = copyText
            flashCopied()
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .foregroundStyle(copied ? EosColor.State.runningDot : EosColor.inkTertiary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied" : "Copy message")
    }

    private var rewindButton: some View {
        Button {
            guard let id = workerId, !rewinding else { return }
            rewinding = true; rewindFailed = false
            Task {
                let ok = await model.rewind(workerId: id, text: copyText)
                rewinding = false
                if !ok { rewindFailed = true }
            }
        } label: {
            Image(systemName: "arrow.uturn.backward")
                .foregroundStyle(rewindFailed ? EosColor.State.failedDot
                                 : (rewinding ? EosColor.inkTertiary.opacity(0.5) : EosColor.inkTertiary))
        }
        .buttonStyle(.plain)
        .disabled(rewinding)
        .accessibilityLabel("Rewind to here")
    }

    // Relative by default; long-press flips to the absolute datetime (§5.2). .msg-time text-xs fg-faint.
    private var timestamp: some View {
        Text(showFullTime ? RelativeTime.absolute(ts) : RelativeTime.relative(ts))
            .foregroundStyle(EosColor.inkTertiary)
            .onLongPressGesture { showFullTime.toggle() }
            .accessibilityLabel(RelativeTime.absolute(ts))
    }

    private func flashCopied() {
        withAnimation(.easeOut(duration: 0.15)) { copied = true }
        Task {
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            withAnimation(.easeOut(duration: 0.15)) { copied = false }
        }
    }
}

// Time formatting (port of fmtTimeAgo). ts is epoch-ms. Non-generic so the formatters can be static.
enum RelativeTime {
    nonisolated(unsafe) private static let relFmt: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter(); f.unitsStyle = .abbreviated; return f
    }()
    nonisolated(unsafe) private static let absFmt: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; return f
    }()

    static func relative(_ tsMs: Double) -> String {
        guard tsMs > 0 else { return "" }
        let date = Date(timeIntervalSince1970: tsMs / 1000)
        if Date().timeIntervalSince(date) < 5 { return "now" }
        return relFmt.localizedString(for: date, relativeTo: Date())
    }
    static func absolute(_ tsMs: Double) -> String {
        guard tsMs > 0 else { return "" }
        return absFmt.string(from: Date(timeIntervalSince1970: tsMs / 1000))
    }
}
