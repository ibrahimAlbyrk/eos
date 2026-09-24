import { AgentsView } from "./agents/AgentsView.jsx";
import { AgentsSidebar } from "./agents/sidebar/AgentsSidebar.jsx";
import { CodeView } from "./code/CodeView.jsx";
import { CodeSidebar } from "./code/sidebar/CodeSidebar.jsx";

// Maps a view id to its workspace Component. Adding a tab = add an entry here
// (plus a descriptor in tabs.js). The Shell is the only importer, so pulling in
// the heavy Components here does not create a cycle with TabBar.
const COMPONENTS = {
  agents: AgentsView,
  code: CodeView,
};

// Maps a view id to its sidebar Component. The Shell renders this into the
// persistent collapsed-hover popup (mounted once, outside the per-view subtree)
// so the flyout survives view switches. Both accept { live, variant }.
const SIDEBARS = {
  agents: AgentsSidebar,
  code: CodeSidebar,
};

// Views that stay mounted (hidden) after their first visit. Code holds live
// xterm instances; unmounting them meant rebuilding and replaying every
// terminal on each return, which showed as a black screen.
const KEEP_MOUNTED = new Set(["code"]);

export function keepsMounted(id) {
  return KEEP_MOUNTED.has(id);
}

export function getViewComponent(id) {
  return COMPONENTS[id] ?? AgentsView;
}

export function getViewSidebar(id) {
  return SIDEBARS[id] ?? AgentsSidebar;
}
