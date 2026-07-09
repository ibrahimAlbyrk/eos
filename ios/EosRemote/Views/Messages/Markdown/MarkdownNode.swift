import Foundation
import Markdown

// The parsed Markdown tree the renderer walks (spec 03 §5.1). swift-markdown (cmark-gfm — the GFM
// family the Mac's Marked uses) parses the source; we lower its Document into this small block/inline
// model so the SwiftUI renderer owns code-fence + copy-button rendering instead of an attributed
// string. One MarkdownDocument per assistant message, cached by source text (§5.1 parse cache).

enum MarkdownBlock: Equatable {
    case heading(level: Int, inlines: [MarkdownInline])
    case paragraph([MarkdownInline])
    case codeBlock(language: String?, code: String)
    case unorderedList([MarkdownListItem])
    case orderedList(start: Int, items: [MarkdownListItem])
    case blockQuote([MarkdownBlock])
    case table(header: [[MarkdownInline]], rows: [[[MarkdownInline]]])
    case thematicBreak
}

// A list item is its own block sequence so nested lists / multi-paragraph items render (spec §5.1).
struct MarkdownListItem: Equatable { let blocks: [MarkdownBlock] }

enum MarkdownInline: Equatable {
    case text(String)
    case emphasis([MarkdownInline])
    case strong([MarkdownInline])
    case code(String)             // inline code span
    case link(text: [MarkdownInline], url: String)
    case lineBreak
    case softBreak
}

struct MarkdownDocument: Equatable {
    let blocks: [MarkdownBlock]

    static func parse(_ source: String) -> MarkdownDocument {
        let doc = Document(parsing: source, options: [.parseBlockDirectives])
        return MarkdownDocument(blocks: doc.blockChildren.map(lower))
    }

    // MARK: block lowering

    private static func lower(_ markup: Markup) -> MarkdownBlock {
        switch markup {
        case let h as Heading:
            return .heading(level: h.level, inlines: lowerInlines(h.inlineChildren))
        case let p as Paragraph:
            return .paragraph(lowerInlines(p.inlineChildren))
        case let c as CodeBlock:
            let lang = c.language?.trimmingCharacters(in: .whitespaces)
            return .codeBlock(language: (lang?.isEmpty == false) ? lang : nil,
                              code: c.code.hasSuffix("\n") ? String(c.code.dropLast()) : c.code)
        case let list as UnorderedList:
            return .unorderedList(list.listItems.map { MarkdownListItem(blocks: $0.blockChildren.map(lower)) })
        case let list as OrderedList:
            return .orderedList(start: Int(list.startIndex),
                                items: list.listItems.map { MarkdownListItem(blocks: $0.blockChildren.map(lower)) })
        case let q as BlockQuote:
            return .blockQuote(q.blockChildren.map(lower))
        case let t as Table:
            return lowerTable(t)
        case is ThematicBreak:
            return .thematicBreak
        default:
            // Unknown block (e.g. HTML) → its plain rendered text as a paragraph, never dropped.
            return .paragraph([.text(markup.format())])
        }
    }

    private static func lowerTable(_ t: Table) -> MarkdownBlock {
        let header = t.head.cells.map { lowerInlines($0.inlineChildren) }
        let rows = t.body.rows.map { row in Array(row.cells.map { lowerInlines($0.inlineChildren) }) }
        return .table(header: Array(header), rows: Array(rows))
    }

    // MARK: inline lowering

    private static func lowerInlines<S: Sequence>(_ inlines: S) -> [MarkdownInline] where S.Element == InlineMarkup {
        inlines.map(lowerInline)
    }

    private static func lowerInline(_ markup: InlineMarkup) -> MarkdownInline {
        switch markup {
        case let t as Markdown.Text:      return .text(t.string)
        case let e as Emphasis:           return .emphasis(lowerInlines(e.inlineChildren))
        case let s as Strong:             return .strong(lowerInlines(s.inlineChildren))
        case let c as InlineCode:         return .code(c.code)
        case let l as Markdown.Link:      return .link(text: lowerInlines(l.inlineChildren), url: l.destination ?? "")
        case is LineBreak:                return .lineBreak
        case is SoftBreak:                return .softBreak
        default:                          return .text(markup.plainText)
        }
    }
}
