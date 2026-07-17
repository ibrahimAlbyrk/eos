import { useUi } from "../../../state/ui.jsx";
import { workerGitDir } from "../../../lib/workerGitDir.js";

// Top-right toolbar toggle for the Files docked panel (GitDiffToggleButton
// idiom). Opens on the pane's agent git dir, falling back to the composer's
// project path when the pane has no agent yet; the panel's own folder picker
// covers the no-dir case.
export function FilesToggleButton({ worker }) {
  const ui = useUi();
  const open = ui.isPanelOpen("files");

  const onClick = () => {
    if (open) { ui.closeFilesViewer(); return; }
    ui.openFilesViewer(workerGitDir(worker) ?? ui.composer.cwd ?? null);
  };

  return (
    <button
      className={"pane-split-btn" + (open ? " is-active" : "")}
      onClick={onClick}
      title={open ? "Hide files" : "Show files"}
      aria-label="Toggle files panel"
      aria-pressed={open}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <path d="M2 4.4a1 1 0 0 1 1-1h2.8l1.3 1.5H13a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.4Z" />
      </svg>
    </button>
  );
}
