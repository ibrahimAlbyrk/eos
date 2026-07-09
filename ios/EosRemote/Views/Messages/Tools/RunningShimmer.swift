import SwiftUI

// Running-shimmer (spec 03 §6.4, port of @keyframes ti-shimmer). A gradient sweeps across the verb
// text while the tool is running (fg-dim → shimmer → fg-dim, background-clip:text, 8s linear infinite).
// The masked-gradient sweep is applied over the text via an overlay masked by the same text; a
// LinearGradient offset animates .repeatForever. Reduce Motion falls back to the plain pulsing-opacity
// variant sanctioned by §6.4. The agent-card title reuses this while running.
struct ShimmerText: View {
    let text: String
    var font: Font = EosFont.label
    var base: Color = EosColor.inkSecondary
    var active: Bool = true

    @State private var phase: CGFloat = -1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Text(text)
            .font(font)
            .foregroundStyle(base)
            .modifier(ShimmerOverlay(active: active && !reduceMotion, phase: phase, text: text, font: font))
            .opacity(active && reduceMotion ? pulseOpacity : 1)          // pulsing-opacity fallback (§6.4)
            .onAppear { startIfNeeded() }
    }

    @State private var pulseOpacity: Double = 1
    private func startIfNeeded() {
        guard active else { return }
        if reduceMotion {
            withAnimation(.easeInOut(duration: 1.0).repeatForever(autoreverses: true)) { pulseOpacity = 0.5 }
        } else {
            withAnimation(.linear(duration: 1.6).repeatForever(autoreverses: false)) { phase = 2 }
        }
    }
}

// The sweep: a bright band that travels left→right, masked to the glyphs so only the text lights up.
private struct ShimmerOverlay: ViewModifier {
    let active: Bool
    let phase: CGFloat
    let text: String
    let font: Font

    func body(content: Content) -> some View {
        content.overlay {
            if active {
                GeometryReader { geo in
                    let w = geo.size.width
                    LinearGradient(
                        colors: [.clear, EosColor.ink.opacity(0.55), .clear],
                        startPoint: .leading, endPoint: .trailing)
                        .frame(width: max(w, 1))
                        .offset(x: phase * max(w, 1))
                        .mask(Text(text).font(font))
                }
                .allowsHitTesting(false)
            }
        }
    }
}
