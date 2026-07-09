import SwiftUI
import EosRemoteKit

// Stacked permission-ask banner pinned above the composer (contract §C3, Mac
// center/PermissionBanner.jsx): the front card asks `Allow <worker> to run <tool>?` with the
// parsed input detail in a code well and Deny / Always allow / Allow once actions; up to two
// ghost cards peek 4/8pt beneath when more asks are queued. Busy = an action fired for the front
// ask and the Store hasn't dropped it yet — all three buttons disable until the patch lands.
struct PermissionBanner: View {
    let pending: [Pending]
    let nameFor: (String) -> String
    let onAllow: (Pending) -> Void
    let onAlwaysAllow: (Pending) -> Void
    let onDeny: (Pending) -> Void

    @State private var busyId: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(pending: [Pending], nameFor: @escaping (String) -> String,
         onAllow: @escaping (Pending) -> Void, onAlwaysAllow: @escaping (Pending) -> Void,
         onDeny: @escaping (Pending) -> Void) {
        self.pending = pending
        self.nameFor = nameFor
        self.onAllow = onAllow
        self.onAlwaysAllow = onAlwaysAllow
        self.onDeny = onDeny
    }

    var body: some View {
        if let front = pending.first {
            card(front)
                .background {
                    ZStack {
                        if pending.count > 2 { ghostCard.padding(.horizontal, 20).offset(y: 8) }
                        if pending.count > 1 { ghostCard.padding(.horizontal, 10).offset(y: 4) }
                    }
                }
                .padding(.bottom, pending.count > 2 ? 8 : pending.count > 1 ? 4 : 0)
                .animation(reduceMotion ? .none : EosSpring.chip, value: pending.map(\.id))
                .onChange(of: pending.first?.id) { busyId = nil }
        }
    }

    private var ghostCard: some View {
        RoundedRectangle(cornerRadius: EosRadius.banner, style: .continuous)
            .fill(EosColor.surface2)
            .overlay(RoundedRectangle(cornerRadius: EosRadius.banner, style: .continuous)
                .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
    }

    private func card(_ p: Pending) -> some View {
        VStack(alignment: .leading, spacing: EosSpacing.sm) {
            HStack(alignment: .top, spacing: EosSpacing.xs) {
                Circle()
                    .fill(EosColor.State.waitingDot)
                    .frame(width: 8, height: 8)
                    .padding(.top, 5)                       // optically centers on the first line
                headline(p)
                    .foregroundStyle(EosColor.ink)
                Spacer(minLength: EosSpacing.xs)
                if pending.count > 1 {
                    Text("\(pending.count) pending")
                        .font(EosFont.captionSmall)
                        .foregroundStyle(EosColor.ink)
                        .padding(.horizontal, EosSpacing.xs)
                        .padding(.vertical, 3)
                        .background(EosColor.State.waitingSoft, in: Capsule())
                }
            }
            if let detail = detailText(p) {
                Text(detail)
                    .font(EosFont.code)
                    .foregroundStyle(EosColor.inkSecondary)
                    .lineLimit(3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(EosSpacing.xs)
                    .background(EosColor.surface3,
                                in: RoundedRectangle(cornerRadius: EosRadius.chip, style: .continuous))
            }
            actionRow(p)
        }
        .padding(EosSpacing.md)
        .background(EosColor.surface2,
                    in: RoundedRectangle(cornerRadius: EosRadius.banner, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: EosRadius.banner, style: .continuous)
            .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
    }

    // "Allow <worker> to run <tool>?" — worker/tool in SemiBold (no EosFont token carries the
    // label-size SemiBold; Typography.swift is outside P1's ownership, so it is derived locally).
    private func headline(_ p: Pending) -> Text {
        let semi = Font.custom("PlusJakartaSans-SemiBold", size: 15, relativeTo: .subheadline)
        let name = nameFor(p.workerId ?? "")
        let tool = p.toolName ?? "a tool"
        return Text("Allow ").font(EosFont.label)
            + Text(name).font(semi)
            + Text(" to run ").font(EosFont.label)
            + Text(tool).font(semi)
            + Text("?").font(EosFont.label)
    }

    // First of input.command ?? file_path ?? path ?? query ?? regex; `input` arrives as a JSON
    // string on the wire but is handled decoded too.
    private func detailText(_ p: Pending) -> String? {
        guard let input = p.raw["input"] else { return nil }
        let obj: JSONValue?
        if let s = input.stringValue { obj = JSONValue.parse(s) } else { obj = input }
        guard let obj else { return nil }
        for key in ["command", "file_path", "path", "query", "regex"] {
            if let v = obj[key]?.stringValue, !v.isEmpty { return v }
        }
        return nil
    }

    private func actionRow(_ p: Pending) -> some View {
        let busy = busyId != nil
        return HStack(spacing: EosSpacing.xs) {
            actionButton("Deny", tint: EosColor.danger, filled: false) { busyId = p.id; onDeny(p) }
            Spacer()
            actionButton("Always allow", tint: EosColor.ink, filled: false) { busyId = p.id; onAlwaysAllow(p) }
            actionButton("Allow once", tint: EosColor.onAccent, filled: true) { busyId = p.id; onAllow(p) }
        }
        .disabled(busy)
        .opacity(busy ? 0.55 : 1)
    }

    private func actionButton(_ title: String, tint: Color, filled: Bool,
                              action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(EosFont.label)
                .padding(.horizontal, EosSpacing.sm)
                .padding(.vertical, 7)
                .foregroundStyle(tint)
                .background(filled ? EosColor.coral : .clear, in: Capsule())
                .overlay {
                    if !filled {
                        Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

#Preview("PermissionBanner") {
    func ask(_ id: String, tool: String, input: String) -> Pending {
        Pending(raw: .object([
            "id": .string(id),
            "worker_id": .string("w-\(id)"),
            "tool": .string(tool),
            "input": .string(input),
        ]))
    }
    return VStack(spacing: EosSpacing.lg) {
        Spacer()
        PermissionBanner(
            pending: [ask("p1", tool: "Bash", input: #"{"command":"rm -rf node_modules && npm install"}"#)],
            nameFor: { _ in "refactor-auth" },
            onAllow: { _ in }, onAlwaysAllow: { _ in }, onDeny: { _ in })
        PermissionBanner(
            pending: [
                ask("p2", tool: "Edit", input: #"{"file_path":"/Users/x/project/src/index.ts"}"#),
                ask("p3", tool: "Bash", input: #"{"command":"npm test"}"#),
                ask("p4", tool: "Grep", input: #"{"query":"TODO"}"#),
            ],
            nameFor: { _ in "fix-login" },
            onAllow: { _ in }, onAlwaysAllow: { _ in }, onDeny: { _ in })
    }
    .padding(EosSpacing.screenInset)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
