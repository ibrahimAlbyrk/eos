import { useMemo } from "react";
import { TabBar } from "../../../components/TabBar.jsx";
import { SettingsFooter } from "../../../components/SettingsFooter.jsx";
import { SidebarHead } from "./SidebarHead.jsx";
import { AgentsTree } from "./AgentsTree.jsx";
import { buildAgentTree } from "../../../lib/tree.js";

// Single definition of the Code view's sidebar content. "full" renders the
// panel cards; "popup" reuses the same sections inside the collapsed-hover
// popup, so anything added here shows up in both.
export function CodeSidebar({ live, variant = "full" }) {
  const tree = useMemo(() => buildAgentTree(live.workers), [live.workers]);

  const body = (
    <>
      <TabBar variant={variant} />
      <SidebarHead total={live.workers.length} variant={variant} />
      <AgentsTree roots={tree} onRename={live.renameAgent} variant={variant} />
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
