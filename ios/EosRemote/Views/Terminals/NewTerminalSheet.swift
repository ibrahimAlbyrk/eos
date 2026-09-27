import SwiftUI

// New terminal (Terminals "+"): a folder (the daemon's recents or the directory browser, via
// RepoPickerSheet) and what to run — Claude Code or a plain shell — then POST /pty. The desktop
// Code view adopts the session as a pane; `onOpened` hands its id back for the push.
struct NewTerminalSheet: View {
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let onOpened: (String) -> Void

    @State private var cwd: String?
    @State private var claude = true
    @State private var showPicker = false
    @State private var opening = false
    @State private var failed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            EosSheetHeader("New terminal") { dismiss() }
            VStack(alignment: .leading, spacing: 0) {
                SelectRow(icon: "folder", title: cwd.map(basename) ?? "Choose folder…",
                          subtitle: cwd, selected: false) { showPicker = true }
                SectionCaption("Run")
                SelectRow(icon: "asterisk", iconTint: EosColor.coral, title: "Claude Code",
                          subtitle: "A new Claude Code session", selected: claude) { claude = true }
                SelectRow(icon: "terminal", title: "Shell",
                          subtitle: "Your login shell", selected: !claude) { claude = false }
            }
            .padding(.horizontal, EosSpacing.xs)
            Spacer(minLength: EosSpacing.md)
            if failed {
                Text("Couldn't open the terminal — try again")
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.danger)
                    .frame(maxWidth: .infinity)
                    .padding(.bottom, EosSpacing.xs)
            }
            PillButton(opening ? "Opening…" : "Open", style: .coral) { Task { await open() } }
                .frame(maxWidth: .infinity)
                .disabled(cwd == nil || opening || !model.connected)
                .opacity(cwd == nil || opening || !model.connected ? 0.55 : 1)
                .padding(.bottom, EosSpacing.md)
        }
        .eosSheet(detents: [.medium])
        .sheet(isPresented: $showPicker) {
            RepoPickerSheet(current: cwd) { cwd = $0 }.environmentObject(model)
        }
        .task { if cwd == nil { cwd = await model.fetchRecents().first } }
    }

    private func open() async {
        guard let cwd else { return }
        opening = true
        failed = false
        let session = await model.createPty(cwd: cwd, claude: claude)
        opening = false
        guard let session else { failed = true; return }
        Haptics.success()
        onOpened(session.id)
        dismiss()
    }

    private func basename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }
}
