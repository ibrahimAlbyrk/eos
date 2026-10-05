// Composition root for the side-panel tab registry: the tabs that collapse the
// old 9 dockable viewers, plus the new-tab launcher and pages. Changes composes
// gitdiff/* (diff + commits + conflicts + stashes merged); Files nests the
// FileViewer inside. Importing this module runs the registrations (import
// side-effect); SidePanel imports it so the registry is populated before it reads.

import { registerPanel } from "../../../lib/panelRegistry.js";
import { GitDiffViewer } from "../gitdiff/GitDiffViewer.jsx";
import { FilesPanel } from "../../files/FilesPanel.jsx";
import { FileViewer } from "../messages/FileViewer.jsx";
import { TerminalViewer } from "../messages/TerminalViewer.jsx";
import { BrowserPanel } from "../../browser/BrowserPanel.jsx";
import { ChatFilesPanel } from "../../chatfiles/ChatFilesPanel.jsx";
import { SubagentsPanel } from "../subagents/SubagentsPanel.jsx";
import { NewTabPanel } from "../../newtab/NewTabPanel.jsx";
import { PagePanel } from "../../pages/PagePanel.jsx";

registerPanel({ type: "review", label: "Changes", Component: GitDiffViewer });
registerPanel({ type: "files", label: "Files", Component: FilesPanel });
registerPanel({ type: "file", label: "File", Component: FileViewer });
registerPanel({ type: "terminal", label: "Terminal", Component: TerminalViewer });
// The native page view floats over the DOM, so CSS can't hide it; its tabs and
// URLs live in browserPanelStore and survive the unmount.
registerPanel({ type: "browser", label: "Browser", Component: BrowserPanel, keepAlive: false });
registerPanel({ type: "chatfiles", label: "Chat files", Component: ChatFilesPanel });
registerPanel({ type: "subagents", label: "Subagents", Component: SubagentsPanel });
registerPanel({ type: "newtab", label: "New tab", Component: NewTabPanel });
registerPanel({ type: "page", label: "Page", Component: PagePanel });
