import SwiftUI
import UIKit

// Attachment chips above the composer field (contract §C8, ref IMG_4431): 56pt tiles — image
// chips show the thumbnail, file chips a doc-glyph tile — with a one-line name caption beneath.
// Uploading overlays a spinner; error tints the tile danger and makes the tile tap retry; the ×
// removes. Callbacks carry the chip's id (AttachmentDraftModel seeds it from the deduped label).
struct AttachmentChipRow: View {
    let chips: [AttachmentChipVM]
    let onRemove: (String) -> Void
    let onRetry: (String) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(alignment: .top, spacing: EosSpacing.sm) {
                ForEach(chips) { chip in
                    AttachmentChip(chip: chip,
                                   onRemove: { onRemove(chip.id) },
                                   onRetry: { onRetry(chip.id) })
                }
            }
            .padding(.top, 6)        // headroom for the × overhang
            .padding(.trailing, 6)
        }
    }
}

private struct AttachmentChip: View {
    let chip: AttachmentChipVM
    let onRemove: () -> Void
    let onRetry: () -> Void

    private var isError: Bool { chip.status == .error }

    var body: some View {
        VStack(spacing: EosSpacing.xxs) {
            Button(action: onRetry) {
                ZStack {
                    tile
                    if chip.status == .uploading {
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .fill(EosColor.black.opacity(0.45))
                        ProgressView().tint(EosColor.ink)
                    }
                    if isError {
                        Image(systemName: "arrow.clockwise")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundStyle(EosColor.danger)
                    }
                }
                .frame(width: 56, height: 56)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .strokeBorder(isError ? EosColor.danger : EosColor.hairline,
                                  lineWidth: EosLine.hairline))
            }
            .buttonStyle(.plain)
            .disabled(!isError)                             // tile tap = retry, error only
            .overlay(alignment: .topTrailing) { removeButton }
            Text(chip.label)
                .font(EosFont.captionSmall)
                .foregroundStyle(isError ? EosColor.danger : EosColor.inkSecondary)
                .lineLimit(1)
                .frame(width: 64)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(chip.label), \(accessibilityStatus)")
    }

    private var accessibilityStatus: String {
        switch chip.status {
        case .uploading: return "uploading"
        case .ready:     return "attached"
        case .error:     return "failed, tap to retry"
        }
    }

    @ViewBuilder private var tile: some View {
        if chip.kind == .image, let thumb = chip.thumbnail {
            Image(uiImage: thumb)
                .resizable()
                .scaledToFill()
                .frame(width: 56, height: 56)
        } else {
            ZStack {
                RoundedRectangle(cornerRadius: 12, style: .continuous)
                    .fill(EosColor.surface2)
                Image(systemName: chip.kind == .image ? "photo" : "doc.text")
                    .font(.system(size: 20))
                    .foregroundStyle(isError ? EosColor.danger : EosColor.inkSecondary)
                    .opacity(isError ? 0 : 1)               // the retry glyph replaces it
            }
        }
    }

    private var removeButton: some View {
        Button(action: onRemove) {
            Image(systemName: "xmark")
                .font(.system(size: 9, weight: .bold))
                .foregroundStyle(EosColor.ink)
                .frame(width: 18, height: 18)
                .background(EosColor.surface3, in: Circle())
                .overlay(Circle().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
        }
        .buttonStyle(.plain)
        .offset(x: 6, y: -6)
        .accessibilityLabel("Remove \(chip.label)")
    }
}

#Preview("AttachmentChipRow") {
    AttachmentChipRow(
        chips: [
            .init(id: "IMG_0041", label: "IMG_0041", kind: .image, status: .ready, thumbnail: nil),
            .init(id: "build.log", label: "build.log", kind: .file, status: .uploading, thumbnail: nil),
            .init(id: "crash-report", label: "crash-report", kind: .file, status: .error, thumbnail: nil),
            .init(id: "notes.md", label: "notes.md", kind: .file, status: .ready, thumbnail: nil),
        ],
        onRemove: { _ in }, onRetry: { _ in })
    .padding(EosSpacing.md)
    .background(EosColor.surface, in: RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous))
    .padding(EosSpacing.screenInset)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
