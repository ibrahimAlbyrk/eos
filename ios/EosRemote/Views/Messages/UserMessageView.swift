import SwiftUI
import EosRemoteKit

// User message (spec 03 §1 #1, §5.5): right-aligned coralWash bubble. Body runs the TextSegmenter
// (URLs→coral links, {cwd}/→"@", paste/slash pills). Wrapped in MessageRowView (copy + timestamp +
// rewind when the backend supports it). The "\n\nattachments:\n" wire suffix is split off via
// AttachmentTokens.parseAttachmentMessage (contract §C3) and rendered as compact chips (icon +
// filename) under the text instead of the raw suffix; copy keeps the full wire text.
struct UserMessageView: View {
    let block: Block
    let workerId: String
    @Environment(\.openFile) private var openFile

    var body: some View {
        let parsed = AttachmentTokens.parseAttachmentMessage(text)
        MessageRowView(ts: block.ts, copyText: text, isUser: true, workerId: workerId, trailing: true) {
            HStack {
                Spacer(minLength: 40)                                  // max-width ~80% (§10)
                VStack(alignment: .leading, spacing: EosSpacing.xxs) {
                    if !parsed.display.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                        Text(TextSegmenter.attributed(parsed.display, cwd: nil))
                            .tint(EosColor.coral)
                            .lineSpacing(3)                            // line-height 1.5 (§10)
                    }
                    if !parsed.attachments.isEmpty {
                        attachmentChips(parsed.attachments)
                    }
                }
                .padding(.vertical, 7).padding(.horizontal, 13)        // pad 7×13 (§10)
                .background(EosColor.coralWash,
                            in: RoundedRectangle(cornerRadius: 10, style: .continuous))  // radius 10 (§10)
                .opacity(optimistic ? 0.6 : 1)                         // optimistic bubble dims (§4.10 #1)
            }
        }
    }

    // Chip tap opens the file viewer for viewable kinds (folders have no viewer).
    private func attachmentChips(_ attachments: [AttachmentTokens.ParsedAttachment]) -> some View {
        HStack(spacing: EosSpacing.xxs) {
            ForEach(Array(attachments.enumerated()), id: \.offset) { _, a in
                Button {
                    if a.kind != "folder" { openFile(a.path) }
                } label: {
                    HStack(spacing: 4) {
                        Image(systemName: glyph(a.kind))
                            .font(.system(size: 10, weight: .regular))
                        Text(chipName(a))
                            .font(EosFont.captionSmall)
                            .lineLimit(1)
                    }
                    .foregroundStyle(EosColor.inkSecondary)
                    .padding(.horizontal, EosSpacing.xs)
                    .padding(.vertical, 3)
                    .background(EosColor.surface2, in: Capsule())
                    .overlay(Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func glyph(_ kind: String) -> String {
        switch kind {
        case "image":  return "photo"
        case "folder": return "folder"
        default:       return "doc.text"
        }
    }

    private func chipName(_ a: AttachmentTokens.ParsedAttachment) -> String {
        if let label = a.label {
            return label.trimmingCharacters(in: CharacterSet(charactersIn: "[]{}"))
        }
        return a.path.split(separator: "/").last.map(String.init) ?? a.path
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
