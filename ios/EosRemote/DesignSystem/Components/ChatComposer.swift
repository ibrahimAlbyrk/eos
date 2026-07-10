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
// chips (when any), the growing text field, and a control row [⊕ attach] [ModePill] spacer [↑
// send | ⏹ interrupt]. The ⊕ is a native Menu whose content the owning screen supplies (system
// glass anchors it above the button). Children are content-on-glass — never glass-on-glass. Glass
// frosts to opaque under Reduce Transparency (the Composer fallback, kept per §A2).
// The card gives a small rubber-band pull on press-drag of the control row, springing back on
// release (reduce-motion gated). The text field keeps its editing gestures untouched.
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

    // Elastic pull of the whole card, driven by a UIKit pan (see ComposerPullPan). The spring
    // on `value: pull` animates both the lagging follow and the bounce back to .zero.
    @State private var pull: CGSize = .zero

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
                    attachButton
                    ModePill(mode: mode, action: onModeTap)
                    Spacer()
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
            .offset(x: pull.width, y: pull.height)
            .animation(reduceMotion ? .none : EosSpring.chip, value: pull)
        }
        // Outside the GlassEffectContainer: representable views never materialize inside its
        // rasterized subtree, so the pan anchor must live out here on the plain hierarchy.
        .background(ComposerPullPan(
            onChanged: { t in
                guard !reduceMotion else { return }
                pull = CGSize(width: rubberBand(t.x), height: rubberBand(t.y))
            },
            onEnded: { pull = .zero }))
        .animation(reduceMotion ? .none : EosSpring.chip, value: chips.map(\.id))
    }

    // Smoothly asymptotes to ±10pt — full-strength near rest, heavy resistance past it.
    private func rubberBand(_ translation: CGFloat) -> CGFloat {
        10 * tanh(translation / 120)
    }

    // Send-sized (40pt) soft-lifted interactive glass — clearly lighter than the card, never a
    // black hole. controlWash (ink-based) because dark-gray tints read near-black on device.
    private var attachButton: some View {
        Menu {
            attachMenu()
        } label: {
            Image(systemName: "plus")
                .font(.system(size: 16, weight: .regular))
                .foregroundStyle(EosColor.ink)
                .frame(width: 40, height: 40)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.tint(EosColor.controlWash).interactive(), in: .circle)
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

// UIKit pan for the elastic pull. A SwiftUI DragGesture (and even UIGestureRecognizerRepresentable)
// never engages inside the bottom safe-area-inset + GlassEffectContainer subtree — the transcript
// scroll view claims those touches. So a plain UIViewRepresentable anchor sits behind the control
// row and installs a window-level pan gated to touches that go DOWN inside the row. Other pans
// (transcript scroll, drawer) are made to wait for this one, which fails instantly for any touch
// outside the row — so everything else keeps its gestures. Taps still reach the row's buttons
// (a pan needs slop movement to begin; recognition then cancels the press, like the drawer pan).
private struct ComposerPullPan: UIViewRepresentable {
    let onChanged: (CGPoint) -> Void
    let onEnded: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onChanged: onChanged, onEnded: onEnded) }

    func makeUIView(context: Context) -> AnchorView {
        let v = AnchorView()
        v.isUserInteractionEnabled = false          // geometry anchor only
        v.coordinator = context.coordinator
        return v
    }

    func updateUIView(_ v: AnchorView, context: Context) {
        context.coordinator.onChanged = onChanged
        context.coordinator.onEnded = onEnded
    }

    final class AnchorView: UIView {
        weak var coordinator: Coordinator?
        private var pan: UIPanGestureRecognizer?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let pan { pan.view?.removeGestureRecognizer(pan); self.pan = nil }
            guard let window, let coordinator else { return }
            let g = UIPanGestureRecognizer(target: coordinator, action: #selector(Coordinator.handle))
            g.maximumNumberOfTouches = 1
            g.delegate = coordinator
            coordinator.anchor = self
            window.addGestureRecognizer(g)
            pan = g
        }
    }

    @MainActor final class Coordinator: NSObject, UIGestureRecognizerDelegate {
        var onChanged: (CGPoint) -> Void
        var onEnded: () -> Void
        weak var anchor: UIView?

        init(onChanged: @escaping (CGPoint) -> Void, onEnded: @escaping () -> Void) {
            self.onChanged = onChanged
            self.onEnded = onEnded
        }

        @objc func handle(_ r: UIPanGestureRecognizer) {
            guard let view = r.view else { return }
            switch r.state {
            case .changed:
                onChanged(r.translation(in: view))
            case .ended, .cancelled, .failed:
                onEnded()
            default:
                break
            }
        }

        // Only touches that go down in the card's bottom strip — the control-row band — feed
        // this pan; the text field above keeps its editing gestures untouched.
        func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive t: UITouch) -> Bool {
            guard let anchor, anchor.window != nil else { return false }
            let p = t.location(in: anchor)
            return anchor.bounds.contains(p) && p.y > anchor.bounds.height - 64
        }

        // Row-origin touches: every other pan (transcript scroll, drawer) waits for this one.
        // For touches outside the row it never receives the touch, counts as failed, and the
        // others proceed untouched.
        func gestureRecognizer(_ g: UIGestureRecognizer,
                               shouldBeRequiredToFailBy other: UIGestureRecognizer) -> Bool {
            other is UIPanGestureRecognizer
        }
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
