// Composition root for the panel registry: imports the six viewers and records
// each type's descriptor. Importing this module runs the registrations (import
// side-effect). PanelDock imports it so the registry is populated before it reads.
// Adding a panel type touches only this file + the type's open action — never the
// dock or the tiling engine (open/closed).

import { registerPanel } from "../../../lib/panelRegistry.js";
import { FILES_PANEL_WIDTH_FRAC, CHAT_FILES_PANEL_WIDTH_FRAC } from "./dockConfig.js";
import { FileViewer } from "../messages/FileViewer.jsx";
import { AgentViewer } from "../messages/AgentViewer.jsx";
import { DiffViewer } from "../messages/DiffViewer.jsx";
import { CommitsViewer } from "../messages/CommitsViewer.jsx";
import { GitDiffViewer } from "../gitdiff/GitDiffViewer.jsx";
import { TerminalViewer } from "../messages/TerminalViewer.jsx";
import { FilesPanel } from "../../files/FilesPanel.jsx";
import { ChatFilesPanel } from "../../chatfiles/ChatFilesPanel.jsx";
import { BrowserPanel } from "../../browser/BrowserPanel.jsx";

registerPanel({ type: "file", label: "File", Component: FileViewer, close: (ui) => ui.closeFileViewer(), minW: 260, minH: 140 });
registerPanel({ type: "agent", label: "Agent", Component: AgentViewer, close: (ui) => ui.closeAgentViewer(), minW: 240, minH: 160 });
registerPanel({ type: "diff", label: "Diff", Component: DiffViewer, close: (ui) => ui.closeDiffViewer(), minW: 300, minH: 160 });
registerPanel({ type: "commits", label: "Commits", Component: CommitsViewer, close: (ui) => ui.closeCommitsViewer(), minW: 280, minH: 140 });
registerPanel({ type: "gitdiff", label: "Git Diff", Component: GitDiffViewer, close: (ui) => ui.closeGitDiffViewer(), minW: 320, minH: 160 });
// Close/hide/evict keep the pane's PTY sessions alive (they persist and reattach
// on reopen); no dispose kill. Only a tab's × or a shell exit ends a session.
registerPanel({ type: "terminal", label: "Terminal", Component: TerminalViewer, close: (ui) => ui.closeTerminalViewer(), minW: 280, minH: 160 });
registerPanel({ type: "files", label: "Files", Component: FilesPanel, close: (ui) => ui.closeFilesViewer(), minW: 220, minH: 160, defaultFrac: FILES_PANEL_WIDTH_FRAC });
// Whole-conversation attachment list for the pane's agent — distinct from the
// "files" filesystem explorer above. Closing just drops the dock panel.
registerPanel({ type: "chatfiles", label: "Files in Chat", Component: ChatFilesPanel, close: (ui) => ui.closeChatFilesViewer(), minW: 240, minH: 160, defaultFrac: CHAT_FILES_PANEL_WIDTH_FRAC });
// Live Chrome screencast canvas. Closing/hiding stops the frame stream
// (daemon Page.stopScreencast); the tab lives in the daemon and reattaches.
registerPanel({ type: "browser", label: "Browser", Component: BrowserPanel, close: (ui) => ui.closeBrowserViewer(), minW: 320, minH: 220 });
