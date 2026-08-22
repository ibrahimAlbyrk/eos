import { useEffect, useMemo, useSyncExternalStore } from "react";
import { TabBar } from "../../../components/TabBar.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { SidebarHead } from "./SidebarHead.jsx";
import { AgentsTree } from "./AgentsTree.jsx";
import { buildAgentTree } from "../../../lib/tree.js";
import { archivedTree } from "../../../lib/archive.js";
import { useSidebarPrefs } from "../../../state/sidebarPrefsStore.js";
import { subscribe, getArchive, refreshArchived } from "../../../state/archiveStore.js";

// Single definition of the Code view's sidebar content. "full" renders the
// panel cards; "popup" reuses the same sections inside the collapsed-hover popup.
//
// One UNIFIED list: live and archived agents are both normalized to tagged
// worker-row roots (__archived) and flow through the SAME grouping + sorting
// pipeline (AgentsTree), so an archived row can sit interleaved with active rows
// under a shared Folder/Date/Custom bucket. The Status filter just picks which
// subset feeds the pipeline: Active → live roots, Archived → archived roots, All
// → both. Each root is dispatched to its renderer (TreeNode / ArchiveNode) by the
// tag; selection/kind routing stays per-renderer. archiveStore remains the source
// of truth for archived rows/selection.
export function CodeSidebar({ live, variant = "full" }) {
  const { status } = useSidebarPrefs();
  const { rows: archivedRows, loaded: archivedLoaded, selectedId: archivedSelectedId } =
    useSyncExternalStore(subscribe, getArchive);

  const showActive = status !== "archived";
  const showArchived = status !== "active";

  const activeRoots = useMemo(
    () => buildAgentTree(live.workers).map((r) => ({ ...r, __archived: false })),
    [live.workers],
  );
  const archivedRoots = useMemo(
    () => archivedTree(archivedRows).map((r) => ({ ...r, __archived: true })),
    [archivedRows],
  );
  const roots = useMemo(() => {
    if (status === "active") return activeRoots;
    if (status === "archived") return archivedRoots;
    return [...activeRoots, ...archivedRoots];
  }, [status, activeRoots, archivedRoots]);

  // Empty-state gating + label reflect what's actually being shown.
  const loaded = showActive && showArchived ? (live.loaded && archivedLoaded)
    : showArchived ? archivedLoaded : live.loaded;
  const emptyLabel = status === "archived" ? "No archived agents — Cmd+W archives the selected one" : undefined;

  // Archived rows now render in the sidebar without the main ArchiveView mounted,
  // so fetch them here whenever they're shown — mount + each SSE change ping.
  useEffect(() => {
    if (showArchived) refreshArchived();
  }, [showArchived, live.eventSignal.tick]);

  const body = (
    <>
      <TabBar variant={variant} />
      <SidebarHead total={live.workers.length} variant={variant} />
      <AgentsTree
        roots={roots}
        loaded={loaded}
        onRename={live.renameAgent}
        variant={variant}
        archivedSelectedId={archivedSelectedId}
        emptyLabel={emptyLabel}
      />
      <SettingsFooter />
    </>
  );

  if (variant === "popup") return body;

  return (
    <>
      <div className="side-island side-island--agents">{body}</div>

      <div className="side-island side-island--status">
        <span className="lab">Daemon</span>
        <span className="val">
          <span className="status-dot" style={!live.health ? { background: "var(--err)" } : {}}></span>
          {live.health ? "online" : "offline"}
        </span>
      </div>
    </>
  );
}
