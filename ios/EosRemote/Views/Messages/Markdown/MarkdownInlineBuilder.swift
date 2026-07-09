import SwiftUI

// Flattens inline Markdown runs into a single AttributedString so prose flows and wraps naturally
// (spec 03 §5.1). Bold → semibold ink, em → italic, inline code → mono on bgSunken (r3, via a run
// background), links → coral tappable. The `base` selects the run's default font (body vs. heading
// vs. table header) so headings share the inline machinery (bold/code/links inside a heading work).
enum MarkdownInlineBuilder {
    enum Base {
        case body, heading1, heading2, heading3, heading4, tableHeader

        var font: Font {
            switch self {
            case .body:        return EosFont.bodySerif                          // text-base serif
            case .heading1:    return .system(size: 19, design: .serif).weight(.semibold)  // text-2xl
            case .heading2:    return .system(size: 17, design: .serif).weight(.semibold)  // text-xl
            case .heading3:    return .system(size: 15, design: .serif).weight(.semibold)  // text-md
            case .heading4:    return EosFont.bodySerifEmph                       // text-base semibold
            case .tableHeader: return EosFont.bodySerifEmph
            }
        }
        var bold: Font { font.weight(.bold) }
    }

    static func attributed(_ inlines: [MarkdownInline], base: Base) -> AttributedString {
        var out = AttributedString()
        append(inlines, into: &out, base: base, emphasis: false, strong: false)
        if out.runs.isEmpty { out = AttributedString("") }
        return out
    }

    private static func append(_ inlines: [MarkdownInline], into out: inout AttributedString,
                               base: Base, emphasis: Bool, strong: Bool) {
        for inline in inlines {
            switch inline {
            case let .text(s):
                out.append(styledRun(s, base: base, emphasis: emphasis, strong: strong))
            case let .emphasis(children):
                append(children, into: &out, base: base, emphasis: true, strong: strong)
            case let .strong(children):
                append(children, into: &out, base: base, emphasis: emphasis, strong: true)
            case let .code(code):
                out.append(codeRun(code))
            case let .link(text, url):
                var seg = AttributedString()
                append(text, into: &seg, base: base, emphasis: emphasis, strong: strong)
                seg.foregroundColor = EosColor.coral
                seg.underlineStyle = .single
                if let u = URL(string: url) { seg.link = u }
                out.append(seg)
            case .lineBreak:
                out.append(AttributedString("\n"))
            case .softBreak:
                out.append(AttributedString(" "))
            }
        }
    }

    private static func styledRun(_ s: String, base: Base, emphasis: Bool, strong: Bool) -> AttributedString {
        var run = AttributedString(s)
        var font = strong ? base.bold : base.font
        if emphasis { font = font.italic() }
        run.font = font
        run.foregroundColor = EosColor.ink
        return run
    }

    // Inline code span (§10 code: mono text-sm, pad 2×5, bg surface-2, radius 3). AttributedString has
    // no run padding/corner-radius, so we approximate with a bgSunken run background + hair-spaces for
    // the horizontal inset — close to the Mac's chip without a separate view per span.
    private static func codeRun(_ code: String) -> AttributedString {
        var run = AttributedString("\u{200A}\(code)\u{200A}")
        run.font = EosFont.code
        run.foregroundColor = EosColor.ink
        run.backgroundColor = EosColor.bgSunken
        return run
    }
}
