import { useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useArchiveAgent, useKillAgent } from "../../../hooks/useArchiveAgent.js";
import { BranchConfirmDialog } from "./BranchConfirmDialog.jsx";
import { subtreeIds } from "../../../lib/tree.js";
import { nameOf } from "../../../lib/agentName.js";
import { permanentDeleteMessage } from "../../../lib/archive.js";
import { api } from "../../../api/client.js";
import { MenuList } from "./MenuList.jsx";

// Breadcrumb chevron dropdown — acts on the currently selected agent.
export function HeaderAgentMenu({ live, onRename }) {
  const ui = useUi();
  const archiveAgent = useArchiveAgent(live);
  const killAgent = useKillAgent(live);
  // Survives the menu closing on item click (MenuList runs onClose after run).
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const agent = live.workers.find((w) => w.id === ui.selectedId);
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

  const confirmKill = async () => {
    if (busy) return;
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
    "sep",
    // kbd "⌘W" is display-only (MenuList's single-keypress match never fires
    // on a multi-char kbd) — it advertises the real hotkey, not a menu key.
    { id: "archive", label: "Archive", kbd: "⌘W", run: () => archiveAgent(agent.id) },
    { id: "delete", label: "Delete", danger: true, run: () => setConfirming(true) },
  ];

  return (
    <>
      {open && (
        <div className="head-menu" data-popover="head-menu">
          <MenuList items={items} onClose={ui.closeAllPops} />
        </div>
      )}
      {confirming && (
        <BranchConfirmDialog
          message={permanentDeleteMessage(nameOf(agent), subtreeIds(live.workers, agent.id).length)}
          confirmLabel="Delete permanently"
          danger
          busy={busy}
          onConfirm={confirmKill}
          onCancel={() => { if (!busy) setConfirming(false); }}
        />
      )}
    </>
  );
}
