import SwiftUI
import EosRemoteKit

// Three-dot session menu content (contract §C13, ref IMG_4432 minus Share — no share backend)
// plus the rename-dialog wiring. The conversation header hosts this inside a native `Menu`
// (system glass for free, §A2 class 3); the rename dialog is the P1 GlassDialog overlay.
struct SessionMenu: View {
    let currentModelDisplay: String
    let onChangeModel: () -> Void
    let onRename: () -> Void
    let onArchive: () -> Void

    var body: some View {
        // Two-line label: SwiftUI renders Text + Text as title + subtitle inside Menu (§C13).
        Button(action: onChangeModel) {
            Text("Change model")
            Text(currentModelDisplay)
            Image(systemName: "shuffle")
        }
        Button(action: onRename) { Label("Rename", systemImage: "pencil") }
        Button(action: onArchive) { Label("Archive", systemImage: "archivebox") }
    }
}

// Rename flow (§C13, ref IMG_4433, D-17): the rename-intent latch flags the daemon that a human
// rename is in progress (blocks auto-rename races), then GlassDialog collects the name. OK commits
// PUT /workers/:id/name — empty input resets to auto-name ({name: null}); Cancel releases the
// intent. Shown as a full-screen overlay by the conversation, one instance per presentation so the
// field re-seeds from the current name each time.
struct RenameSessionDialog: View {
    @EnvironmentObject private var model: AppModel
    let workerId: String
    let onDone: () -> Void
    let onError: (String) -> Void

    @State private var text: String

    init(workerId: String, currentName: String,
         onDone: @escaping () -> Void, onError: @escaping (String) -> Void) {
        self.workerId = workerId
        self.onDone = onDone
        self.onError = onError
        _text = State(initialValue: currentName)
    }

    var body: some View {
        GlassDialog(title: "Rename session", message: "Enter a new name", text: $text,
                    onCancel: {
                        Task { await model.renameIntent(workerId, active: false) }
                        onDone()
                    },
                    onConfirm: {
                        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        Task {
                            if !(await model.setName(workerId, name: trimmed.isEmpty ? nil : trimmed)) {
                                onError("Couldn't rename the session")
                            }
                        }
                        onDone()
                    })
            .onAppear { Task { await model.renameIntent(workerId, active: true) } }
    }
}
