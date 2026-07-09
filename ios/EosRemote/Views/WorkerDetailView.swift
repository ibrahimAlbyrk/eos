import SwiftUI
import EosRemoteKit

// Conversation (contract §C3, ref IMG_4429 — rewrite of the v1 worker detail, file kept). The
// screen-local header (back / title / three-dot) floats over an §E1 gradient; the transcript
// pipeline (TaskFromView, LoopStatusCard, MessageView list, GoalCheckLine/ProcessingLine,
// TranscriptFoot, backward paging, bottom anchor) is re-hosted unchanged. New in v2: the stacked
// permission banner + ChatComposer in the bottom safeAreaInset (§E2 gradient), the interrupt
// affordance as the send button's alternate (D-15), the attention ledger touch (§D4), and the
// archived read-only state (Restore pill instead of composer).
struct WorkerDetailView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    let workerId: String

    @FocusState private var composerFocused: Bool
    // Blur-in ledger (spec 03 §6.1): seeds the loaded history as already-revealed so only output
    // arriving after entry animates. Bound to workerId so each transcript seeds its own history.
    @StateObject private var reveal = RevealLedger()

    @State private var showModelSheet = false
    @State private var showModeSheet = false
    @State private var showRename = false
    // Optimistic mode-pill state (§C3): set on pick, reverted on PUT failure, cleared when the
    // worker row catches up over SSE.
    @State private var modeOverride: PermissionModeUI?
    @State private var errorToast: String?

    private var worker: Worker? { model.workers.first { $0.id == workerId } }
    private var archivedWorker: Worker? { model.archived.first { $0.id == workerId } }
    private var isArchived: Bool { worker == nil && archivedWorker != nil }
    private var anyWorker: Worker? { worker ?? archivedWorker }
    private var title: String { anyWorker.map(nameOf) ?? workerId }

    private var currentMode: PermissionModeUI {
        if let m = modeOverride { return m }
        if let raw = worker?.permissionMode, let m = PermissionModeUI(rawValue: raw) { return m }
        return .acceptEdits
    }

    private var currentModelDisplay: String {
        let choices = ModelCatalog.choices(for: model.uiConfig)
        return ModelCatalog.resolve(anyWorker?.model, in: choices)?.displayName
            ?? anyWorker?.model ?? "Model"
    }

    // §C3 banner scope (D-9): asks addressed to the open agent or any of its descendants — walk
    // each ask's parent chain up to the open id (cheaper than materializing the subtree).
    private var bannerPending: [Pending] {
        let workers = model.workers
        func inSubtree(_ id: String?) -> Bool {
            var cur = id, hops = 0
            while let c = cur, hops < 64 {
                if c == workerId { return true }
                cur = workers.first { $0.id == c }?.parentId
                hops += 1
            }
            return false
        }
        return model.pending.filter { inSubtree($0.workerId) }
    }

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: EosSpacing.md) {
                if model.hasOlder {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, EosSpacing.xs)
                        .onAppear { Task { await model.loadOlder() } }
                }
                // Top-of-transcript task card (spec 03 §1 MessageTask): "Task from {parent}" + the
                // boot prompt, shown when this worker was spawned by an orchestrator.
                if let w = anyWorker, let parentId = w.parentId, let prompt = w.prompt, !prompt.isEmpty {
                    TaskFromView(prompt: prompt,
                                 parent: AgentRef(id: parentId,
                                                  name: model.workers.first { $0.id == parentId }?.name ?? "orchestrator"))
                        .padding(.bottom, EosSpacing.xs)
                }
                // Status card for an active dynamic loop (spec 03 §1 LoopStatus). Absent when none.
                if let loop = anyWorker?.loop {
                    LoopStatusCardView(loop: loop, history: model.loopHistory(for: workerId))
                        .padding(.bottom, EosSpacing.xs)
                }
                ForEach(model.transcript) { MessageView(block: $0).id($0.id) }
                // Foot activity anchor: live goal-check line while a looped worker idles under an
                // active check, else the ProcessingLine spark.
                if let check = model.activeGoalCheck(for: workerId) {
                    GoalCheckLineView(check: check)
                        .padding(.top, EosSpacing.xxs)
                } else {
                    ProcessingLineView(busy: model.isBusy(workerId))
                        .padding(.top, EosSpacing.xxs)
                }
                TranscriptFoot()
            }
            .padding(.horizontal, EosSpacing.screenInset)
        }
        .environmentObject(reveal)
        // Bottom anchor lands the newest message on open and follows the tail at the bottom.
        .defaultScrollAnchor(.bottom)
        .scrollDismissesKeyboard(.interactively)
        // Tap-outside keyboard dismiss (§E4, master 17) alongside the interactive drag.
        .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
        .task(id: workerId) {
            reveal.bind(sessionId: workerId)
            await model.openWorker(workerId)
            model.markViewed(workerId)          // §D4: viewed on open
            // Let the first page paint, then open the animation window so only later output blurs in.
            try? await Task.sleep(nanoseconds: 350_000_000)
            reveal.markEntrySettled()
        }
        .onDisappear {
            model.closeWorker(workerId)
            model.markViewed(workerId)          // §D4: viewed on close too
        }
        // Worker gone from both lists while connected (killed/purged elsewhere) → pop (§C3).
        .onChange(of: model.workers) {
            if model.connected, !model.workers.isEmpty, worker == nil, archivedWorker == nil { dismiss() }
        }
        .onChange(of: worker?.permissionMode) { _, mode in
            if let mode, mode == modeOverride?.rawValue { modeOverride = nil }
        }
        .background(EosColor.bg)
        .safeAreaInset(edge: .top) { header }
        .safeAreaInset(edge: .bottom) { bottomStack }
        .overlay {
            if showRename {
                RenameSessionDialog(workerId: workerId, currentName: title,
                                    onDone: { showRename = false },
                                    onError: showError)
            }
        }
        .sheet(isPresented: $showModelSheet) {
            // Sheets don't inherit the environment object — inject explicitly (RootView pattern).
            if let worker {
                ModelSheet(context: .worker(worker)).environmentObject(model)
            }
        }
        .sheet(isPresented: $showModeSheet) {
            ModeSheet(current: currentMode, onPick: applyMode).environmentObject(model)
        }
        .toolbar {
            ToolbarItemGroup(placement: .keyboard) {
                Spacer()
                Button("Done") { composerFocused = false }
            }
        }
    }

    // MARK: header (§C3 anatomy over the §E1 gradient)

    private var header: some View {
        VStack(spacing: EosSpacing.xxs) {
            GlassEffectContainer(spacing: 8) {
                HStack(spacing: EosSpacing.sm) {
                    CircularIconButton(systemName: "chevron.backward", diameter: 40, glass: true,
                                       accessibilityLabel: "Back") { dismiss() }
                    Spacer()
                    Text(title)
                        .font(EosFont.labelStrong)
                        .foregroundStyle(EosColor.ink)
                        .lineLimit(1)
                    Spacer()
                    if isArchived {
                        Color.clear.frame(width: 40, height: 40)   // keeps the title centered
                    } else {
                        menuButton
                    }
                }
            }
            .padding(.horizontal, EosSpacing.screenInset)
            .padding(.vertical, EosSpacing.xs)
            if !model.connected {
                OfflineChip(connecting: model.connecting, deviceLabel: model.activeDevice?.label)
            }
        }
        .background {
            LinearGradient(colors: [EosColor.bg, EosColor.bg.opacity(0.9), EosColor.bg.opacity(0)],
                           startPoint: .top, endPoint: .bottom)
                .padding(.bottom, -16)         // §E1: fades 16pt past the bar row, no hard clip
                .ignoresSafeArea(edges: .top)
        }
    }

    private var menuButton: some View {
        Menu {
            SessionMenu(currentModelDisplay: currentModelDisplay,
                        onChangeModel: { showModelSheet = true },
                        onRename: { showRename = true },
                        onArchive: archiveSession)
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(EosColor.ink)
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .glassEffect(.regular.interactive(), in: .circle)
        .accessibilityLabel("Session menu")
    }

    // MARK: bottom stack (banner + composer, or the archived Restore pill) over the §E2 gradient

    private var bottomStack: some View {
        VStack(spacing: EosSpacing.sm) {
            if let errorToast {
                Text(errorToast)
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.ink)
                    .padding(.horizontal, EosSpacing.sm)
                    .padding(.vertical, EosSpacing.xs)
                    .background(EosColor.surface3, in: Capsule())
                    .overlay(Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
                    .transition(.opacity)
            }
            if isArchived {
                restoreBar
            } else {
                ConversationBottomBar(workerId: workerId,
                                      workerName: title,
                                      isBusy: model.isBusy(workerId),
                                      pending: bannerPending,
                                      mode: currentMode,
                                      onModeTap: { showModeSheet = true },
                                      onError: showError,
                                      focused: $composerFocused,
                                      upload: { name, data in await model.uploadAttachment(name: name, data: data) })
                    .id(workerId)               // reset the draft (chips/text) per conversation
                    .disabled(!model.connected)
                    .opacity(model.connected ? 1 : 0.55)
            }
        }
        .padding(.horizontal, EosSpacing.screenInset)
        .padding(.bottom, EosSpacing.xs)
        .background {
            LinearGradient(colors: [.clear, EosColor.bg], startPoint: .top, endPoint: .bottom)
                .padding(.top, -24)             // §E2: 24pt overshoot above the stack
                .ignoresSafeArea(edges: .bottom)
        }
    }

    private var restoreBar: some View {
        HStack {
            Spacer()
            PillButton("Restore session", style: .coral) {
                Task {
                    if await model.restore(workerId) {
                        Haptics.success()
                        _ = await model.fetchArchived()   // drops the row; live list lands via SSE
                    } else {
                        showError("Couldn't restore the session")
                    }
                }
            }
            .disabled(!model.connected)
            .opacity(model.connected ? 1 : 0.55)
            Spacer()
        }
    }

    // MARK: actions

    private func applyMode(_ mode: PermissionModeUI) {
        modeOverride = mode                     // optimistic (§C3), reverted on error
        Task {
            if !(await model.setPermissionMode(workerId, mode: mode.rawValue)) {
                modeOverride = nil
                showError("Couldn't change the mode")
            }
        }
    }

    private func archiveSession() {
        Haptics.warning()
        Task {
            if await model.archive(workerId) { dismiss() }
            else { showError("Couldn't archive the session") }
        }
    }

    private func showError(_ message: String) {
        withAnimation(.easeOut(duration: 0.15)) { errorToast = message }
        Task {
            try? await Task.sleep(nanoseconds: 4_000_000_000)
            if errorToast == message {
                withAnimation(.easeOut(duration: 0.15)) { errorToast = nil }
            }
        }
    }
}

