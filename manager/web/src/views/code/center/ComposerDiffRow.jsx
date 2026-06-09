import { useEffect, useState, useRef } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { basename } from "../../../lib/path.js";
import { VerifyButton } from "../VerifyButton.jsx";
import { useWorkerVerdict } from "../../../hooks/useWorkerVerdict.js";

const DIFF_REFRESH_MS = 10000;

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
      <button className="pr-create-btn" disabled={disabled} title={title} onClick={() => onAction(active.id)}>
        <span>{active.label}</span>
      </button>
      <button className="pr-dropdown-toggle" disabled={disabled} onClick={() => setOpen(!open)}>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
    </div>
  );
}

// Orchestrator hub strip: one row per worktree child with unintegrated work.
// The user reviews/tests the whole fleet from the orchestrator screen — the
// badge opens that child's Changes panel (Verify/Try live in its header)
// without changing the selection.
function ChildIntegrationRow({ child, ui, live }) {
  const [diff, setDiff] = useState(null);
  const [tryState, setTryState] = useState({ activeTry: null, kept: false });
  const fetchRef = useRef(null);
  useEffect(() => {
    let cancelled = false;
    const fetchDiff = async () => {
      const [r, ts] = await Promise.all([api.getWorkerDiff(child.id), api.getTryState(child.id)]);
      if (!cancelled) { setDiff(r); setTryState(ts); }
    };
    fetchRef.current = fetchDiff;
    fetchDiff();
    const t = setInterval(fetchDiff, DIFF_REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); fetchRef.current = null; };
  }, [child.id]);

  // SSE-driven: the child's own activity (tool events, try_*) refreshes its
  // badge promptly; debounced per burst, the interval above stays as the
  // fallback for out-of-band edits.
  useEffect(() => {
    if (live.eventSignal.workerId !== child.id) return;
    const t = setTimeout(() => fetchRef.current?.(), 600);
    return () => clearTimeout(t);
  }, [live.eventSignal.tick, live.eventSignal.workerId, child.id]);

  // Verdict from the child's OWN transcript (same selector as its own view —
  // covers a user-clicked /verify that produced no parent report); the
  // report-parsed Handover stays as fallback.
  const derived = useWorkerVerdict(child.id, live);
  const reported = ui.verdict?.children?.[child.id] ?? null;
  const verdict = derived && derived.verdict !== "unverified" ? derived : reported;
  const applied = Boolean(tryState.kept || tryState.activeTry?.workerId === child.id);
  const dirty = diff && (diff.insertions > 0 || diff.deletions > 0 || diff.files > 0);
  if (!dirty && !verdict && !applied) return null;

  const viewing = ui.diffViewer?.workerId === child.id;
  return (
    <div className="child-int-row">
      <span className="cir-name" title={child.branch ?? undefined}>{child.name ?? child.id}</span>
      {verdict && verdict.verdict !== "unverified" && (
        <span className={"git-chip verdict-chip verdict-" + verdict.verdict} title={verdict.command ? `verified by: ${verdict.command}` : undefined}>
          <span className="lbl">{verdict.verdict}</span>
        </span>
      )}
      {applied && (
        <span className="git-chip applied-chip" title={tryState.kept ? "These changes were applied to your checkout and kept" : "These changes are currently applied in your checkout"}>
          <span className="lbl">applied</span>
        </span>
      )}
      <span className="diff-grow"></span>
      {dirty ? (
        <button
          className={"diff-badge diff-badge-btn" + (viewing ? " on" : "")}
          title="Review, verify and try this worker's changes"
          onClick={() => (viewing ? ui.closeDiffViewer() : ui.openDiffViewer(child.id))}
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
      ) : (
        <span className="cir-clean">integrated</span>
      )}
    </div>
  );
}

