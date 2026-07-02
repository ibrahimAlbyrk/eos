import { useState, useSyncExternalStore } from "react";
import { useUi } from "../../state/ui.jsx";
import { BranchConfirmDialog } from "../code/popovers/BranchConfirmDialog.jsx";
import { subscribe, getArchive, refreshArchived } from "../../state/archiveStore.js";
import { subtreeIds } from "../../lib/tree.js";
import { nameOf } from "../../lib/agentName.js";
import { permanentDeleteMessage } from "../../lib/archive.js";

// Right-click menu for an archived sidebar row: Restore (no confirm — it only
// clears the archived flag) and Delete permanently (confirm-gated — the full
// kill cascade). The confirm dialog is held OUTSIDE the popover-open gate so
// it survives the menu closing on click. Both actions end in refreshArchived,
// which drops a vanished selection (the row's restore/purge fallback).
export function ArchiveContextMenu({ live }) {
  const ui = useUi();
  const { rows } = useSyncExternalStore(subscribe, getArchive);
  const [confirmId, setConfirmId] = useState(null);
  const [busy, setBusy] = useState(false);

  const open = ui.openPopover === "archive-ctx";
  const doomed = confirmId ? rows.find((w) => w.id === confirmId) ?? null : null;
  if (!open && !doomed) return null;

  const runRestore = async (id) => {
    ui.closeAllPops();
    const r = await live.restoreAgent(id);
    if (!r?.ok) {
      // eslint-disable-next-line no-console
      console.error("restore failed:", r?.body?.error ?? `status ${r?.status ?? "?"}`);
    }
    await refreshArchived();
  };

  const runPurge = async () => {
    if (!doomed || busy) return;
    setBusy(true);
    const r = await live.purgeAgent(doomed.id);
    if (!r?.ok) {
      // eslint-disable-next-line no-console
      console.error("delete failed:", r?.body?.error ?? `status ${r?.status ?? "?"}`);
    }
    await refreshArchived();
    setBusy(false);
    setConfirmId(null);
  };

  let menu = null;
  if (open) {
    const { x, y } = ui.popoverPos;
    const { agentId } = ui.popoverData;
    const left = Math.min(x, window.innerWidth - 220);
    const top = Math.min(y, window.innerHeight - 110);
    menu = (
      <div
        className="ctx-menu glass-pop open"
        data-popover="archive-ctx"
        style={{ display: "block", left, top }}
      >
        <button className="menu-item" onClick={() => runRestore(agentId)}>
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 8a5.5 5.5 0 1 1 1.6 3.9M2.5 8V4.5M2.5 8H6" />
          </svg>
          Restore
        </button>
        <div className="menu-sep"></div>
        <button
          className="menu-item danger"
          onClick={() => { setConfirmId(agentId); ui.closeAllPops(); }}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M2.5 4.5h11M6.5 2.5h3M5 4.5V13a1 1 0 0 0 1 1h4a1 1 0 0 0 1-1V4.5M6.5 7.5v4M9.5 7.5v4" />
          </svg>
          Delete permanently
        </button>
      </div>
    );
  }

  return (
    <>
      {menu}
      {doomed && (
        <BranchConfirmDialog
          message={permanentDeleteMessage(nameOf(doomed), subtreeIds(rows, doomed.id).length)}
          confirmLabel="Delete permanently"
          danger
          busy={busy}
          onConfirm={runPurge}
          onCancel={() => { if (!busy) setConfirmId(null); }}
        />
      )}
    </>
  );
}
