import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { gitAgentName } from "../../../lib/gitAgentName.js";
import { addDispatched } from "../../../state/outboxStore.js";
import { notify } from "../../../lib/notify.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { useGitStatus } from "../../../hooks/useGitStatus.js";
import { hasUnintegratedWork } from "../../../lib/workState.js";
import { requestStashFocus } from "../../../state/gitDiffIntent.js";

const EMPTY = { isGit: true, current: null, branches: [], remoteUrl: null, ahead: 0, behind: 0, conflicts: 0 };

function BranchIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="5" r="1.5" />
      <path d="M4.5 5v6M11.5 6.5c0 2.2-2.7 2.6-4.5 3.2" />
    </svg>
  );
}

function CommitIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
      <circle cx="8" cy="8" r="2.5" />
      <line x1="1.5" y1="8" x2="5.5" y2="8" /><line x1="10.5" y1="8" x2="14.5" y2="8" />
    </svg>
  );
}

function RebaseIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="3.5" r="1.5" />
      <path d="M4.5 11V6.5a3 3 0 0 1 3-3h1.5" />
      <path d="m7.5 1.5 2 2-2 2" />
    </svg>
  );
}

function MergeIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4.5" cy="3.5" r="1.5" />
      <circle cx="4.5" cy="12.5" r="1.5" />
      <circle cx="11.5" cy="8" r="1.5" />
      <path d="M4.5 5v6M4.5 6a4 4 0 0 0 4 4h1.5" />
    </svg>
  );
}

function ConflictIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M7 1.5L13 12H1L7 1.5z" />
      <line x1="7" y1="5.5" x2="7" y2="8.5" />
      <circle cx="7" cy="10.3" r="0.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function SyncIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M5 13V5M2.5 7.5 5 5l2.5 2.5" />
      <path d="M11 3v8M8.5 8.5 11 11l2.5-2.5" />
    </svg>
  );
}

function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="m11.5 2.5 2 2L5 13l-2.7.7L3 11l8.5-8.5z" />
    </svg>
  );
}

function PrIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="4" cy="4" r="1.5" />
      <circle cx="4" cy="12" r="1.5" />
      <circle cx="12" cy="12" r="1.5" />
      <path d="M4 5.5v5M12 10.5V7a3 3 0 0 0-3-3H7" />
      <path d="m8.5 2.5-1.5 1.5 1.5 1.5" />
    </svg>
  );
}

function PushIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 13V5M5 8l3-3 3 3" />
      <line x1="4" y1="2.5" x2="12" y2="2.5" />
    </svg>
  );
}

function PullIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M8 3v8M5 8l3 3 3-3" />
      <line x1="4" y1="13.5" x2="12" y2="13.5" />
    </svg>
  );
}

function StashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="5.5" width="10" height="6.5" rx="1" />
      <line x1="3.5" y1="3.5" x2="10.5" y2="3.5" />
      <line x1="4.5" y1="1.5" x2="9.5" y2="1.5" />
    </svg>
  );
}

