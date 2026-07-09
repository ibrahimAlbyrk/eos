import SwiftUI

// Centered glass dialog (contract §A2 class 3 / §C13, ref IMG_4433): a Liquid-Glass card over a
// 0.28-alpha ink scrim with a single text field — the rename surface. The owner shows it as a
// ZStack overlay (not a sheet); the scrim is inert, dismissal is Cancel/confirm only. Standard
// keyboard avoidance raises the card (§E5 — no .ignoresSafeArea(.keyboard)).
struct GlassDialog: View {
    let title: String
    let message: String
    @Binding var text: String
    var confirmLabel: String = "OK"
    let onCancel: () -> Void
    let onConfirm: () -> Void

    @FocusState private var focused: Bool
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    init(title: String, message: String, text: Binding<String>,
         confirmLabel: String = "OK", onCancel: @escaping () -> Void, onConfirm: @escaping () -> Void) {
        self.title = title
        self.message = message
        self._text = text
        self.confirmLabel = confirmLabel
        self.onCancel = onCancel
        self.onConfirm = onConfirm
    }

    var body: some View {
        ZStack {
            EosColor.black.opacity(0.28).ignoresSafeArea()
            card
        }
    }

    private var card: some View {
        VStack(spacing: EosSpacing.md) {
            VStack(spacing: EosSpacing.xxs) {
                Text(title)
                    .font(EosFont.labelStrong)
                    .foregroundStyle(EosColor.ink)
                Text(message)
                    .font(EosFont.caption)
                    .foregroundStyle(EosColor.inkSecondary)
                    .multilineTextAlignment(.center)
            }
            TextField("", text: $text)
                .font(EosFont.body)
                .foregroundStyle(EosColor.ink)
                .tint(EosColor.coral)
                .focused($focused)
                .submitLabel(.done)
                .onSubmit(onConfirm)
                .padding(.horizontal, EosSpacing.sm)
                .padding(.vertical, EosSpacing.xs)
                .background(EosColor.surface2, in: Capsule())
                .overlay(Capsule().strokeBorder(EosColor.hairlineStrong, lineWidth: EosLine.hairline))
            HStack(spacing: EosSpacing.sm) {
                dialogButton("Cancel", filled: false, action: onCancel)
                dialogButton(confirmLabel, filled: true, action: onConfirm)
            }
        }
        .padding(EosSpacing.lg)
        .frame(maxWidth: 320)
        .glassEffect(reduceTransparency ? .identity : .regular,
                     in: .rect(cornerRadius: EosRadius.menu))
        // Reduce Transparency: same opaque fallback as the composer — the card is text-critical.
        .background {
            if reduceTransparency {
                RoundedRectangle(cornerRadius: EosRadius.menu, style: .continuous)
                    .fill(EosColor.surface)
                    .overlay(RoundedRectangle(cornerRadius: EosRadius.menu, style: .continuous)
                        .strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline))
            }
        }
        .padding(.horizontal, EosSpacing.xl)
        .onAppear { focused = true }
    }

    private func dialogButton(_ label: String, filled: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(EosFont.label)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 10)
                .foregroundStyle(filled ? EosColor.onAccent : EosColor.ink)
                .background(filled ? EosColor.coral : .clear, in: Capsule())
                .overlay {
                    if !filled {
                        Capsule().strokeBorder(EosColor.hairline, lineWidth: EosLine.hairline)
                    }
                }
                .contentShape(Capsule())
        }
        .buttonStyle(.plain)
    }
}

#Preview("GlassDialog") {
    struct Harness: View {
        @State private var name = "refactor-auth"
        var body: some View {
            ZStack {
                EosColor.bg.ignoresSafeArea()
                VStack(spacing: EosSpacing.md) {                // busy backdrop to show the glass
                    ForEach(0..<12, id: \.self) { i in
                        Text("Transcript line \(i) — some assistant prose flowing under the dialog")
                            .font(EosFont.body)
                            .foregroundStyle(EosColor.inkSecondary)
                    }
                }
                GlassDialog(title: "Rename session",
                            message: "Enter a new name",
                            text: $name,
                            onCancel: {}, onConfirm: {})
            }
        }
    }
    return Harness()
}
