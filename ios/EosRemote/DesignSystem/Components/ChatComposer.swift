import SwiftUI
import UIKit

// Composer vocabulary (contract §H P1): the trailing button's role, and the attachment-chip view
// model published by AttachmentDraftModel (P2) and rendered by AttachmentChipRow.

enum ComposerAction {
    case send(enabled: Bool, () -> Void)
    case interrupt(() -> Void)
}

enum AttachmentKind: String { case image, file }

enum ChipStatus { case uploading, ready, error }

struct AttachmentChipVM: Identifiable {
    let id: String
    let label: String
    let kind: AttachmentKind
    let status: ChipStatus
    let thumbnail: UIImage?
}

// The v2 composer (contract §C3/C4, ref IMG_4429): one Liquid-Glass card holding the attachment
// chips (when any), the growing text field, and a control row [ModePill] spacer [⊕ attach] [↑
// send | ⏹ interrupt]. The ⊕ is a native Menu whose content the owning screen supplies (system
// glass anchors it above the button). Children are content-on-glass — never glass-on-glass. Glass
// frosts to opaque under Reduce Transparency (the Composer fallback, kept per §A2).
struct ChatComposer: View {
    @Binding var text: String
    let placeholder: String
    let mode: PermissionModeUI
    let onModeTap: () -> Void
    let attachMenu: () -> AnyView
    let chips: [AttachmentChipVM]
    let onRemoveChip: (String) -> Void
    let onRetryChip: (String) -> Void
    let trailing: ComposerAction
    var focused: FocusState<Bool>.Binding

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(text: Binding<String>, placeholder: String,
         mode: PermissionModeUI, onModeTap: @escaping () -> Void,
         attachMenu: @escaping () -> AnyView,
         chips: [AttachmentChipVM], onRemoveChip: @escaping (String) -> Void,
         onRetryChip: @escaping (String) -> Void,
         trailing: ComposerAction,
         focused: FocusState<Bool>.Binding) {
        self._text = text
        self.placeholder = placeholder
        self.mode = mode
        self.onModeTap = onModeTap
        self.attachMenu = attachMenu
        self.chips = chips
        self.onRemoveChip = onRemoveChip
        self.onRetryChip = onRetryChip
        self.trailing = trailing
        self.focused = focused
    }

    var body: some View {
        GlassEffectContainer(spacing: 8) {
            VStack(spacing: EosSpacing.xs) {
                if !chips.isEmpty {
                    AttachmentChipRow(chips: chips, onRemove: onRemoveChip, onRetry: onRetryChip)
                }
                TextField(placeholder, text: $text, axis: .vertical)
                    .font(EosFont.body)
                    .lineLimit(1...6)                       // grows to 6 lines then scrolls
                    .tint(EosColor.coral)
                    .frame(minHeight: 24, alignment: .topLeading)
                    .focused(focused)
                HStack(spacing: EosSpacing.sm) {            // control row (content-on-glass)
                    ModePill(mode: mode, action: onModeTap)
                    Spacer()
                    attachButton
                    trailingButton
                }
            }
            .padding(EosSpacing.md)
            .glassEffect(reduceTransparency ? .identity : .regular,
                         in: RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous))
            // Under Reduce Transparency `.identity` drops the glass with no fill, so paint an
            // opaque surface + hairline behind it to keep the field legible.
            .background {
                if reduceTransparency {
                    RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous)
                        .fill(EosColor.surface)
                        .overlay(RoundedRectangle(cornerRadius: EosRadius.composer, style: .continuous)
                            .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
                }
            }
        }
        .animation(reduceMotion ? .none : EosSpring.chip, value: chips.map(\.id))
    }

    // Ref IMG_4429/4435: the attach control is a solid near-black circle, send-sized (40pt).
    private var attachButton: some View {
        Menu {
            attachMenu()
        } label: {
            ZStack {
                Circle().fill(EosColor.black)
                Image(systemName: "plus")
                    .font(.system(size: 16, weight: .regular))
                    .foregroundStyle(EosColor.ink)
            }
            .frame(width: 40, height: 40)
            .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Attach")
    }

    @ViewBuilder private var trailingButton: some View {
        switch trailing {
        case .send(let enabled, let act):
            primaryButton("arrow.up", label: "Send", action: act)
                .opacity(enabled ? 1 : 0.35)
                .disabled(!enabled)
        case .interrupt(let act):
            primaryButton("stop.fill", label: "Interrupt", action: act)
        }
    }

    // CircularIconButton's .glassProminent pads outside its 40pt label, rendering the primary
    // visibly larger than the 40pt attach circle beside it — so the coral prominent-glass
    // circle is built inline here at an exact 40pt.
    private func primaryButton(_ systemName: String, label: String,
                               action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(EosColor.ink)
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(EosColor.coral).interactive(), in: .circle)
        .accessibilityLabel(label)
    }
}

#Preview("ChatComposer") {
    struct Harness: View {
        @State private var empty = ""
        @State private var typed = "Refactor the auth token flow"
        @FocusState private var focus: Bool
        private var chips: [AttachmentChipVM] {
            [.init(id: "IMG_0041", label: "IMG_0041", kind: .image, status: .ready, thumbnail: nil),
             .init(id: "build.log", label: "build.log", kind: .file, status: .uploading, thumbnail: nil),
             .init(id: "crash.txt", label: "crash.txt", kind: .file, status: .error, thumbnail: nil)]
        }
        var body: some View {
            VStack(spacing: EosSpacing.lg) {
                Spacer()
                // Busy + empty field: the interrupt affordance
                ChatComposer(text: $empty, placeholder: "Code anything…",
                             mode: .acceptEdits, onModeTap: {},
                             attachMenu: { AnyView(Button("Choose file", systemImage: "doc.text") {}) },
                             chips: [], onRemoveChip: { _ in }, onRetryChip: { _ in },
                             trailing: .interrupt({}), focused: $focus)
                // Text + chips: send enabled
                ChatComposer(text: $typed, placeholder: "Reply to refactor-auth",
                             mode: .bypassPermissions, onModeTap: {},
                             attachMenu: { AnyView(Button("Choose file", systemImage: "doc.text") {}) },
                             chips: chips, onRemoveChip: { _ in }, onRetryChip: { _ in },
                             trailing: .send(enabled: true, {}), focused: $focus)
            }
            .padding(EosSpacing.screenInset)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(EosColor.bg)
        }
    }
    return Harness()
}
