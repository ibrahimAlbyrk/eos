import { useUi } from "../../state/ui.jsx";
import { usePanelHost } from "../../state/panelHost.js";
import { projectPathFor } from "../../lib/breadcrumb.js";
import { sessionRootOf } from "../../lib/agentIndex.js";

// What a side panel's pages belong to: the pane's project folder and, beside an
// agent, that chat (its session root) — the defaults for a new page and the
// launcher's page list. A Code view pane has its folder and no chat.
export function usePageScope(live) {
  const ui = useUi();
  const host = usePanelHost();
  if (host) return { project: host.cwd ?? null, agentId: null, workerId: null };
  const workerId = ui.selectedId ?? null;
  return {
    project: projectPathFor(live?.workers ?? [], workerId),
    agentId: workerId ? sessionRootOf(workerId) : null,
    workerId,
  };
}
