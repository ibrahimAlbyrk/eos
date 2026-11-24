import SwiftUI
import EosRemoteKit

// The run form (07 §4.8): the item (a text or a link, or one the routine offers), the options the
// routine shows inline and the rest under More, a note, as usual or show only, Run. The Mac's
// start route checks it as it checks the Mac's own form.
struct RunFormView: View {
    @ObservedObject var feed: EosFeed
    let routine: EosRoutine
    let onStarted: (String) -> Void

    @State private var itemText = ""
    @State private var picked: EosItem?
    @State private var candidates: [EosItem] = []
    @State private var options: [String: JSONValue] = [:]
    @State private var note = ""
    @State private var showOnly = false
    @State private var starting = false
    @State private var refusal: String?
    // One id per form: a second press answers the run the first one made.
    @State private var requestId = UUID().uuidString

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EosSpacing.md) {
                Text(routine.name).font(EosFont.heading).foregroundStyle(EosColor.ink)
                do {
                    EosCard {
                        Text(routine.takes.label).font(EosFont.label).foregroundStyle(EosColor.ink)
                        TextField(routine.takes.placeholder, text: $itemText, axis: .vertical)
                            .font(EosFont.body)
                            .onChange(of: itemText) { _, _ in picked = nil }
                        ForEach(candidates, id: \.self) { candidate in
                            Button { picked = candidate; itemText = candidate.title ?? candidate.url ?? "" } label: {
                                HStack {
                                    Text(candidate.title ?? candidate.url ?? candidate.kind).font(EosFont.caption)
                                    Spacer()
                                    if picked == candidate { Image(systemName: "checkmark") }
                                }
                                .foregroundStyle(EosColor.inkSecondary)
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
                let inline = routine.options.filter(\.inline)
                let more = routine.options.filter { !$0.inline }
                if !inline.isEmpty { EosCard { ForEach(inline, id: \.key) { optionField($0) } } }
                if !more.isEmpty {
                    DisclosureGroup("More") { ForEach(more, id: \.key) { optionField($0) } }
                        .font(EosFont.label)
                        .foregroundStyle(EosColor.inkSecondary)
                }
                EosCard {
                    TextField("A note for this run", text: $note, axis: .vertical).font(EosFont.body)
                    Toggle("Show only: send nothing", isOn: $showOnly).font(EosFont.label)
                }
                if let refusal {
                    Text(refusal).font(EosFont.caption).foregroundStyle(EosColor.danger)
                }
                PillButton(starting ? "Starting…" : "Run", systemImage: "play.fill", style: .primary) { run() }
                    .disabled(starting)
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.vertical, EosSpacing.lg)
        }
        .background(EosColor.bg)
        .task { candidates = await feed.candidates(routine.id) }
    }

    @ViewBuilder private func optionField(_ option: EosRoutineOption) -> some View {
        let value = options[option.key] ?? option.default
        switch option.type {
        case "bool":
            Toggle(option.label, isOn: Binding(get: { value.boolValue ?? false },
                                               set: { options[option.key] = .bool($0) }))
                .font(EosFont.label)
        case "choice":
            Picker(option.label, selection: Binding(get: { value.stringValue ?? "" },
                                                    set: { options[option.key] = .string($0) })) {
                ForEach(option.values ?? [], id: \.self) { Text($0).tag($0) }
            }
            .font(EosFont.label)
        case "number":
            TextField(option.label, text: Binding(get: { value.doubleValue.map { String($0) } ?? "" },
                                                  set: { options[option.key] = Double($0).map(JSONValue.number) ?? .null }))
                .keyboardType(.decimalPad)
                .font(EosFont.body)
        default:
            TextField(option.label, text: Binding(get: { value.stringValue ?? "" },
                                                  set: { options[option.key] = .string($0) }))
                .font(EosFont.body)
        }
    }

    private func run() {
        starting = true
        refusal = nil
        let item = picked ?? EosItem.typed(itemText)
        let body = EosRequests.startRun(routineId: routine.id, item: item, options: options.filter { $0.value != .null },
                                        note: note, showOnly: showOnly, requestId: requestId)
        Task {
            let started = await feed.start(body)
            starting = false
            switch started {
            case .success(let runId): onStarted(runId)
            case .failure(let why): refusal = why.text
            }
        }
    }
}
