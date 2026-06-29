import { FileViewer } from "../messages/FileViewer.jsx";
import { AgentViewer } from "../messages/AgentViewer.jsx";
import { DiffViewer } from "../messages/DiffViewer.jsx";
import { CommitsViewer } from "../messages/CommitsViewer.jsx";
import { ConflictResolver } from "../messages/ConflictResolver.jsx";
import { MemoryViewer } from "../messages/MemoryViewer.jsx";

// The right-docked panel region of one pane. Renders all six viewers; each
// self-gates on ITS pane's top-of-stack via the PaneScopeContext it is rendered
// inside (resolved in useUi). Closed viewers stay MOUNTED but are zero-width and
// parked (content-visibility:hidden), so a buried panel keeps its fetched state.
export function PanePanel({ live }) {
  return (
    <>
      <FileViewer />
      <AgentViewer />
      <DiffViewer live={live} />
      <CommitsViewer />
      <ConflictResolver live={live} />
      <MemoryViewer />
    </>
  );
}
