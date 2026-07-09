import SwiftUI

// Processing line (spec 03 §6.2, port of ProcessingLine.jsx). The activity anchor under the latest
// reply: an animated 4-point spark + a live M:SS elapsed while the worker is busy; a static (frozen-
// peak) spark when idle. Anchored at the foot of the transcript in WorkerDetailView. Elapsed is a local
// clock started when `busy` flips on — the daemon carries no turn-start timestamp to the client.
struct ProcessingLineView: View {
    let busy: Bool

    @State private var start: Date?
    @State private var now = Date()
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    var body: some View {
        HStack(spacing: 7) {                                                   // .thinking-line gap 7 (§10)
            SparkView(size: 22, animated: busy)                               // static when idle (§6.2)
            if busy {
                Text(elapsedText)
                    .font(EosFont.mono).foregroundStyle(EosColor.inkTertiary)  // text-sm fg-faint (§10)
                    .monospacedDigit()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onAppear { if busy { start = Date() } }
        .onChange(of: busy) { _, isBusy in
            start = isBusy ? Date() : nil
            now = Date()
        }
        .onReceive(tick) { t in if busy { now = t } }
        .accessibilityLabel(busy ? "Working, \(elapsedText) elapsed" : "Idle")
    }

    private var elapsedText: String {
        let secs = Int(now.timeIntervalSince(start ?? now))
        return String(format: "%d:%02d", secs / 60, secs % 60)
    }
}
