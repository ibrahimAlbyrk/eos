import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { SidebarHead } from "./SidebarHead.jsx";
import { AgentsTree } from "./AgentsTree.jsx";
import { LayoutGroups } from "./LayoutGroups.jsx";
import { buildAgentTree } from "../../../lib/tree.js";
import { archivedTree } from "../../../lib/archive.js";
import { useSidebarPrefs } from "../../../state/sidebarPrefsStore.js";
import { subscribe, getArchive, refreshArchived } from "../../../state/archiveStore.js";

// The dynamic section label mirrors the grouping (Projects / Recent / Groups),
// or "Archived" when the archived-only list is showing.
function FilterIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2.5 4h11M4.5 8h7M6.5 12h3" />
    </svg>
  );
}

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
  const ui = useUi();
  const { status, groupBy } = useSidebarPrefs();
  const { rows: archivedRows, loaded: archivedLoaded, selectedId: archivedSelectedId, archiveMode } =
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

  // Live agent ids — layout restore keeps a dead agent's leaf empty (not stripped),
  // and the dirty indicator treats such an empty pane as non-divergent.
  const aliveIds = useMemo(() => new Set(live.workers.map((w) => w.id)), [live.workers]);

  // Empty-state gating + label reflect what's actually being shown.
  const loaded = showActive && showArchived ? (live.loaded && archivedLoaded)
    : showArchived ? archivedLoaded : live.loaded;
  const emptyLabel = status === "archived" ? "No archived agents — Cmd+W archives the selected one" : undefined;

  // Archived rows now render in the sidebar without the main ArchiveView mounted,
  // so fetch them here whenever they're shown — mount + each SSE change ping.
  useEffect(() => {
    if (showArchived) refreshArchived();
  }, [showArchived, live.eventSignal.tick]);

  const sectionLabel = status === "archived"
    ? "Archived"
    : groupBy === "date" ? "Recent" : groupBy === "custom" ? "Groups" : "Projects";

  const handlePrefs = (e) => {
    e.stopPropagation();
    if (ui.openPopover === "sidebar-prefs") { ui.closeAllPops(); return; }
    ui.openPop("sidebar-prefs", { x: e.clientX, y: e.clientY });
  };

  const body = (
    <>
      <SidebarHead live={live} variant={variant} archiveMode={archiveMode} />
      <LayoutGroups aliveIds={aliveIds} />
      {roots.length > 0 && (
        <div className="sb-seclabel">
          <span className="sb-seclabel__text">{sectionLabel}</span>
          <button
            className={"sb-seclabel__filter" + (ui.openPopover === "sidebar-prefs" ? " on" : "")}
            title="View options"
            data-popover-trigger="sidebar-prefs"
            onClick={handlePrefs}
          >
            <FilterIcon />
          </button>
        </div>
      )}
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

  return <div className="side-island side-island--agents">{body}</div>;
}
