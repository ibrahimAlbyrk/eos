import SwiftUI
import EosRemoteKit

// The real file viewer (round 4, replaces the "coming soon" placeholder). Content rides the
// existing control tunnel: text/code via GET /fs/read (highlighted through the CodeHighlighter
// pipeline, numbered gutter on the dark code card), images via GET /fs/image (out-of-band asset
// frame, pinch-zoomable). Oversize/binary degrade to a size note (contract idiom); offline and
// fetch errors get a retry state. Presented via the `\.openFile` environment action below.
struct FileViewerSheet: View {
    let path: String
    @EnvironmentObject private var model: AppModel
    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .loading
    @State private var copied = false

    enum Phase {
        case loading
        case text([Line])
        case image(UIImage)
        case note(String)      // terminal degrade: binary / too large
        case failure(String)   // retryable: offline / fetch error
    }
    struct Line: Identifiable { let id: Int; let text: AttributedString }

    var body: some View {
        NavigationStack {
            content
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(EosColor.bg)
                .safeAreaInset(edge: .top, spacing: 0) { pathBar }
                .navigationTitle(basename(path))
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
        .task(id: path) { await load() }
        .presentationDetents([.large])
    }

    // MARK: states

    @ViewBuilder private var content: some View {
        switch phase {
        case .loading:
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        case .text(let lines):
            codeBody(lines)
        case .image(let image):
            ZoomableImageView(image: image)
        case .note(let message):
            statusBody(icon: "doc", message: message, retry: false)
        case .failure(let message):
            statusBody(icon: "wifi.exclamationmark", message: message, retry: true)
        }
    }

    // Mono path bar under the title: middle-truncated, with the copy affordance (FilePathBar idiom).
    private var pathBar: some View {
        HStack(spacing: EosSpacing.xs) {
            Text(tildeShorten(path))
                .font(EosFont.codeSmall).foregroundStyle(EosColor.inkSecondary)
                .lineLimit(1).truncationMode(.middle)
                .frame(maxWidth: .infinity, alignment: .leading)
            CopyButtonMini(text: path, copied: $copied)
        }
        .padding(.horizontal, EosSpacing.screenInset).padding(.vertical, 8)
        .background(EosColor.bg)
    }

    // Numbered gutter + highlighted lines on the dark code card (CodeBlockView palette).
    private func codeBody(_ lines: [Line]) -> some View {
        let gutterWidth = CGFloat(max(28, 12 + String(lines.count).count * 8))
        return ScrollView([.vertical, .horizontal], showsIndicators: true) {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(lines) { line in
                    HStack(alignment: .firstTextBaseline, spacing: 10) {
                        Text("\(line.id)")
                            .font(EosFont.codeSmall)
                            .foregroundStyle(CodeHighlighter.codeCardText.opacity(0.4))
                            .frame(width: gutterWidth, alignment: .trailing)
                        Text(line.text)
                            .font(EosFont.code)
                            .foregroundStyle(CodeHighlighter.codeCardText)
                    }
                    .padding(.vertical, 1)
                }
            }
            .padding(.vertical, 10).padding(.trailing, 14)
            .textSelection(.enabled)
        }
        .background(CodeHighlighter.codeCardBackground)
    }

    private func statusBody(icon: String, message: String, retry: Bool) -> some View {
        VStack(spacing: EosSpacing.md) {
            Image(systemName: icon)
                .font(.system(size: 28, weight: .regular))
                .foregroundStyle(EosColor.inkTertiary)
            Text(message)
                .font(EosFont.body).foregroundStyle(EosColor.inkSecondary)
                .multilineTextAlignment(.center)
            if retry {
                PillButton("Retry", systemImage: "arrow.clockwise") { Task { await load() } }
            }
        }
        .padding(EosSpacing.screenInset)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: load

    private func load() async {
        guard model.connected else {
            phase = .failure("Not connected\(model.activeDevice.map { " to \($0.label)" } ?? "")")
            return
        }
        phase = .loading
        switch await model.fetchFile(path: path) {
        case .text(let content, _):
            phase = .text(await highlightLines(content))
        case .image(let data):
            if let image = UIImage(data: data) { phase = .image(image) }
            else { phase = .note("Couldn't decode image") }
        case .tooLarge(let size):
            phase = .note("Too large to preview (\(FileViewer.formatSize(size)))")
        case .binary(let size):
            phase = .note("Binary file (\(FileViewer.formatSize(size))) — no preview")
        case .failure(let message):
            phase = .failure(message)
        }
    }

    private func highlightLines(_ content: String) async -> [Line] {
        let attr: AttributedString
        if content.utf8.count <= FileViewer.highlightCap {
            attr = await CodeHighlighter.highlight(code: content, language: FileViewer.languageForPath(path))
        } else {
            var plain = AttributedString(content)
            plain.foregroundColor = CodeHighlighter.codeCardText
            attr = plain
        }
        return FileViewer.splitLines(attr).enumerated().map { Line(id: $0.offset + 1, text: $0.element) }
    }
}

// Pinch-zoomable image: magnify 1–6× with pan when zoomed, double-tap resets.
private struct ZoomableImageView: View {
    let image: UIImage
    @State private var scale: CGFloat = 1
    @GestureState private var pinch: CGFloat = 1
    @State private var offset: CGSize = .zero
    @GestureState private var drag: CGSize = .zero

    var body: some View {
        GeometryReader { geo in
            Image(uiImage: image)
                .resizable()
                .scaledToFit()
                .frame(width: geo.size.width, height: geo.size.height)
                .scaleEffect(min(max(scale * pinch, 1), 6))
                .offset(x: offset.width + drag.width, y: offset.height + drag.height)
                .gesture(
                    MagnificationGesture()
                        .updating($pinch) { value, state, _ in state = value }
                        .onEnded { value in scale = min(max(scale * value, 1), 6) }
                )
                .simultaneousGesture(
                    DragGesture()
                        .updating($drag) { value, state, _ in if scale > 1 { state = value.translation } }
                        .onEnded { value in if scale > 1 { offset.width += value.translation.width; offset.height += value.translation.height } }
                )
                .onTapGesture(count: 2) {
                    withAnimation(.easeOut(duration: 0.2)) { scale = 1; offset = .zero }
                }
        }
    }
}

// Environment action every file affordance calls (tool file chips, detail path bars, attachment
// chips). The presenter (WorkerDetailView, or AgentViewerSheet for its inner tools) owns the sheet
// + the AppModel injection; the default is a safe no-op so previews/gallery don't trap.
private struct OpenFileKey: EnvironmentKey {
    static let defaultValue: @MainActor (String) -> Void = { _ in }
}
extension EnvironmentValues {
    var openFile: @MainActor (String) -> Void {
        get { self[OpenFileKey.self] }
        set { self[OpenFileKey.self] = newValue }
    }
}

// Identifiable wrapper so `.sheet(item:)` presents per-path.
struct ViewedFile: Identifiable {
    let path: String
    var id: String { path }
}
