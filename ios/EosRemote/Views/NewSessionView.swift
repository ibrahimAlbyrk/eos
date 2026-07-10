import SwiftUI
import EosRemoteKit

// New session (contract §C4, ref IMG_4435) — replaces SpawnSheet + the Home fast-path. Nothing is
// POSTed until first send (lazy create, master 6): the screen holds a local draft (cwd / model /
// effort / mode / attachments) and `spawnOrchestrator` fires on send.
//
// Cross-package seam (P3 consumes; not fixed in §H so declared here): RootView constructs the
// `.newSession` route as NewSessionView(onDeviceTap:onSpawned:) — onDeviceTap presents RootView's
// DeviceSwitcherSheet (B1 sheet ownership); onSpawned(id) replaces the current nav entry with
// .conversation(id) (§C4.3, no flash of the list). Back navigation is plain `dismiss`.
struct NewSessionView: View {
    @EnvironmentObject private var model: AppModel

    private let onDeviceTap: () -> Void
    private let onSpawned: (String) -> Void

    init(onDeviceTap: @escaping () -> Void, onSpawned: @escaping (String) -> Void) {
        self.onDeviceTap = onDeviceTap
        self.onSpawned = onSpawned
    }

    var body: some View {
        // Wrapper exists so the AttachmentDraftModel StateObject can capture the environment's
        // AppModel as its upload sink at init (environment objects aren't visible in property
        // initializers).
        NewSessionContent(model: model, onDeviceTap: onDeviceTap, onSpawned: onSpawned)
    }
}

private struct NewSessionContent: View {
    @ObservedObject var model: AppModel
    let onDeviceTap: () -> Void
    let onSpawned: (String) -> Void

    @Environment(\.dismiss) private var dismiss

    @StateObject private var draft: AttachmentDraftModel

    @State private var text = ""
    @State private var cwd: String?
    @State private var recentsLoading = true
    @State private var mode: PermissionModeUI = .acceptEdits
    @State private var draftModel = ModelCatalog.defaultModelAlias
    @State private var draftEffort = ModelCatalog.defaultEffort
    @State private var draftProfile: String?
    @State private var spawning = false
    @State private var errorText: String?

    @State private var showModelSheet = false
    @State private var showModeSheet = false
    @State private var showRepoPicker = false
    @State private var showCamera = false
    @State private var showPhotos = false
    @State private var showFiles = false

    @FocusState private var composerFocused: Bool

    init(model: AppModel, onDeviceTap: @escaping () -> Void, onSpawned: @escaping (String) -> Void) {
        self.model = model
        self.onDeviceTap = onDeviceTap
        self.onSpawned = onSpawned
        _draft = StateObject(wrappedValue: AttachmentDraftModel(upload: { [weak model] name, data in
            await model?.uploadAttachment(name: name, data: data)
        }))
    }

