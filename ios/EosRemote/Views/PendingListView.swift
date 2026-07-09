import SwiftUI
import EosRemoteKit

// Pending decisions (spec 02 §3.8): each pending → a decision card (surface, hairline, r16) with the
// tool name in serif, the summary secondary, an optional TTL waiting-chip, and Deny (ghost danger) /
// Approve (primary PillButton) actions. Paper background, no system list chrome.
struct PendingListView: View {
    @EnvironmentObject var model: AppModel

    var body: some View {
        ScrollView {
            LazyVStack(spacing: EosSpacing.md) {
                if model.pending.isEmpty {
                    ContentUnavailableView("No pending decisions", systemImage: "checkmark.shield")
                        .padding(.top, EosSpacing.xxl)
                } else {
                    ForEach(model.pending) { p in PendingCard(pending: p) }
                }
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.top, EosSpacing.md)
        }
        .scrollContentBackground(.hidden)
        .background(EosColor.bg)
    }
}

private struct PendingCard: View {
    @EnvironmentObject var model: AppModel
    let pending: Pending

    var body: some View {
        VStack(alignment: .leading, spacing: EosSpacing.sm) {
            HStack(alignment: .firstTextBaseline) {
                Text(pending.tool ?? "permission")
                    .font(EosFont.heading)
                    .foregroundStyle(EosColor.ink)
                Spacer()
                if pending.ttl != nil { StateDot(state: "WAITING", labeled: true) }
            }
            if let s = pending.summary {
                Text(s).font(EosFont.body).foregroundStyle(EosColor.inkSecondary)
            }
            HStack(spacing: EosSpacing.sm) {
                DenyPill { Task { await model.approve(pendingId: pending.id, allow: false) } }
                PillButton("Approve", style: .primary) {
                    Task { await model.approve(pendingId: pending.id, allow: true) }
                }
            }
            .padding(.top, EosSpacing.xxs)
        }
        .padding(EosSpacing.md)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous)
            .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
    }
}

// Ghost pill tinted with `danger` — PillButton's .ghost is fixed to ink, so the destructive Deny
// action is expressed here (spec 02 §3.8: Deny = ghost danger).
private struct DenyPill: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text("Deny")
                .font(EosFont.labelStrong)
                .foregroundStyle(EosColor.danger)
                .padding(.horizontal, EosSpacing.lg)
                .padding(.vertical, EosSpacing.sm)
                .overlay(Capsule().strokeBorder(EosColor.danger.opacity(0.5), lineWidth: EosLine.button))
        }
        .buttonStyle(.plain)
    }
}
