import { isMod } from "../../../keymap/index.js";

// J, K and Enter move through Needs you while no text field has the keyboard.

function inTextField(e) {
  const t = e.target;
  return Boolean(t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)));
}

// A plain key: no modifier, outside a text field.
export function plainKey(key) {
  return (e) => e.key?.toLowerCase() === key && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey && !inTextField(e);
}

// ⌘↵: the screen's primary action.
export const primaryKey = (e) => isMod(e) && e.key === "Enter";
