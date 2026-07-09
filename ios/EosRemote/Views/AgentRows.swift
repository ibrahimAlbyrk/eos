import SwiftUI
import EosRemoteKit

// Agents-tree rows (contract §D3/D4, ref IMG_4434): the orchestrator root card and the indented
// worker child row the Code list renders over AgentTree.buildTree output. Pure presentation —
// tree building, sorting and the attention ledger live in P2 (AgentTree.swift / AppModel).

// §C3/D3 display-name rule: explicit name, else "Orchestrator" for roots, else the id.
func nameOf(_ w: Worker) -> String {
    if let n = w.raw["name"]?.stringValue, !n.isEmpty { return n }
    return w.isOrchestrator ? "Orchestrator" : w.id
}

// Mac definitionOf port: the "(definition)" suffix shows only for specialist workers — nil for
// orchestrators and the generic "general-purpose".
func definitionOf(_ w: Worker) -> String? {
    guard !w.isOrchestrator, let d = w.workerDefinition, !d.isEmpty, d != "general-purpose" else { return nil }
    return d
}

// Compact trailing time ("2m", "3h", "Apr 14" — §D3). ts is epoch-ms like every daemon timestamp.
enum CompactTime {
    nonisolated(unsafe) private static let monthDay: DateFormatter = {
        let f = DateFormatter(); f.dateFormat = "MMM d"; return f
    }()

    static func label(_ tsMs: Double) -> String {
        guard tsMs > 0 else { return "" }
        let date = Date(timeIntervalSince1970: tsMs / 1000)
        let s = Date().timeIntervalSince(date)
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86_400 { return "\(Int(s / 3600))h" }
        if s < 7 * 86_400 { return "\(Int(s / 86_400))d" }
        return monthDay.string(from: date)
    }
}

// Orchestrators read heavier than workers (§D3 — the Mac's .ag-name.main); no EosFont token
// carries a label-size SemiBold, so it is derived locally (same pattern as PermissionBanner).
private let labelSemi = Font.custom("PlusJakartaSans-SemiBold", size: 15, relativeTo: .subheadline)

// Root card (§D3): 44pt folder tile with a state dot overlaid bottom-trailing, heavy title,
// cwd-basename subtitle + worker count, trailing time + one status slot (pending chip > attention
// dot > loop badge > nothing). The tile is its own button when children exist (collapse toggle);
// `archived` forces the idle dot and drops the live status slot (§C2 Archived rows).
struct OrchestratorRow: View {
    let worker: Worker
    var workerCount: Int = 0
    var archived: Bool = false
    var attention: Bool = false
    var pendingCount: Int = 0
    var onTileTap: (() -> Void)? = nil

    private var runState: EosRunState { EosRunState.from(archived ? "IDLE" : worker.state) }
    private var timeMs: Double {
        archived ? (worker.archivedAt ?? worker.recencyKey) : worker.recencyKey
    }

    var body: some View {
        HStack(spacing: EosSpacing.sm) {
            if let onTileTap {
                Button(action: onTileTap) { tile }.buttonStyle(.plain)
                    .accessibilityLabel("Toggle workers")
            } else {
                tile
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(nameOf(worker))
                    .font(labelSemi)
                    .foregroundStyle(EosColor.ink)
                    .lineLimit(1)
                if let subtitle {
                    Text(subtitle)
                        .font(EosFont.caption)
                        .foregroundStyle(EosColor.inkTertiary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: EosSpacing.xs)
            VStack(alignment: .trailing, spacing: EosSpacing.xxs) {
                Text(CompactTime.label(timeMs))
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.inkTertiary)
                if !archived { statusSlot }
            }
        }
        .padding(EosSpacing.sm)
        .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: EosRadius.card, style: .continuous)
            .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
        .contentShape(Rectangle())
    }

    private var tile: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(EosColor.surface2)
            Image(systemName: "folder")
                .font(.system(size: 18, weight: .regular))
                .foregroundStyle(EosColor.inkSecondary)
        }
        .frame(width: 44, height: 44)
        .overlay(alignment: .bottomTrailing) {
            Circle()
                .fill(runState.dot)
                .frame(width: 10, height: 10)
                .overlay(Circle().strokeBorder(EosColor.bg, lineWidth: 1.5))
                .offset(x: 3, y: 3)
                .accessibilityLabel(runState.label)
        }
    }

    private var subtitle: String? {
        let base = worker.cwd.flatMap { $0.split(separator: "/").last.map(String.init) }
        let count = workerCount > 0 ? "\(workerCount) worker\(workerCount == 1 ? "" : "s")" : nil
        let parts = [base, count].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    @ViewBuilder private var statusSlot: some View {
        if pendingCount > 0 {
            PendingCountChip(count: pendingCount)
        } else if attention {
            AttentionDot()
        } else if worker.loop != nil {
            LoopBadge()
        }
    }
}

