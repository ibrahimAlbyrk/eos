#if DEBUG
import SwiftUI
import EosRemoteKit

// DEBUG render-gallery (reusable verification harness) — a scrolling list of MessageViews seeded with
// representative sample Blocks so the text renderers can be eyeballed without a live daemon. Reachable
// via the `-eosGallery` launch arg (mirrors RootView's pairing-bypass pattern). Later phases extend
// the sample set with tool/agent/terminal blocks.
struct MessageGalleryView: View {
    @StateObject private var reveal = RevealLedger()

    // `-eosGalleryScroll <anchor>` jumps to a sample on launch so regions below the fold (code fences,
    // table) can be screenshotted without scroll tooling. Anchors: "assistant" (top of the reply).
    private var scrollAnchor: String? {
        guard let i = CommandLine.arguments.firstIndex(of: "-eosGalleryScroll"),
              i + 1 < CommandLine.arguments.count else { return nil }
        return CommandLine.arguments[i + 1]
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: EosSpacing.md) {
                    Text("Message Render Gallery")
                        .font(EosFont.titleSerif).foregroundStyle(EosColor.ink)
                        .padding(.top, EosSpacing.md)
                    Text("ui font: \(EosFont.uiFontIsJakarta ? "Plus Jakarta Sans" : "SF Pro (fallback)") · code font: \(EosFont.codeFontIsJetBrains ? "JetBrains Mono" : "SF Mono (fallback)") · highlight theme: \(CodeHighlighter.themeName)")
                        .font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
                    ForEach(MessageGallerySamples.blocks) { block in
                        MessageView(block: block).id(block.id)
                        Divider().opacity(0.4)
                    }
                    loopShowcase.id("loops")                 // terminal + loop-status + goal-check surfaces
                    detailShowcase.id("details")            // expanded detail bodies (diff / preview / generic)
                    registryShowcase.id("registry")         // Tier-2 tool-registry cards
                    tier3Showcase.id("tier3")               // Tier-3 long tail (system / git / worktree)
                    Color.clear.frame(height: 1).id("end")   // scroll target for verifying the fold
                }
                .padding(.horizontal, EosSpacing.screenInset)
            }
            .environmentObject(reveal)
            .background(EosColor.bg)
            .task {
                reveal.bind(sessionId: "gallery")
                reveal.markEntrySettled()   // static gallery → post-seed blocks reveal on first paint
                if let anchor = scrollAnchor {
                    // Re-scroll a few times: the LazyVStack materializes below-fold sections on demand,
                    // so a single scrollTo to a far anchor undershoots. Converge after content loads.
                    let edge: UnitPoint = anchor == "end" ? .bottom : .top
                    for _ in 0..<6 {
                        try? await Task.sleep(nanoseconds: 250_000_000)
                        proxy.scrollTo(anchor, anchor: edge)
                    }
                }
            }
        }
    }

    // The transcript-top LoopStatus card (active / passed / exhausted tints) + the live GoalCheck line
    // — surfaces that aren't Block payloads, so they're rendered directly here (4c-i acceptance list).
    private var loopShowcase: some View {
        VStack(alignment: .leading, spacing: EosSpacing.sm) {
            Text("Loop surfaces").font(EosFont.heading).foregroundStyle(EosColor.ink)
            Text("LoopStatus — active").font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
            LoopStatusCardView(loop: MessageGallerySamples.loopStatusSample,
                               history: MessageGallerySamples.loopHistorySample)
            Text("LoopStatus — passed").font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
            LoopStatusCardView(loop: WorkerLoop(raw: .object([
                "status": .string("passed"), "attempt": .number(4), "maxAttempts": .number(5),
                "lastReason": .string("All criteria satisfied."),
                "goalSummary": .string("Ship the Terminal card + Loop family."),
            ]))!, history: MessageGallerySamples.loopHistorySample)
            Text("LoopStatus — exhausted (unbounded)").font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
            LoopStatusCardView(loop: WorkerLoop(raw: .object([
                "status": .string("exhausted"), "attempt": .number(8), "maxAttempts": .null,
                "lastReason": .string("Attempt budget spent without meeting the goal."),
                "goalSummary": .string("Ship the Terminal card + Loop family."),
            ]))!, history: MessageGallerySamples.loopHistorySample)
            Text("GoalCheckLine — live (idle under a check)").font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
            GoalCheckLineView(check: MessageGallerySamples.goalCheckSample)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // The expanded tool DETAIL bodies rendered directly (a tap-free view of the diff hunks, code
    // preview, bash command/output, and the generic parameters/output/raw card).
    private var detailShowcase: some View {
        VStack(alignment: .leading, spacing: EosSpacing.sm) {
            Text("Expanded detail bodies").font(EosFont.heading).foregroundStyle(EosColor.ink)
            Text("Edit — diff hunks").font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
            EditDetailView(tool: MessageGallerySamples.editToolSample)
            Text("Read — code preview").font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
            ReadDetailView(tool: MessageGallerySamples.readToolSample)
            Text("Bash — command + output").font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
            BashDetailView(tool: MessageGallerySamples.bashToolSample)
            Text("Unknown — generic fallback card").font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
            GenericToolCardView(tool: MessageGallerySamples.unknownToolSample)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // The Tier-2 TOOL-REGISTRY cards. A representative sample of each new family —
    // worker/create/peer/task/workflow/ask/notify/skill/datetime/etc — rendered as real ToolItemViews
    // (collapsed rows, tap to expand) plus the top-of-transcript TaskFrom header and the workflow report.
    @ViewBuilder private var registryShowcase: some View {
        VStack(alignment: .leading, spacing: EosSpacing.sm) {
            Text("Tier-2 tool registry (4c-ii)").font(EosFont.heading).foregroundStyle(EosColor.ink)

            galleryLabel("TaskFrom header (top-of-transcript)")
            TaskFromView(prompt: MessageGallerySamples.taskFromPrompt,
                         parent: AgentRef(id: "orch", name: "orchestrator"))

            galleryLabel("Tool rows — tap to expand")
            ForEach(MessageGallerySamples.registryTools, id: \.id) { tool in
                ToolItemView(tool: tool)
            }

            galleryLabel("TaskUpdate (expanded)")
            TaskUpdateDetailView(tool: MessageGallerySamples.taskUpdateTool)

            galleryLabel("TaskList (expanded)")
            TaskListDetailView(tool: MessageGallerySamples.taskListTool)

            galleryLabel("workflow tool card (expanded)")
            WorkflowToolDetailView(tool: MessageGallerySamples.workflowTool)

            galleryLabel("workflow completion report")
            WorkflowReportView(text: MessageGallerySamples.workflowReportText)

            galleryLabel("available workers (expanded)")
            AvailableWorkersDetailView(tool: MessageGallerySamples.availableWorkersTool)

            // The higher-value expanded cards sit adjacent to the bottom `end` anchor so a launch with
            // `-eosGalleryScroll end` reliably lands on them (the LazyVStack converges on .bottom).
            galleryLabel("spawn_worker w/ loop badge (expanded)").id("registry-expanded")
            WorkerToolBodyView(tool: MessageGallerySamples.spawnWorkerTool)

            galleryLabel("ask_user Q&A (expanded)")
            AskUserDetailView(tool: MessageGallerySamples.askUserTool)

            galleryLabel("peer ask (expanded)")
            PeerAskDetailView(tool: MessageGallerySamples.peerAskTool)

            galleryLabel("TodoWrite (expanded)")
            TodoWriteDetailView(tool: MessageGallerySamples.todoWriteTool)

            galleryLabel("create_worker blueprint (expanded)")
            CreateWorkerDetailView(tool: MessageGallerySamples.createWorkerTool)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    // The Tier-3 long tail (§8.3) rendered directly, each under a label, so the final full-transcript
    // proof shows the system markers, git records, and worktree card grouped and titled. These also
    // appear inline in the top `blocks` scroll; this section is the labeled reference view.
    private var tier3Showcase: some View {
        VStack(alignment: .leading, spacing: EosSpacing.sm) {
            Text("Tier-3 long tail").font(EosFont.heading).foregroundStyle(EosColor.ink)

            galleryLabel("deliveryFailed — SystemLineView (§1 #13)")
            SystemLineView(kind: .deliveryFailed(text: "run the audit and report back"))

            galleryLabel("cleared — centered divider (§1 #14)")
            SystemLineView(kind: .cleared)

            galleryLabel("turnError — humanized provider error (§1 #15)")
            SystemLineView(kind: .turnError(message: providerErrorMessage("insufficient_credits")))

            galleryLabel("push [ok] — GitLineView (§1 #16)")
            GitLineView(direction: .push, ok: true, message: "Pushed 3 commits", branch: "eos-task-cards")

            galleryLabel("pull [err] — GitLineView (§1 #17)")
            GitLineView(direction: .pull, ok: false,
                        message: "Pull failed: local changes would be overwritten", branch: "main")

            galleryLabel("worktreePreserved — Reveal copies path (§1 #18)")
            WorktreePreservedView(path: "/Users/dev/.eos/worktrees/eos-task-cards", branch: "eos-task-cards",
                                  diffStat: " a.swift | 3 +\n b.swift | 9 +-\n c.yml | 1 +")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func galleryLabel(_ text: String) -> some View {
        Text(text).font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
    }
}

// Representative sample blocks (spec's gallery acceptance list). Kept separate so later phases append
// tool/agent/report samples without touching the view.
enum MessageGallerySamples {
    static let blocks: [Block] = [
        Block(id: "u-1", workerId: "w-demo", ts: base - 300_000,
              payload: .user(text: userSample, optimistic: false)),
        Block(id: "th-1", workerId: "w-demo", ts: base - 200_000,
              payload: .thinking(text: thinkingSample)),
        Block(id: "a-1", workerId: "w-demo", ts: base - 100_000,
              payload: .assistant(text: assistantSample)),
        // Tool / agent / report tier (spec gallery acceptance list).
        Block(id: "t-read", workerId: "w-demo", ts: base - 90_000, payload: .tool(readTool)),
        Block(id: "t-edit", workerId: "w-demo", ts: base - 80_000, payload: .tool(editTool)),
        Block(id: "t-bash", workerId: "w-demo", ts: base - 70_000, payload: .tool(bashTool)),
        Block(id: "t-fail", workerId: "w-demo", ts: base - 60_000, payload: .tool(deniedTool)),
        Block(id: "tg-1", workerId: "w-demo", ts: base - 50_000,
              payload: .toolGroup(lane: .generic, summary: buildSummary([readTool, readTool2, editTool]),
                                  tools: [readTool, readTool2, editTool])),
        Block(id: "t-unknown", workerId: "w-demo", ts: base - 40_000, payload: .tool(unknownTool)),
        Block(id: "ag-1", workerId: "w-demo", ts: base - 30_000, payload: .agentRun(agentRunSample)),
        Block(id: "rep-1", workerId: "w-demo", ts: base - 20_000,
              payload: .report(text: reportSample, fromWorker: nil, workerName: "refactor-auth")),
        // The Terminal card (running / done ✓ / failed ✗ 1) + the Loop family (§ gallery
        // acceptance list). The live terminal is flagged live=true so the running head + spinner render.
        Block(id: "term-run", workerId: "w-demo", ts: base - 18_000, live: true, payload: .terminal(terminalRunning)),
        Block(id: "term-ok", workerId: "w-demo", ts: base - 16_000, payload: .terminal(terminalDone)),
        Block(id: "term-fail", workerId: "w-demo", ts: base - 14_000, payload: .terminal(terminalFailed)),
        Block(id: "loop-1", workerId: "w-demo", ts: base - 12_000, payload: .loop(text: loopRetrigger)),
        Block(id: "lc-met", workerId: "w-demo", ts: base - 10_000, payload: .loopCheck(loopCheckMet)),
        Block(id: "lc-unmet", workerId: "w-demo", ts: base - 8_000, payload: .loopCheck(loopCheckUnmet)),
        // The Tier-3 long tail (§8.3 / §1 #13–#18). System markers (deliveryFailed / cleared /
        // turnError → SystemLineView), the git records (push [ok] / pull [err] → GitLineView), and the
        // preserved-worktree card (→ WorktreePreservedView). This completes the Block.Payload coverage.
        Block(id: "df-1", workerId: "w-demo", ts: base - 7_000,
              payload: .deliveryFailed(text: "run the audit and report back")),
        Block(id: "clr-1", workerId: "w-demo", ts: base - 6_500, payload: .cleared),
        Block(id: "te-1", workerId: "w-demo", ts: base - 6_000,
              payload: .turnError(reason: "insufficient_credits",
                                  message: providerErrorMessage("insufficient_credits"))),
        Block(id: "push-ok", workerId: "w-demo", ts: base - 5_500,
              payload: .gitPush(ok: true, message: "Pushed 3 commits", branch: "eos-task-cards")),
        Block(id: "pull-err", workerId: "w-demo", ts: base - 5_000,
              payload: .gitPull(ok: false, message: "Pull failed: local changes would be overwritten", branch: "main")),
        Block(id: "wt-1", workerId: "w-demo", ts: base - 4_500,
              payload: .worktreePreserved(path: "/Users/dev/.eos/worktrees/eos-task-cards",
                                          branch: "eos-task-cards",
                                          diffStat: " ios/EosRemote/Views/BlockView.swift  | 12 +-\n ios/EosRemote/Views/Messages/Tools/GitLineView.swift | 48 ++++\n ios/project.yml | 2 +")),
    ]

    // Exposed for the loop showcase (the non-block LoopStatus card + live GoalCheck line).
    static var loopStatusSample: WorkerLoop { WorkerLoop(raw: loopStatusRaw)! }
    static var goalCheckSample: LoopCheckProgress { goalCheckProgress }
    static var loopHistorySample: [LoopCheck] { [loopCheckMet, loopCheckUnmet, loopCheckEscalated] }

    // MARK: terminal samples

    private static let terminalRunning = Terminal(
        runId: "run-1", command: "npm run build && npm test",
        output: "> build\n> vite build\n\nvite v5.2.0 building for production...\n✓ 214 modules transformed.\ndist/index.html   0.62 kB\nrendering chunks...",
        exitCode: 0, note: nil, truncated: false, done: false)

    private static let terminalDone = Terminal(
        runId: "run-2", command: "cd ios && xcodebuild build -scheme EosRemote",
        output: "Build settings from command line:\n    SDKROOT = iphonesimulator26.5\n\n** BUILD SUCCEEDED **",
        exitCode: 0, note: nil, truncated: false, done: true)

    private static let terminalFailed = Terminal(
        runId: "run-3", command: "swift build",
        output: "Compiling EosRemoteKit MessageNormalizer.swift\nerror: cannot find 'LoopCheckBuffer' in scope\n  1 error generated.",
        exitCode: 1, note: "exit 1", truncated: true, done: true)

    // MARK: loop samples

    private static let loopRetrigger =
        "Goal not yet met (2/5). Keep going: the diff-stats chip is still missing on the MultiEdit header, and the terminal auto-tail needs a fixture. Re-run the check when both land."

    private static let loopCheckMet = LoopCheck(
        attempt: 3, maxAttempts: 5, strategy: "hybrid", met: true, outcome: "released",
        reason: "All criteria satisfied: build green, tests pass, gallery screenshots present.")

    private static let loopCheckUnmet = LoopCheck(
        attempt: 2, maxAttempts: 5, strategy: "hybrid", met: false, outcome: "continued",
        reason: "Terminal auto-tail fixture missing; loop-status card not yet wired.")

    private static let loopCheckEscalated = LoopCheck(
        attempt: 4, maxAttempts: 5, strategy: "judge", met: false, outcome: "escalated",
        reason: "Judge paused the loop and surfaced the unverified report to the parent for a decision.")

    private static let loopStatusRaw: JSONValue = .object([
        "status": .string("active"), "attempt": .number(3), "maxAttempts": .number(5),
        "lastReason": .string("Terminal auto-tail fixture missing; loop-status card not yet wired."),
        "goalSummary": .string("Ship the Terminal card + Loop family with the live overlays wired and a green build."),
    ])

    private static let goalCheckProgress = LoopCheckProgress(
        workerId: "w-demo", attempt: 3, maxAttempts: 5, strategy: "hybrid", phase: "verifying",
        criterionId: "build-green", met: nil, outcome: nil, reason: nil,
        startedAt: Date().timeIntervalSince1970 * 1000 - 37_000)

    private static let base = Date().timeIntervalSince1970 * 1000

    // MARK: tool samples

    // Exposed for the detail-body showcase (the expanded views rendered tap-free).
    static var editToolSample: Tool { editTool }
    static var readToolSample: Tool { readTool }
    static var bashToolSample: Tool { bashTool }
    static var unknownToolSample: Tool { unknownTool }

    private static func mkResult(_ text: String, error: Bool = false, patch: JSONValue? = nil) -> ToolResult {
        ToolResult(text: text, isError: error, patch: patch)
    }

    private static let readTool = Tool(
        id: "tr1", name: "Read", verb: "read",
        input: .object(["file_path": .string("/Users/dev/Projects/eos/ios/EosRemoteKit/Data/DiffHelpers.swift")]),
        result: mkResult("     1\timport Foundation\n     2\t\n     3\t// Diff-hunk helpers (spec 03 §5.8).\n     4\tpublic struct DiffHunk: Sendable, Equatable {\n     5\t    public enum Kind { case ctx, del, add }\n     6\t    public let num: Int\n     7\t    public let text: String\n     8\t}"),
        running: false, done: true, ts: base - 90_000)

    private static let readTool2 = Tool(
        id: "tr2", name: "Read", verb: "read",
        input: .object(["file_path": .string("/Users/dev/Projects/eos/ios/project.yml")]),
        result: mkResult("name: EosRemote"), running: false, done: true, ts: base - 89_000)

    // Edit with a real diff hunk (old_string → new_string; LCS builds the hunks + inline highlight).
    private static let editTool = Tool(
        id: "te1", name: "Edit", verb: "edit",
        input: .object([
            "file_path": .string("/Users/dev/Projects/eos/ios/EosRemote/Views/BlockView.swift"),
            "old_string": .string("case .tool(let tool):\n    toolRow(tool)\n    Spacer()"),
            "new_string": .string("case .tool(let tool):\n    ToolItemView(tool: tool)\n    Spacer()"),
        ]),
        result: mkResult("The file has been updated."), running: false, done: true, ts: base - 80_000)

    private static let bashTool = Tool(
        id: "tb1", name: "Bash", verb: "bash",
        input: .object(["command": .string("cd ios && xcodebuild build -scheme EosRemote")]),
        result: mkResult("Build settings from command line:\n    SDKROOT = iphonesimulator26.5\n\n** BUILD SUCCEEDED **"),
        running: false, done: true, ts: base - 70_000)

    // A denied tool (isError + a permission-flavoured message → the denied badge + failed tint).
    private static let deniedTool = Tool(
        id: "td1", name: "Bash", verb: "bash",
        input: .object(["command": .string("rm -rf ~/.eos")]),
        result: mkResult("This command was denied by policy (destructive path).", error: true),
        running: false, done: true, ts: base - 60_000)

    // An unregistered MCP tool → FALLBACK descriptor + GenericToolCard.
    private static let unknownTool = Tool(
        id: "tu1", name: "mcp__custom__frobnicate", verb: "read",
        input: .object(["target": .string("widget-42"), "mode": .string("deep"), "retries": .number(3)]),
        result: mkResult("{ \"ok\": true, \"frobnicated\": 42 }"), running: false, done: true, ts: base - 40_000)

    private static let agentRunSample = AgentRun(
        toolUseId: "ag1", description: "audit the parser pipeline", prompt: "Read messageParser.js and cross-check every block kind against spec 03 §1. Report gaps.",
        model: "sonnet", subagentType: "Explore", status: "completed", background: false,
        result: "Found 2 gaps: the `turnError` humanization isn't wired, and `peer_consult` linking needs a fixture. Everything else matches.",
        tools: [readTool, bashTool])

    private static let reportSample =
        "Done. Wired the Tier-1 tool chrome + detail bodies, diff hunks, tool groups, the agent block, and the report rows. Build is green on iPhone 17 / iOS 26.5."

    private static let userSample =
        "Check the parser in @src/messageParser.js and open https://github.com/anthropics for the reference. Run /review when done."

    private static let thinkingSample =
        "The user wants the parser inspected. I should read messageParser.js first, then cross-check the block kinds against the spec. The table rendering path needs a closer look — GFM tables map to a Grid here."

    // MARK: 4c-ii Tier-2 registry samples

    static let taskFromPrompt =
        "Phase 4c-ii: implement the Tier-2 tool-registry cards for the iOS transcript. Follow docs/mobile-redesign/03 §2.2–2.6 and §3. See https://example.com/spec for the full table. Touch only ios/."

    // The collapsed tool rows (each dispatches through getToolView → its bespoke label/badge/detail).
    static var registryTools: [Tool] { [
        spawnWorkerTool, killWorkerTool, createWorkerTool, listActiveWorkersTool,
        notifyTool, skillTool, sendToParentTool, peerAskTool,
        taskCreateTool, taskUpdateTool, todoWriteTool, workflowTool, datetimeTool, scheduleWakeupTool,
    ] }

    // spawn_worker w/ arm-at-spawn loop → the "loop" header badge + loop-detail line + prompt.
    static let spawnWorkerTool = Tool(
        id: "sw1", name: "mcp__orchestrator__spawn_worker", verb: "spawn",
        input: .object([
            "prompt": .string("Port the §2.5 task detail views (TaskCreate/Update/Get/List/TodoWrite) and register them in getToolView. Match §10 geometry."),
            "loop": .object([
                "goal": .object(["summary": .string("build green + task cards render")]),
                "strategy": .string("hybrid"), "limit": .number(5),
            ]),
        ]),
        result: mkResult("{\"id\":\"w-task\",\"name\":\"task-cards\",\"state\":\"WORKING\"}"),
        running: false, done: true, ts: base)

    static let killWorkerTool = Tool(
        id: "kw1", name: "mcp__orchestrator__kill_worker", verb: "kill",
        input: .object(["id": .string("w-stale")]),
        result: mkResult("{\"id\":\"w-stale\",\"name\":\"stale-probe\",\"state\":\"KILLING\",\"branch\":\"eos-stale-probe\"}"),
        running: false, done: true, ts: base)

    static let listActiveWorkersTool = Tool(
        id: "lw1", name: "mcp__orchestrator__list_active_workers", verb: "list",
        input: .object([:]),
        result: mkResult("[{\"id\":\"w-a\",\"name\":\"parser-audit\",\"state\":\"IDLE\",\"prompt\":\"Cross-check block kinds against spec 03 §1.\"},{\"id\":\"w-b\",\"name\":\"task-cards\",\"state\":\"WORKING\",\"prompt\":\"Port the task detail views.\"}]"),
        running: false, done: true, ts: base)

    static let createWorkerTool = Tool(
        id: "cw1", name: "mcp__orchestrator__create_worker", verb: "create",
        input: .object([
            "name": .string("perf-profiler"),
            "description": .string("Profiles a hot path and reports the top offenders with flamegraph deltas."),
            "model": .string("sonnet"), "effort": .string("high"), "permissionMode": .string("acceptEdits"),
            "persistent": .bool(true),
            "whenToUse": .string("Dispatch when a change regresses latency and you need a ranked culprit list."),
            "toolsAllow": .array([.string("Read"), .string("Bash"), .string("mcp__*")]),
            "toolsDeny": .array([.string("Write")]),
            "editRegex": .string("(^|/)src/.*\\.ts$"),
            "body": .string("You are a performance profiler.\nProfile the named entry point.\nReport the top 5 offenders.\nInclude a before/after delta.\nDo not refactor — measure only.\nUse the repo's bench harness.\nKeep the report evidence-light.\nOne headline finding per line.\nCite the file:line for each.\nStop when the goal criteria pass.\nNever edit outside src/.\nFail loudly on a missing harness.\nExtra line 13 to trigger the +N more."),
        ]),
        result: mkResult("{\"name\":\"perf-profiler\"}"), running: false, done: true, ts: base)

    static let notifyTool = Tool(
        id: "nt1", name: "mcp__orchestrator__notify_user", verb: "notify",
        input: .object(["title": .string("Task complete"),
                        "body": .string("Tier-2 registry cards landed across worker/task/workflow — review ready.")]),
        result: mkResult(""), running: false, done: true, ts: base)

    static let skillTool = Tool(
        id: "sk1", name: "Skill", verb: "skill",
        input: .object(["skill": .string("code-review")]),
        result: mkResult("Launching skill: code-review"),
        running: false, done: true, ts: base,
        skillBody: "Base directory for this skill: /Users/dev/.claude/skills/code-review\n\n# Code Review\n\nReview the current diff for correctness bugs and cleanups.\nStart broad, then narrow to the changed lines.\nReport findings with a file:line and a one-line fix.",
        skillPath: "/Users/dev/.claude/skills/code-review")

    static let sendToParentTool = Tool(
        id: "mp1", name: "mcp__worker__send_message_to_parent", verb: "report",
        input: .object(["text": .string("Done. §2.3 worker cards + §2.5 task cards + §3 workflow surfaces are wired and the build is green on iPhone 17 / iOS 26.5.")]),
        result: mkResult("{\"ok\":true}"), running: false, done: true, ts: base)

    static let peerAskTool = Tool(
        id: "pa1", name: "mcp__worker__ask_peer", verb: "ask",
        input: .object(["peerName": .string("parser-audit"),
                        "question": .string("Does attachAskUserAnswers fold the answer for a multi-question AskUserQuestion, or only the first?")]),
        result: mkResult("It folds all questions — parseAskAnswers maps every question to its arrow-list answer, nil for any it can't correlate."),
        running: false, done: true, ts: base,
        peerTo: AgentRef(id: "w-a", name: "parser-audit"))

    static let askUserTool = Tool(
        id: "au1", name: "mcp__orchestrator__ask_user", verb: "ask",
        input: .object(["questions": .array([
            .object(["question": .string("Bundle JetBrains Mono for code fences?"), "header": .string("Font")]),
            .object(["question": .string("Which highlight theme?"), "header": .string("Theme")]),
        ])]),
        result: mkResult("{\"answers\":{\"Bundle JetBrains Mono for code fences?\":\"Yes — bundle it\",\"Which highlight theme?\":\"github-dark-dimmed\"}}"),
        running: false, done: true, ts: base)

    static let taskCreateTool = Tool(
        id: "tc1", name: "TaskCreate", verb: "task",
        input: .object(["subject": .string("Wire the workflow report branch"),
                        "description": .string("A report block whose workerName == workflow renders as WorkflowReportView, not the AgentLink report row.")]),
        result: mkResult("Task #7 created (status: pending)."), running: false, done: true, ts: base)

    static let taskUpdateTool = Tool(
        id: "tu2", name: "TaskUpdate", verb: "task",
        input: .object(["taskId": .string("7"), "status": .string("in_progress"),
                        "description": .string("Branch added in MessageView; now wiring the status chip parse."),
                        "owner": .string("task-cards"),
                        "addBlockedBy": .array([.number(3)])]),
        result: mkResult("Updated task #7 status, owner."), running: false, done: true, ts: base)

    static let taskListTool = Tool(
        id: "tl1", name: "TaskList", verb: "task",
        input: .object([:]),
        result: mkResult("#5 [completed] Port the diff-hunk helpers\n#6 [in_progress] Register the Tier-2 tools (task-cards)\n#7 [pending] Wire the workflow report branch [blocked by #3]"),
        running: false, done: true, ts: base)

    static let todoWriteTool = Tool(
        id: "tw1", name: "TodoWrite", verb: "todo",
        input: .object(["todos": .array([
            .object(["content": .string("Register worker tools"), "activeForm": .string("Registering worker tools"), "status": .string("completed")]),
            .object(["content": .string("Register task tools"), "activeForm": .string("Registering task tools"), "status": .string("in_progress")]),
            .object(["content": .string("Extend the gallery"), "activeForm": .string("Extending the gallery"), "status": .string("pending")]),
        ])]),
        result: mkResult(""), running: false, done: true, ts: base)

    static let workflowTool = Tool(
        id: "wf1", name: "mcp__orchestrator__workflow", verb: "workflow",
        input: .object(["mode": .string("run-stored"), "from": .string("nightly-audit")]),
        result: mkResult("{\"runId\":\"run-8a2f\",\"status\":\"passed\",\"message\":\"All 4 steps completed.\",\"output\":{\"steps\":4,\"passed\":4,\"durationMs\":18240}}"),
        running: false, done: true, ts: base)

    static let workflowReportText =
        "[workflow run-8a2f] completed (status: passed):\n{\"steps\":4,\"passed\":4,\"failed\":0,\"durationMs\":18240,\"summary\":\"nightly audit green\"}"

    static let datetimeTool = Tool(
        id: "dt1", name: "mcp__orchestrator__current_datetime", verb: "datetime",
        input: .object([:]),
        result: mkResult("{\"formatted\":\"2026-07-09 14:32:05 UTC+03:00 (Europe/Istanbul)\",\"timeZone\":\"Europe/Istanbul\"}"),
        running: false, done: true, ts: base)

    static let scheduleWakeupTool = Tool(
        id: "sched1", name: "ScheduleWakeup", verb: "schedule",
        input: .object(["delaySeconds": .number(2700), "reason": .string("Re-check the deploy"),
                        "prompt": .string("Poll the CI status for run-8a2f; if green, message the parent that the nightly audit passed.")]),
        result: mkResult("{\"id\":\"wake-1\"}"), running: false, done: true, ts: base)

    static let availableWorkersTool = Tool(
        id: "aw1", name: "mcp__orchestrator__list_available_workers", verb: "list",
        input: .object([:]),
        result: mkResult("[{\"name\":\"general-purpose\",\"source\":\"builtin\",\"whenToUse\":\"Catch-all for any concrete work.\"},{\"name\":\"perf-profiler\",\"source\":\"user\",\"whenToUse\":\"Rank latency culprits after a regression.\"},{\"name\":\"schema-migrator\",\"source\":\"project\",\"description\":\"Runs a reversible DB migration and verifies it.\"}]"),
        running: false, done: true, ts: base)

    private static let assistantSample = """
# Rendering map overview

Here's how the **transcript** pipeline maps to SwiftUI, with a couple of *notes* on the tricky parts and an inline `Block.Payload` reference.

## Block kinds

The parser emits ~22 kinds. The text-tier ones:

- **User** — right-aligned `coralWash` bubble
  - runs the rich-text segmenter
  - attachments render above
- **Assistant** — full-width serif Markdown
  1. headings + prose
  2. fenced code with copy
  3. tables and lists
- **Thinking** — mono, `inkTertiary`, no bubble

> Prose renders in serif; everything technical renders in mono.

### Geometry table

| Element | Font | Radius |
|---|---|---|
| inline code | mono 13 | 3 |
| code fence | mono 13 | 6 |
| user bubble | serif | 10 |

### A Swift fence

```swift
func render(_ block: Block) -> some View {
    switch block.payload {
    case .assistant(let text):
        MarkdownView(source: text)   // serif GFM
    default:
        EmptyView()
    }
}
```

### A JSON fence

```json
{
  "kind": "assistant",
  "blockId": "blk_42",
  "spans": [{ "type": "code", "lang": "swift" }],
  "revealed": true
}
```

See the [full spec](https://example.com/spec) for the remaining tool cards.

---

That's the centerpiece.
"""
}
#endif
