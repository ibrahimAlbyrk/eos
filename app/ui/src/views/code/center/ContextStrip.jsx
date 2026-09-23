import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { basename } from "../../../lib/path.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { useGitStatus } from "../../../hooks/useGitStatus.js";
import { subscribeGitChange, BRANCH_KINDS } from "../../../state/gitChangeBus.js";
import { FolderDropdown } from "../popovers/FolderDropdown.jsx";
import { BranchManager } from "../popovers/BranchManager.jsx";

// The context strip: a --pop tab tucked behind the composer card holding a {}
// project pill and a branch pill. Both open the existing pickers; project/branch
// come from the pane's worker when one is selected, else from ui.composer (the
// pre-spawn config the folder picker writes).
export function ContextStrip({ live, worker }) {
  const ui = useUi();
  const selected = worker ?? null;

  const cwd = selected
    ? (selected.cwd ?? selected.worktree_from ?? null)
    : (ui.composer.cwd ?? live.recents[0] ?? null);
  const folderLabel = cwd ? basename(cwd) : "pick folder…";

  // No-agent spawn: seed ui.composer.cwd from the first recent so a spawn has a
  // folder without the operator opening the picker (was in ComposerConfigRow).
  useEffect(() => {
    if (!selected && !ui.composer.cwd && live.recents[0]) ui.updateComposer({ cwd: live.recents[0] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, live.recents, ui.selectedId]);

  const gs = useGitStatus(selected?.id, { gitDir: workerGitDir(selected) }).status;

  // No-agent spawn config: fetch the current branch for the chosen folder and
  // keep it live (any commit/checkout in that folder refreshes the pill).
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const [isGit, setIsGit] = useState(true);
  const refreshBranch = useCallback(async () => {
    const c = cwdRef.current;
    if (!c) return;
    try {
      const r = await api.listBranches(c);
      setIsGit(r.isGit !== false);
      if (r.current) ui.updateComposer({ branch: r.current });
      else if (!r.isGit) ui.updateComposer({ branch: null });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (selected || !cwd) return;
    refreshBranch();
  }, [selected, cwd, refreshBranch]);
  useEffect(() => {
    if (selected || !cwd) return;
    const onFocus = () => refreshBranch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [selected, cwd, refreshBranch]);
  useEffect(() => {
    if (selected || !cwd) return;
    return subscribeGitChange(cwd, BRANCH_KINDS, refreshBranch);
  }, [selected, cwd, refreshBranch]);

  const branch = selected
    ? (gs?.currentBranch ?? selected.branch ?? null)
    : (isGit ? (ui.composer.branch ?? "main") : null);

  const toggle = (id, e) => {
    e.stopPropagation();
    if (ui.openPopover === id) ui.closeAllPops();
    else ui.openPop(id);
  };

  return (
    <div className="c-strip">
      <div className="c-strip-wrap">
        <button
          className={"strip-pill strip-project" + (ui.openPopover === "folder-dd" ? " on" : "")}
          onClick={(e) => toggle("folder-dd", e)}
          data-popover-trigger="folder-dd"
        >
          <span className="strip-brace">{"{}"}</span>
          <span className="strip-project-name">{folderLabel}</span>
        </button>
        <FolderDropdown live={live} />
      </div>
      {branch && (
        <div className="c-strip-wrap">
          <button
            className={"strip-pill strip-branch" + (ui.openPopover === "branch-dd" ? " on" : "")}
            onClick={(e) => toggle("branch-dd", e)}
            data-popover-trigger="branch-dd"
          >
            <svg className="strip-branch-ic" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="4" cy="4" r="1.5" /><circle cx="4" cy="12" r="1.5" /><circle cx="12" cy="8" r="1.5" />
              <path d="M4 5.5v5M5.5 8h5" />
            </svg>
            <span className="strip-branch-name" title={branch}>{branch}</span>
          </button>
          <BranchManager live={live} cwd={cwd} />
        </div>
      )}
    </div>
  );
}
