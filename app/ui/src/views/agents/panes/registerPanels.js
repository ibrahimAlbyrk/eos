// Composition root for the side-panel tab registry: the five tabs that collapse
// the old 9 dockable viewers. Review composes gitdiff/* (diff + commits +
// conflicts + stashes merged); Files nests the FileViewer inside. Importing this
// module runs the registrations (import side-effect); SidePanel imports it so the
// registry is populated before it reads.

import { registerPanel } from "../../../lib/panelRegistry.js";
import { GitDiffViewer } from "../gitdiff/GitDiffViewer.jsx";
import { FilesPanel } from "../../files/FilesPanel.jsx";
import { FileViewer } from "../messages/FileViewer.jsx";
import { TerminalViewer } from "../messages/TerminalViewer.jsx";
import { BrowserPanel } from "../../browser/BrowserPanel.jsx";
import { ChatFilesPanel } from "../../chatfiles/ChatFilesPanel.jsx";

registerPanel({ type: "review", label: "Review", Component: GitDiffViewer });
registerPanel({ type: "files", label: "Files", Component: FilesPanel });
registerPanel({ type: "file", label: "File", Component: FileViewer });
registerPanel({ type: "terminal", label: "Terminal", Component: TerminalViewer });
registerPanel({ type: "browser", label: "Browser", Component: BrowserPanel });
registerPanel({ type: "chatfiles", label: "Chat files", Component: ChatFilesPanel });
