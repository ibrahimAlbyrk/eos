import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { basename } from "../../../lib/path.js";
import { FolderDropdown } from "../popovers/FolderDropdown.jsx";
import { BranchManager } from "../popovers/BranchManager.jsx";

export function ComposerConfigRow({ live }) {
  const ui = useUi();
  const state = ui.composer;
  const updateState = (patch) => ui.updateComposer(patch);

  const cwd = state.cwd ?? live.recents[0] ?? null;
  const folderLabel = cwd ? basename(cwd) : "pick folder…";
  const [isGit, setIsGit] = useState(true);

  // initialize cwd from first recent if unset (one-shot)
  useEffect(() => {
    if (!state.cwd && live.recents[0]) {
      updateState({ cwd: live.recents[0] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.recents, ui.selectedId]);

  // Ref to track the latest cwd so the focus listener always reads current value
  const cwdRef = useRef(cwd);
  cwdRef.current = cwd;
  const selectedIdRef = useRef(ui.selectedId);
  selectedIdRef.current = ui.selectedId;

  const refreshBranch = useCallback(async () => {
    const c = cwdRef.current;
    if (!c) return;
    try {
      const r = await api.listBranches(c);
      setIsGit(r.isGit !== false);
      if (r.current) updateState({ branch: r.current });
      else if (!r.isGit) updateState({ branch: null });
    } catch {}
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // fetch branch on cwd / selection change
  useEffect(() => {
    if (!cwd) return;
    refreshBranch();
  }, [cwd, ui.selectedId, refreshBranch]);

  // single focus listener on mount
  useEffect(() => {
    window.addEventListener("focus", refreshBranch);
    return () => window.removeEventListener("focus", refreshBranch);
  }, [refreshBranch]);

  const branchLabel = state.branch ?? "main";

  const toggle = (id, e) => {
    e.stopPropagation();
    if (ui.openPopover === id) ui.closeAllPops();
    else ui.openPop(id);
  };

  return (
    <div className="c-row1 c-row1--config" id="composerConfigRow">
      <div className="cb-chip-wrap">
        <button
          className="cb-chip"
          onClick={(e) => toggle("folder-dd", e)}
          data-popover-trigger="folder-dd"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
          </svg>
          <span id="cbFolderVal">{folderLabel}</span>
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
        <FolderDropdown live={live} />
      </div>

      {isGit && <div className="cb-chip-group">
        <div className="cb-chip-wrap">
          <button
            className="cb-chip cb-chip--in-group"
            onClick={(e) => toggle("branch-dd", e)}
            data-popover-trigger="branch-dd"
          >
            <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <circle cx="4" cy="4" r="1.5" /><circle cx="4" cy="12" r="1.5" /><circle cx="12" cy="8" r="1.5" />
              <path d="M4 5.5v5M5.5 8h5" />
            </svg>
            <span className="cb-chip-val--branch">{branchLabel}</span>
          </button>
          <BranchManager live={live} cwd={cwd} />
        </div>
      </div>}
    </div>
  );
}
