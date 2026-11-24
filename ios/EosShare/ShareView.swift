import SwiftUI
import EosRemoteKit

struct ShareView: View {
    @ObservedObject var model: ShareModel
    let done: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                if let thing = model.thing {
                    Section("Shared") {
                        Text(thing.item.title ?? thing.value).lineLimit(3)
                    }
                }
                if model.devices.count > 1, let device = model.device {
                    Section("Mac") {
                        Picker("Mac", selection: Binding(get: { device.id }, set: { id in
                            guard let next = model.devices.first(where: { $0.id == id }) else { return }
                            Task { await model.choose(next) }
                        })) {
                            ForEach(model.devices) { Text($0.label).tag($0.id) }
                        }
                    }
                }
                content
            }
            .navigationTitle("Eos")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel", action: done) }
                if case .ready = model.phase {
                    ToolbarItem(placement: .confirmationAction) {
                        Button(model.starting ? "Starting…" : "Run") { Task { await model.run() } }
                            .disabled(model.picked == nil || model.starting)
                    }
                }
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch model.phase {
        case .loading:
            Section { ProgressView() }
        case .failed(let why):
            Section { Text(why) }
        case .finished(let what):
            Section {
                Text(what)
                Button("Done", action: done)
            }
        case .ready(let live):
            Section {
                if model.routines.isEmpty {
                    Text("No routine takes this.")
                }
                ForEach(model.routines) { routine in
                    Button { model.picked = routine.id } label: {
                        HStack {
                            VStack(alignment: .leading) {
                                Text(routine.name)
                                Text(routine.summary).font(.caption).foregroundStyle(.secondary).lineLimit(2)
                            }
                            Spacer()
                            if model.picked == routine.id { Image(systemName: "checkmark") }
                        }
                    }
                    .foregroundStyle(.primary)
                }
            } header: {
                Text("Routine")
            } footer: {
                if !live { Text("Your Mac isn't connected. The run goes when the Eos app next reaches it.") }
            }
            Section {
                TextField("A note for this run", text: $model.note, axis: .vertical)
            }
            if let refusal = model.refusal {
                Section { Text(refusal).foregroundStyle(.red) }
            }
        }
    }
}
