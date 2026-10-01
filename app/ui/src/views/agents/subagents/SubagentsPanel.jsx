import { useUi } from "../../../state/ui.jsx";
import { useSubagents } from "../../../state/subagentsStore.js";
import { findLeaf } from "../../../lib/paneLayout.js";
import { PanelShell } from "../panes/PanelShell.jsx";
import { SubagentList } from "./SubagentList.jsx";
import { SubagentDetail } from "./SubagentDetail.jsx";
import { openSubagents } from "./openSubagents.js";

// Side-panel tab: this pane's agent's subagents — the list, or one subagent's
// detail when one was opened (from the list, the transcript line or the
// Environment popover). Back returns to the list.
export function SubagentsPanel({ live }) {
  const ui = useUi();
  // In a split each pane shows its own agent; the global selection only stands
  // in until the pane tree has caught up with it.
  const workerId = findLeaf(ui.tree, ui.paneId)?.agentId ?? ui.selectedId ?? null;
  const runs = useSubagents(workerId);
  const opened = ui.panelData?.subagents;
  const run = opened?.workerId === workerId ? runs.find((r) => r.toolUseId === opened.toolUseId) : null;
  const worker = live.workers.find((w) => w.id === workerId);

  return (
    <PanelShell type="subagents">
      {run ? (
        <SubagentDetail
          key={run.toolUseId}
          run={run}
          now={live.now}
          cwd={worker?.cwd}
          workers={live.workers}
          onBack={() => openSubagents(ui, workerId)}
        />
      ) : (
        <SubagentList runs={runs} now={live.now} onOpen={(id) => openSubagents(ui, workerId, id)} />
      )}
    </PanelShell>
  );
}
