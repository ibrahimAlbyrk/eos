import { describe, it, expect } from "vitest";
import { EditorState, EditorSelection } from "@codemirror/state";
import { ensureSyntaxTree } from "@codemirror/language";
import { CompletionContext } from "@codemirror/autocomplete";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { pageActions } from "./pageActions.js";
import { PREFIXES, insertTable, makeTasks, setLineBlock, toggleTaskAt, toggleTaskCommand } from "./blocks.js";
import { previewDecorations } from "./livePreview.js";
import { tableDecorations } from "./tables.js";
import { slashSource } from "./completions.js";

// Enough of an EditorView for the block commands and the decoration builder:
// state + dispatch + the visible range (the whole doc).
function fakeView(doc, cursor = doc.length, actions = {}) {
  const view = {
    state: EditorState.create({
      doc,
      selection: EditorSelection.cursor(cursor),
      extensions: [markdown({ base: markdownLanguage }), pageActions.of({ current: actions })],
    }),
    dispatch(spec) { this.state = this.state.update(spec).state; },
    focus() {},
    get visibleRanges() { return [{ from: 0, to: this.state.doc.length }]; },
  };
  ensureSyntaxTree(view.state, doc.length, 5000);
  return view;
}

function decorations(view) {
  const out = [];
  previewDecorations(view).between(0, view.state.doc.length, (from, to, deco) => {
    out.push({ from, to, cls: deco.spec.class, widget: deco.spec.widget?.constructor.name ?? null });
  });
  return out;
}

describe("page blocks", () => {
  it("turns the caret line into a block, replacing any marker", () => {
    const v = fakeView("- [ ] ship it");
    setLineBlock(v, PREFIXES.h2);
    expect(v.state.doc.toString()).toBe("## ship it");
    setLineBlock(v, PREFIXES.todo);
    expect(v.state.doc.toString()).toBe("- [ ] ship it");
  });

  it("strips the typed slash command", () => {
    const v = fakeView("plan /to", 8);
    setLineBlock(v, PREFIXES.todo, { from: 5, to: 8 });
    expect(v.state.doc.toString()).toBe("- [ ] plan ");
  });

  it("toggles tasks and makes selected lines tasks", () => {
    const v = fakeView("- [ ] a\n- [x] b");
    toggleTaskAt(v, 1);
    toggleTaskAt(v, 2);
    expect(v.state.doc.toString()).toBe("- [x] a\n- [ ] b");
    const w = fakeView("one\n\n- two\n- [ ] three");
    w.state = w.state.update({ selection: EditorSelection.range(0, w.state.doc.length) }).state;
    makeTasks(w);
    expect(w.state.doc.toString()).toBe("- [ ] one\n\n- [ ] two\n- [ ] three");
    const x = fakeView("plain", 2);
    toggleTaskCommand(x);
    expect(x.state.doc.toString()).toBe("- [ ] plain");
  });
});

describe("page live preview", () => {
  it("draws checkboxes, bullets and headings away from the caret", () => {
    const doc = "# Title\n\n- [ ] open\n- [x] done\n- item\n\ntext";
    const view = fakeView(doc, doc.length, { canHand: true });
    const d = decorations(view);
    const widgets = d.map((x) => x.widget).filter(Boolean);
    expect(widgets.filter((w) => w === "CheckboxWidget")).toHaveLength(2);
    expect(widgets).toContain("BulletWidget");
    expect(widgets.filter((w) => w === "HandWidget")).toHaveLength(1); // only the open task
    expect(d.some((x) => x.cls?.includes("pg-h1"))).toBe(true);
    expect(d.some((x) => x.cls?.includes("pg-task is-done"))).toBe(true);
    // "# " is hidden (a replace without widget) while the caret is elsewhere
    expect(d.some((x) => x.from === 0 && x.to === 2 && !x.cls && !x.widget)).toBe(true);
  });

  it("shows the raw markdown on the caret's line", () => {
    const view = fakeView("# Title\n\n- [ ] open", 3);
    const d = decorations(view);
    expect(d.some((x) => x.from === 0 && x.to === 2 && x.cls === "pg-mark")).toBe(true);
  });

  it("offers no hand-off without a reachable agent", () => {
    const widgets = decorations(fakeView("- [ ] open", 0)).map((x) => x.widget);
    expect(widgets).not.toContain("HandWidget");
  });
});

