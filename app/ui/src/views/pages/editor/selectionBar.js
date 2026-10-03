import { StateField } from "@codemirror/state";
import { showTooltip } from "@codemirror/view";
import { actionsOf } from "./pageActions.js";
import { makeTasks } from "./blocks.js";

// A small glass bar over a text selection: send the passage to the chat, or
// turn the selected lines into tasks. Mouse-down on a button keeps the
// selection (preventDefault) so the action reads it.

function button(label, icon, onPress) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "pg-selbar__btn";
  b.innerHTML = `<svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">${icon}</svg><span>${label}</span>`;
  b.addEventListener("mousedown", (e) => { e.preventDefault(); onPress(); });
  return b;
}

function barFor(state) {
  const sel = state.selection.main;
  if (sel.empty || !state.sliceDoc(sel.from, sel.to).trim()) return null;
  return {
    pos: sel.from,
    above: true,
    arrow: false,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "pg-selbar glass-pop";
      const selected = () => {
        const s = view.state.selection.main;
        return view.state.sliceDoc(s.from, s.to).trim();
      };
      const actions = actionsOf(view.state);
      if (actions.onAddToChat) {
        dom.append(button("Add to chat", '<path d="M8 13V3.5M4 7.5 8 3.5l4 4"/>', () => actionsOf(view.state).onAddToChat(selected())));
      }
      dom.append(button("Make task", '<rect x="2.5" y="2.5" width="11" height="11" rx="3"/><path d="m5.5 8.2 1.8 1.8 3.3-3.6"/>', () => makeTasks(view)));
      return { dom };
    },
  };
}

export const selectionBar = StateField.define({
  create: (state) => barFor(state),
  update(bar, tr) {
    if (!tr.selection && !tr.docChanged) return bar;
    return barFor(tr.state);
  },
  provide: (f) => showTooltip.from(f),
});