// The banner + composer block. A separate view so it can OWN the AttachmentDraftModel as a
// @StateObject (created with the upload hook at init — the parent can't: @EnvironmentObject isn't
// available in a View's init) and observe its chip-status flips.
private struct ConversationBottomBar: View {
    @EnvironmentObject private var model: AppModel
    let workerId: String
    let workerName: String
    let isBusy: Bool
    let pending: [Pending]
    let mode: PermissionModeUI
    let onModeTap: () -> Void
    let onError: (String) -> Void
    var focused: FocusState<Bool>.Binding

    @StateObject private var draft: AttachmentDraftModel
    @State private var text = ""
    @State private var presentCamera = false
    @State private var presentPhotos = false
    @State private var presentFiles = false

    init(workerId: String, workerName: String, isBusy: Bool, pending: [Pending],
         mode: PermissionModeUI, onModeTap: @escaping () -> Void,
         onError: @escaping (String) -> Void, focused: FocusState<Bool>.Binding,
         upload: @escaping (String, Data) async -> String?) {
        self.workerId = workerId
        self.workerName = workerName
        self.isBusy = isBusy
        self.pending = pending
        self.mode = mode
        self.onModeTap = onModeTap
        self.onError = onError
        self.focused = focused
        _draft = StateObject(wrappedValue: AttachmentDraftModel(upload: upload))
    }

