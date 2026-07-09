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

#Preview("Sunburst") {
    VStack(spacing: EosSpacing.xl) {
        Sunburst().fill(EosColor.coral).frame(width: 56, height: 56)
        Sunburst().fill(EosColor.coral).frame(width: 13, height: 13)
        HStack(spacing: EosSpacing.lg) {
            Sunburst(spokes: 8).fill(EosColor.coral).frame(width: 40, height: 40)
            Sunburst(spokes: 12).fill(EosColor.coralPressed).frame(width: 40, height: 40)
        }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(EosColor.bg)
}
