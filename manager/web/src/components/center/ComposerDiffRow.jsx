import { useEffect, useState, useRef } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { basename } from "../../lib/path.js";

const DIFF_REFRESH_MS = 10000;

const PR_OPTIONS = [
  { id: "pr", label: "Create PR", icon: "pr" },
  { id: "draft", label: "Create draft PR", icon: "draft" },
  { id: "manual", label: "Manually create PR", icon: "external" },
];

function PrIcon({ type }) {
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
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.3">
      <circle cx="5" cy="4" r="1.5" /><circle cx="5" cy="12" r="1.5" /><circle cx="11" cy="8" r="1.5" />
      <path d="M5 5.5v5M6.5 8h3" />
    </svg>
  );
}

export function ComposerDiffRow({ live }) {
  const ui = useUi();
  const selected = live.workers.find((w) => w.id === ui.selectedId);
  const [diff, setDiff] = useState({ insertions: 0, deletions: 0, files: 0 });
  const [isGit, setIsGit] = useState(true);
  const [menuOpen, setMenuOpen] = useState(false);
  const [prMode, setPrMode] = useState("pr");
  const [remoteUrl, setRemoteUrl] = useState(null);
  const [currentBranch, setCurrentBranch] = useState(null);
  const menuRef = useRef(null);

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
    const checkGit = async () => {
      const cwd = selected?.cwd ?? selected?.worktree_from;
      if (!cwd) return;
      try {
        const r = await api.listBranches(cwd);
        if (!cancelled) {
          setIsGit(r.isGit !== false);
          setRemoteUrl(r.remoteUrl ?? null);
          setCurrentBranch(r.current ?? null);
        }
      } catch {}
    };
    checkGit();
    fetchDiff();
    const t = setInterval(fetchDiff, DIFF_REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); ac.abort(); };
  }, [ui.selectedId, selected?.cwd, selected?.worktree_from]);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (e) => {
      if (menuRef.current && !menuRef.current.contains(e.target)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  if (!selected || !isGit) return null;

  const folder = basename(selected.cwd ?? selected.worktree_from ?? "");
  const branch = selected.branch ?? "—";
  const activeOption = PR_OPTIONS.find((o) => o.id === prMode) ?? PR_OPTIONS[0];

  const handlePrAction = () => {
    if (prMode === "manual") {
      if (remoteUrl) {
        const b = currentBranch ?? branch;
        const prUrl = `${remoteUrl}/compare/main...${b}?quick_pull=1`;
        api.openFile(prUrl);
      }
      return;
    }
    const prompt = prMode === "draft"
      ? "Create a draft pull request for the current branch. Use `gh pr create --draft`."
      : "Create a pull request for the current branch. Use `gh pr create`.";
    api.sendWorkerMessage(ui.selectedId, prompt);
  };

  const selectMode = (id) => {
    setPrMode(id);
    setMenuOpen(false);
  };

  return (
    <div className="c-row-diff" id="composerDiffRow">
      <span className="diff-repo-label">
        <b>{folder}</b>
        <span className="diff-sep">·</span>
        <span className="diff-branch">{branch}</span>
      </span>
      <span className="diff-grow"></span>
      {(diff?.insertions > 0 || diff?.deletions > 0) && (
        <span className="diff-badge">
          +{diff.insertions.toLocaleString()}{" "}
          <span className="diff-neg">−{diff.deletions.toLocaleString()}</span>
        </span>
      )}
      <div className="pr-wrap" ref={menuRef}>
        {menuOpen && (
          <div className="pr-menu">
            {PR_OPTIONS.map((opt) => (
              <button key={opt.id} className={"pr-menu-item" + (prMode === opt.id ? " on" : "")} onClick={() => selectMode(opt.id)}>
                <PrIcon type={opt.icon} />
                <span>{opt.label}</span>
                {prMode === opt.id && (
                  <svg className="pr-menu-check" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="m3 8 3 3 7-7" />
                  </svg>
                )}
              </button>
            ))}
          </div>
        )}
        <button className="pr-create-btn" onClick={handlePrAction}>
          <span>{activeOption.label}</span>
        </button>
        <button className="pr-dropdown-toggle" onClick={() => setMenuOpen(!menuOpen)}>
          <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
            <path d="m4 6 4 4 4-4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
