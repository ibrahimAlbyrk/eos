import { useUi } from "../../../state/ui.jsx";
import { useGitStatus } from "../../../hooks/useGitStatus.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { EosSwitcher } from "../../../components/EosSwitcher.jsx";
import { setArchiveViewing } from "../../../state/archiveStore.js";
import { setPref } from "../../../state/sidebarPrefsStore.js";

// Sidebar top chrome + primary nav, matching the reference IA:
//   full variant → traffic lights + collapse button (the .side-top strip)
//   both variants → Eos ▾ switcher + search, then the New task / Changes /
//   Archive nav rows.
// The old "Agents N" title, the 4-button action cluster and the duplicate
// sb-section are gone (their functions live on the Eos row + nav rows now).
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

function CollapseIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <rect x="2" y="3" width="12" height="10" rx="2" /><line x1="6" y1="3" x2="6" y2="13" />
    </svg>
  );
}

function NavRow({ icon, label, meta, strong, selected, onClick }) {
  const cls = ["sb-nav-row"];
  if (strong) cls.push("strong");
  if (selected) cls.push("on");
  return (
    <button className={cls.join(" ")} onClick={onClick}>
      <span className="sb-nav-row__ic">{icon}</span>
      <span className="sb-nav-row__label">{label}</span>
      {meta != null && <span className="sb-nav-row__meta">{meta}</span>}
    </button>
  );
}

export function SidebarHead({ live, variant, archiveMode = false }) {
  const ui = useUi();
  const full = variant === "full";

  const selected = live?.workers.find((w) => w.id === ui.selectedId) ?? null;
  const gitDir = workerGitDir(selected);
  const { status: gs } = useGitStatus(selected?.id, { gitDir });
  const changeCount = gs?.diff?.files ?? 0;

  const newTask = () => ui.setSelectedId(null);

  const openChanges = () => {
    const dir = gitDir ?? ui.composer.cwd;
    ui.openPanel("review", { cwd: dir, workerId: selected?.id });
  };

  const toggleArchive = () => {
    const next = !archiveMode;
    setArchiveViewing(next);
    // Drive the sidebar list too, so Archive shows the archived groups.
    setPref("status", next ? "archived" : "active");
  };

  return (
    <>
      {full && (
        <div className="side-top">
          <span className="side-dot" />
          <span className="side-dot" />
          <span className="side-dot" />
          <button className="side-collapse" title="Collapse panel" onClick={() => ui.collapseSidebar()}>
            <CollapseIcon />
          </button>
        </div>
      )}

      <EosSwitcher />

      <div className="sb-nav">
        <NavRow icon={<PencilIcon />} label="New task" meta="⌘T" strong onClick={newTask} />
        <NavRow icon={<BranchIcon />} label="Changes" meta={changeCount > 0 ? String(changeCount) : null} onClick={openChanges} />
        <NavRow icon={<TrayIcon />} label="Archive" selected={archiveMode} strong={archiveMode} onClick={toggleArchive} />
      </div>
    </>
  );
}
