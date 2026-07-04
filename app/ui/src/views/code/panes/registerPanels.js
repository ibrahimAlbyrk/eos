// Composition root for the panel registry: imports the seven viewers and records
// each type's descriptor. Importing this module runs the registrations (import
// side-effect). PanelDock imports it so the registry is populated before it reads.
// Adding a panel type touches only this file + the type's open action — never the
// dock or the tiling engine (open/closed).

import { registerPanel } from "../../../lib/panelRegistry.js";
import { killPaneSessions } from "../../../state/ptyPanelStore.js";
import { FileViewer } from "../messages/FileViewer.jsx";
import { AgentViewer } from "../messages/AgentViewer.jsx";
import { DiffViewer } from "../messages/DiffViewer.jsx";
import { CommitsViewer } from "../messages/CommitsViewer.jsx";
import { ConflictResolver } from "../messages/ConflictResolver.jsx";
import { TerminalViewer } from "../messages/TerminalViewer.jsx";

registerPanel({ type: "file", label: "File", Component: FileViewer, close: (ui) => ui.closeFileViewer(), minW: 260, minH: 140 });
registerPanel({ type: "agent", label: "Agent", Component: AgentViewer, close: (ui) => ui.closeAgentViewer(), minW: 240, minH: 160 });
registerPanel({ type: "diff", label: "Diff", Component: DiffViewer, close: (ui) => ui.closeDiffViewer(), minW: 300, minH: 160 });
registerPanel({ type: "commits", label: "Commits", Component: CommitsViewer, close: (ui) => ui.closeCommitsViewer(), minW: 280, minH: 140 });
registerPanel({ type: "conflict", label: "Conflicts", Component: ConflictResolver, close: (ui) => ui.closeConflictResolver(), minW: 300, minH: 160 });
// dispose runs when a terminal panel leaves the dock via EVICTION (not the ×,
// which routes through close): kill the evicted pane's sessions only.
registerPanel({ type: "terminal", label: "Terminal", Component: TerminalViewer, close: (ui) => { killPaneSessions(ui.paneId); ui.closeTerminalViewer(); }, dispose: killPaneSessions, minW: 280, minH: 160 });
