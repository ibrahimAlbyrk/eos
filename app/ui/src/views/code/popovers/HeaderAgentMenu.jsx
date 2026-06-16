import { useUi } from "../../../state/ui.jsx";
import { useDeleteAgent } from "../../../hooks/useDeleteAgent.js";
import { api } from "../../../api/client.js";
import { MenuList } from "./MenuList.jsx";

// Breadcrumb chevron dropdown — acts on the currently selected agent.
export function HeaderAgentMenu({ live, onRename }) {
  const ui = useUi();
  const deleteAgent = useDeleteAgent(live);
  if (ui.openPopover !== "head-menu") return null;
  const agent = live.workers.find((w) => w.id === ui.selectedId);
  if (!agent) return null;

  const openIn = (target) => {
    api.openWorkerIn(agent.id, target).then((r) => {
      if (!r?.ok) {
        // eslint-disable-next-line no-console
        console.error("open-in failed:", r?.body?.error ?? `status ${r?.status ?? "?"}`);
      }
    });
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
    { id: "delete", label: "Delete", kbd: "D", danger: true, run: () => deleteAgent(agent.id) },
  ];

  return (
    <div className="head-menu" data-popover="head-menu">
      <MenuList items={items} onClose={ui.closeAllPops} />
    </div>
  );
}
