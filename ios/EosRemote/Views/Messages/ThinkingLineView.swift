import SwiftUI
import EosRemoteKit

// Thinking line (spec 03 §1 #3, §10 .thinking-line): raw reasoning in mono, inkTertiary, line-height
// 1.55, no bubble/label. Streams token-by-token; the appended tail blur-ins (§6.1). NOT wrapped in a
// MessageRow. A live block keeps blurring its growth in; a settled durable block reveals once.
struct ThinkingLineView: View {
    let block: Block

    var body: some View {
        Text(text)
            .font(EosFont.code)
            .lineSpacing(4)                                    // .mono line-height 1.55 (§10)
            .foregroundStyle(EosColor.inkTertiary)
            .frame(maxWidth: .infinity, alignment: .leading)
            // Live blocks re-animate each growth (the streaming tail); a durable block reveals once.
            .blurInReveal(blockKey: block.live ? "\(block.id):\(text.count)" : block.id, isLive: block.live)
    }

    private var text: String {
        if case let .thinking(t) = block.payload { return t }
        return ""
    }
}
