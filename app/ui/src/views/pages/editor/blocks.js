import { EditorSelection } from "@codemirror/state";

// Line-level block edits shared by the slash menu, the toolbar and the
// keyboard: turn the caret's line into a heading / task / list item / quote, or
// toggle a task. Markdown stays the source of truth — these only rewrite the
// line's leading marker.

const BLOCK_PREFIX = /^(\s*)(?:#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+|>\s?)?/;
const TASK = /^(\s*[-*+]\s+\[)([ xX])(\])/;

export const PREFIXES = {
  text: "",
  h1: "# ",
  h2: "## ",
  h3: "### ",
  todo: "- [ ] ",
  bullet: "- ",
  numbered: "1. ",
  quote: "> ",
};

// The caret's line, minus an optional range typed on it (e.g. the "/cmd" that
// summoned the slash menu).
function caretLine(state, strip) {
  const line = state.doc.lineAt(state.selection.main.head);
  let text = line.text;
  if (strip) text = text.slice(0, strip.from - line.from) + text.slice(strip.to - line.from);
  return { line, text };
}

// Replace the line's block marker (and `strip`) with `prefix`.
export function setLineBlock(view, prefix, strip = null) {
  const { line, text } = caretLine(view.state, strip);
  const m = text.match(BLOCK_PREFIX);
  const rest = text.slice(m[0].length);
  const insert = m[1] + prefix + rest;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(line.from + insert.length),
    scrollIntoView: true,
    userEvent: "input.block",
  });
  view.focus();
}

export function insertCodeBlock(view, strip = null) {
  const { line, text } = caretLine(view.state, strip);
  const before = text.trim() ? `${text}\n` : "";
  const insert = `${before}\`\`\`\n\n\`\`\``;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(line.from + before.length + 4),
    userEvent: "input.block",
  });
  view.focus();
}

export function insertDivider(view, strip = null) {
  const { line, text } = caretLine(view.state, strip);
  const insert = `${text.trim() ? `${text}\n` : ""}---\n`;
  view.dispatch({
    changes: { from: line.from, to: line.to, insert },
    selection: EditorSelection.cursor(line.from + insert.length),
    userEvent: "input.block",
  });
  view.focus();
}

// Tick/untick the task on `lineNo` (1-based); false when it isn't a task.
export function toggleTaskAt(view, lineNo) {
  const line = view.state.doc.line(lineNo);
  const m = line.text.match(TASK);
  if (!m) return false;
  const at = line.from + m[1].length;
  view.dispatch({ changes: { from: at, to: at + 1, insert: m[2] === " " ? "x" : " " }, userEvent: "input.task" });
  return true;
}

// ⌘↵: toggle the caret line's task, or make it one.
export function toggleTaskCommand(view) {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (!toggleTaskAt(view, line.number)) setLineBlock(view, PREFIXES.todo);
  return true;
}

// Selected lines become open tasks (blank lines are skipped).
export function makeTasks(view) {
  const { state } = view;
  const sel = state.selection.main;
  const first = state.doc.lineAt(sel.from).number;
  const last = state.doc.lineAt(sel.to).number;
  const changes = [];
  for (let n = first; n <= last; n++) {
    const line = state.doc.line(n);
    if (!line.text.trim() || TASK.test(line.text)) continue;
    const m = line.text.match(BLOCK_PREFIX);
    changes.push({ from: line.from, to: line.from + m[0].length, insert: `${m[1]}- [ ] ` });
  }
  if (changes.length) view.dispatch({ changes, userEvent: "input.block" });
  view.focus();
}

export const taskText = (lineText) => lineText.replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, "").trim();
