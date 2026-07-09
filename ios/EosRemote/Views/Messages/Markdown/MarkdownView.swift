import SwiftUI

// Renders a parsed MarkdownDocument as SwiftUI VIEWS (spec 03 §5.1, the paper/serif reconciliation of
// .md-prose). Block nodes → stacked views; inline runs → an AttributedString so prose flows/wraps.
// Code fences + tables are real view nodes (CodeBlockView / a Grid) for scroll + copy control. Exact
// geometry from §10 (.md-prose): serif body + .lineSpacing(4), heading margins 16/8, list indent 22,
// inline code on bgSunken r3, coral links.
struct MarkdownView: View {
    let source: String

    var body: some View {
        let doc = MarkdownCache.document(for: source)
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(doc.blocks.enumerated()), id: \.offset) { _, block in
                MarkdownBlockView(block: block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .tint(EosColor.coral)   // link taps
    }
}

private struct MarkdownBlockView: View {
    let block: MarkdownBlock

    var body: some View {
        switch block {
        case let .heading(level, inlines):
            Text(MarkdownInlineBuilder.attributed(inlines, base: headingBase(level)))
                .foregroundStyle(EosColor.ink)
                .padding(.top, 16).padding(.bottom, 8)                 // h margins 16 0 8 (§10)
                .frame(maxWidth: .infinity, alignment: .leading)

        case let .paragraph(inlines):
            Text(MarkdownInlineBuilder.attributed(inlines, base: .body))
                .lineSpacing(4)                                        // serif body (§5.1)
                .foregroundStyle(EosColor.ink)
                .padding(.bottom, 10)                                  // p margin 0 0 10 (§10)
                .frame(maxWidth: .infinity, alignment: .leading)

        case let .codeBlock(language, code):
            CodeBlockView(language: language, code: code)
                .padding(.top, 8).padding(.bottom, 12)                 // pre margin 8 0 12 (§10)

        case let .unorderedList(items):
            MarkdownListView(items: items, ordered: false, start: 1)

        case let .orderedList(start, items):
            MarkdownListView(items: items, ordered: true, start: start)

        case let .blockQuote(blocks):
            HStack(spacing: 0) {
                RoundedRectangle(cornerRadius: 1.5)
                    .fill(EosColor.hairline)
                    .frame(width: 3)                                   // border-left 3 (§10)
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(blocks.enumerated()), id: \.offset) { _, b in
                        MarkdownBlockView(block: b).foregroundStyle(EosColor.inkSecondary)
                    }
                }
                .padding(.horizontal, 14).padding(.vertical, 6)        // blockquote pad 6×14 (§10)
            }
            .padding(.bottom, 10)

        case let .table(header, rows):
            MarkdownTableView(header: header, rows: rows)
                .padding(.bottom, 10)

        case .thematicBreak:
            Rectangle().fill(EosColor.hairline).frame(height: 1)
                .padding(.vertical, 10)
    }
    }

    private func headingBase(_ level: Int) -> MarkdownInlineBuilder.Base {
        switch level {
        case 1: return .heading1        // text-2xl (§10)
        case 2: return .heading2        // text-xl
        case 3: return .heading3        // text-md
        default: return .heading4       // text-base
        }
    }
}

// Nested bullet / ordered list (spec §5.1: indent 22, marker inkTertiary, item gap 2).
private struct MarkdownListView: View {
    let items: [MarkdownListItem]
    let ordered: Bool
    let start: Int

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {                      // li margin 2 0 (§10)
            ForEach(Array(items.enumerated()), id: \.offset) { idx, item in
                HStack(alignment: .top, spacing: 6) {
                    Text(marker(idx))
                        .font(EosFont.bodySerif)
                        .foregroundStyle(EosColor.inkTertiary)         // marker fg-faint (§10)
                        .frame(minWidth: 16, alignment: .trailing)
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(Array(item.blocks.enumerated()), id: \.offset) { _, b in
                            // Drop the trailing paragraph margin inside tight list items.
                            MarkdownBlockView(block: b)
                        }
                    }
                }
            }
        }
        .padding(.leading, 22)                                         // padding-left 22 (§10)
        .padding(.vertical, 4)                                         // ul margin 4 0 10 (§10)
        .padding(.bottom, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func marker(_ idx: Int) -> String { ordered ? "\(start + idx)." : "•" }
}

// GFM table (spec §5.1/§10): header row bgSunken, cell borders hairline, both padded 6×14.
private struct MarkdownTableView: View {
    let header: [[MarkdownInline]]
    let rows: [[[MarkdownInline]]]

    private var columnCount: Int { max(header.count, rows.map(\.count).max() ?? 0) }

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .leading, horizontalSpacing: 2, verticalSpacing: 2) {  // border-spacing 2
                GridRow {
                    ForEach(0..<columnCount, id: \.self) { c in
                        cell(header.indices.contains(c) ? header[c] : [], isHeader: true)
                    }
                }
                ForEach(Array(rows.enumerated()), id: \.offset) { _, row in
                    GridRow {
                        ForEach(0..<columnCount, id: \.self) { c in
                            cell(row.indices.contains(c) ? row[c] : [], isHeader: false)
                        }
                    }
                }
            }
        }
    }

    private func cell(_ inlines: [MarkdownInline], isHeader: Bool) -> some View {
        Text(MarkdownInlineBuilder.attributed(inlines, base: isHeader ? .tableHeader : .body))
            .foregroundStyle(EosColor.ink)
            .padding(.horizontal, 14).padding(.vertical, 6)            // th/td pad 6×14 (§10)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(isHeader ? EosColor.surface3 : EosColor.surface)        // header raised on dark (surface-3)
            .clipShape(RoundedRectangle(cornerRadius: 4, style: .continuous))  // th/td radius 4 (§10)
    }
}
