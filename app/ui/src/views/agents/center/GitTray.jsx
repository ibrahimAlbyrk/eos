import { useEffect, useState, useRef } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { useGitStatus } from "../../../hooks/useGitStatus.js";
import { hasUnintegratedWork } from "../../../lib/workState.js";
import { gitAgentName } from "../../../lib/gitAgentName.js";
import { requestStashFocus } from "../../../state/gitDiffIntent.js";
import { notify } from "../../../lib/notify.js";
import { PushButton } from "./PushButton.jsx";
import { PullButton } from "./PullButton.jsx";
import { SplitButton, OptionIcon } from "./SplitButton.jsx";

const PR_OPTIONS = [
  { id: "pr", label: "Create PR", icon: "pr" },
  { id: "draft", label: "Create draft PR", icon: "draft" },
  { id: "manual", label: "Manually create PR", icon: "external" },
];

const COMMIT_OPTIONS = [
  { id: "commit", label: "Commit", icon: "commit" },
  { id: "commit-push", label: "Commit & push", icon: "push" },
];

// The session's git actions (changes, commit, push/pull, PR) on a tray tucked
// behind the composer card: only its top edge peeks out, hovering slides it up.
// `pinned` (or an open split menu) holds it up so a menu never slides away.
export function GitTray({ live, worker, wtStatus, pinned }) {
  const ui = useUi();
  const [prMode, setPrMode] = useState("pr");
  const [commitMode, setCommitMode] = useState("commit");
  const [pushFx, setPushFx] = useState(""); // "" | "sync-leaving" | "sync-exit"
  const [integrating, setIntegrating] = useState(false);
  const [menusOpen, setMenusOpen] = useState(0);
  const syncChipRef = useRef(null);

  // Worktree dir first (cwd is NULL for worktree rows) — otherwise these chips
  // describe the user's checkout instead of where the agent edits.
  const gitDir = workerGitDir(worker);
  const { status: gs, refresh } = useGitStatus(worker.id, { gitDir });

  const diff = gs?.diff ?? { insertions: 0, deletions: 0, files: 0 };
  const ahead = gs?.ahead ?? 0;
  const behind = gs?.behind ?? 0;
  const stash = gs?.stash ?? 0;
  const conflicts = gs?.conflicts ?? 0;
  const pushKind = gs?.pushKind ?? "noop";

  // Once there's nothing left to push, the sync chip unmounts — clear any push
  // FX class so a future chip doesn't mount pre-hidden.
  useEffect(() => {
    if (ahead <= 0 && behind <= 0) setPushFx("");
  }, [ahead, behind]);

  if (gs && !gs.isGit) return null;

  const dirtyChildren = wtStatus?.children ?? [];
  const onMenu = (open) => setMenusOpen((n) => n + (open ? 1 : -1));
  const openReview = () => ui.openPanel("review", { workerId: worker.id, cwd: gitDir });

  const handlePrAction = (id) => {
    if (id === "manual") {
      const branch = gs?.currentBranch ?? worker.branch;
      if (gs?.remoteUrl && branch) api.openFile(`${gs.remoteUrl}/compare/main...${branch}?quick_pull=1`);
      return;
    }
    api.sendWorkerAction(worker.id, id === "draft" ? "draft-pr" : "pr");
  };

  // Fan-in: a git agent in a fresh worktree merges the orchestrator's child
  // branches into one verified result (children left intact).
  const handleIntegrate = async () => {
    if (integrating) return;
    const branches = dirtyChildren.map((w) => w.branch).filter(Boolean);
    if (branches.length < 2) return;
    setIntegrating(true);
    try {
      const root = worker.cwd ?? worker.worktree_from;
      const r = await live.spawnGitAgent({
        worktreeFrom: root,
        promptTemplate: { id: "integrate", vars: { BRANCHES: branches.join(", ") } },
        name: gitAgentName(root, gs?.currentBranch ?? worker.branch, "merge"),
      });
      if (r?.ok && r.body?.id) ui.setSelectedId(r.body.id);
      else if (!r?.ok) notify.error(r?.body?.error ?? "integration failed to start");
    } finally {
      setIntegrating(false);
    }
  };

  return (
    <div className={"git-tray" + (pinned || menusOpen > 0 ? " pinned" : "")}>
      <div className="git-tray-body">
        <span className="git-tray-grip" aria-hidden="true" />
        <div className="diff-actions">
          {(ahead > 0 || behind > 0) && (
            <button
              ref={syncChipRef}
              className={"git-chip sync-chip sync-chip-btn" + (pushFx ? " " + pushFx : "")}
              title="Show unpushed commits"
              onClick={openReview}
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
            <button className="git-chip stash-chip stash-chip-btn" title="View stashes" onClick={() => { requestStashFocus(); openReview(); }}>
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
            <button className="git-chip conflict-chip conflict-chip-btn" title="Resolve merge conflicts" onClick={openReview}>
              <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M7 1.5L13 12H1L7 1.5z" />
                <line x1="7" y1="5.5" x2="7" y2="8.5" />
                <circle cx="7" cy="10.3" r="0.4" fill="currentColor" stroke="none" />
              </svg>
              <span className="num">{conflicts}</span>
              <span className="lbl">{conflicts === 1 ? "conflict" : "conflicts"}</span>
            </button>
          )}
          {hasUnintegratedWork(diff) && (
            <>
              <button className="diff-badge diff-badge-btn" title="View changes" onClick={openReview}>
                {diff.insertions > 0 || diff.deletions > 0 ? (
                  <>
                    +{diff.insertions.toLocaleString()}{" "}
                    <span className="diff-neg">−{diff.deletions.toLocaleString()}</span>
                  </>
                ) : (
                  <>{diff.files} new</>
                )}
              </button>
              <SplitButton
                options={COMMIT_OPTIONS}
                mode={commitMode}
                onSelectMode={setCommitMode}
                onAction={(id) => api.sendWorkerAction(worker.id, id)}
                onOpenChange={onMenu}
                disabled={conflicts > 0}
                title={conflicts > 0 ? "Resolve conflicts first" : undefined}
              />
            </>
          )}
          {gs?.pushable && (
            <PushButton
              workerId={worker.id}
              label={pushKind === "set-upstream" ? "Publish" : "Push"}
              ahead={ahead}
              sourceRef={syncChipRef}
              onSourceFx={setPushFx}
              onSettled={refresh}
            />
          )}
          {gs?.pullable && <PullButton workerId={worker.id} onSettled={refresh} />}
          {Boolean(worker.is_orchestrator) && dirtyChildren.length >= 2 && (
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
            onOpenChange={onMenu}
          />
        </div>
      </div>
    </div>
  );
}
