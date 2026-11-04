import { useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useGitStatus } from "../../../hooks/useGitStatus.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { subscribe, getArchive, setArchiveViewing } from "../../../state/archiveStore.js";
import { setPref } from "../../../state/sidebarPrefsStore.js";
import { setMainView } from "../../../slots/index.js";
import { shortcutLabel } from "../../../lib/platform.js";
import { NavRow } from "./NavRow.jsx";

// The built-in rows of the sidebar's primary nav.

function PencilIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11.2 2.6 13.4 4.8 5.6 12.6 2.6 13.4l.8-3z" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 2.2-2.7 2.6-4.5 3.2" />
    </svg>
  );
}

function TrayIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="3" width="12" height="4" rx="1" /><path d="M3.5 7v5.5h9V7M6.5 9.5h3" />
    </svg>
  );
}

export function NewTaskNavItem() {
  const ui = useUi();
  const { archiveMode } = useSyncExternalStore(subscribe, getArchive);
  const newTask = () => {
    // Leaving Archive this way also puts the sidebar list back on active agents,
    // as the Archive row's own toggle does.
    if (archiveMode) setPref("status", "active");
    setMainView(null);
    ui.setSelectedId(null);
  };
  return <NavRow icon={<PencilIcon />} label="New task" meta={shortcutLabel("mod+t")} strong onClick={newTask} />;
}

export function ChangesNavItem({ live }) {
  const ui = useUi();
  const selected = live?.workers.find((w) => w.id === ui.selectedId) ?? null;
  const gitDir = workerGitDir(selected);
  const { status: gs } = useGitStatus(selected?.id, { gitDir });
  const changeCount = gs?.diff?.files ?? 0;
  const openChanges = () => ui.openPanel("review", { cwd: gitDir ?? ui.composer.cwd, workerId: selected?.id });
  return <NavRow icon={<BranchIcon />} label="Changes" meta={changeCount > 0 ? String(changeCount) : null} onClick={openChanges} />;
}

export function ArchiveNavItem() {
  const { archiveMode } = useSyncExternalStore(subscribe, getArchive);
  const toggleArchive = () => {
    const next = !archiveMode;
    setArchiveViewing(next);
    // Drive the sidebar list too, so Archive shows the archived groups.
    setPref("status", next ? "archived" : "active");
  };
  return <NavRow icon={<TrayIcon />} label="Archive" selected={archiveMode} strong={archiveMode} onClick={toggleArchive} />;
}
