import SwiftUI
import EosRemoteKit

// The dynamic-loop family (spec 03 §1 #10/#11 + the top-of-transcript LoopStatus row + the foot
// GoalCheckLine). Four surfaces, all from the loop-status/loop-check CSS in §10:
//   • MessageLoopView    — the collapsible "Dynamic loop — automated goal-check" re-trigger row (#10).
//   • LoopCheckLineView  — the thin per-attempt verdict marker inline in the scrollback (#11).
//   • LoopStatusCardView — the transcript-top status card off worker.loop + attempt history.
//   • GoalCheckLineView  — the live goal-check line shown in the ProcessingLine region on idle.
// Colors follow §0.3: state color is reserved for run-state (met→running, escalated→waiting).

// MARK: - #10 MessageLoopView — collapsible re-trigger row (port of MessageLoop.jsx)

// A dynamic-loop automated re-trigger delivered into the worker's chat. Rendered as a distinct
// collapsible system row (NOT a user bubble) so the human watching can tell it apart from their own
// input: verb label + chevron; expanded → the re-trigger text (report-detail body).
struct MessageLoopView: View {
    let text: String
    @State private var open = false

    var body: some View {
        DisclosureRowView(open: $open) {
            Text("Dynamic loop — automated goal-check")
                .font(EosFont.label).foregroundStyle(EosColor.inkSecondary)     // .ti-verb fg-dim (§10)
        } content: {
            if !text.isEmpty {
                Text(text)
                    .font(EosFont.body).foregroundStyle(EosColor.ink)           // report-detail body (§10)
                    .lineSpacing(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 4)
                    .textSelection(.enabled)
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - #11 LoopCheckLineView — durable per-attempt verdict marker (port of LoopCheckBlock)

// A durable per-attempt goal-check verdict, rendered inline as a thin marker (like the git push/pull
// lines) so the scrollback keeps a record of every check at its chronological position:
//   icon (✓ met / ! escalated / · unmet) + "Goal check · attempt N/M · {outcome}" + reason.
// .loop-check-line text-xs fg-dim, gap 6; ok→ok icon, escalated→warn icon (§10).
struct LoopCheckLineView: View {
    let check: LoopCheck

    private var escalated: Bool { check.outcome == "escalated" }
    private var icon: String { check.met ? "✓" : (escalated ? "!" : "·") }
    private var iconColor: Color {
        check.met ? EosColor.State.runningDot : (escalated ? EosColor.State.waitingDot : EosColor.inkTertiary)
    }
    private var attemptText: String? {
        guard let a = check.attempt else { return nil }
        return check.maxAttempts.map { "\(a)/\($0)" } ?? String(a)
    }
    private var outcomeText: String { check.outcome ?? (check.met ? "met" : "unmet") }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {                     // gap 6 (§10)
            Text(icon).foregroundStyle(iconColor)                              // lc-icon, colored (§10)
            Text("Goal check\(attemptText.map { " · attempt \($0)" } ?? "") · \(outcomeText)")
                .foregroundStyle(EosColor.inkSecondary)                        // lc-msg fg-dim (§10)
            if !check.reason.isEmpty {
                Text(check.reason)
                    .foregroundStyle(EosColor.inkTertiary)                     // lc-reason (§10)
                    .lineLimit(2)
            }
        }
        .font(EosFont.codeSmall)                                               // text-xs mono (§10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - LoopStatusCardView — transcript-top status card (port of LoopStatus.jsx)

// Status card for a worker's active dynamic loop, shown at the top of the transcript. Surfaces the
// loop's status + attempt count + goal + last goal-check reason, plus a compact last-5 attempt history
// (the durable loop_check verdicts). .loop-status pad 10×14 radius 10; active→accent@6%/accent@14%,
// passed→ok@7%/ok@16%, exhausted|stopped→surface/hairline; dot accent (passed→ok, exhausted→faint) (§10).
struct LoopStatusCardView: View {
    let loop: WorkerLoop
    let history: [LoopCheck]                 // durable loop_check verdicts, oldest→newest

    private var recent: [LoopCheck] { Array(history.suffix(5)) }

    private var dotColor: Color {
        switch loop.status {
        case "passed": return EosColor.State.runningDot
        case "exhausted": return EosColor.inkTertiary
        default: return EosColor.coral                       // active / stopped
        }
    }
    private var fill: Color {
        switch loop.status {
        case "passed": return EosColor.State.runningDot.opacity(0.07)
        case "exhausted", "stopped": return EosColor.surface
        default: return EosColor.coral.opacity(0.06)
        }
    }
    private var borderColor: Color {
        switch loop.status {
        case "passed": return EosColor.State.runningDot.opacity(0.16)
        case "exhausted", "stopped": return EosColor.hairline
        default: return EosColor.coral.opacity(0.14)
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Circle().fill(dotColor).frame(width: 7, height: 7)             // dot 7×7 (§10)
                Text("Loop · \(loop.status)")
                    .font(EosFont.label).fontWeight(.semibold)
                    .foregroundStyle(EosColor.ink)                            // label fg 600 (§10)
                Text("attempt \(loop.attemptText)")
                    .font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
            }
            if let goal = loop.goalSummary, !goal.isEmpty {
                Text(goal)
                    .font(EosFont.caption).foregroundStyle(EosColor.ink)       // goal text-sm fg (§10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if let reason = loop.lastReason, !reason.isEmpty {
                Text(reason)
                    .font(EosFont.caption).foregroundStyle(EosColor.inkSecondary) // reason text-sm fg-dim (§10)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            if !recent.isEmpty {
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(Array(recent.enumerated()), id: \.offset) { _, h in attemptRow(h) }
                }
                .padding(.top, 2)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)                        // pad 10×14 (§10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(fill, in: RoundedRectangle(cornerRadius: 10, style: .continuous))  // radius 10 (§10)
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(borderColor, lineWidth: 1))
    }

    // .loop-status-attempt-row: "#N  {outcome}  {reason}" colored met/escalated/unmet (§10).
    private func attemptRow(_ h: LoopCheck) -> some View {
        let escalated = h.outcome == "escalated"
        let color = h.met ? EosColor.State.runningDot : (escalated ? EosColor.State.waitingDot : EosColor.inkTertiary)
        let outcome = h.outcome ?? (h.met ? "met" : "unmet")
        return HStack(alignment: .firstTextBaseline, spacing: 6) {
            if let a = h.attempt { Text("#\(a)").foregroundStyle(EosColor.inkTertiary) }  // lsa-n (§10)
            Text(outcome).foregroundStyle(color).fontWeight(.medium)                       // lsa-outcome (§10)
            if !h.reason.isEmpty {
                Text(h.reason).foregroundStyle(EosColor.inkSecondary).lineLimit(1)         // lsa-reason (§10)
            }
        }
        .font(EosFont.codeSmall)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

// MARK: - GoalCheckLineView — live goal-check line (port of GoalCheckLine.jsx)

// Live goal-check indicator, shown in the ProcessingLine region while the daemon runs a looped worker's
// goal check on its idle edge — the otherwise-silent window. Reuses the thinking-line chrome: animated
// spark + "Goal check · attempt N/M · {phase}" + a M:SS elapsed. Ticks off a local 1s clock started at
// the check's startedAt (the daemon carries no live turn clock to the client).
struct GoalCheckLineView: View {
    let check: LoopCheckProgress

    @State private var now = Date()
    private let tick = Timer.publish(every: 1, on: .main, in: .common).autoconnect()

    private var attemptText: String {
        check.maxAttempts.map { "\(check.attempt)/\($0)" } ?? String(check.attempt)
    }
    // The phase segment: naming the criterion under a verify command, else the outcome/phase (§ loopDisplay).
    private var phaseLabel: String {
        switch check.phase {
        case "verifying": return check.criterionId.map { "verifying \($0)" } ?? "verifying"
        case "verdict": return check.outcome ?? "verdict"
        default: return check.phase                                            // started | judging
        }
    }
    private var elapsedText: String {
        let secs = max(0, Int(now.timeIntervalSince1970 - check.startedAt / 1000))
        return String(format: "%d:%02d", secs / 60, secs % 60)
    }

    var body: some View {
        HStack(spacing: 7) {                                                    // .thinking-line gap 7 (§10)
            SparkView(size: 22, animated: true)                               // live → animated spark (§6.2)
            Text("Goal check · attempt \(attemptText) · \(phaseLabel)")
                .font(EosFont.mono).foregroundStyle(EosColor.inkSecondary)      // gc-text (§10)
            Circle().fill(EosColor.inkTertiary).frame(width: 3, height: 3)     // .thinking-sep 3×3 (§10)
            Text(elapsedText)
                .font(EosFont.mono).foregroundStyle(EosColor.inkTertiary)      // .mono clock (§10)
                .monospacedDigit()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onReceive(tick) { now = $0 }
        .accessibilityLabel("Goal check, attempt \(attemptText), \(phaseLabel)")
    }
}