// The session's own git actions, on top of the git agent's: commit / PR go to
// the session's agent as worker actions, push / pull run directly. This menu is
// the only git door on the composer — nothing shows while it's closed.
function SessionGitSection({ live, worker, wtStatus }) {
  const ui = useUi();
  // Worktree dir first (cwd is NULL for worktree rows) — otherwise these rows
  // describe the user's checkout instead of where the agent edits.
  const gitDir = workerGitDir(worker);
  const { status: gs } = useGitStatus(worker.id, { gitDir });
  if (!gs?.isGit) return null;

  const diff = gs.diff ?? { insertions: 0, deletions: 0, files: 0 };
  const dirty = hasUnintegratedWork(diff);
  const ahead = gs.ahead ?? 0;
  const behind = gs.behind ?? 0;
  const stash = gs.stash ?? 0;
  const conflicts = gs.conflicts ?? 0;
  const dirtyChildren = wtStatus?.children ?? [];
  const blocked = conflicts > 0 ? "Resolve conflicts first" : undefined;

  const run = (fn) => () => {
    ui.closeAllPops();
    fn();
  };
  const action = (id) => run(() => api.sendWorkerAction(worker.id, id));
  const openReview = () => ui.openPanel("review", { workerId: worker.id, cwd: gitDir });

  // Fan-in: a git agent in a fresh worktree merges the orchestrator's child
  // branches into one verified result (children left intact).
  const integrate = run(async () => {
    const root = worker.cwd ?? worker.worktree_from;
    const r = await live.spawnGitAgent({
      worktreeFrom: root,
      promptTemplate: { id: "integrate", vars: { BRANCHES: dirtyChildren.map((w) => w.branch).filter(Boolean).join(", ") } },
      name: gitAgentName(root, gs.currentBranch ?? worker.branch, "merge"),
    });
    if (r?.ok && r.body?.id) ui.setSelectedId(r.body.id);
    else if (!r?.ok) notify.error(r?.body?.error ?? "integration failed to start");
  });

  return (
    <>
      <button className="menu-item gap-session" title="Review changes" onClick={run(openReview)}>
        <BranchIcon />
        <span className="gap-branch">{gs.currentBranch ?? worker.branch ?? "—"}</span>
        {conflicts > 0 ? (
          <span className="gap-meta gap-warn">{conflicts} {conflicts === 1 ? "conflict" : "conflicts"}</span>
        ) : dirty && (
          <span className="gap-meta">
            {diff.insertions > 0 || diff.deletions > 0 ? (
              <>
                <span className="gap-add">+{diff.insertions.toLocaleString()}</span>{" "}
                <span className="gap-del">−{diff.deletions.toLocaleString()}</span>
              </>
            ) : (
              <>{diff.files} new</>
            )}
          </span>
        )}
      </button>
      {dirty && (
        <>
          <button className="menu-item" disabled={conflicts > 0} title={blocked} onClick={action("commit")}>
            <CommitIcon />
            Commit
            <span className="gap-meta">{diff.files} {diff.files === 1 ? "file" : "files"}</span>
          </button>
          <button className="menu-item" disabled={conflicts > 0} title={blocked} onClick={action("commit-push")}>
            <PushIcon />
            Commit &amp; push
          </button>
        </>
      )}
      {gs.pushable && (
        <button className="menu-item" onClick={run(() => api.pushWorker(worker.id))}>
          <PushIcon />
          {gs.pushKind === "set-upstream" ? "Publish" : "Push"}
          {ahead > 0 && <span className="gap-meta">↑{ahead}</span>}
        </button>
      )}
      {gs.pullable && (
        <button className="menu-item" onClick={run(() => api.pullWorker(worker.id))}>
          <PullIcon />
          Pull
          {behind > 0 && <span className="gap-meta">↓{behind}</span>}
        </button>
      )}
      {stash > 0 && (
        <button className="menu-item" onClick={run(() => { requestStashFocus(); openReview(); })}>
          <StashIcon />
          View stashes
          <span className="gap-meta">{stash}</span>
        </button>
      )}
      {Boolean(worker.is_orchestrator) && dirtyChildren.length >= 2 && (
        <button
          className="menu-item"
          title="Merge these worktree branches into one verified result — spawns a git agent in a fresh worktree (originals untouched)"
          onClick={integrate}
        >
          <MergeIcon />
          Merge all
          <span className="gap-meta">{dirtyChildren.length}</span>
        </button>
      )}
      <button className="menu-item" onClick={action("pr")}>
        <PrIcon />
        Create PR
      </button>
      <button className="menu-item" onClick={action("draft-pr")}>
        <PrIcon />
        Create draft PR
      </button>
      <div className="gap-sep"></div>
    </>
  );
}

