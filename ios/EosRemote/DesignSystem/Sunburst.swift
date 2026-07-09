import SwiftUI

// The coral asterisk logo (spec 02 §2.8) — a custom Shape, not an SF Symbol. `sparkle` (4 arms) and
// `asterisk` (6 straight strokes) don't match the reference's many-armed sunburst with tapered
// spokes; a custom shape scales crisply, tints with coral, and can animate later.
//
// A star polygon of 2*spokes vertices alternating between an outer radius (spoke tips) and an inner
// radius (innerRatio, the valleys). The outer tips are softly rounded with a quadratic curve so the
// spokes read as tapered terracotta petals rather than sharp points.
struct Sunburst: Shape {
    var spokes: Int = 8
    var innerRatio: CGFloat = 0.32

    func path(in rect: CGRect) -> Path {
        var path = Path()
        guard spokes >= 2 else { return path }

        let center = CGPoint(x: rect.midX, y: rect.midY)
        let outer = min(rect.width, rect.height) / 2
        let inner = outer * innerRatio
        let count = spokes * 2
        let step = (2 * CGFloat.pi) / CGFloat(count)
        // Round the spoke tips proportionally to the tip's angular half-width and its radius.
        let tipRound = outer * 0.16

        func point(radius: CGFloat, angle: CGFloat) -> CGPoint {
            CGPoint(x: center.x + radius * cos(angle), y: center.y + radius * sin(angle))
        }

        for i in 0..<count {
            let angle = step * CGFloat(i) - .pi / 2   // start straight up
            let isTip = i % 2 == 0
            if isTip {
                // Approach the rounded tip: line in to just before the point, curve across it, line out.
                let tipAngle = angle
                let backAngle = tipAngle - step * 0.5   // toward previous valley
                let fwdAngle  = tipAngle + step * 0.5   // toward next valley
                let approach = point(radius: outer - tipRound, angle: backAngle)
                let depart   = point(radius: outer - tipRound, angle: fwdAngle)
                let tip      = point(radius: outer, angle: tipAngle)
                if i == 0 { path.move(to: approach) } else { path.addLine(to: approach) }
                path.addQuadCurve(to: depart, control: tip)
            } else {
                path.addLine(to: point(radius: inner, angle: angle))
            }
        }
        path.closeSubpath()
        return path
    }
}

// Dawn-star mark (spec 05 §1.2) — the Sunburst shape filled with the SVG's radial star gradient
// (white → #e8f1ff → #a9cdf6 → #5f93dd → #3f6fb5) plus a soft cornflower halo behind it. This is the
// composed brand mark; the bare `Sunburst` above is kept for the doc-03 processing spark (recolored
// to `coral`). The tiny caption-scale foot instance drops the halo (size < 20) to avoid a fuzzy glow.
struct DawnStar: View {
    var size: CGFloat = 56
    private static let starStops: [Gradient.Stop] = [
        .init(color: Color(hex: 0xFFFFFF), location: 0.0),
        .init(color: Color(hex: 0xE8F1FF), location: 0.2),
        .init(color: Color(hex: 0xA9CDF6), location: 0.5),
        .init(color: Color(hex: 0x5F93DD), location: 0.8),
        .init(color: Color(hex: 0x3F6FB5), location: 1.0),
    ]
    var body: some View {
        ZStack {
            if size >= 20 {
                // Halo: cornflower glow, ~1.7× the mark, behind.
                Circle()
                    .fill(RadialGradient(colors: [Color(hex: 0x6EA4E8).opacity(0.5),
                                                  Color(hex: 0x6EA4E8).opacity(0.13),
                                                  Color(hex: 0x6EA4E8).opacity(0)],
                                         center: .center, startRadius: 0, endRadius: size * 0.85))
                    .frame(width: size * 1.7, height: size * 1.7)
                    .accessibilityHidden(true)
            }
            Sunburst(spokes: 8)
                .fill(RadialGradient(stops: Self.starStops, center: .center,
                                     startRadius: 0, endRadius: size * 0.5))
                .frame(width: size, height: size)
        }
        .accessibilityHidden(true)
    }
}

#Preview("Sunburst") {
    VStack(spacing: EosSpacing.xl) {
        DawnStar(size: 56)
        DawnStar(size: 13)
        HStack(spacing: EosSpacing.lg) {
            Sunburst(spokes: 8).fill(EosColor.coral).frame(width: 40, height: 40)
            Sunburst(spokes: 12).fill(EosColor.coralPressed).frame(width: 40, height: 40)
        }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
