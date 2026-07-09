import SwiftUI

// The processing/thinking spark (spec 03 §6.2, port of @keyframes spark-a/spark-b). A 4-point sparkle
// = two crossed tapered strokes breathing on two phases: layer A scales 0.55↔1 / opacity 0.35↔1 over
// 1.8s ease-in-out; layer B (45° rotated) scales 0.55↔0.9 / opacity 0.25↔0.7 with a +0.4s delay. The
// static variant freezes both at their 50% peak. Color coral.
struct SparkView: View {
    var size: CGFloat = 28
    var animated: Bool = true
    var color: Color = EosColor.coral

    // 0 = trough (peak-in progress); the animation drives these to 1 and auto-reverses. Static = 0.5.
    @State private var aPhase: CGFloat = 0
    @State private var bPhase: CGFloat = 0
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            layer(FourPointSpark(), phase: animated ? aPhase : 0.5,
                  minScale: 0.55, maxScale: 1.0, minOpacity: 0.35, maxOpacity: 1.0, rotation: 0)
            layer(FourPointSpark(), phase: animated ? bPhase : 0.5,
                  minScale: 0.55, maxScale: 0.9, minOpacity: 0.25, maxOpacity: 0.7, rotation: 45)
        }
        .frame(width: size, height: size)
        .onAppear {
            guard animated, !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { aPhase = 1 }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true).delay(0.4)) { bPhase = 1 }
        }
    }

    private func layer(_ shape: FourPointSpark, phase: CGFloat, minScale: CGFloat, maxScale: CGFloat,
                       minOpacity: Double, maxOpacity: Double, rotation: Double) -> some View {
        let scale = minScale + (maxScale - minScale) * phase
        let opacity = minOpacity + (maxOpacity - minOpacity) * Double(phase)
        return shape
            .fill(color)
            .rotationEffect(.degrees(rotation))
            .scaleEffect(scale)
            .opacity(opacity)
    }
}

// A 4-pointed spark: four tapered spokes (N/E/S/W) meeting at a slim waist — the crossed-strokes look
// the Mac draws with two radial-masked bars. Built as a star polygon with a small inner ratio.
struct FourPointSpark: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        let c = CGPoint(x: rect.midX, y: rect.midY)
        let outer = min(rect.width, rect.height) / 2
        let inner = outer * 0.18                      // slim waist → tapered spokes
        let count = 8                                 // 4 tips + 4 valleys
        let step = (2 * CGFloat.pi) / CGFloat(count)
        for i in 0..<count {
            let angle = step * CGFloat(i) - .pi / 2
            let r = (i % 2 == 0) ? outer : inner
            let p = CGPoint(x: c.x + r * cos(angle), y: c.y + r * sin(angle))
            if i == 0 { path.move(to: p) } else { path.addLine(to: p) }
        }
        path.closeSubpath()
        return path
    }
}

#Preview("Spark") {
    HStack(spacing: 24) {
        SparkView(animated: true)
        SparkView(animated: false)
    }
    .padding()
    .background(EosColor.bg)
}
