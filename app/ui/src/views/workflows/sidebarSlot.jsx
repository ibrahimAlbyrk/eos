// The Workflows left-sidebar slot (under the Editor/Library/Runs switcher). The
// active tab portals its palette/list here so the left panel is populated per-tab
// and the main area shows only the canvas/detail. Kept in its own module so the
// views and WorkflowsView can both import it without a cycle.
import { createContext, useContext } from "react";
import { createPortal } from "react-dom";

export const WorkflowSidebarSlotContext = createContext(null);

export function WorkflowSidebarPortal({ children }) {
  const el = useContext(WorkflowSidebarSlotContext);
  return el ? createPortal(children, el) : null;
}
