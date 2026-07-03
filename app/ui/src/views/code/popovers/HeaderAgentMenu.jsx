import { useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useSettings } from "../../../state/settings.jsx";
import { useArchiveAgent, useKillAgent } from "../../../hooks/useArchiveAgent.js";
import { DeleteConfirmDialog } from "./DeleteConfirmDialog.jsx";
import { subtreeIds } from "../../../lib/tree.js";
import { nameOf } from "../../../lib/agentName.js";
import { permanentDeleteMessage } from "../../../lib/archive.js";
import { DELETE_CONFIRM_KEY, shouldConfirmDelete } from "../../../lib/deleteConfirm.js";
import { api } from "../../../api/client.js";
import { MenuList } from "./MenuList.jsx";

// Breadcrumb chevron dropdown — acts on the pane's agent (passed in by the
// PaneHeader that owns it), scoped to that pane's popover state.
export function HeaderAgentMenu({ live, agent, onRename }) {
  const ui = useUi();
  const { settings, setSetting } = useSettings();
  const archiveAgent = useArchiveAgent(live);
  const killAgent = useKillAgent(live);
  // Survives the menu closing on item click (MenuList runs onClose after run).
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = ui.openPopover === "head-menu";
  if (!agent || (!open && !confirming)) return null;

  const openIn = (target) => {
    api.openWorkerIn(agent.id, target).then((r) => {
      if (!r?.ok) {
        // eslint-disable-next-line no-console
        console.error("open-in failed:", r?.body?.error ?? `status ${r?.status ?? "?"}`);
      }
    });
  };

  const confirmKill = async (dontAskAgain) => {
    if (busy) return;
    if (dontAskAgain) setSetting(DELETE_CONFIRM_KEY, false);
    setBusy(true);
    await killAgent(agent.id);
    setBusy(false);
    setConfirming(false);
  };

  const items = [
    {
      id: "open-in",
      label: "Open in",
      submenu: [
        { id: "vscode", label: "VS Code", kbd: "1", run: () => openIn("vscode") },
        { id: "finder", label: "Finder", kbd: "2", run: () => openIn("finder") },
      ],
    },
    "sep",
    { id: "rename", label: "Rename", kbd: "R", run: () => onRename(agent.id) },
    // Same download path as the /export slash command: tree export for orchestrators.
    { id: "export", label: "Export", kbd: "E", run: () => api.exportWorker(agent.id, { tree: !!agent.is_orchestrator }) },
    "sep",
    // kbd "⌘W" is display-only (MenuList's single-keypress match never fires
    // on a multi-char kbd) — it advertises the real hotkey, not a menu key.
    { id: "archive", label: "Archive", kbd: "⌘W", run: () => archiveAgent(agent.id) },
    // "Don't ask again" suppresses the confirm — kill directly.
    { id: "delete", label: "Delete", danger: true, run: () => (shouldConfirmDelete(settings) ? setConfirming(true) : killAgent(agent.id)) },
  ];

  return (
    <>
      {open && (
        <div className="head-menu" data-popover="head-menu">
          <MenuList items={items} onClose={ui.closeAllPops} />
        </div>
      )}
      {confirming && (
        <DeleteConfirmDialog
          message={permanentDeleteMessage(nameOf(agent), subtreeIds(live.workers, agent.id).length)}
          busy={busy}
          onConfirm={confirmKill}
          onCancel={() => { if (!busy) setConfirming(false); }}
        />
      )}
    </>
  );
}
