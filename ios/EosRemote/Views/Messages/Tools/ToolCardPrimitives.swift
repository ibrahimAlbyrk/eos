import SwiftUI
import EosRemoteKit

// Shared building blocks for the tool detail bodies (spec 03 §10 tool-detail-bodies). Each maps to a
// `styles.css` class: card chrome (.tool-body-card), .file-path-bar, .code-preview, .tool-failure-banner,
// .bash-*, .gd-section. Kept in one file so the exact geometry lives together and the individual
// *DetailView files stay small.

// Card chrome shared by read/bash/edit/generic detail bodies: margin 4/0/8, border 1 hairline, radius
// 10, bg surface, clipped. Blocks inside separate with a border-top (see .separated()).
struct ToolBodyCard<Content: View>: View {
    @ViewBuilder let content: () -> Content
    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content() }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(EosColor.surface)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))     // radius 10 (§10)
            .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(EosColor.hairline, lineWidth: 1))                     // border 1 (§10)
            .padding(.top, 4).padding(.bottom, 8)                                   // margin 4 0 8 (§10)
    }
}

// A top hairline separating stacked sections inside a ToolBodyCard (blocks separated by border-top 1).
extension View {
    func toolSectionSeparator() -> some View {
        overlay(alignment: .top) { Rectangle().fill(EosColor.hairline).frame(height: 1) }
    }
}

// .file-path-bar: flex space-between, pad 8×14, mono text-sm, fg-dim, with a copy button (opacity 0→1
// on hover on the Mac; always-visible-muted on iOS). `~`-shortening is the caller's job. `openPath`
// (the RAW absolute path, not the shortened display) makes the path tap-to-view (\.openFile).
struct FilePathBar: View {
    let path: String
    var openPath: String? = nil
    @State private var copied = false
    @Environment(\.openFile) private var openFile
    var body: some View {
        HStack(spacing: EosSpacing.xs) {
            Text(path)
                .font(EosFont.code)
                .foregroundStyle(EosColor.inkSecondary)                            // fg-dim (§10)
                .lineLimit(1).truncationMode(.middle)
                .underline(openPath != nil, pattern: .solid)                       // .ti-link (§10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .onTapGesture { if let openPath { openFile(openPath) } }
            CopyButtonMini(text: path, copied: $copied)
        }
        .padding(.horizontal, 14).padding(.vertical, 8)                            // pad 8×14 (§10)
    }
}

// A small muted copy affordance reused by the file-path bar and the generic-card sections (§6.5).
struct CopyButtonMini: View {
    let text: String
    @Binding var copied: Bool
    var body: some View {
        Button {
            UIPasteboard.general.string = text
            withAnimation(.easeOut(duration: 0.15)) { copied = true }
            Task {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                withAnimation(.easeOut(duration: 0.15)) { copied = false }
            }
        } label: {
            Image(systemName: copied ? "checkmark" : "doc.on.doc")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(copied ? EosColor.State.runningDot : EosColor.inkTertiary)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(copied ? "Copied" : "Copy")
    }
}

// .code-preview: first-N source lines with a fixed-width line-number gutter. cp-num width 28 right
// fg-faint · cp-text pre-wrap fg · hl-heading accent+600 · cp-fade opacity .35 for a "(N more)" footer.
struct CodePreview: View {
    let lines: [PreviewLine]
    let limit: Int
    var running: Bool = false

    private var shown: [PreviewLine] { Array(lines.prefix(limit)) }
    private var moreCount: Int { max(lines.count - limit, 0) }

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if running && lines.isEmpty {
                Text("Reading…").font(EosFont.code).italic().foregroundStyle(EosColor.inkTertiary)
                    .padding(.horizontal, 14).padding(.vertical, 8)
            } else {
                ForEach(Array(shown.enumerated()), id: \.offset) { _, line in
                    HStack(alignment: .top, spacing: 0) {
                        Text(line.num > 0 ? "\(line.num)" : "")
                            .font(EosFont.code)
                            .foregroundStyle(EosColor.inkTertiary)                 // cp-num fg-faint (§10)
                            .frame(width: 28, alignment: .trailing)                // cp-num width 28 (§10)
                        Text(line.text)
                            .font(EosFont.code)
                            .foregroundStyle(isHeading(line.text) ? EosColor.coral : EosColor.ink)
                            .fontWeight(isHeading(line.text) ? .semibold : .regular) // hl-heading (§10)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.leading, 6)
                    }
                    .lineSpacing(3)                                                // line-height 1.65 (§10)
                }
                if moreCount > 0 {
                    Text("(\(moreCount) more line\(moreCount > 1 ? "s" : ""))")
                        .font(EosFont.code)
                        .foregroundStyle(EosColor.inkTertiary)
                        .opacity(0.35)                                             // cp-fade opacity .35 (§10)
                        .padding(.leading, 34)
                }
            }
        }
        .padding(.vertical, 8).padding(.trailing, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        // One AX element for the preview (VoiceOver: the lines read as one stop instead of a
        // num/text pair per line; the gutter numbers are visual chrome, not content).
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(running && lines.isEmpty ? "Reading" : "file preview, first \(shown.count) lines")
        .accessibilityValue(shown.map(\.text).joined(separator: "\n"))
    }

    // Markdown heading lines get the accent treatment (.hl-heading) — a `#`-prefixed source line.
    private func isHeading(_ text: String) -> Bool {
        text.range(of: "^\\s{0,3}#{1,6}\\s", options: .regularExpression) != nil
    }
}

// .tool-failure-banner: margin 6/12/4, pad 6×10, radius 4; warn@10% bg (denied: err@10%), text-sm,
// fg-dim. Shows the tool's error text under a "denied"/"failed" lead.
struct FailureBanner: View {
    let kind: FailureKind
    let text: String
    var body: some View {
        Text(text)
            .font(EosFont.caption)
            .foregroundStyle(EosColor.inkSecondary)                                // fg-dim (§10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10).padding(.vertical, 6)                        // pad 6×10 (§10)
            .background(bannerFill, in: RoundedRectangle(cornerRadius: 4, style: .continuous))
            .padding(.leading, 12).padding(.trailing, 12).padding(.top, 6).padding(.bottom, 4)
    }
    private var bannerFill: Color {
        kind == .denied ? EosColor.State.failedDot.opacity(0.10) : EosColor.State.waitingDot.opacity(0.10)
    }
}

// Home-relative `~` shortening for the file-path bar (Read/Write/Skill). Mirrors the Mac's `~`-collapse.
func tildeShorten(_ path: String) -> String {
    guard let r = path.range(of: "/Users/[^/]+", options: .regularExpression), r.lowerBound == path.startIndex
    else { return path }
    return "~" + path[r.upperBound...]
}

// basename of a path (the tool file chip label).
func basename(_ path: String) -> String {
    (path as NSString).lastPathComponent
}