export function ComposerDiffRow({ live }) {
  const ui = useUi();
  const selected = live.workers.find((w) => w.id === ui.selectedId);
  const [diff, setDiff] = useState({ insertions: 0, deletions: 0, files: 0 });
  const [isGit, setIsGit] = useState(true);
  const [prMode, setPrMode] = useState("pr");
  const [commitMode, setCommitMode] = useState("commit");
  const [remoteUrl, setRemoteUrl] = useState(null);
  const [currentBranch, setCurrentBranch] = useState(null);
  const [ahead, setAhead] = useState(0);
  const [behind, setBehind] = useState(0);
  const [hasUpstream, setHasUpstream] = useState(true);
  const [stash, setStash] = useState(0);
  const [conflicts, setConflicts] = useState(0);
  const [pushing, setPushing] = useState(false);

  const fetchDiffRef = useRef(null);
  const checkGitRef = useRef(null);

  useEffect(() => {
    if (!ui.selectedId) return;
    const ac = new AbortController();
    let cancelled = false;
    const fetchDiff = async () => {
      try {
        const r = await api.getWorkerDiff(ui.selectedId, { signal: ac.signal });
        if (!cancelled) {
          if (r && (r.files > 0 || r.insertions > 0 || r.deletions > 0)) setIsGit(true);
          setDiff(r ?? { insertions: 0, deletions: 0, files: 0 });
        }
      } catch {}
    };
    fetchDiffRef.current = fetchDiff;
    const checkGit = async () => {
      // Where the agent actually edits: worktree dir first (cwd is NULL for
      // worktree rows) — otherwise these chips describe the USER'S repo while
      // the diff badge reads the worktree.
      const cwd = selected?.worktree_dir ?? selected?.cwd ?? selected?.worktree_from;
      if (!cwd) return;
      try {
        const r = await api.listBranches(cwd);
        if (!cancelled) {
          setIsGit(r.isGit !== false);
          setRemoteUrl(r.remoteUrl ?? null);
          setCurrentBranch(r.current ?? null);
          // ahead === null ⇒ no upstream (branch not yet published).
          setHasUpstream(r.ahead !== null);
          setAhead(r.ahead ?? 0);
          setBehind(r.behind ?? 0);
          setStash(r.stash ?? 0);
          setConflicts(r.conflicts ?? 0);
        }
      } catch {}
    };
    checkGitRef.current = checkGit;
    checkGit();
    fetchDiff();
    const t = setInterval(() => { fetchDiff(); checkGit(); }, DIFF_REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); ac.abort(); fetchDiffRef.current = null; checkGitRef.current = null; };
  }, [ui.selectedId, selected?.cwd, selected?.worktree_from, selected?.worktree_dir]);

  // SSE-driven: the selected agent's activity refreshes the badge promptly.
  // Debounced per event burst; /diff is one cheap git call, and identical
  // in-flight GETs are deduplicated by the client. The interval above stays
  // as the fallback for edits that emit no events.
  useEffect(() => {
    if (live.eventSignal.workerId !== ui.selectedId) return;
    const t = setTimeout(() => fetchDiffRef.current?.(), 600);
    return () => clearTimeout(t);
  }, [live.eventSignal.tick, live.eventSignal.workerId, ui.selectedId]);

  if (!selected || !isGit) return null;

  const isolated = Boolean(selected.worktree_dir || (selected.worktree_from && selected.branch));
  const isOrchestrator = Boolean(selected.is_orchestrator);
  const folder = basename(selected.cwd ?? selected.worktree_from ?? "");
  const branch = currentBranch ?? selected.branch ?? null;
  const verdict = ui.verdict?.workerId === selected.id ? ui.verdict : null;
  const showVerdict = verdict && verdict.verdict !== "unverified";
  // Hub strip: the orchestrator's worktree children, reviewed/tried from here.
  const childWorkers = isOrchestrator
    ? live.workers.filter((w) => w.parent_id === selected.id && w.worktree_from && w.branch)
    : [];

  const handlePrAction = (id) => {
    if (id === "manual") {
      if (remoteUrl) {
        const b = currentBranch ?? branch;
        const prUrl = `${remoteUrl}/compare/main...${b}?quick_pull=1`;
        api.openFile(prUrl);
      }
      return;
    }
    api.sendWorkerAction(ui.selectedId, id === "draft" ? "draft-pr" : "pr");
  };

  const handleCommitAction = (id) => {
    api.sendWorkerAction(ui.selectedId, id);
  };

  // Deterministic push — the daemon picks the right variant (set-upstream /
  // fast-forward / force-with-lease); no agent turn. Result lands in chat via
  // the git_push event; refresh the sync chip once it settles.
  const handlePush = async () => {
    if (pushing) return;
    setPushing(true);
    try { await api.pushWorker(ui.selectedId); }
    finally { setPushing(false); checkGitRef.current?.(); }
  };

  const showSync = ahead > 0 || behind > 0;
  const dirty = diff?.insertions > 0 || diff?.deletions > 0 || diff?.files > 0;
  // Show Push when clean and there's something to publish: commits ahead, or a
  // local-only branch (no upstream) that has a remote to push to.
  const unpublished = !hasUpstream && !!remoteUrl;
  const showPushOnly = !dirty && !!branch && (ahead > 0 || unpublished);

  return (
    <>
    {childWorkers.length > 0 && (
      <div className="child-int-panel">
        {childWorkers.map((w) => (
          <ChildIntegrationRow key={w.id} child={w} ui={ui} live={live} />
        ))}
      </div>
    )}
    <div className="c-row-diff" id="composerDiffRow">
      <span className="diff-repo-label">
        <b>{folder}</b>
        {branch && (
          <>
            <span className="diff-sep">·</span>
            <span className="diff-branch">{branch}</span>
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
      <span className="diff-grow"></span>
      {showSync && (
        <button
          className={"git-chip sync-chip sync-chip-btn" + (ui.commitsViewer ? " on" : "")}
          title="Show unpushed commits"
          onClick={() => {
            if (ui.commitsViewer) { ui.closeCommitsViewer(); return; }
            const dir = selected.worktree_dir ?? selected.cwd ?? selected.worktree_from;
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
        <span className="git-chip stash-chip">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2" y="5.5" width="10" height="6.5" rx="1" />
            <line x1="3.5" y1="3.5" x2="10.5" y2="3.5" />
            <line x1="4.5" y1="1.5" x2="9.5" y2="1.5" />
          </svg>
          <span className="num">{stash}</span>
          <span className="lbl">stashed</span>
        </span>
      )}
      {conflicts > 0 && (
        <span className="git-chip conflict-chip">
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M7 1.5L13 12H1L7 1.5z" />
            <line x1="7" y1="5.5" x2="7" y2="8.5" />
            <circle cx="7" cy="10.3" r="0.4" fill="currentColor" stroke="none" />
          </svg>
          <span className="num">{conflicts}</span>
          <span className="lbl">{conflicts === 1 ? "conflict" : "conflicts"}</span>
        </span>
      )}
      {(diff?.insertions > 0 || diff?.deletions > 0 || diff?.files > 0) && (
        <button
          className={"diff-badge diff-badge-btn" + (ui.diffViewer ? " on" : "")}
          title="View changes"
          onClick={() => (ui.diffViewer ? ui.closeDiffViewer() : ui.openDiffViewer(ui.selectedId))}
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
      {dirty && !isOrchestrator && (
        <VerifyButton
          workerId={ui.selectedId}
          workerState={selected.state}
          className="pr-create-btn pr-solo"
        />
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
      {showPushOnly && (
        <button className="pr-create-btn pr-solo" onClick={handlePush} disabled={pushing}>
          <OptionIcon type="push" />
          <span>{pushing ? "Pushing…" : unpublished ? "Publish" : "Push"}</span>
        </button>
      )}
      <SplitButton
        options={PR_OPTIONS}
        mode={prMode}
        onSelectMode={setPrMode}
        onAction={handlePrAction}
      />
    </div>
    </>
  );
}
