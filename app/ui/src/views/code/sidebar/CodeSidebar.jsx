import { useMemo, useSyncExternalStore } from "react";
import { TabBar } from "../../../components/TabBar.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { SidebarHead } from "./SidebarHead.jsx";
import { AgentsTree } from "./AgentsTree.jsx";
import { ScheduledList } from "./ScheduledList.jsx";
import { ArchiveSidebar } from "../../archive/ArchiveSidebar.jsx";
import { ArchiveToggle } from "../../archive/ArchiveToggle.jsx";
import { buildAgentTree } from "../../../lib/tree.js";
import { subscribe, getArchive } from "../../../state/archiveStore.js";

// Single definition of the Code view's sidebar content. "full" renders the
// panel cards; "popup" reuses the same sections inside the collapsed-hover
// popup, so anything added here shows up in both. Archive mode (the toggle
// above the Settings footer) swaps the agent tree for the archived list; the
// tree's own state is untouched, so toggling back restores it as-is.
export function CodeSidebar({ live, variant = "full" }) {
  const { archiveMode } = useSyncExternalStore(subscribe, getArchive);
  const tree = useMemo(() => buildAgentTree(live.workers), [live.workers]);

  const body = (
    <>
      <TabBar variant={variant} />
      {archiveMode ? (
        <ArchiveSidebar />
      ) : (
        <>
          <SidebarHead total={live.workers.length} variant={variant} />
          <AgentsTree roots={tree} loaded={live.loaded} onRename={live.renameAgent} variant={variant} />
        </>
      )}
      <ArchiveToggle />
      <SettingsFooter />
    </>
  );

  if (variant === "popup") return body;

  return (
    <>
      <div className="side-island side-island--agents">{body}</div>

      {!archiveMode && <ScheduledList />}

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
