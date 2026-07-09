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
    ]

    private static let base = Date().timeIntervalSince1970 * 1000

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