// Indented child row (§D3): 8pt state dot, git-role branch glyph, name, faint "(definition)"
// suffix, trailing pending chip > loop badge > attention dot > lowercase status label.
struct WorkerChildRow: View {
    let worker: Worker
    var attention: Bool = false
    var pendingCount: Int = 0

    var body: some View {
        HStack(spacing: EosSpacing.xs) {
            StateDot(state: worker.state)
            if worker.agentRole == "git" {
                Image(systemName: "arrow.triangle.branch")
                    .font(.system(size: 11, weight: .regular))
                    .foregroundStyle(EosColor.inkTertiary)
                    .accessibilityLabel("Git worker")
            }
            Text(nameOf(worker))
                .font(EosFont.label)
                .foregroundStyle(EosColor.ink)
                .lineLimit(1)
            if let def = definitionOf(worker) {
                Text("(\(def))")
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.inkFaint)
                    .lineLimit(1)
            }
            Spacer(minLength: EosSpacing.xs)
            trailingSlot
        }
        .padding(.vertical, EosSpacing.xs)
        .contentShape(Rectangle())
    }

    @ViewBuilder private var trailingSlot: some View {
        if pendingCount > 0 {
            PendingCountChip(count: pendingCount)
        } else if worker.loop != nil {
            LoopBadge()
        } else if attention {
            AttentionDot()
        } else {
            Text(EosRunState.from(worker.state).label)
                .font(EosFont.captionSmall)
                .foregroundStyle(EosColor.inkTertiary)
        }
    }
}

// §D4: agent stopped with unviewed output — 8pt attention blue with a bg ring.
private struct AttentionDot: View {
    var body: some View {
        Circle()
            .fill(EosColor.attention)
            .frame(width: 8, height: 8)
            .overlay(Circle().strokeBorder(EosColor.bg, lineWidth: 1.5))
            .accessibilityLabel("Unviewed output")
    }
}

// Active dynamic loop marker (§D3) — the LoopViews violet vocabulary in capsule form.
private struct LoopBadge: View {
    var body: some View {
        Text("loop")
            .font(EosFont.captionSmall)
            .foregroundStyle(EosColor.State.violetDot)
            .padding(.horizontal, EosSpacing.xs)
            .padding(.vertical, 3)
            .background(EosColor.State.violetSoft, in: Capsule())
            .accessibilityLabel("Dynamic loop active")
    }
}

// Pending permission asks somewhere in the row's subtree (§D3) — the phone's route to the
// conversation banner (§C3).
private struct PendingCountChip: View {
    let count: Int
    var body: some View {
        HStack(spacing: 4) {
            Circle().fill(EosColor.State.waitingDot).frame(width: 6, height: 6)
            Text("\(count)")
                .font(EosFont.captionSmall)
                .foregroundStyle(EosColor.ink)
        }
        .padding(.horizontal, EosSpacing.xs)
        .padding(.vertical, 3)
        .background(EosColor.State.waitingSoft, in: Capsule())
        .accessibilityLabel("\(count) pending permission\(count == 1 ? "" : "s")")
    }
}

#Preview("AgentRows") {
    func w(_ id: String, name: String? = nil, orch: Bool = false, state: String = "IDLE",
           cwd: String? = nil, def: String? = nil, role: String? = nil) -> Worker {
        var o: [String: JSONValue] = ["id": .string(id), "state": .string(state),
                                      "is_orchestrator": .bool(orch)]
        if let name { o["name"] = .string(name) }
        if let cwd { o["cwd"] = .string(cwd) }
        if let def { o["worker_definition"] = .string(def) }
        if let role { o["agent_role"] = .string(role) }
        return Worker(raw: .object(o))
    }
    return VStack(alignment: .leading, spacing: EosSpacing.sm) {
        OrchestratorRow(worker: w("o1", name: "Fix login flow", orch: true, state: "WORKING",
                                  cwd: "/Users/x/dev/eos"),
                        workerCount: 3, pendingCount: 2, onTileTap: {})
        OrchestratorRow(worker: w("o2", orch: true, state: "IDLE", cwd: "/Users/x/dev/api"),
                        attention: true)
        OrchestratorRow(worker: w("o3", name: "Old session", orch: true, cwd: "/Users/x/dev/web"),
                        archived: true)
        WorkerChildRow(worker: w("w1", name: "refactor-auth", state: "WORKING", def: "code-reviewer"))
            .padding(.leading, 56)
        WorkerChildRow(worker: w("w2", name: "land-branch", state: "IDLE", role: "git"), attention: true)
            .padding(.leading, 56)
    }
    .padding(EosSpacing.screenInset)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
