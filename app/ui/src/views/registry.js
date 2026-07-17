import { CodeView } from "./code/CodeView.jsx";
import { WorkflowsView, WorkflowsSidebar } from "./workflows/WorkflowsView.jsx";
import { CodeSidebar } from "./code/sidebar/CodeSidebar.jsx";

// Maps a view id to its workspace Component. Adding a tab = add an entry here
// (plus a descriptor in tabs.js). The Shell is the only importer, so pulling in
// the heavy Components here does not create a cycle with TabBar.
const COMPONENTS = {
  code: CodeView,
  workflows: WorkflowsView,
};

// Maps a view id to its sidebar Component. The Shell renders this into the
// persistent collapsed-hover popup (mounted once, outside the per-view subtree)
// so the flyout survives view switches. Both accept { live, variant };
// WorkflowsSidebar ignores live.
const SIDEBARS = {
  code: CodeSidebar,
  workflows: WorkflowsSidebar,
};

export function getViewComponent(id) {
  return COMPONENTS[id] ?? CodeView;
}

export function getViewSidebar(id) {
  return SIDEBARS[id] ?? CodeSidebar;
}
