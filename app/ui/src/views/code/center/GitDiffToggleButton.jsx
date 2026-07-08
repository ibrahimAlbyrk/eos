import { useUi } from "../../../state/ui.jsx";
import { workerGitDir } from "../../../lib/workerGitDir.js";

// Top-right toolbar toggle for the Git Diff docked panel (TerminalToggleButton
// idiom). Opens on the pane's agent git dir, falling back to the composer's
// project path when the pane has no agent yet.
export function GitDiffToggleButton({ worker }) {
  const ui = useUi();
  const open = ui.isPanelOpen("gitdiff");

  const onClick = () => {
    if (open) { ui.closeGitDiffViewer(); return; }
    const dir = workerGitDir(worker) ?? ui.composer.cwd;
    if (dir) ui.openGitDiffViewer(dir);
  };

  return (
    <button
      className={"pane-split-btn" + (open ? " is-active" : "")}
      onClick={onClick}
      title={open ? "Hide git diff" : "Show git diff"}
      aria-label="Toggle git diff panel"
      aria-pressed={open}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="4.2" cy="3.8" r="1.8" />
        <circle cx="11.8" cy="12.2" r="1.8" />
        <path d="M11.8 10.4V7.5A2.5 2.5 0 0 0 9.3 5H6.9" />
        <path d="M8.5 3.4 6.9 5l1.6 1.6" />
        <path d="M4.2 5.6v2.9A2.5 2.5 0 0 0 6.7 11h2.4" />
        <path d="M7.5 12.6 9.1 11 7.5 9.4" />
      </svg>
    </button>
  );
}
