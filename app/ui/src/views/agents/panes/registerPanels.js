// Composition root for the built-in side-panel tabs: the tabs that collapse the
// old 9 dockable viewers, plus the new-tab launcher and pages. Changes composes
// gitdiff/* (diff + commits + conflicts + stashes merged); Files nests the
// FileViewer inside. Importing this module runs the registrations (import
// side-effect); SidePanel imports it so the registry is populated before it reads.

import { registerPanel } from "../../../lib/panelRegistry.js";
import { shortcutLabel } from "../../../lib/platform.js";
import { useFeature } from "../../../state/featuresStore.js";
import { useArtifactCatalog } from "../../../state/artifactCatalogStore.js";
import { TAB_ICONS } from "./panelTabMeta.jsx";
import { usePageTitle, useViewTitle, useWorkflowTitle, useArtifactTitle } from "./tabTitles.js";
import {
  TerminalMeta, FilesMeta, PageMeta, ChatFilesMeta, DiffMeta, SubagentMeta, TransferMeta, ArtifactsMeta,
} from "../../newtab/toolMetas.jsx";
import { GitDiffViewer } from "../gitdiff/GitDiffViewer.jsx";
import { FilesPanel } from "../../files/FilesPanel.jsx";
import { FileViewer } from "../messages/FileViewer.jsx";
import { TerminalViewer } from "../messages/TerminalViewer.jsx";
import { BrowserPanel } from "../../browser/BrowserPanel.jsx";
import { ChatFilesPanel } from "../../chatfiles/ChatFilesPanel.jsx";
import { SubagentsPanel } from "../subagents/SubagentsPanel.jsx";
import { NewTabPanel } from "../../newtab/NewTabPanel.jsx";
import { PagePanel } from "../../pages/PagePanel.jsx";
import { TransferPanel } from "../../transfer/TransferPanel.jsx";
import { ViewPanel } from "../../../genui/panel/ViewPanel.jsx";
import { WorkflowPanel } from "../workflow/WorkflowPanel.jsx";
import { JobsPanel } from "../../jobs/JobsPanel.jsx";
import { SideQuestionPanel } from "../../btw/SideQuestionPanel.jsx";
import { ArtifactPanel } from "../../artifacts/ArtifactPanel.jsx";
import { ArtifactsPanel } from "../../artifacts/ArtifactsPanel.jsx";

const AGENT = ["agent"];
const BOTH = ["agent", "code"];
// Transfer moves files between paired computers — not where this one can't pair.
const useRemote = () => useFeature("remote");
// The artifact list is this Mac's own — not in a view of another computer.
const useArtifactsAvailable = () => useArtifactCatalog({ load: false }).available;

const panel = (type, label, rest) => registerPanel({ type, label, icon: TAB_ICONS[type], ...rest });

panel("review", "Changes", { Component: GitDiffViewer, launcher: { order: 10, in: AGENT, Meta: DiffMeta } });
panel("files", "Files", { Component: FilesPanel, kbd: shortcutLabel("mod+p"), launcher: { order: 30, in: BOTH, Meta: FilesMeta } });
panel("file", "File", { Component: FileViewer });
panel("terminal", "Terminal", { Component: TerminalViewer, kbd: shortcutLabel("ctrl+`"), launcher: { order: 20, in: BOTH, Meta: TerminalMeta } });
// The native page view floats over the DOM, so CSS can't hide it; its tabs and
// URLs live in browserPanelStore and survive the unmount.
panel("browser", "Browser", { Component: BrowserPanel, keepAlive: false });
panel("chatfiles", "Chat files", { Component: ChatFilesPanel, launcher: { order: 50, in: AGENT, Meta: ChatFilesMeta } });
panel("subagents", "Subagents", { Component: SubagentsPanel, launcher: { order: 60, in: AGENT, Meta: SubagentMeta } });
panel("newtab", "New tab", { Component: NewTabPanel });
panel("page", "Page", { Component: PagePanel, useTitle: usePageTitle, launcher: { order: 40, in: BOTH, label: "New page", Meta: PageMeta } });
panel("transfer", "Transfer", { Component: TransferPanel, launcher: { order: 80, in: BOTH, Meta: TransferMeta, useAvailable: useRemote } });
// Every background job (the header beacon opens it on one).
panel("jobs", "Jobs", { Component: JobsPanel, launcher: { order: 90, in: AGENT } });
// The /btw side question for this pane's agent (⌘/ or /btw in the composer).
panel("btw", "/btw", { Component: SideQuestionPanel, kbd: shortcutLabel("mod+/"), launcher: { order: 100, in: AGENT } });
// A visual answer opened from the transcript (view:<id>).
panel("view", "View", { Component: ViewPanel, useTitle: useViewTitle });
// A Workflow run's live view, opened from its card (workflow:<workerId>/<callId>).
panel("workflow", "Workflow", { Component: WorkflowPanel, useTitle: useWorkflowTitle });
// A claude.ai artifact (artifact:<slug>). Kept mounted while hidden, unlike the
// browser: its native view is shown and hidden through the bridge (setVisible),
// and staying mounted keeps it attached for an instant switch back.
panel("artifact", "Artifact", { Component: ArtifactPanel, useTitle: useArtifactTitle });
// Every artifact of every Claude sign-in.
panel("artifacts", "Artifacts", { Component: ArtifactsPanel, launcher: { order: 70, in: AGENT, Meta: ArtifactsMeta, useAvailable: useArtifactsAvailable } });
