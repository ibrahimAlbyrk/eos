import CoreGraphics

// Spacing / radii / hairline widths (spec 02 §1.4). An 8-pt-ish scale with a couple of in-between
// stops the reference needs. Circular-button diameter and composer min-height are component
// constants, defined with the components (§2), not here.
enum EosSpacing {
    static let xxs: CGFloat = 4
    static let xs:  CGFloat = 8
    static let sm:  CGFloat = 12
    static let md:  CGFloat = 16   // default screen inset
    static let lg:  CGFloat = 24   // section gaps
    static let xl:  CGFloat = 32
    static let xxl: CGFloat = 48   // vertical breathing around the Home hero
    static let screenInset: CGFloat = 20   // left/right page margin (Claude runs generous)
}

enum EosRadius {
    static let chip:     CGFloat = 8
    static let card:     CGFloat = 16   // decision cards, message wells
    static let composer: CGFloat = 28   // the big rounded composer card
    static let pill:     CGFloat = 999  // fully rounded (model pill, Spawn pill, circular buttons via frame)
}

enum EosLine {                     // hairline widths
    static let hairline: CGFloat = 1
    static let button:   CGFloat = 1.5   // circular icon-button outline
}
