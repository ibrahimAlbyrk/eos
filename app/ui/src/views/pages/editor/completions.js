import { autocompletion, startCompletion } from "@codemirror/autocomplete";
import { api } from "../../../api/client.js";
import { actionsOf } from "./pageActions.js";
import { PREFIXES, insertCodeBlock, insertDivider, insertTable, setLineBlock } from "./blocks.js";

// Two completion sources: "/" at the start of a line opens the block menu
// (markdown blocks + Eos actions), "@" completes a file path in the page's
// project. Both render in the glass popover style.

const BLOCKS = { name: "Blocks", rank: 0 };
const EOS = { name: "Eos", rank: 1 };

const ICONS = {
  text: '<path d="M4 4h8M8 4v8.5"/>',
  h1: '<path d="M3 3.5v9M9 3.5v9M3 8h6"/><path d="M11.5 6.5 13 5.5v7"/>',
  h2: '<path d="M2.5 3.5v9M8 3.5v9M2.5 8H8"/><path d="M10.5 6.3a1.6 1.6 0 1 1 2.6 1.3l-2.6 4.9h3"/>',
  h3: '<path d="M2.5 3.5v9M8 3.5v9M2.5 8H8"/><path d="M10.6 5.5h2.7l-1.6 2.2a1.7 1.7 0 1 1-1.3 2.9"/>',
  todo: '<rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="m5.5 8.2 1.8 1.8 3.3-3.6"/>',
  bullet: '<circle cx="3.5" cy="4.5" r=".9" fill="currentColor"/><circle cx="3.5" cy="11.5" r=".9" fill="currentColor"/><path d="M6.5 4.5h7M6.5 11.5h7"/>',
  numbered: '<path d="M2.5 3.5h1v3M2.3 12.5h2.2l-2-2.2a1 1 0 1 1 1.8-.8M6.5 5h7M6.5 11h7"/>',
  quote: '<path d="M3 3.5v9M6 5.5h7M6 8h7M6 10.5h5"/>',
  code: '<path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3"/>',
  divider: '<path d="M2 8h12"/>',
  table: '<rect x="2.5" y="3" width="11" height="10" rx="2"/><path d="M2.5 6.5h11M2.5 9.75h11M8 6.5V13"/>',
  mention: '<circle cx="8" cy="8" r="2.5"/><path d="M10.5 8v1a1.8 1.8 0 0 0 3.5 0V8A6 6 0 1 0 11.5 13"/>',
  chat: '<path d="M3 3.5h10a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H7l-3 2.5v-2.5H3a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1Z"/>',
  hand: '<path d="M5 11 11 5M6 5h5v5"/>',
  file: '<path d="M4 2.5h5.2L12 5.3v8.2H4z"/><path d="M9 2.5v3h3"/>',
  folder: '<path d="M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z"/>',
};

// `strip` is the typed "/query" — the command replaces it.
const blockCmd = (label, icon, hint, run) => ({ label, icon, hint, section: BLOCKS, run });
const COMMANDS = [
  blockCmd("Text", "text", "", (v, strip) => setLineBlock(v, PREFIXES.text, strip)),
  blockCmd("Heading 1", "h1", "#", (v, strip) => setLineBlock(v, PREFIXES.h1, strip)),
  blockCmd("Heading 2", "h2", "##", (v, strip) => setLineBlock(v, PREFIXES.h2, strip)),
  blockCmd("Heading 3", "h3", "###", (v, strip) => setLineBlock(v, PREFIXES.h3, strip)),
  blockCmd("To-do", "todo", "[]", (v, strip) => setLineBlock(v, PREFIXES.todo, strip)),
  blockCmd("Bulleted list", "bullet", "-", (v, strip) => setLineBlock(v, PREFIXES.bullet, strip)),
  blockCmd("Numbered list", "numbered", "1.", (v, strip) => setLineBlock(v, PREFIXES.numbered, strip)),
  blockCmd("Quote", "quote", ">", (v, strip) => setLineBlock(v, PREFIXES.quote, strip)),
  blockCmd("Code block", "code", "```", (v, strip) => insertCodeBlock(v, strip)),
  blockCmd("Divider", "divider", "---", (v, strip) => insertDivider(v, strip)),
  blockCmd("Table", "table", "|", (v, strip) => insertTable(v, strip)),
  {
    label: "Mention a file", icon: "mention", hint: "@", section: EOS,
    available: (a) => Boolean(a.project),
    run: (v, strip) => {
      v.dispatch({ changes: { from: strip.from, to: strip.to, insert: "@" }, selection: { anchor: strip.from + 1 } });
      startCompletion(v);
    },
  },
  {
    label: "Add page to chat", icon: "chat", hint: "", section: EOS,
    available: (a) => Boolean(a.onAddToChat),
    run: (v, strip, a) => { v.dispatch({ changes: strip }); a.onAddToChat(); },
  },
  {
    label: "Hand open tasks to the agent", icon: "hand", hint: "", section: EOS,
    available: (a) => Boolean(a.canHand && a.hasOpenTasks?.()),
    run: (v, strip, a) => { v.dispatch({ changes: strip }); a.onHandAll(); },
  },
];

export function slashSource(context) {
  const line = context.state.doc.lineAt(context.pos);
  const before = line.text.slice(0, context.pos - line.from);
  const m = before.match(/^(\s*)\/([\w ]*)$/);
  if (!m) return null;
  const slash = line.from + m[1].length;
  const actions = actionsOf(context.state);
  return {
    from: slash + 1,
    options: COMMANDS.filter((c) => !c.available || c.available(actions)).map((c) => ({
      label: c.label,
      detail: c.hint,
      section: c.section,
      icon: c.icon,
      apply: (view, _completion, _from, to) => c.run(view, { from: slash, to }, actionsOf(view.state)),
    })),
    validFor: /^[\w ]*$/,
  };
}

async function mentionSource(context) {
  const word = context.matchBefore(/@[\w./-]*/);
  if (!word) return null;
  const prev = word.from > 0 ? context.state.sliceDoc(word.from - 1, word.from) : "";
  if (prev && !/[\s(]/.test(prev)) return null;
  const { project } = actionsOf(context.state);
  if (!project) return null;
  let entries;
  try {
    entries = (await api.listFiles(project, word.text.slice(1))).entries ?? [];
  } catch {
    return null;
  }
  if (context.aborted) return null;
  return {
    from: word.from + 1,
    filter: false,
    options: entries.slice(0, 30).map((e) => ({
      label: e.type === "directory" ? `${e.relativePath}/` : e.relativePath,
      icon: e.type === "directory" ? "folder" : "file",
    })),
  };
}

function iconOf(completion) {
  const span = document.createElement("span");
  span.className = "pg-ac__icon";
  span.innerHTML = `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${ICONS[completion.icon] ?? ""}</svg>`;
  return span;
}

export const pageCompletions = autocompletion({
  override: [slashSource, mentionSource],
  icons: false,
  tooltipClass: () => "pg-ac glass-pop",
  addToOptions: [{ render: iconOf, position: 20 }],
  aboveCursor: false,
});
