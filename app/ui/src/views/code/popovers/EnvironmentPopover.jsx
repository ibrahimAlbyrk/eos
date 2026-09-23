import { createPortal } from "react-dom";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { useGitStatus } from "../../../hooks/useGitStatus.js";
import { PushButton } from "../center/PushButton.jsx";
import { PullButton } from "../center/PullButton.jsx";

// Environment & changes popover (charcoal-aurora). Opened from the header's
// checklist button, anchored under the header's bottom line (top: header bottom;
// right-aligned to the button cluster). New home for the quick git affordances
// that used to live in the orphaned ComposerDiffRow — Changes counts, Push ↑n /
// Pull ↓n (rehomed PushButton/PullButton with their ring FX), Commit-or-push and
// View-all (open the Review side panel), branch (opens the strip's Branch
// manager), Create PR, and Custom git task (⌘G). Portal'd to <body> so a split
// pane's contain:paint can't clip it (HeaderAgentMenu idiom). Wrapper/inner split
// (ModelEffortPanel idiom) so the git-status subscription only runs while open.
export function EnvironmentPopover({ worker, anchor }) {
  const ui = useUi();
  if (ui.openPopover !== "env" || !worker) return null;
  return <EnvPopover ui={ui} worker={worker} anchor={anchor} />;
}

function EnvPopover({ ui, worker, anchor }) {
  const gitDir = workerGitDir(worker);
  const { status: gs, refresh } = useGitStatus(worker.id, { gitDir });

  const rect = anchor?.current?.getBoundingClientRect();
  if (!rect) return null;
  const pos = { top: Math.round(rect.bottom + 26), right: Math.max(8, Math.round(window.innerWidth - rect.right)) };

  const diff = gs?.diff ?? { insertions: 0, deletions: 0, files: 0 };
  const branch = gs?.currentBranch ?? worker.branch ?? "main";
  const ahead = gs?.ahead ?? 0;
  const behind = gs?.behind ?? 0;
  const pushable = gs?.pushable ?? false;
  const pushKind = gs?.pushKind ?? "noop";
  const pullable = gs?.pullable ?? false;

  const openReview = () => { ui.openPanel("review", { workerId: worker.id, cwd: gitDir }); ui.closeAllPops(); };
  // Reuse the composer strip's Branch manager (popover id "branch-dd") — already
  // mounted for this pane's folder and knows how to checkout/create branches.
  const openBranch = () => { ui.closeAllPops(); ui.openPop("branch-dd"); };
  const createPr = () => { api.sendWorkerAction(worker.id, "pr"); ui.closeAllPops(); };
  // Same path GitAgentPopover.startCustom used: flip the composer into git mode so
  // the next prompt spawns a git agent (Composer owns the spawnGitAgent call).
  const customGit = () => { ui.closeAllPops(); ui.toggleGitMode?.(true); };

  return createPortal(
    <div className="env-pop" data-popover="env" style={pos}>
      <div className="env-head"><span>Environment</span><PlusGlyph /></div>

      <div className="env-row env-static">
        <ChangesIcon />
        <span className="env-label">Changes</span>
        <span className="env-count env-add">+{diff.insertions.toLocaleString()}</span>
        <span className="env-count env-del">−{diff.deletions.toLocaleString()}</span>
      </div>

      <div className="env-row env-static">
        <LocalIcon />
        <span className="env-label">Local</span>
        <ChevronDown />
      </div>

      <button className="env-row" onClick={openBranch}>
        <BranchIcon />
        <span className="env-label env-branch" title={branch}>{branch}</span>
        <ChevronDown />
      </button>

      <button className="env-row" onClick={openReview}>
        <CommitIcon />
        <span className="env-label">Commit or push</span>
      </button>

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

      <button className="env-row" onClick={customGit}>
        <PencilIcon />
        <span className="env-label">Custom git task</span>
        <span className="kbd">⌘G</span>
      </button>

      <div className="env-head env-head--sources"><span>Sources</span><PlusGlyph /></div>

      <div className="env-row env-static env-dim">
        <DocIcon />
        <span className="env-label">source docs</span>
      </div>
      <div className="env-row env-static env-dim">
        <GlobeIcon />
        <span className="env-label">Web search</span>
      </div>
      <button className="env-row env-faint" onClick={openReview}>
        <ExternalIcon />
        <span className="env-label">View all</span>
      </button>
    </div>,
    document.body,
  );
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
function LocalIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round">
      <rect x="2" y="5.5" width="10" height="6.5" rx="1" />
      <line x1="3.5" y1="3.5" x2="10.5" y2="3.5" />
      <line x1="4.5" y1="1.5" x2="9.5" y2="1.5" />
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
function CommitIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="2.5" />
      <line x1="1.5" y1="8" x2="5.5" y2="8" /><line x1="10.5" y1="8" x2="14.5" y2="8" />
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
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M11 2.5l2.5 2.5M3 13l1-3.2 6.7-6.7 2.2 2.2L6.2 12 3 13z" />
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
function GlobeIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="8" cy="8" r="6" /><ellipse cx="8" cy="8" rx="2.6" ry="6" /><path d="M2 8h12" />
    </svg>
  );
}
function ExternalIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />
      <path d="M9 2h5v5M14 2 7 9" />
    </svg>
  );
}
