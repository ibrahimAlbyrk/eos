import { ViewPlugin } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { registerUndoTarget } from "./undoRouter.js";

// ⌘Z/⇧⌘Z come through the app menu, never as keys CodeMirror's keymap sees —
// route them to this editor's history while it has focus.
export const menuUndo = ViewPlugin.define((view) => ({
  destroy: registerUndoTarget({
    hasFocus: () => view.hasFocus,
    undo: () => undo(view),
    redo: () => redo(view),
  }),
}));
