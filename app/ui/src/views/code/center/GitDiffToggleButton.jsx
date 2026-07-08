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
        <rect x="2" y="2" width="12" height="12" rx="2.5" />
        <path d="M8 4.4v3" />
        <path d="M6.5 5.9h3" />
        <path d="M6.5 10.6h3" />
      </svg>
    </button>
  );
}
