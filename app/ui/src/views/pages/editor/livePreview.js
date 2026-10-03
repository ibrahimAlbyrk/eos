import { Decoration, EditorView, ViewPlugin, WidgetType } from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import { actionsOf } from "./pageActions.js";
import { toggleTaskAt, taskText } from "./blocks.js";

// Live preview: the page is plain markdown, drawn like a document. Headings
// grow, "- [ ]" becomes a checkbox, "-" a bullet, emphasis/code/links style in
// place and their markers hide — except on the line (or span) the caret is in,
// where the raw markdown shows so it can be edited. Open tasks get a "Hand to
// agent" button on hover when the page can reach an agent.

const CHECK_SVG = '<svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m3.5 8.5 3 3 6-7"/></svg>';
const HAND_SVG = '<svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 11 11 5M6 5h5v5"/></svg>';

class CheckboxWidget extends WidgetType {
  constructor(checked) { super(); this.checked = checked; }
  eq(o) { return o.checked === this.checked; }
  toDOM() {
    const box = document.createElement("span");
    box.className = "pg-check" + (this.checked ? " is-done" : "");
    box.setAttribute("role", "checkbox");
    box.setAttribute("aria-checked", String(this.checked));
    box.setAttribute("aria-label", this.checked ? "Mark as not done" : "Mark as done");
    if (this.checked) box.innerHTML = CHECK_SVG;
    return box;
  }
  ignoreEvent() { return false; }
}

class BulletWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const dot = document.createElement("span");
    dot.className = "pg-bullet";
    return dot;
  }
}

class RuleWidget extends WidgetType {
  eq() { return true; }
  toDOM() {
    const hr = document.createElement("span");
    hr.className = "pg-rule";
    return hr;
  }
}

class HandWidget extends WidgetType {
  constructor(text) { super(); this.text = text; }
  eq(o) { return o.text === this.text; }
  toDOM(view) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pg-hand";
    btn.innerHTML = `${HAND_SVG}<span>Hand to agent</span>`;
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      actionsOf(view.state).onHandTask?.(this.text);
    });
    return btn;
  }
  ignoreEvent() { return true; }
}

const hide = Decoration.replace({});
const bullet = Decoration.replace({ widget: new BulletWidget() });
const rule = Decoration.replace({ widget: new RuleWidget() });
const mark = (cls) => Decoration.mark({ class: cls });
const lineClass = (cls) => Decoration.line({ class: cls });

