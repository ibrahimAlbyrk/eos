import { useEffect, useState, useRef } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { basename } from "../../../lib/path.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { PushButton } from "./PushButton.jsx";
import { PullButton } from "./PullButton.jsx";
import { useGitStatus } from "../../../hooks/useGitStatus.js";
import { hasUnintegratedWork } from "../../../lib/workState.js";
import { truncateBranch } from "../../../lib/branchDisplay.js";
import { gitAgentName } from "../../../lib/gitAgentName.js";
import { requestStashFocus } from "../../../state/gitDiffIntent.js";

const PR_OPTIONS = [
  { id: "pr", label: "Create PR", icon: "pr" },
  { id: "draft", label: "Create draft PR", icon: "draft" },
  { id: "manual", label: "Manually create PR", icon: "external" },
];

const COMMIT_OPTIONS = [
  { id: "commit", label: "Commit", icon: "commit" },
  { id: "commit-push", label: "Commit & push", icon: "push" },
];

function OptionIcon({ type }) {
  if (type === "draft") return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="4" r="1.5" /><circle cx="8" cy="12" r="1.5" />
      <line x1="8" y1="5.5" x2="8" y2="10.5" strokeDasharray="2 2" />
    </svg>
  );
  if (type === "external") return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M6 3H4a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1v-2" />
      <path d="M9 2h5v5M14 2 7 9" />
    </svg>
  );
  if (type === "commit") return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="8" cy="8" r="2.5" />
      <line x1="1.5" y1="8" x2="5.5" y2="8" /><line x1="10.5" y1="8" x2="14.5" y2="8" />
    </svg>
  );
  if (type === "push") return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V5M5 8l3-3 3 3" />
      <line x1="4" y1="2.5" x2="12" y2="2.5" />
    </svg>
  );
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="8" r="1.5" />
      <path d="M5 5.5v5M6.5 8h3" />
    </svg>
  );
}