    // D-6: static suggestions — no suggestions backend exists; they fill the empty screen and
    // insert text only.
    private let suggestions = [
        "Fix the failing tests in my repo",
        "Refactor a file and explain the changes",
        "Find and fix a TODO",
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: EosSpacing.md) {
                deviceChip
                    .frame(maxWidth: .infinity)
                SectionCaption("Suggestions")
                ForEach(suggestions, id: \.self) { suggestion in
                    // Ref IMG_4435: suggestion chips are translucent glass, not opaque fills.
                    Button { text = suggestion } label: {
                        Text(suggestion)
                            .font(EosFont.body)
                            .foregroundStyle(EosColor.ink)
                            .padding(.horizontal, EosSpacing.md)
                            .padding(.vertical, EosSpacing.sm)
                            .glassEffect(.regular.interactive(), in: .capsule)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .scrollDismissesKeyboard(.interactively)
        .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
        // App bg must ignore the keyboard region too, else the keyboard's rounded top-corner
        // notches fall outside the keyboard-avoided background and show the bare black window
        // (see WorkerDetailView). The composer (safe-area inset) still avoids the keyboard.
        .background(EosColor.bg.ignoresSafeArea().ignoresSafeArea(.keyboard, edges: .bottom))
        .safeAreaInset(edge: .top) { header }
        .safeAreaInset(edge: .bottom) { bottomStack }
        .navigationBarBackButtonHidden(true)
        .toolbar(.hidden, for: .navigationBar)
        .sheet(isPresented: $showModelSheet) {
            ModelSheet(context: .draft(model: $draftModel, effort: $draftEffort,
                                       backendProfile: $draftProfile))
        }
        .sheet(isPresented: $showModeSheet) {
            ModeSheet(current: mode) { mode = $0 }
        }
        .sheet(isPresented: $showRepoPicker) {
            RepoPickerSheet(current: cwd) { cwd = $0 }
        }
        .attachmentPickers(draft: draft, camera: $showCamera, photos: $showPhotos, files: $showFiles)
        .onChange(of: draft.lastError) { _, message in
            guard let message else { return }
            draft.lastError = nil
            showError(message)
        }
        .task {
            let paths = await model.fetchRecents()
            if cwd == nil { cwd = paths.first }
            recentsLoading = false
        }
    }

    // MARK: header (§E1 gradient chrome) — back chevron · model title button · trailing spacer

    private var header: some View {
        VStack(spacing: EosSpacing.xs) {
            HStack {
                CircularIconButton(systemName: "chevron.backward", glass: true,
                                   accessibilityLabel: "Back") { dismiss() }
                Spacer()
                Button { showModelSheet = true } label: {
                    HStack(spacing: 6) {
                        Text(modelTitle)
                            .font(EosFont.labelStrong)
                            .foregroundStyle(EosColor.ink)
                            .lineLimit(1)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 12, weight: .semibold))
                            .foregroundStyle(EosColor.inkSecondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Model: \(modelTitle)")
                Spacer()
                Color.clear.frame(width: 40, height: 40)   // mirrors the back button; title centers
            }
            .padding(.horizontal, EosSpacing.md)
            if !model.connected { offlineBanner }
        }
        .padding(.bottom, EosSpacing.md)   // gradient extends 16pt below the bar row (§E1)
        .background {
            LinearGradient(colors: [EosColor.bg, EosColor.bg.opacity(0.9), EosColor.bg.opacity(0)],
                           startPoint: .top, endPoint: .bottom)
                .ignoresSafeArea(edges: .top)
        }
    }

    private var modelTitle: String {
        if let name = draftProfile,
           let profile = model.uiConfig?.backendProfiles.first(where: { $0.name == name }) {
            // The sheet writes the picked provider model into draftModel (pinned by default).
            if !draftModel.isEmpty { return draftModel }
            return profile.model.isEmpty ? profile.label : profile.model
        }
        let choices = ModelCatalog.choices(for: model.uiConfig)
        return ModelCatalog.resolve(draftModel, in: choices)?.displayName ?? draftModel
    }

    private var offlineBanner: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(model.connecting ? EosColor.State.waitingDot : EosColor.State.failedDot)
                .frame(width: 6, height: 6)
            Text(model.connecting ? "Reconnecting to \(deviceLabel)…" : "Not connected")
                .font(EosFont.captionSmall)
                .foregroundStyle(EosColor.inkSecondary)
        }
        .padding(.horizontal, EosSpacing.sm)
        .padding(.vertical, EosSpacing.xxs)
        .background(EosColor.surface2, in: Capsule())
        .overlay(Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
    }

    // D-7: the reference's "Default" cloud chip maps to the paired Mac — tap opens the device
    // switcher (presented by RootView).
    private var deviceChip: some View {
        Group {
            if model.activeDevice != nil {
                // Ref IMG_4435: the "Default" cloud chip is a glass capsule.
                Button(action: onDeviceTap) {
                    HStack(spacing: 6) {
                        StateDot(state: connState.dotState)
                        Text(deviceLabel)
                            .font(EosFont.label)
                            .foregroundStyle(EosColor.ink)
                    }
                    .padding(.horizontal, EosSpacing.sm)
                    .padding(.vertical, EosSpacing.xs)
                    .glassEffect(.regular.interactive(), in: .capsule)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Device: \(deviceLabel), \(connState.label)")
            }
        }
    }

    private var deviceLabel: String { model.activeDevice?.label ?? "this Mac" }
    private var connState: DeviceConnState {
        model.activeDevice.map { model.connectionState(for: $0.id) } ?? .disconnected
    }

    // MARK: bottom stack (§E2 gradient) — error capsule · repo chip · composer

    private var bottomStack: some View {
        VStack(alignment: .leading, spacing: EosSpacing.sm) {
            if let errorText {
                Text(errorText)
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.ink)
                    .padding(.horizontal, EosSpacing.md)
                    .padding(.vertical, EosSpacing.xs)
                    .background(EosColor.surface3, in: Capsule())
                    .overlay(Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
                    .frame(maxWidth: .infinity)
            }
            repoChip
            ChatComposer(text: $text, placeholder: "Code anything…",
                         mode: mode, onModeTap: { showModeSheet = true },
                         attachMenu: {
                             AttachmentMenu.content(draft: draft,
                                                    presentCamera: $showCamera,
                                                    presentPhotos: $showPhotos,
                                                    presentFiles: $showFiles)
                         },
                         chips: draft.items,
                         onRemoveChip: { draft.remove(label: $0) },
                         onRetryChip: { draft.retry(label: $0) },
                         trailing: .send(enabled: sendEnabled, { Task { await send() } }),
                         focused: $composerFocused)
        }
        .padding(.horizontal, EosSpacing.screenInset)
        .padding(.bottom, EosSpacing.xs)
        .background {
            LinearGradient(colors: [EosColor.bg.opacity(0), EosColor.bg],
                           startPoint: .top, endPoint: .bottom)
                .padding(.top, -24)   // overshoot above the stack (§E2)
                .ignoresSafeArea(edges: .bottom)
        }
        .animation(.default, value: errorText)
    }

    private var repoChip: some View {
        Button { showRepoPicker = true } label: {
            HStack(spacing: 6) {
                Image(systemName: "folder")
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(EosColor.inkSecondary)
                if recentsLoading && cwd == nil {
                    ProgressView().controlSize(.small).tint(EosColor.inkTertiary)
                } else {
                    Text(cwd.map(basename) ?? "Choose folder…")
                        .font(EosFont.label)
                        .foregroundStyle(cwd == nil ? EosColor.inkTertiary : EosColor.ink)
                        .lineLimit(1)
                }
            }
            .padding(.horizontal, EosSpacing.sm)
            .padding(.vertical, EosSpacing.xs)
            .glassEffect(.regular.interactive(), in: .capsule)   // ref IMG_4435 repo chip
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Repository: \(cwd.map(basename) ?? "none chosen")")
    }

    private func basename(_ path: String) -> String {
        path.split(separator: "/").last.map(String.init) ?? path
    }

    // MARK: send — the lazy create (§C4)

    // C3/C8 gates: text present, nothing mid-upload, not already spawning, device reachable.
    private var sendEnabled: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !draft.items.contains { $0.status == .uploading }
            && !spawning
            && model.connected
    }

    private func send() async {
        guard let cwd else {
            // No cwd chosen and recents were empty — pick a folder first; the draft holds.
            showRepoPicker = true
            return
        }
        spawning = true
        let id = await model.spawnOrchestrator(cwd: cwd, model: draftModel, effort: draftEffort,
                                               prompt: text + draft.suffix(),
                                               permissionMode: mode.rawValue,
                                               backendProfile: draftProfile)
        spawning = false
        if let id {
            Haptics.success()
            composerFocused = false
            text = ""
            draft.clear()
            onSpawned(id)
        } else {
            showError("Couldn't start the session — try again")
        }
    }

    private func showError(_ message: String) {
        errorText = message
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if errorText == message { errorText = nil }
        }
    }
}

#Preview("NewSessionView") {
    NavigationStack {
        NewSessionView(onDeviceTap: {}, onSpawned: { _ in })
            .environmentObject(AppModel())
    }
    .eosTheme()
}
