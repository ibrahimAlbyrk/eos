import SwiftUI
import EosRemoteKit

// User message (spec 03 §1 #1, §5.5): right-aligned coralWash bubble. Body runs the TextSegmenter
// (URLs→coral links, {cwd}/→"@", paste/slash pills). Wrapped in MessageRowView (copy + timestamp +
// rewind when the backend supports it). Attachment chips render as a row ABOVE the bubble — the typed
// Block payload carries only text in Phase 4a, so the chip row is present but empty until the
// attachments channel lands (tap-zoom deferred, §5.5).
struct UserMessageView: View {
    let block: Block
    let workerId: String

    var body: some View {
        MessageRowView(ts: block.ts, copyText: text, isUser: true, workerId: workerId, trailing: true) {
            HStack {
                Spacer(minLength: 40)                                  // max-width ~80% (§10)
                Text(TextSegmenter.attributed(text, cwd: nil))
                    .tint(EosColor.coral)
                    .lineSpacing(3)                                    // line-height 1.5 (§10)
                    .padding(.vertical, 7).padding(.horizontal, 13)    // pad 7×13 (§10)
                    .background(EosColor.coralWash,
                                in: RoundedRectangle(cornerRadius: 10, style: .continuous))  // radius 10 (§10)
                    .opacity(optimistic ? 0.6 : 1)                     // optimistic bubble dims (§4.10 #1)
            }
        }
    }

    private var text: String {
        if case let .user(t, _) = block.payload { return t }
        return ""
    }
    private var optimistic: Bool {
        if case let .user(_, o) = block.payload { return o }
        return false
    }
}
