import SwiftUI
import EosRemoteKit

// The deterministic git push/pull records (spec 03 §1 #16/#17, port of the `git-push-line` div in
// Messages.jsx — pull reuses the same class with a ↓ glyph). A thin mono line, no bubble, no action
// row: a direction glyph + the outcome message + an optional branch chip. Geometry per §10:
//   .git-push-line — text-xs, fg-dim, gap 8, pad 6×0. gp-icon weight 700; ok→running tint, err→failed
//   tint (and the message reddens on error). gp-branch — pill pad 1×6, radius 5, tint@8% bg, fg-mid.
// State color is reserved for run-state (§0.3): a successful push/pull → running (green), failure → failed.
enum GitDirection { case push, pull }

struct GitLineView: View {
    let direction: GitDirection
    let ok: Bool
    let message: String
    let branch: String?

    // ok → the direction arrow (↑/↓); err → `!`. Weight 700, colored running/failed.
    private var icon: String {
        ok ? (direction == .push ? "↑" : "↓") : "!"
    }
    private var iconColor: Color { ok ? EosColor.State.runningDot : EosColor.State.failedDot }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {                     // gap 8 (§10)
            Text(icon)
                .fontWeight(.bold)                                              // gp-icon weight 700 (§10)
                .foregroundStyle(iconColor)                                     // ok→running / err→failed (§10)
            Text(message)
                .foregroundStyle(ok ? EosColor.inkSecondary : EosColor.State.failedDot) // err→failed msg (§10)
                .lineLimit(1).truncationMode(.tail)                            // gp-msg ellipsis (§10)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let branch, !branch.isEmpty {
                Text(branch)
                    .foregroundStyle(EosColor.inkSecondary)                    // gp-branch fg-mid (§10)
                    .fixedSize()
                    .padding(.horizontal, 6).padding(.vertical, 1)             // pad 1×6 (§10)
                    .background(EosColor.coral.opacity(0.08),                  // tint@8% (§10)
                                in: RoundedRectangle(cornerRadius: 5, style: .continuous))
            }
        }
        .font(EosFont.codeSmall)                                               // mono text-xs (§10)
        .padding(.vertical, 6)                                                 // pad 6×0 (§10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityLabel(accessibility)
    }

    private var accessibility: String {
        let verb = direction == .push ? "push" : "pull"
        let status = ok ? "succeeded" : "failed"
        return "Git \(verb) \(status): \(message)\(branch.map { " on \($0)" } ?? "")"
    }
}
