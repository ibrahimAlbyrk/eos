import { FileViewer } from "../messages/FileViewer.jsx";
import { AgentViewer } from "../messages/AgentViewer.jsx";
import { DiffViewer } from "../messages/DiffViewer.jsx";
import { CommitsViewer } from "../messages/CommitsViewer.jsx";
import { ConflictResolver } from "../messages/ConflictResolver.jsx";
import { MemoryViewer } from "../messages/MemoryViewer.jsx";
import { TerminalViewer } from "../messages/TerminalViewer.jsx";

// The docked panel's contents: all six viewers, mounted once and overlaid inside
// the panel slot (only the open one is visible). Rendered OUTSIDE any
// PaneScopeContext so each self-gates on the FOCUSED pane's top-of-stack (see
// useUi) — the slot itself is anchored beside that pane by PaneGrid/SinglePane.
export function PaneViewers({ live }) {
  return (
    <>
      <FileViewer />
      <AgentViewer />
      <DiffViewer live={live} />
      <CommitsViewer />
      <ConflictResolver live={live} />
      <MemoryViewer />
      <TerminalViewer live={live} />
    </>
  );
}
