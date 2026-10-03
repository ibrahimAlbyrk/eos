import { useUi } from "../../state/ui.jsx";
import { usePanelHost } from "../../state/panelHost.js";
import { sessionRootOf } from "../../lib/agentIndex.js";

// The browser session a side panel shows: the one its tab data names, else the
// selected agent's session root. A Code view pane has no agent session, so it
// uses the global (human) browser.
export function useBrowserSessionKey() {
  const ui = useUi();
  const host = usePanelHost();
  return ui.panelData?.browser?.sessionKey ?? (host ? null : sessionRootOf(ui.selectedId));
}
