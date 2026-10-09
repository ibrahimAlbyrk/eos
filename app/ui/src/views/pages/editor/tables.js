import { StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";

// Markdown tables in the live preview: away from the caret a table draws as a
// real table; once the caret enters it (a click on a cell puts it there) the
// raw markdown shows for editing. Lives in a state field because a view
// plugin may not replace whole lines with a block widget.

const CELL_MARKS = { Emphasis: "pg-em", StrongEmphasis: "pg-strong", InlineCode: "pg-icode", Strikethrough: "pg-strike", Link: "pg-link" };
const HIDDEN = new Set(["EmphasisMark", "CodeMark", "StrikethroughMark", "LinkMark", "URL", "LinkTitle", "LinkLabel"]);

// A cell's inline markdown as styled text runs, markers dropped.
function inlineParts(state, node, from, to, cls, out) {
  let pos = from;
  for (let c = node.firstChild; c; c = c.nextSibling) {
    if (c.to <= from || c.from >= to) continue;
    if (c.from > pos) out.push({ text: state.sliceDoc(pos, c.from), cls });
    if (c.name === "Escape") out.push({ text: state.sliceDoc(c.from + 1, c.to), cls });
    else if (CELL_MARKS[c.name]) {
      const marks = c.name === "Link" ? c.getChildren("LinkMark") : [];
      const inner = marks.length ? [marks[0].to, marks[1]?.from ?? c.to] : [c.from, c.to];
      inlineParts(state, c, inner[0], inner[1], [cls, CELL_MARKS[c.name]].filter(Boolean).join(" "), out);
    } else if (!HIDDEN.has(c.name)) out.push({ text: state.sliceDoc(c.from, c.to), cls });
    pos = c.to;
  }
  if (pos < to) out.push({ text: state.sliceDoc(pos, to), cls });
  return out;
}

// Empty cells have no TableCell node, so cells are counted by the pipes —
// the same way the parser counts them (a leading pipe opens no cell).
function rowCells(state, row, base) {
  const cells = [];
  let cell = null;
  let start = row.from;
  let first = true;
  const close = (node) => cells.push(node
    ? { at: node.to - base, parts: inlineParts(state, node, node.from, node.to, "", []) }
    : { at: start - base, parts: [] });
  for (let c = row.firstChild; c; c = c.nextSibling) {
    if (c.name === "TableCell") cell = c;
    else if (c.name === "TableDelimiter") {
      if (!first || cell) close(cell);
      cell = null;
      first = false;
      start = c.to;
    }
  }
  if (cell) close(cell);
  return cells;
}

function alignments(text) {
  return text.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((s) => {
    const t = s.trim();
    const left = t.startsWith(":");
    const right = t.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : "";
  });
}

// Cell `at` offsets are relative to the table's first line, so a widget stays
// valid while text above it shifts.
export function tableModel(state, table, base) {
  const head = rowCells(state, table.getChild("TableHeader"), base);
  const delim = table.getChild("TableDelimiter");
  // Like GFM: a body row is cut or padded to the header's width.
  const fit = (cells) => head.map((_, i) => cells[i] ?? { at: cells.at(-1)?.at ?? 0, parts: [] });
  return {
    align: alignments(state.sliceDoc(delim.from, delim.to)),
    head,
    body: table.getChildren("TableRow").map((r) => fit(rowCells(state, r, base))),
  };
}

class TableWidget extends WidgetType {
  constructor(src, model) { super(); this.src = src; this.model = model; }
  eq(o) { return o.src === this.src; }
  toDOM(view) {
    const wrap = document.createElement("div");
    wrap.className = "pg-table";
    const table = wrap.appendChild(document.createElement("table"));
    const row = (parent, cells, tag) => {
      const tr = parent.appendChild(document.createElement("tr"));
      cells.forEach((cell, i) => {
        const td = tr.appendChild(document.createElement(tag));
        td.dataset.at = String(cell.at);
        if (this.model.align[i]) td.style.textAlign = this.model.align[i];
        for (const p of cell.parts) {
          if (!p.cls) { td.append(p.text); continue; }
          const span = td.appendChild(document.createElement("span"));
          span.className = p.cls;
          span.textContent = p.text;
        }
      });
    };
    row(table.createTHead(), this.model.head, "th");
    const body = table.createTBody();
    for (const cells of this.model.body) row(body, cells, "td");
    wrap.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const cell = e.target.closest?.("[data-at]");
      view.dispatch({ selection: { anchor: view.posAtDOM(wrap) + (cell ? Number(cell.dataset.at) : 0) } });
      view.focus();
    });
    return wrap;
  }
  ignoreEvent() { return true; }
}

const sourceLine = Decoration.line({ class: "pg-table-src" });

// Exported for tests. Only top-level tables: one inside a list or quote
// shares its lines with their markers.
export function tableDecorations(state) {
  const out = [];
  const { doc, selection } = state;
  for (let t = syntaxTree(state).topNode.firstChild; t; t = t.nextSibling) {
    if (t.name !== "Table") continue;
    const first = doc.lineAt(t.from);
    const last = doc.lineAt(t.to);
    if (selection.ranges.some((r) => r.from <= last.to && r.to >= first.from)) {
      for (let n = first.number; n <= last.number; n++) out.push(sourceLine.range(doc.line(n).from));
    } else {
      const widget = new TableWidget(doc.sliceString(first.from, last.to), tableModel(state, t, first.from));
      out.push(Decoration.replace({ widget, block: true }).range(first.from, last.to));
    }
  }
  return Decoration.set(out);
}

export const tablePreview = StateField.define({
  create: tableDecorations,
  update(deco, tr) {
    if (tr.docChanged || tr.selection || syntaxTree(tr.startState) !== syntaxTree(tr.state)) return tableDecorations(tr.state);
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});
