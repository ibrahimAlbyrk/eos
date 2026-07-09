import SwiftUI
import EosRemoteKit

// Worker-exited-with-uncommitted-work marker (spec 03 §1 #18, port of the `worktree-preserved` div in
// Messages.jsx). A thin mono card recording that a worker's worktree was kept: a warn-tinted title +
// a "{branch} · N files changed · {path}" detail + a trailing Reveal button. Geometry per §10:
//   .worktree-preserved — text-xs, fg-dim, gap 8, pad 6×10, border 1 (tint@10%), radius 8.
//   .wp-title — warn, weight 600. .wp-detail — ellipsis. .wp-btn — accent, margin-left auto.
// iOS has no Finder (§7), so Reveal COPIES the path instead of opening it, swapping to a checkmark for
// 1.5s (the §6.5 copy-feedback pattern) so the tap has a visible result.
struct WorktreePreservedView: View {
    let path: String
    let branch: String
    let diffStat: String

    @State private var copied = false

    // Mirror the Mac: file count = non-empty lines of the per-file diffStat; 0 → "uncommitted changes".
    private var fileCount: Int {
        diffStat.split(whereSeparator: \.isNewline).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }.count
    }
    private var changeText: String {
        fileCount > 0 ? "\(fileCount) file\(fileCount == 1 ? "" : "s") changed" : "uncommitted changes"
    }
    private var detail: String { "\(branch) · \(changeText) · \(path)" }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {                     // gap 8 (§10)
            Text("Worktree preserved")
                .fontWeight(.semibold)                                          // wp-title weight 600 (§10)
                .foregroundStyle(EosColor.State.waitingDot)                    // warn tint (§10)
                .fixedSize()
            Text(detail)
                .foregroundStyle(EosColor.inkSecondary)                        // fg-dim (§10)
                .lineLimit(1).truncationMode(.middle)                         // wp-detail ellipsis (§10)
                .frame(maxWidth: .infinity, alignment: .leading)
            revealButton
        }
        .font(EosFont.codeSmall)                                               // mono text-xs (§10)
        .padding(.horizontal, 10).padding(.vertical, 6)                        // pad 6×10 (§10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous)
            .strokeBorder(EosColor.coral.opacity(0.10), lineWidth: 1))         // border tint@10% (§10)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Worktree preserved. \(detail)")
    }

    // .wp-btn — accent, margin-left auto. iOS copies the path (no Finder, §7) → checkmark 1.5s (§6.5).
    private var revealButton: some View {
        Button {
            UIPasteboard.general.string = path
            withAnimation(.easeOut(duration: 0.15)) { copied = true }
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                withAnimation(.easeOut(duration: 0.15)) { copied = false }
            }
        } label: {
            Text(copied ? "Copied" : "Reveal")
                .font(EosFont.codeSmall)
                .foregroundStyle(copied ? EosColor.State.runningDot : EosColor.coral)  // accent → ok on copy
                .fixedSize()
                .padding(.horizontal, 6).padding(.vertical, 2)                 // wp-btn pad 2×6 (§10)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Path copied" : "Copy worktree path")
    }
}
