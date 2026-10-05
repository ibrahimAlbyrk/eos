import { memo, useState } from "react";
import { SidePanelVisibleContext } from "../../../state/paneScope.js";
import { getPanel } from "../../../lib/panelRegistry.js";
import { mountedTabs, tabType } from "../../../lib/panelTabs.js";

// The side panel's tab contents. A tab stays mounted from the first time it's
// shown until its pill closes — hidden while another tab is shown — so it keeps
// what the user left in it (scope, scroll, expanded rows, a typed filter).
// A panel registered keepAlive:false mounts only while shown. `shown` = the side
// panel itself is on screen.

// Off screen, a tab skips the parent's re-renders (live updates) until shown again.
const TabContent = memo(
  function TabContent({ Component, offScreen: _offScreen, ...props }) {
    return <Component {...props} />;
  },
  (_prev, next) => next.offScreen,
);

export function SidePanelTabs({ openTabs, activeTab, shown, live, tools }) {
  const [seen, setSeen] = useState(() => new Set());
  const mounted = mountedTabs(seen, openTabs, activeTab, shown);
  if (mounted.length !== seen.size || mounted.some((t) => !seen.has(t))) setSeen(new Set(mounted));

  return mounted.map((id) => {
    const panel = getPanel(tabType(id));
    const onScreen = shown && id === activeTab;
    if (!panel || (!onScreen && panel.keepAlive === false)) return null;
    return (
      <div key={id} className="sp-tab-body" hidden={id !== activeTab}>
        <SidePanelVisibleContext.Provider value={onScreen}>
          <TabContent Component={panel.Component} offScreen={!onScreen} live={live} tabId={id} tools={tools} />
        </SidePanelVisibleContext.Provider>
      </div>
    );
  });
}