    var body: some View {
        VStack(spacing: EosSpacing.sm) {
            PermissionBanner(pending: pending,
                             nameFor: { id in model.workers.first { $0.id == id }.map(nameOf) ?? id },
                             onAllow: allow, onAlwaysAllow: alwaysAllow, onDeny: deny)
            ChatComposer(text: $text, placeholder: "Reply to \(workerName)",
                         mode: mode, onModeTap: onModeTap,
                         attachMenu: {
                             AnyView(AttachmentMenu.content(draft: draft,
                                                            presentCamera: $presentCamera,
                                                            presentPhotos: $presentPhotos,
                                                            presentFiles: $presentFiles))
                         },
                         chips: draft.items,
                         onRemoveChip: { draft.remove(label: $0) },   // chip.id == deduped label
                         onRetryChip: { draft.retry(label: $0) },
                         trailing: trailingAction,
                         focused: focused)
        }
        .attachmentPickers(draft: draft, camera: $presentCamera,
                           photos: $presentPhotos, files: $presentFiles)
        .onChange(of: draft.lastError) { _, e in
            if let e { onError(e); draft.lastError = nil }
        }
    }

    // D-15: busy + empty field ⇒ interrupt; with text the send arrow returns (message queues).
    private var trailingAction: ComposerAction {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if isBusy && trimmed.isEmpty {
            return .interrupt({ Task { await model.interrupt(workerId) } })
        }
        let uploading = draft.items.contains {
            if case .uploading = $0.status { return true } else { return false }
        }
        return .send(enabled: !trimmed.isEmpty && !uploading, send)
    }

    private func send() {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let payload = trimmed + draft.suffix()  // §C8: the Mac wire suffix rides the text verbatim
        text = ""
        focused.wrappedValue = false
        draft.clear()
        Haptics.success()
        Task { await model.sendMessage(to: workerId, text: payload) }
    }

    // §C3 banner wiring (Mac usePendingPermissions order): Always allow = decision POST first,
    // then the policy rule fire-and-forget. Resolved rows drop via the Store pending patches.
    private func allow(_ p: Pending) {
        Haptics.success()
        Task { await model.approve(pendingId: p.id, allow: true) }
    }

    private func alwaysAllow(_ p: Pending) {
        Haptics.success()
        Task {
            await model.approve(pendingId: p.id, allow: true)
            await model.addPolicyRule(tool: p.toolName ?? "")   // POST /api/policy/rule {tool, behavior:"allow"}
        }
    }

    private func deny(_ p: Pending) {
        Haptics.warning()
        Task { await model.approve(pendingId: p.id, allow: false) }
    }
}

// Transcript foot (spec 02 §3.5): the small Sunburst + an Eos-domain AI disclaimer (the risk here is
// actions taken, not answers).
struct TranscriptFoot: View {
    var body: some View {
        HStack(spacing: EosSpacing.xxs) {
            DawnStar(size: 13)
            Text("Eos runs autonomous agents and can make mistakes. Review actions before approving.")
                .font(EosFont.caption)
                .foregroundStyle(EosColor.inkTertiary)
        }
        .padding(.vertical, EosSpacing.md)
    }
}
