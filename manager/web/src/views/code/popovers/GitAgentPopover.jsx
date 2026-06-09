import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { gitAgentName } from "../../../lib/gitAgentName.js";

const EMPTY = { isGit: true, current: null, branches: [], ahead: 0, behind: 0, conflicts: 0 };

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

export function GitAgentPopover({ live, cwd }) {
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
      ui.addOptimisticUserMessage(r.body.id, prompt, prompt);
    } else if (!r?.ok) {
      alert(r?.body?.error ?? "git agent spawn failed");
    }
  };

  const startCustom = () => {
    ui.closeAllPops();
    ui.toggleGitMode(true);
  };

  const current = info.current;
  const selected = live.workers.find((w) => w.id === ui.selectedId);
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
      <div className="git-agent-popover glass-pop open" data-popover="git-agent">
        <div className="gap-empty">{!cwd ? "Pick a folder first" : "Not a git repository"}</div>
      </div>
    );
  }

  return (
    <div className="git-agent-popover glass-pop open" data-popover="git-agent">
      <div className="gap-head">
        <BranchIcon />
        <span className="gap-branch">{current ?? "—"}</span>
        {(info.ahead > 0 || info.behind > 0) && (
          <span className="gap-sync">
            {info.ahead > 0 && <span>↑{info.ahead}</span>}
            {info.behind > 0 && <span>↓{info.behind}</span>}
          </span>
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
