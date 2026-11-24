import SwiftUI
import EosRemoteKit

// One run (07 §4.8): its state and station, the team's lines, time and cost; Stop; a message to the
// team. While it is open the phone watches it, so the Mac sends its live lines.
struct RunView: View {
    @ObservedObject var feed: EosFeed
    let runId: String

    @State private var message = ""
    @State private var refusal: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EosSpacing.md) {
                if let detail = feed.runs[runId] {
                    header(detail)
                    if !detail.agents.isEmpty {
                        EosCard {
                            ForEach(detail.agents) { agent in
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(agent.name ?? agent.role.capitalized).font(EosFont.label)
                                        .foregroundStyle(EosColor.ink)
                                    if let line = agent.lastActivity {
                                        Text(line).font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
                                            .lineLimit(2)
                                    }
                                }
                            }
                        }
                    }
                    if !feed.activity.isEmpty {
                        EosCard {
                            ForEach(Array(feed.activity.suffix(30).enumerated()), id: \.offset) { _, line in
                                Text(line.line).font(EosFont.codeSmall).foregroundStyle(EosColor.inkSecondary)
                            }
                        }
                    }
                    if !detail.run.ended { controls }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
                if let refusal {
                    Text(refusal).font(EosFont.caption).foregroundStyle(EosColor.danger)
                }
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.vertical, EosSpacing.lg)
        }
        .background(EosColor.bg)
        .task { await feed.loadRun(runId) }
        .onAppear { feed.watch(runId) }
        .onDisappear { feed.watch(nil) }
    }

    private func header(_ detail: EosRunDetail) -> some View {
        EosCard {
            Text(detail.run.headline ?? detail.run.itemTitle ?? "Run").font(EosFont.heading)
                .foregroundStyle(EosColor.ink)
            Text([detail.run.state.replacingOccurrences(of: "_", with: " "), detail.run.station]
                    .compactMap { $0 }.joined(separator: " · "))
                .font(EosFont.caption).foregroundStyle(EosColor.inkSecondary)
            Text("\(eosDuration(ms: detail.run.workMs)) · \(eosCost(detail.run.costUsd))"
                 + (detail.usual.map { " (usually \(eosDuration(ms: $0.ms)), \(eosCost($0.usd)))" } ?? ""))
                .font(EosFont.caption).foregroundStyle(EosColor.inkTertiary)
            if let reason = detail.run.reason {
                Text(reason).font(EosFont.caption).foregroundStyle(EosColor.inkTertiary)
            }
        }
    }

    private var controls: some View {
        EosCard {
            TextField("A message to the team", text: $message, axis: .vertical).font(EosFont.body)
            HStack {
                PillButton("Send", style: .ghost) {
                    let text = message
                    Task {
                        refusal = await feed.message(runId, text)?.text
                        if refusal == nil { message = "" }
                    }
                }
                .disabled(message.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                Spacer()
                PillButton("Stop", systemImage: "stop.fill", style: .ghost) {
                    Task { refusal = await feed.stop(runId)?.text; await feed.loadRun(runId) }
                }
            }
        }
    }
}
