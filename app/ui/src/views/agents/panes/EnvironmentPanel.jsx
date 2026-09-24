import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { useGitStatus } from "../../../hooks/useGitStatus.js";
import { subscribe, getSnapshot, attach } from "../../../state/chatAttachmentsStore.js";
import { useEnvPanelOpen } from "../../../state/envPanelStore.js";
import { PushButton } from "../center/PushButton.jsx";
import { PullButton } from "../center/PullButton.jsx";
import { BranchManager } from "../popovers/BranchManager.jsx";

// Environment & changes panel, toggled from the header's checklist button. Opens
// in the pane's right gutter; the transcript + composer column slides left only
// when it would otherwise run under the panel (see .env-dock in menus.css).
// Wrapper/inner split so the git-status subscription only runs while open.
export function EnvDock({ live, worker, children }) {
  const ui = useUi();
  const open = useEnvPanelOpen(ui.paneId) && Boolean(worker);
  return (
    <div className={"env-dock" + (open ? " is-open" : "")}>
      <div className="env-dock-main">{children}</div>
      {open && <EnvPanel ui={ui} live={live} worker={worker} />}
    </div>
  );
}

function EnvPanel({ ui, live, worker }) {
  const gitDir = workerGitDir(worker);
  const { status: gs, refresh } = useGitStatus(worker.id, { gitDir });

  const diff = gs?.diff ?? { insertions: 0, deletions: 0, files: 0 };
  const branch = gs?.currentBranch ?? worker.branch ?? "main";
  const ahead = gs?.ahead ?? 0;
  const behind = gs?.behind ?? 0;
  const pushable = gs?.pushable ?? false;
  const pushKind = gs?.pushKind ?? "noop";
  const pullable = gs?.pullable ?? false;

  const branchOpen = ui.openPopover === "branch-dd";
  const toggleBranch = () => (branchOpen ? ui.closeAllPops() : ui.openPop("branch-dd"));
  const createPr = () => api.sendWorkerAction(worker.id, "pr");
  const openReview = () => ui.openPanel("review", { workerId: worker.id, cwd: gitDir });

  return (
    <div className="env-pop">
      <div className="env-head"><span>Environment</span><PlusGlyph /></div>

      <button className="env-row" onClick={openReview}>
        <ChangesIcon />
        <span className="env-label">Changes</span>
        <span className="env-count env-add">+{diff.insertions.toLocaleString()}</span>
        <span className="env-count env-del">−{diff.deletions.toLocaleString()}</span>
      </button>

      <div className="env-branch-wrap">
        <button
          className={"env-row" + (branchOpen ? " is-active" : "")}
          onClick={toggleBranch}
          data-popover-trigger="branch-dd"
        >
          <BranchIcon />
          <span className="env-label env-branch" title={branch}>{branch}</span>
          <ChevronDown />
        </button>
        <BranchManager live={live} cwd={gitDir} />
      </div>

      {pushable && (
        <div className="env-row env-fx-row">
          <PushButton
            workerId={worker.id}
            label={pushKind === "set-upstream" ? "Publish" : "Push"}
            ahead={ahead}
            onSettled={refresh}
          />
          {ahead > 0 && <span className="env-sync">↑{ahead}</span>}
        </div>
      )}
      {pullable && (
        <div className="env-row env-fx-row">
          <PullButton workerId={worker.id} onSettled={refresh} />
          {behind > 0 && <span className="env-sync">↓{behind}</span>}
        </div>
      )}

      <button className="env-row" onClick={createPr}>
        <PrIcon />
        <span className="env-label">Create pull request</span>
      </button>

      <SourcesSection ui={ui} workerId={worker.id} />
    </div>
  );
}

// Sources = the files attached to this chat. Same module-singleton store the
// "Chat files" side-panel tab reads, so the two always agree. Row click opens
// the file (or the Files panel for a folder). Capped at 8 visible rows, rest scroll.
function SourcesSection({ ui, workerId }) {
  const snap = useSyncExternalStore(
    useCallback((cb) => (workerId ? subscribe(workerId, cb) : () => {}), [workerId]),
    useCallback(() => getSnapshot(workerId), [workerId]),
  );
  useEffect(() => {
    if (!workerId) return;
    return attach(workerId);
  }, [workerId]);

  const attachments = snap.attachments;
  const open = (att) => {
    if (att.kind === "folder") ui.openPanel("files", { cwd: att.path });
    else ui.openFile(att.path);
  };

  return (
    <>
      <div className="env-head env-head--sources"><span>Sources</span></div>
      {attachments.length === 0 ? (
        <div className="env-row env-static env-dim">
          <span className="env-label">No files attached</span>
        </div>
      ) : (
        <div className="env-sources">
          {attachments.map((att) => (
            <button key={att.path} className="env-row" onClick={() => open(att)} title={att.path}>
              {att.kind === "folder" ? <FolderGlyph /> : <DocIcon />}
              <span className="env-label">{basename(att.path)}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function basename(path) {
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  return p.split("/").pop() || p;
}

function PlusGlyph() {
  return (
    <svg className="env-plus" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
      <path d="M8 3v10M3 8h10" />
    </svg>
  );
}
function ChevronDown() {
  return (
    <svg className="env-chev" width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="m4 6 4 4 4-4" />
    </svg>
  );
}
function ChangesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
      <path d="M5.5 8h5M8 5.5v5" />
    </svg>
  );
}
function BranchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 2.2-2.7 2.6-4.5 3.2" />
    </svg>
  );
}
function PrIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="4" r="1.5" /><circle cx="4" cy="12" r="1.5" /><circle cx="12" cy="8" r="1.5" />
      <path d="M4 5.5v5M5.5 8h5" />
    </svg>
  );
}
function DocIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 1.5h-5a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h7a1 1 0 0 0 1-1V4.5z" />
      <path d="M9.5 1.5V4.5h3" />
      <path d="M6 8.5h4M6 11h2.5" />
    </svg>
  );
}
function FolderGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />
    </svg>
  );
}
