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
                    Text("code font: \(EosFont.codeFontIsJetBrains ? "JetBrains Mono" : "SF Mono (fallback)") · highlight theme: \(CodeHighlighter.themeName)")
                        .font(EosFont.captionSmall).foregroundStyle(EosColor.inkTertiary)
                    ForEach(MessageGallerySamples.blocks) { block in
                        MessageView(block: block).id(block.id)
                        Divider().opacity(0.4)
                    }
                    detailShowcase.id("details")            // expanded detail bodies (diff / preview / generic)
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
                    try? await Task.sleep(nanoseconds: 400_000_000)
                    withAnimation { proxy.scrollTo(anchor, anchor: anchor == "end" ? .bottom : .top) }
                }
            }
        }
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
        // Phase 4b-ii tool/agent/report tier (spec gallery acceptance list).
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
    ]

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
