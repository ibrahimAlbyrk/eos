import { createPortal } from "react-dom";
import { useUi } from "../../../../state/ui.jsx";
import { useEditors } from "../../../../state/editorsStore.js";
import { hasLocalScreen } from "../../../../lib/host.js";
import { locationLabel } from "../../../../lib/pathLinks.js";
import { transferMode } from "../../../../lib/transferClient.js";
import { useMachines } from "../../../transfer/useMachines.js";
import { MenuList } from "../../popovers/MenuList.jsx";
import {
  attachAsContext, copyText, openInEditor, openInPanel, openWithDefaultApp, revealInFinder, sendToMac,
} from "./pathActions.js";

export const PATH_MENU = "path-ctx";

const ROW_H = 32;

// Drops separators that would open, close or double up the menu once
// unavailable items are filtered out.
function tidy(items) {
  const out = [];
  for (const it of items) {
    if (!it) continue;
    if (it === "sep" && (out.length === 0 || out[out.length - 1] === "sep")) continue;
    out.push(it);
  }
  while (out[out.length - 1] === "sep") out.pop();
  return out;
}

// Right-click menu for a path in the chat (usePathLinks opens it). popoverData
// carries { owner, ref }: every transcript in a pane mounts one, and only the
// one whose path was clicked shows. Items that drive this Mac's screen (an
// editor, Finder) or its other Macs only show where they can work.
export function PathContextMenu({ owner, cwd }) {
  const ui = useUi();
  const editors = useEditors();
  const machines = useMachines();
  if (ui.openPopover !== PATH_MENU || ui.popoverData?.owner !== owner) return null;
  const ref = ui.popoverData.ref;
  if (!ref?.path) return null;

  const local = hasLocalScreen();
  const isDir = ref.type === "directory";
  const loc = locationLabel(ref).replace("–", "-");
  const rel = cwd && ref.path.startsWith(cwd + "/") ? ref.path.slice(cwd.length + 1) : null;
  const peers = transferMode() === "local" ? machines.peers : [];

  const items = tidy([
    { id: "open", label: isDir ? "Open in Files" : "Open", run: () => openInPanel(ui, ref) },
    local && editors.length > 0 && {
      id: "open-in",
      label: "Open in",
      submenu: [
        ...editors.map((ed) => ({ id: ed.id, label: ed.name, run: () => openInEditor(ref, ed) })),
        { id: "default-app", label: "Default app", run: () => openWithDefaultApp(ref) },
      ],
    },
    local && editors.length === 0 && { id: "default-app", label: "Open with default app", run: () => openWithDefaultApp(ref) },
    local && { id: "reveal", label: "Reveal in Finder", run: () => revealInFinder(ref) },
    "sep",
    { id: "copy", label: "Copy path", run: () => copyText(ref.path) },
    loc && { id: "copy-loc", label: `Copy path${loc}`, run: () => copyText(ref.path + loc) },
    rel && { id: "copy-rel", label: "Copy relative path", run: () => copyText(rel + loc) },
    "sep",
    { id: "attach", label: "Attach as context", run: () => attachAsContext(ui, ref) },
    peers.length > 0 && {
      id: "send",
      label: "Send to",
      submenu: peers.map((p) => ({ id: p.ref, label: p.label, run: () => sendToMac(ui, ref, p) })),
    },
  ]);

  const rows = items.filter((it) => it !== "sep").length;
  const left = Math.min(ui.popoverPos.x, window.innerWidth - 220);
  const top = Math.min(ui.popoverPos.y, window.innerHeight - rows * ROW_H - 24);

  return createPortal(
    <div className="head-menu" data-popover={PATH_MENU} style={{ left, top }}>
      <MenuList items={items} onClose={ui.closeAllPops} />
    </div>,
    document.body,
  );
}
