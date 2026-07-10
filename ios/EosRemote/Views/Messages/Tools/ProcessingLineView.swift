import SwiftUI
import EosRemoteKit

// Processing line (spec 03 §6.2, port of ProcessingLine.jsx). The activity anchor under the latest
// reply: an animated 4-point spark + a live M:SS elapsed while the worker is busy; a static (frozen-
// peak) spark when idle. Anchored at the foot of the transcript in WorkerDetailView. Elapsed mirrors
// the Mac dashboard (agentActivity.js): server clock minus the worker's daemon-stamped
// turn_started_at, so it survives app relaunch/reconnect and matches the Mac to the second. The
// server clock is estimated via TurnClock (event-frame ts offset — phone clock skew cancels out).
// A local start remains only as the fallback when no turn_started_at rides the worker row.
struct ProcessingLineView: View {
    let busy: Bool
    var turnStartedAt: Double? = nil
    var clock: TurnClock = TurnClock()

    @State private var localStart: Date?
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
        .onAppear {
            now = Date()
            if busy { localStart = Date() }
        }
        .onChange(of: busy) { _, isBusy in
            localStart = isBusy ? Date() : nil
            now = Date()
        }
        .onReceive(tick) { t in if busy { now = t } }
        .accessibilityLabel(busy ? "Working, \(elapsedText) elapsed" : "Idle")
    }

    private var elapsedText: String {
        let secs: Int
        if let turnStartedAt {
            secs = Int(clock.elapsedMs(turnStartedAt: turnStartedAt,
                                       deviceNowMs: now.timeIntervalSince1970 * 1000) / 1000)
        } else {
            secs = Int(now.timeIntervalSince(localStart ?? now))
        }
        return String(format: "%d:%02d", secs / 60, secs % 60)
    }
}