describe("page tables", () => {
  const TABLE = "## Targets\n| | LAN | Relay |\n|---|:---:|--:|\n| fps | **60** | `30` \\| adaptive |\n| short |\n\nafter";
  const tableDecos = (view) => {
    const out = [];
    tableDecorations(view.state).between(0, view.state.doc.length, (from, to, deco) => {
      out.push({ from, to, cls: deco.spec.class, model: deco.spec.widget?.model });
    });
    return out;
  };

  it("draws a table away from the caret, cells parsed like GFM", () => {
    const view = fakeView(TABLE, TABLE.length);
    const [d, ...rest] = tableDecos(view);
    expect(rest).toHaveLength(0);
    expect(view.state.sliceDoc(d.from, d.to)).toBe(TABLE.slice(11, TABLE.indexOf("\n\n")));
    const { align, head, body } = d.model;
    expect(align).toEqual(["", "center", "right"]);
    expect(head.map((c) => c.parts.map((p) => p.text).join(""))).toEqual(["", "LAN", "Relay"]);
    expect(body[0][1].parts).toEqual([{ text: "60", cls: "pg-strong" }]);
    expect(body[0][2].parts).toEqual([{ text: "30", cls: "pg-icode" }, { text: " ", cls: "" }, { text: "|", cls: "" }, { text: " adaptive", cls: "" }]);
    expect(body[1]).toHaveLength(3); // a short row is padded to the header
    // a cell's offset lands the caret at the end of its text
    expect(view.state.sliceDoc(d.from, d.from + body[0][0].at).endsWith("| fps")).toBe(true);
  });

  it("shows the markdown while the caret is in the table", () => {
    const view = fakeView(TABLE, 14);
    const d = tableDecos(view);
    expect(d.every((x) => x.cls === "pg-table-src" && !x.model)).toBe(true);
    expect(d).toHaveLength(4);
  });

  it("inserts a table kept apart from the text around it", () => {
    const v = fakeView("intro\n/ta\nnext", 9);
    insertTable(v, { from: 6, to: 9 });
    expect(v.state.doc.toString()).toBe("intro\n\n| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n\nnext");
    const { from, to } = v.state.selection.main;
    expect(v.state.sliceDoc(from, to)).toBe("Column 1");
    ensureSyntaxTree(v.state, v.state.doc.length, 5000);
    v.state = v.state.update({ selection: EditorSelection.cursor(0) }).state;
    expect(tableDecos(v)[0].model.head).toHaveLength(2);
  });
});

describe("slash menu", () => {
  it("opens only at the start of a line and hides unavailable Eos actions", () => {
    const view = fakeView("/to", 3, { project: null, canHand: false });
    const r = slashSource(new CompletionContext(view.state, 3, false));
    expect(r.from).toBe(1);
    const labels = r.options.map((o) => o.label);
    expect(labels).toContain("To-do");
    expect(labels).not.toContain("Mention a file");
    expect(labels).not.toContain("Hand open tasks to the agent");
    expect(slashSource(new CompletionContext(fakeView("a/to").state, 4, false))).toBe(null);
  });

  it("applies a command over the typed /query", () => {
    const view = fakeView("/to", 3);
    const r = slashSource(new CompletionContext(view.state, 3, false));
    r.options.find((o) => o.label === "To-do").apply(view, null, r.from, 3);
    expect(view.state.doc.toString()).toBe("- [ ] ");
  });
});