function SplitButton({ options, mode, onSelectMode, onAction, disabled, title }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return;
    const close = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const active = options.find((o) => o.id === mode) ?? options[0];

  return (
    <div className="pr-wrap" ref={ref}>
      {open && (
        <div className="pr-menu">
          {options.map((opt) => (
            <button key={opt.id} className={"pr-menu-item" + (mode === opt.id ? " on" : "")} onClick={() => { onSelectMode(opt.id); setOpen(false); }}>
              <OptionIcon type={opt.icon} />
              <span>{opt.label}</span>
              {mode === opt.id && (
                <svg className="pr-menu-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="m3 8 3 3 7-7" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
      <button className="pr-create-btn" disabled={disabled} title={title ?? active.label} onClick={() => onAction(active.id)}>
        <span className="split-ic"><OptionIcon type={active.icon} /></span>
        <span className="btn-label">{active.label}</span>
      </button>
      <button className="pr-dropdown-toggle" disabled={disabled} onClick={() => setOpen(!open)}>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
    </div>
  );
}


export function ComposerDiffRow({ live, worker, wtStatus }) {
  const ui = useUi();
  // The pane's own worker (this row is only rendered when it's set), not the
  // global selection — each pane's git row describes ITS agent's tree.
  const selected = worker;
  const [prMode, setPrMode] = useState("pr");
  const [commitMode, setCommitMode] = useState("commit");
  const [pushFx, setPushFx] = useState(""); // "" | "sync-leaving" | "sync-exit"
  const [integrating, setIntegrating] = useState(false);

  const syncChipRef = useRef(null);

  // Where the agent actually edits: worktree dir first (cwd is NULL for
  // worktree rows) — otherwise these chips describe the USER'S repo while
  // the diff badge reads the worktree.
  const gitDir = workerGitDir(selected);
  const { status: gs, refresh } = useGitStatus(selected?.id, { gitDir });

  // Snapshot missing (first visit) → render zeros: only folder/branch from the
  // sync worker row show, chips/badges stay hidden until real data lands.
  const diff = gs?.diff ?? { insertions: 0, deletions: 0, files: 0 };
  const currentBranch = gs?.currentBranch ?? null;
  const remoteUrl = gs?.remoteUrl ?? null;
  const ahead = gs?.ahead ?? 0;
  const behind = gs?.behind ?? 0;
  const stash = gs?.stash ?? 0;
  const conflicts = gs?.conflicts ?? 0;
  const pushable = gs?.pushable ?? false;
  const pushKind = gs?.pushKind ?? "noop";
  const pullable = gs?.pullable ?? false;

  // Once there's nothing left to push, the sync chip unmounts — clear any push
  // FX class so a future chip doesn't mount pre-hidden.
  useEffect(() => {
    if (ahead <= 0 && behind <= 0) setPushFx("");
  }, [ahead, behind]);

  if (!selected || (gs && !gs.isGit)) return null;

  const isolated = Boolean(selected.worktree_dir || (selected.worktree_from && selected.branch));
  const isOrchestrator = Boolean(selected.is_orchestrator);
  const folder = basename(selected.cwd ?? selected.worktree_from ?? "");
  const branch = currentBranch ?? selected.branch ?? null;
  const verdict = ui.verdict?.workerId === selected.id ? ui.verdict : null;
  const showVerdict = verdict && verdict.verdict !== "unverified";
  // The worktree fleet is owned by WorktreeHub now; it reports the dirty children
  // up (with branches) so "Merge all" can gate + integrate from the git row.
  const dirtyChildren = wtStatus?.children ?? [];

  const handlePrAction = (id) => {
    if (id === "manual") {
      if (remoteUrl) {
        const b = currentBranch ?? branch;
        const prUrl = `${remoteUrl}/compare/main...${b}?quick_pull=1`;
        api.openFile(prUrl);
      }
      return;
    }
    api.sendWorkerAction(selected.id, id === "draft" ? "draft-pr" : "pr");
  };

  const handleCommitAction = (id) => {
    api.sendWorkerAction(selected.id, id);
  };

  // Fan-in: spawn a git agent in a fresh worktree that merges the orchestrator's
  // child branches into one verified result (children left intact), then select
  // it so the operator watches. Same path as the conflict-resolution git agent.
  // The directive lives in the prompt system (manager/prompts/integrate.prompt.md),
  // rendered server-side — only the branch list is passed as data, never prose.
  const handleIntegrate = async () => {
    if (integrating) return;
    const branches = dirtyChildren.map((w) => w.branch).filter(Boolean);
    if (branches.length < 2) return;
    setIntegrating(true);
    try {
      const r = await live.spawnGitAgent({
        worktreeFrom: selected.cwd ?? selected.worktree_from,
        promptTemplate: { id: "integrate", vars: { BRANCHES: branches.join(", ") } },
        name: gitAgentName(selected.cwd ?? selected.worktree_from, branch, "merge"),
      });
      if (r?.ok && r.body?.id) ui.setSelectedId(r.body.id);
      else if (!r?.ok) alert(r?.body?.error ?? "integration failed to start");
    } finally {
      setIntegrating(false);
    }
  };

  const showSync = ahead > 0 || behind > 0;
  const dirty = hasUnintegratedWork(diff);
  // Push shows whenever the deterministic plan would actually push — i.e. there
  // are commits ahead (or a local-only branch to publish) — regardless of any
  // uncommitted working-tree changes. The Commit split-button covers those
  // separately. "set-upstream" ⇒ local-only branch → "Publish".
  const showPush = pushable;

  return (
    <div className="diff-stack">
    <div className="c-row-diff" id="composerDiffRow">
      <span className="diff-repo-label">
        <b title={folder}>{folder}</b>
        {branch && (
          <>
            <span className="diff-sep">·</span>
            <span className="diff-branch" title={branch}>{truncateBranch(branch)}</span>
          </>
        )}
      </span>
      {isolated && (
        <span className="git-chip isolated-chip" title={`Isolated worktree — changes are invisible to your checkout until you Try/integrate them.\n${selected.worktree_dir ?? ""}`}>
          <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <rect x="2.5" y="2.5" width="11" height="11" rx="2" />
            <path d="M5.5 8h5M8 5.5v5" />
          </svg>
          <span className="lbl">isolated</span>
        </span>
      )}
      {showVerdict && (
        <span className={"git-chip verdict-chip verdict-" + verdict.verdict} title={verdict.command ? `verified by: ${verdict.command}` : undefined}>
          <span className="lbl">{verdict.verdict}</span>
        </span>
      )}
      <div className="diff-actions">
      {showSync && (
        <button
          ref={syncChipRef}
          className={"git-chip sync-chip sync-chip-btn" + (ui.isPanelOpen("commits") ? " on" : "") + (pushFx ? " " + pushFx : "")}
          title="Show unpushed commits"
          onClick={() => {
            if (ui.isPanelOpen("commits")) { ui.closeCommitsViewer(); return; }
            const dir = workerGitDir(selected);
            if (dir) ui.openCommitsViewer(dir);
          }}
        >
          {ahead > 0 && (
            <span className="ahead">
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 10V3M3 6l3-3 3 3" />
              </svg>
              <span className="num">{ahead}</span>
            </span>
          )}
          {ahead > 0 && behind > 0 && <span className="dot"></span>}
          {behind > 0 && (
            <span className="behind">
              <svg width="9" height="9" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M6 2v7M3 6l3 3 3-3" />
              </svg>
              <span className="num">{behind}</span>
            </span>
          )}
        </button>
      )}
      {stash > 0 && (
        <button
          className={"git-chip stash-chip stash-chip-btn" + (ui.isPanelOpen("gitdiff") ? " on" : "")}
          title="View stashes"
          onClick={() => {
            if (ui.isPanelOpen("gitdiff")) { ui.closeGitDiffViewer(); return; }
            requestStashFocus();
            ui.openGitDiffViewer(workerGitDir(selected) ?? ui.composer.cwd, selected.id);
          }}
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5.5" width="10" height="6.5" rx="1" />
            <line x1="3.5" y1="3.5" x2="10.5" y2="3.5" />
            <line x1="4.5" y1="1.5" x2="9.5" y2="1.5" />
          </svg>
          <span className="num">{stash}</span>
          <span className="lbl">stashed</span>
        </button>
      )}
      {conflicts > 0 && (
        <button
          className={"git-chip conflict-chip conflict-chip-btn" + (ui.isPanelOpen("gitdiff") ? " on" : "")}
          title="Resolve merge conflicts"
          onClick={() => (ui.isPanelOpen("gitdiff") ? ui.closeGitDiffViewer() : ui.openGitDiffViewer(workerGitDir(selected) ?? ui.composer.cwd, selected.id))}
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 1.5L13 12H1L7 1.5z" />
            <line x1="7" y1="5.5" x2="7" y2="8.5" />
            <circle cx="7" cy="10.3" r="0.4" fill="currentColor" stroke="none" />
          </svg>
          <span className="num">{conflicts}</span>
          <span className="lbl">{conflicts === 1 ? "conflict" : "conflicts"}</span>
        </button>
      )}
      {dirty && (
        <button
          className={"diff-badge diff-badge-btn" + (ui.isPanelOpen("gitdiff") ? " on" : "")}
          title="View changes"
          onClick={() => (ui.isPanelOpen("gitdiff") ? ui.closeGitDiffViewer() : ui.openGitDiffViewer(workerGitDir(selected) ?? ui.composer.cwd, selected.id))}
        >
          {diff.insertions > 0 || diff.deletions > 0 ? (
            <>
              +{diff.insertions.toLocaleString()}{" "}
              <span className="diff-neg">−{diff.deletions.toLocaleString()}</span>
            </>
          ) : (
            <>{diff.files} new</>
          )}
        </button>
      )}
      {dirty && (
        <SplitButton
          options={COMMIT_OPTIONS}
          mode={commitMode}
          onSelectMode={setCommitMode}
          onAction={handleCommitAction}
          disabled={conflicts > 0}
          title={conflicts > 0 ? "Resolve conflicts first" : undefined}
        />
      )}
      {showPush && (
        <PushButton
          workerId={selected.id}
          label={pushKind === "set-upstream" ? "Publish" : "Push"}
          ahead={ahead}
          sourceRef={syncChipRef}
          onSourceFx={setPushFx}
          onSettled={refresh}
        />
      )}
      {pullable && (
        <PullButton workerId={selected.id} onSettled={refresh} />
      )}
      {isOrchestrator && dirtyChildren.length >= 2 && (
        <button
          className="pr-create-btn pr-solo"
          disabled={integrating}
          title="Merge these worktree branches into one verified result — spawns a git agent in a fresh worktree (originals untouched)"
          onClick={handleIntegrate}
        >
          <span className="split-ic"><OptionIcon type="merge" /></span>
          <span className="btn-label">{integrating ? "Merging…" : `Merge all (${dirtyChildren.length})`}</span>
        </button>
      )}
      <SplitButton
        options={PR_OPTIONS}
        mode={prMode}
        onSelectMode={setPrMode}
        onAction={handlePrAction}
      />
      </div>
    </div>
    </div>
  );
}
