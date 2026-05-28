import { CodeView } from "./code/CodeView.jsx";
import { WorkflowsView } from "./workflows/WorkflowsView.jsx";

// Maps a view id to its workspace Component. Adding a tab = add an entry here
// (plus a descriptor in tabs.js). The Shell is the only importer, so pulling in
// the heavy Components here does not create a cycle with TabBar.
const COMPONENTS = {
  code: CodeView,
  workflows: WorkflowsView,
};

export function getViewComponent(id) {
  return COMPONENTS[id] ?? CodeView;
}
