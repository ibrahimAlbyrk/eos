// CodeLens for the File-panel editor: a reference-count chip rendered as a block
// widget ABOVE each definition's line. Mirrors EditView's find-bar decoration
// wiring — a StateEffect carries a fresh Decoration.set, a StateField provides it
// and maps it through doc changes so chips follow edits until the next refetch.
import { StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView, WidgetType } from "@codemirror/view";

export const setCodeLensDeco = StateEffect.define();

export const codeLensField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) if (e.is(setCodeLensDeco)) deco = e.value;
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// count == null ⇒ not yet resolved (off-viewport or in flight): a subtle
// placeholder, never an error. Singular/plural kept honest.
export function codeLensLabel(count) {
  if (count == null) return "…";
  return `${count} reference${count === 1 ? "" : "s"}`;
}

class CodeLensWidget extends WidgetType {
  constructor(def, onClick) {
    super();
    this.def = def;
    this.onClick = onClick;
  }
  eq(other) {
    return other.def.name === this.def.name
      && other.def.line === this.def.line
      && other.def.count === this.def.count;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "cm-codelens";
    const glyph = document.createElement("span");
    glyph.className = "cm-codelens-glyph";
    glyph.textContent = this.def.glyph ?? "•";
    const label = document.createElement("span");
    label.className = "cm-codelens-label" + (this.def.count == null ? " is-loading" : "");
    label.textContent = codeLensLabel(this.def.count);
    el.append(glyph, label);
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.onClick?.(this.def);
    });
    return el;
  }
  ignoreEvent() { return true; }
}

// Build the block-widget set from the def list. Skips lines outside the live doc
// (a def parsed against older content than the current buffer) so a stale fetch
// can never throw; Decoration.set sorts the ranges.
export function buildCodeLensDeco(state, defs, onClick) {
  const total = state.doc.lines;
  const ranges = [];
  for (const def of defs ?? []) {
    if (!def || def.line < 1 || def.line > total) continue;
    const from = state.doc.line(def.line).from;
    ranges.push(
      Decoration.widget({ widget: new CodeLensWidget(def, onClick), side: -1, block: true }).range(from),
    );
  }
  return Decoration.set(ranges, true);
}

// The distinct def names whose line is inside the editor's current viewport —
// the set whose reference counts should be fetched lazily.
export function visibleDefNames(view, defs) {
  if (!defs?.length) return [];
  const { state } = view;
  const seen = new Set();
  const names = [];
  for (const { from, to } of view.visibleRanges) {
    const first = state.doc.lineAt(from).number;
    const last = state.doc.lineAt(to).number;
    for (const d of defs) {
      if (d.line >= first && d.line <= last && !seen.has(d.name)) {
        seen.add(d.name);
        names.push(d.name);
      }
    }
  }
  return names;
}
