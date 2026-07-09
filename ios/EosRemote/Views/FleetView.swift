import SwiftUI
import EosRemoteKit

// Re-skinned fleet row (spec 02 §3.6), evolves the old WorkerRow: a StateDot + name +
// model·effort·tokens meta + a monospaced cost, on paper. Shared by HomeView's fleet list (which is
// the Fleet section root — greeting + composer + this list in one List(.plain), swipe-to-Kill kept).
struct WorkerRowNew: View {
    let worker: Worker

    var body: some View {
        HStack(spacing: EosSpacing.sm) {
            StateDot(state: worker.state)
            VStack(alignment: .leading, spacing: 2) {
                Text(worker.name)
                    .font(EosFont.label)
                    .foregroundStyle(EosColor.ink)
                    .lineLimit(1)
                HStack(spacing: EosSpacing.xxs) {
                    if let m = worker.model { Text(shortModel(m)).font(EosFont.caption) }
                    if let e = worker.effort { Text("· \(e)").font(EosFont.caption) }
                    if let t = worker.tokens { Text("· \(t) tok").font(EosFont.captionSmall) }
                }
                .foregroundStyle(EosColor.inkSecondary)
            }
            Spacer()
            if let c = worker.costUSD {
                Text(String(format: "$%.2f", c))
                    .font(EosFont.mono)
                    .foregroundStyle(EosColor.inkSecondary)
            }
        }
        .padding(.vertical, EosSpacing.xs)
        .contentShape(Rectangle())
    }
}