const INLINE_MARKS = {
  Emphasis: mark("pg-em"),
  StrongEmphasis: mark("pg-strong"),
  InlineCode: mark("pg-icode"),
  Strikethrough: mark("pg-strike"),
  Link: mark("pg-link"),
};
const HIDE_IN = new Set(["Emphasis", "StrongEmphasis", "InlineCode", "Strikethrough", "Link"]);
const MENTION = /(^|[\s(])(@[\w./-]+)/g;

// Exported for tests (a fake view with state + visibleRanges is enough).
export function previewDecorations(view) {
  const { state } = view;
  const ranges = state.selection.ranges;
  const touches = (from, to) => ranges.some((r) => r.from <= to && r.to >= from);
  const caretLines = new Set(ranges.map((r) => state.doc.lineAt(r.head).number));
  const onCaretLine = (pos) => caretLines.has(state.doc.lineAt(pos).number);
  const canHand = Boolean(actionsOf(state).canHand);
  const out = [];
  const add = (from, to, deco) => out.push(deco.range(from, to));

  for (const { from, to } of view.visibleRanges) {
    syntaxTree(state).iterate({
      from, to,
      enter(ref) {
        const { name, node } = ref;
        const heading = /^(?:ATX|Setext)Heading(\d)$/.exec(name);
        if (heading) {
          add(ref.from, ref.from, lineClass(`pg-h pg-h${heading[1]}`));
          return;
        }
        switch (name) {
          case "HeaderMark": {
            if (node.parent?.name.startsWith("Setext")) { if (!onCaretLine(ref.from)) add(ref.from, ref.to, hide); return; }
            const end = state.sliceDoc(ref.to, ref.to + 1) === " " ? ref.to + 1 : ref.to;
            if (onCaretLine(ref.from)) add(ref.from, end, mark("pg-mark"));
            else add(ref.from, end, hide);
            return;
          }
          case "Task": {
            const marker = node.getChild("TaskMarker");
            if (!marker) return;
            const checked = /x/i.test(state.sliceDoc(marker.from, marker.to));
            const listMark = node.parent?.getChild("ListMark");
            const start = listMark ? listMark.from : marker.from;
            const end = state.sliceDoc(marker.to, marker.to + 1) === " " ? marker.to + 1 : marker.to;
            const line = state.doc.lineAt(ref.from);
            add(line.from, line.from, lineClass("pg-task" + (checked ? " is-done" : "")));
            if (!touches(start, end)) add(start, end, Decoration.replace({ widget: new CheckboxWidget(checked) }));
            const text = taskText(line.text);
            if (canHand && !checked && text) add(line.to, line.to, Decoration.widget({ widget: new HandWidget(text), side: 1 }));
            return;
          }
          case "ListMark": {
            const item = node.parent;
            if (item?.getChild("Task")) return; // drawn by the Task case
            if (item?.parent?.name === "BulletList") {
              const end = state.sliceDoc(ref.to, ref.to + 1) === " " ? ref.to + 1 : ref.to;
              if (!touches(ref.from, end)) add(ref.from, end, bullet);
            } else {
              add(ref.from, ref.to, mark("pg-olmark"));
            }
            return;
          }
          case "FencedCode": {
            const first = state.doc.lineAt(ref.from).number;
            const last = state.doc.lineAt(ref.to).number;
            for (let n = first; n <= last; n++) {
              const cls = "pg-codeblock" + (n === first ? " is-first" : "") + (n === last ? " is-last" : "");
              add(state.doc.line(n).from, state.doc.line(n).from, lineClass(cls));
            }
            return;
          }
          case "CodeMark":
          case "CodeInfo": {
            if (node.parent?.name === "FencedCode") { add(ref.from, ref.to, mark("pg-mark")); return; }
            break;
          }
          case "Blockquote": {
            const first = state.doc.lineAt(ref.from).number;
            const last = state.doc.lineAt(ref.to).number;
            for (let n = first; n <= last; n++) add(state.doc.line(n).from, state.doc.line(n).from, lineClass("pg-quote"));
            return;
          }
          case "QuoteMark": {
            const end = state.sliceDoc(ref.to, ref.to + 1) === " " ? ref.to + 1 : ref.to;
            if (onCaretLine(ref.from)) add(ref.from, end, mark("pg-mark"));
            else add(ref.from, end, hide);
            return;
          }
          case "HorizontalRule": {
            if (!onCaretLine(ref.from)) add(ref.from, ref.to, rule);
            return;
          }
          default:
            break;
        }
        if (INLINE_MARKS[name]) {
          add(ref.from, ref.to, INLINE_MARKS[name]);
          return;
        }
        // Markers of an inline span hide unless the caret is inside that span.
        if (name === "EmphasisMark" || name === "CodeMark" || name === "StrikethroughMark" || name === "LinkMark" || name === "URL") {
          const parent = node.parent;
          if (!parent || !HIDE_IN.has(parent.name)) return;
          if (touches(parent.from, parent.to)) add(ref.from, ref.to, mark("pg-mark"));
          else add(ref.from, ref.to, hide);
        }
      },
    });

    const text = state.sliceDoc(from, to);
    for (const m of text.matchAll(MENTION)) {
      const at = from + m.index + m[1].length;
      add(at, at + m[2].length, mark("pg-mention"));
    }
  }
  return Decoration.set(out, true);
}

export const livePreview = ViewPlugin.fromClass(class {
  constructor(view) { this.decorations = previewDecorations(view); }
  update(u) {
    if (u.docChanged || u.viewportChanged || u.selectionSet || u.focusChanged
      || syntaxTree(u.startState) !== syntaxTree(u.state)) {
      this.decorations = previewDecorations(u.view);
    }
  }
}, {
  decorations: (v) => v.decorations,
  eventHandlers: {
    // A checkbox click ticks its task without moving the caret onto the line.
    mousedown(e, view) {
      const box = e.target.closest?.(".pg-check");
      if (!box) return false;
      e.preventDefault();
      const pos = view.posAtDOM(box);
      return toggleTaskAt(view, view.state.doc.lineAt(pos).number);
    },
  },
});

export const livePreviewTheme = EditorView.theme({
  "&": { backgroundColor: "transparent" },
  "&.cm-focused": { outline: "none" },
}, { dark: true });
