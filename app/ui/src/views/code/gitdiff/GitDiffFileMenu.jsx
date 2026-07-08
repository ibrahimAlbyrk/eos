import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { notify } from "../../../lib/notify.js";
import { MenuList } from "../popovers/MenuList.jsx";

// Right-click menu shared by the file-tree rows and the diff-card headers:
// Copy path + an "Open in →" flyout (VS Code / Finder). Uses the shared popover
// plumbing (ui.openPop + data-popover) so the global mousedown/Escape handlers
// dismiss it for free. Portal'd to <body> because the panel lives inside a
// contain:paint pane, which would otherwise clip a position:fixed menu
// (HeaderAgentMenu idiom). popoverData carries { cwd, path } (path is
// repo-relative); the copied/opened path is the absolute join.
export function GitDiffFileMenu() {
  const ui = useUi();
  if (ui.openPopover !== "gitdiff-file-ctx") return null;
  const { cwd, path } = ui.popoverData ?? {};
  if (!cwd || !path) return null;
  const abs = cwd + "/" + path;

  const copyPath = async () => {
    await navigator.clipboard?.writeText(abs);
    notify.info("Path copied");
  };
  const openIn = async (target) => {
    const r = await api.openPathIn(abs, target);
    if (!r.ok) notify.error(r.body?.error ?? "Open failed");
  };

  const items = [
    { id: "copy", label: "Copy path", run: copyPath },
    {
      id: "open-in",
      label: "Open in",
      submenu: [
        { id: "vscode", label: "VS Code", kbd: "1", run: () => openIn("vscode") },
        { id: "finder", label: "Finder", kbd: "2", run: () => openIn("finder") },
      ],
    },
  ];

  const left = Math.min(ui.popoverPos.x, window.innerWidth - 220);
  const top = Math.min(ui.popoverPos.y, window.innerHeight - 96);

  return createPortal(
    <div className="head-menu" data-popover="gitdiff-file-ctx" style={{ left, top }}>
      <MenuList items={items} onClose={ui.closeAllPops} />
    </div>,
    document.body,
  );
}
