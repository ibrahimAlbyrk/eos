import SwiftUI
import EosRemoteKit

// Conversation (contract §C3, ref IMG_4429 — rewrite of the v1 worker detail, file kept). The
// screen-local header (back / title / three-dot) floats over an §E1 gradient; the transcript
// pipeline (TaskFromView, LoopStatusCard, MessageView list, GoalCheckLine/ProcessingLine,
// backward paging, bottom anchor) is re-hosted unchanged. New in v2: the stacked
// permission banner + ChatComposer in the bottom safeAreaInset (§E2 gradient), the interrupt
// affordance as the send button's alternate (D-15), the attention ledger touch (§D4), and the
// archived read-only state (Restore pill instead of composer).
struct WorkerDetailView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let workerId: String

    @FocusState private var composerFocused: Bool
    // Blur-in ledger (spec 03 §6.1): seeds the loaded history as already-revealed so only output
    // arriving after entry animates. Bound to workerId so each transcript seeds its own history.
    @StateObject private var reveal = RevealLedger()

    @State private var showModelSheet = false
    @State private var showModeSheet = false
    @State private var showRename = false
    // Bug-A guards (round 3): `landed` = the initial page has been explicitly
    // scrolled to the tail (defaultScrollAnchor alone loses the race when the
    // first page lands async and re-flows the LazyVStack estimates); until then
    // transcript changes keep re-landing. `pagingArmed` holds the top loader off
    // during that settle — before the fix it auto-fired on open and prepended a
    // 500-row page mid-anchor-settle, which is what left the viewport off-content.
    @State private var landed = false
    @State private var pagingArmed = false
    // Scroll-to-bottom affordance (round 20): true once the viewport drifts more than
    // ~one screen up from the tail; the floating "↓" button above the composer reads it.
    // Hidden at/near the tail so it never appears while pinned during live streaming.
    @State private var awayFromTail = false
    // Imperative scroll handle for the button tap. An idle ScrollPosition (no initial edge) so it
    // only reflects position and never pins — its scrollTo(edge:) CANCELS in-flight deceleration,
    // which proxy.scrollTo(id:) does not (a mid-momentum tap was otherwise ignored until the glide
    // stopped). Landing/tail-follow still ride the proxy + defaultScrollAnchor below, untouched.
    @State private var scrollPosition = ScrollPosition()
    private static let tailAnchor = "transcript-tail"
    // Round 5, item E: while a disclosure toggle animates, size changes anchor to
    // .top instead of .bottom so the expansion grows downward and the tapped row
    // stays where it was. Outside the hold the .bottom anchor keeps tail-follow
    // and the top-pager's prepend stability (round-3 Bug A) exactly as before.
    @State private var disclosureHold = false
    @State private var disclosureHoldTask: Task<Void, Never>?
    // In-flight guard for the gone-from-both-lists check (validatePresence below).
    @State private var checkingPresence = false
    // Optimistic mode-pill state (§C3): set on pick, reverted on PUT failure, cleared when the
    // worker row catches up over SSE.
    @State private var modeOverride: PermissionModeUI?
    @State private var errorToast: String?
    // File viewer host (round 4): every file affordance in the transcript funnels through
    // \.openFile into this one sheet.
    @State private var viewedFile: ViewedFile?

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
        ScrollViewReader { proxy in scrollBody(proxy) }
    }

    private func scrollBody(_ proxy: ScrollViewProxy) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: EosSpacing.md) {
                if model.hasOlder {
                    ProgressView()
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, EosSpacing.xs)
                        // Backward paging only after the open has settled; re-keyed on arm so
                        // onAppear re-fires if the loader is already on screen at that moment.
                        .id("older-pager-\(pagingArmed)")
                        .onAppear { if pagingArmed { Task { await model.loadOlder() } } }
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
                    ProcessingLineView(busy: model.isBusy(workerId),
                                       turnStartedAt: worker?.turnStartedAt,
                                       clock: model.turnClock)
                        .padding(.top, EosSpacing.xxs)
                }
                Color.clear.frame(height: 1).id(Self.tailAnchor)
            }
            .padding(.horizontal, EosSpacing.screenInset)
        }
        .environmentObject(reveal)
        .accessibilityIdentifier("transcript")
        .scrollPosition($scrollPosition)
        // Bottom anchor lands the newest message on open and follows the tail at the
        // bottom — except mid-disclosure, where size changes hold the top instead.
        .defaultScrollAnchor(.bottom, for: .initialOffset)
        .defaultScrollAnchor(.bottom, for: .alignment)
        .defaultScrollAnchor(disclosureHold ? .top : .bottom, for: .sizeChanges)
        // Round 20: watch how far the viewport sits above the tail. The button appears once
        // that gap exceeds one screen (tail-follow disengaged) and hides as it closes — reading
        // geometry, not the anchors, so round-3/round-5 tail-follow is untouched.
        .onScrollGeometryChange(for: Bool.self) { geo in
            let gap = geo.contentSize.height + geo.contentInsets.bottom
                - geo.contentOffset.y - geo.containerSize.height
            return gap > geo.containerSize.height
        } action: { _, away in
            guard away != awayFromTail else { return }
            if reduceMotion { awayFromTail = away }
            else { withAnimation(EosSpring.chip) { awayFromTail = away } }
        }
        .environment(\.onDisclosureToggle) { holdScrollForDisclosure() }
        .scrollDismissesKeyboard(.interactively)
        // Tap-outside keyboard dismiss (§E4, master 17) alongside the interactive drag.
        .simultaneousGesture(TapGesture().onEnded { composerFocused = false })
        .task(id: workerId) {
            landed = false; pagingArmed = false
            reveal.bind(sessionId: workerId)
            await model.openWorker(workerId)
            model.markViewed(workerId)          // §D4: viewed on open
            if !landed && !model.transcript.isEmpty { landTail(proxy) }
            // Let the first page paint, then open the animation window so only later output blurs in.
            try? await Task.sleep(nanoseconds: 350_000_000)
            reveal.markEntrySettled()
        }
        // Slow first page: the transcript lands after the open — land the tail then.
        .onChange(of: model.transcript.count) {
            if !landed && !model.transcript.isEmpty { landTail(proxy) }
        }
        .onDisappear {
            model.closeWorker(workerId)
            model.markViewed(workerId)          // §D4: viewed on close too
        }
        // Worker missing from both lists once the device is connected + loaded (killed/purged
        // elsewhere, or a restored id that no longer exists — round 7): refresh archived once to
        // rule out an archive we haven't fetched yet, then pop silently (§C3).
        .onChange(of: model.workers) { validatePresence() }
        .onChange(of: model.workersLoaded) { validatePresence() }
        .onChange(of: worker?.permissionMode) { _, mode in
            if let mode, mode == modeOverride?.rawValue { modeOverride = nil }
        }
        .background(EosColor.bg)
        .safeAreaInset(edge: .top) { header }
        .safeAreaInset(edge: .bottom) {
            bottomStack
                .overlay(alignment: .top) { scrollToBottomButton }
        }
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
        .environment(\.openFile) { viewedFile = ViewedFile(path: $0) }
        .sheet(item: $viewedFile) { file in
            FileViewerSheet(path: file.path).environmentObject(model)
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

    // Floating "↓" over the transcript, centered just above the composer (§ round 20). Uses the
    // design-system glass circle so it reads as the same chrome as the top-bar buttons. Present only
    // when the viewport is more than a screen above the tail; fades with the DS spring (instant under
    // reduce-motion). Offset lifts it clear of the composer's top edge.
    @ViewBuilder
    private var scrollToBottomButton: some View {
        if awayFromTail {
            CircularIconButton(systemName: "arrow.down", diameter: 44, glass: true,
                               accessibilityLabel: "Scroll to latest") { scrollToTail() }
                .accessibilityIdentifier("scroll-to-bottom")
                .offset(y: -(44 + EosSpacing.sm))
                .transition(reduceMotion ? .identity : .opacity)
        }
    }

    // Fast animated jump to the tail; re-engages tail-follow exactly as a manual scroll-to-bottom
    // does (the .bottom alignment anchor resumes once the viewport lands there). scrollTo(edge:)
    // cancels any in-flight deceleration, so a tap mid-glide lands immediately. Instant under
    // reduce-motion.
    private func scrollToTail() {
        Haptics.tap()
        if reduceMotion {
            scrollPosition.scrollTo(edge: .bottom)
        } else {
            withAnimation(EosSpring.chip) { scrollPosition.scrollTo(edge: .bottom) }
        }
    }

    // MARK: actions

    // Land the viewport on the transcript tail. One scrollTo is not enough: the
    // LazyVStack materializes cells in waves and each wave re-estimates heights
    // (same pathology MessageGalleryView documents), so converge with re-passes
    // before arming the top pager — un-gated, its onAppear fired during the
    // settle and prepended a whole older page mid-layout (the blank-open bug).
    private func landTail(_ proxy: ScrollViewProxy) {
        landed = true
        let target = workerId
        proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
        Task { @MainActor in
            for delayMs in [150, 450] {
                try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                guard workerId == target else { return }
                proxy.scrollTo(Self.tailAnchor, anchor: .bottom)
            }
            try? await Task.sleep(nanoseconds: 150_000_000)
            if workerId == target { pagingArmed = true }
        }
    }

    // Hold the size-change anchor at .top across the 0.15s disclosure animation
    // (plus settle). Called synchronously from the toggle, so the anchor flips in
    // the same update as the height change begins.
    private func holdScrollForDisclosure() {
        disclosureHold = true
        disclosureHoldTask?.cancel()
        disclosureHoldTask = Task { @MainActor in
            try? await Task.sleep(nanoseconds: 500_000_000)
            guard !Task.isCancelled else { return }
            disclosureHold = false
        }
    }

    private var goneFromBothLists: Bool {
        UIRestore.shouldClose(openId: workerId, connected: model.connected,
                              workersLoaded: model.workersLoaded,
                              workerIds: model.workers.map(\.id),
                              archivedIds: model.archived.map(\.id))
    }

    private func validatePresence() {
        guard goneFromBothLists, !checkingPresence else { return }
        checkingPresence = true
        Task {
            _ = await model.fetchArchived()
            if goneFromBothLists { dismiss() }
            checkingPresence = false
        }
    }

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