export function GitAgentPopover({ live, worker, cwd, wtStatus }) {
  const ui = useUi();
  const open = ui.openPopover === "git-agent";
  const [info, setInfo] = useState(EMPTY);
  const [picking, setPicking] = useState(null);
  const [filter, setFilter] = useState("");

  useEffect(() => {
    if (!open || !cwd) return;
    setPicking(null);
    setFilter("");
    let cancelled = false;
    api.listBranches(cwd)
      .then((r) => { if (!cancelled) setInfo({ ...EMPTY, ...r }); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [open, cwd]);

  if (!open) return null;

  const spawn = async (prompt, label, attach = null) => {
    ui.closeAllPops();
    // attach = {workspaceOf, branch}: tree-level ops on a selected worktree
    // worker run INSIDE its worktree, not in the checkout.
    const r = await live.spawnGitAgent(
      attach
        ? { workspaceOf: attach.workspaceOf, prompt, name: gitAgentName(cwd, attach.branch, label) }
        : { cwd, prompt, name: gitAgentName(cwd, info.current, label) },
    );
    if (r?.ok && r.body?.id) {
      ui.setSelectedId(r.body.id);
      addDispatched(r.body.id, { text: prompt });
    } else if (!r?.ok) {
      notify.error(r?.body?.error ?? "git agent spawn failed");
    }
  };

  const startCustom = () => {
    ui.closeAllPops();
    ui.toggleGitMode(true);
  };

  const current = info.current;
  // This pane's own worker (not the global selection) — the integrate/commit
  // options attach to THIS pane's worktree agent.
  const selected = worker ?? null;
  // Worktree workers' eos-* branch: integrate it from the user's checkout —
  // the popover's cwd — with the branch named explicitly (the git agent can't
  // infer it from its own cwd).
  const agentBranch = selected?.worktree_from && selected?.branch ? selected.branch : null;
  // Tree-level ops (commit) on a selected worktree worker attach INSIDE its
  // worktree so the agent has direct access to that tree's state.
  const treeAttach = selected?.worktree_dir && selected?.branch
    ? { workspaceOf: selected.id, branch: selected.branch }
    : null;
  const allBranches = (info.branches ?? []).filter((b) => b !== current);
  const shown = filter
    ? allBranches.filter((b) => b.toLowerCase().includes(filter.toLowerCase()))
    : allBranches;

  const pickBranch = (b) => {
    const prompt = picking === "rebase"
      ? `Rebase the current branch (${current}) onto ${b}. Resolve any conflicts preserving both sides' intent.`
      : `Merge branch ${b} into the current branch (${current}). Resolve any conflicts preserving both sides' intent.`;
    spawn(prompt, `${picking} ${b}`);
  };

  if (!cwd || info.isGit === false) {
    return (
      <div className="git-agent-popover ca-pop ca-git-agent open" data-popover="git-agent">
        <div className="gap-empty">{!cwd ? "Pick a folder first" : "Not a git repository"}</div>
      </div>
    );
  }

  // With a session, its own section leads and covers PRs — the agent part
  // below drops its PR rows; its commit stays (a separate git agent).
  const sessionLed = Boolean(selected) && !picking;

  return (
    <div className="git-agent-popover ca-pop ca-git-agent open" data-popover="git-agent">
      {sessionLed && <SessionGitSection live={live} worker={selected} wtStatus={wtStatus} />}
      <div className="gap-head">
        {sessionLed ? (
          <span className="gap-label">Git agent</span>
        ) : (
          <>
            <BranchIcon />
            <span className="gap-branch">{current ?? "—"}</span>
            {(info.ahead > 0 || info.behind > 0) && (
              <span className="gap-sync">
                {info.ahead > 0 && <span>↑{info.ahead}</span>}
                {info.behind > 0 && <span>↓{info.behind}</span>}
              </span>
            )}
          </>
        )}
        <span className="gap-grow"></span>
        <span className="gap-model">sonnet</span>
      </div>
      {picking ? (
        <>
          <input
            className="gap-search"
            autoFocus
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={picking === "rebase" ? "Rebase onto…" : "Merge branch…"}
            onKeyDown={(e) => { if (e.key === "Enter" && shown[0]) pickBranch(shown[0]); }}
          />
          <div className="gap-branches">
            {shown.length === 0 && <div className="gap-empty">No branches</div>}
            {shown.map((b) => (
              <button key={b} className="menu-item" onClick={() => pickBranch(b)}>
                <BranchIcon />
                <span className="gap-ellipsis">{b}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <>
          <button className="menu-item" onClick={() => spawn("Stage and commit the current changes. Review the diff first; split unrelated changes into atomic conventional commits.", "commit", treeAttach)}>
            <CommitIcon />
            Commit changes
          </button>
          {agentBranch && (
            <button className="menu-item" onClick={() => spawn(`Merge branch ${agentBranch} into the current branch (${current}). Context: ${agentBranch} is a live Eos agent worktree branch — never check it out or delete it. Resolve any conflicts preserving both sides' intent.`, `merge ${agentBranch}`)}>
              <MergeIcon />
              <span className="gap-ellipsis">Integrate {agentBranch}</span>
            </button>
          )}
          <button className="menu-item" onClick={() => setPicking("rebase")}>
            <RebaseIcon />
            Rebase onto…
          </button>
          <button className="menu-item" onClick={() => setPicking("merge")}>
            <MergeIcon />
            Merge branch…
          </button>
          {info.conflicts > 0 && (
            <button className="menu-item warn" onClick={() => spawn(`Resolve the ${info.conflicts} merge conflict(s) currently in the working tree, preserving both sides' intent.`, "conflicts")}>
              <ConflictIcon />
              Resolve {info.conflicts} {info.conflicts === 1 ? "conflict" : "conflicts"}
            </button>
          )}
          {(info.ahead > 0 || info.behind > 0) && (
            <button className="menu-item" onClick={() => spawn(`Sync the current branch with its remote (ahead ${info.ahead}, behind ${info.behind}). Prefer pull --rebase; ask before any force push.`, "sync")}>
              <SyncIcon />
              Sync with remote
            </button>
          )}
          {info.remoteUrl && !sessionLed && (
            <>
              <button className="menu-item" onClick={() => spawn(`Open a pull request for the current branch (${current}). Make sure the branch is committed and pushed first, then write the title and body yourself.`, "pr")}>
                <PrIcon />
                Create PR
              </button>
              <button className="menu-item" onClick={() => spawn(`Open a draft pull request for the current branch (${current}). Make sure the branch is committed and pushed first, then write the title and body yourself.`, "draft pr")}>
                <PrIcon />
                Create draft PR
              </button>
            </>
          )}
          <div className="gap-sep"></div>
          <button className="menu-item" onClick={startCustom}>
            <PencilIcon />
            Custom git task…
            <kbd>⌘G</kbd>
          </button>
        </>
      )}
    </div>
  );
}
