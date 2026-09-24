import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { projectForPath, projectLabel } from "../../../lib/projects.js";
import { useProjects } from "../../../state/projectsStore.js";
import { ProjectIcon } from "../../../components/project/ProjectIcon.jsx";
import { subscribeGitChange, BRANCH_KINDS } from "../../../state/gitChangeBus.js";
import { FolderDropdown } from "../popovers/FolderDropdown.jsx";
import { BranchManager } from "../popovers/BranchManager.jsx";

// The context strip: a --pop tab tucked behind the composer card holding a
// project pill (the project's icon + name, folder icon by default) and a branch pill for the next spawn (no session yet — once one
// exists SessionTray takes this slot). Both open the existing pickers and
// read/write ui.composer, the pre-spawn config.
export function ContextStrip({ live }) {
  const ui = useUi();
  const cwd = ui.composer.cwd ?? live.recents[0] ?? null;
  const { projects } = useProjects();
  const project = projectForPath(projects, cwd);
  const folderLabel = cwd ? projectLabel(project, cwd) : "pick project…";

  // Seed ui.composer.cwd from the first recent so a spawn has a folder without
  // the operator opening the picker (was in ComposerConfigRow).
  useEffect(() => {
    if (!ui.composer.cwd && live.recents[0]) ui.updateComposer({ cwd: live.recents[0] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live.recents, ui.selectedId]);

  // Fetch the current branch for the chosen folder and
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
    if (!cwd) return;
    refreshBranch();
  }, [cwd, refreshBranch]);
  useEffect(() => {
    if (!cwd) return;
    const onFocus = () => refreshBranch();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [cwd, refreshBranch]);
  useEffect(() => {
    if (!cwd) return;
    return subscribeGitChange(cwd, BRANCH_KINDS, refreshBranch);
  }, [cwd, refreshBranch]);

  const branch = isGit ? (ui.composer.branch ?? "main") : null;

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
          <span className="strip-brace"><ProjectIcon icon={project?.icon} /></span>
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
