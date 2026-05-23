import { useEffect, useState } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { basename } from "../../lib/path.js";

const DIFF_REFRESH_MS = 10000;

export function ComposerDiffRow({ live }) {
  const ui = useUi();
  const selected = live.workers.find((w) => w.id === ui.selectedId);
  const [diff, setDiff] = useState({ insertions: 0, deletions: 0, files: 0 });

  useEffect(() => {
    if (!ui.selectedId) return;
    const ac = new AbortController();
    let cancelled = false;
    const fetchDiff = async () => {
      try {
        const r = await api.getWorkerDiff(ui.selectedId, { signal: ac.signal });
        if (!cancelled) setDiff(r ?? { insertions: 0, deletions: 0, files: 0 });
      } catch { /* aborted or transient — ignore */ }
    };
    fetchDiff();
    const t = setInterval(fetchDiff, DIFF_REFRESH_MS);
    return () => { cancelled = true; clearInterval(t); ac.abort(); };
  }, [ui.selectedId]);

  if (!selected) return null;

  const folder = basename(selected.cwd ?? selected.worktree_from ?? "");
  const branch = selected.branch ?? "—";

  return (
    <div className="c-row-diff" id="composerDiffRow">
      <span className="diff-repo-label">
        <b>{folder}</b>
        <span className="diff-sep">·</span>
        <span className="diff-branch">{branch}</span>
      </span>
      <span className="diff-grow"></span>
      <span className="diff-badge">
        +{(diff?.insertions ?? 0).toLocaleString()}{" "}
        <span className="diff-neg">−{(diff?.deletions ?? 0).toLocaleString()}</span>
      </span>
      <button
        className="pr-create-btn"
        title="Create pull request (not implemented yet)"
        onClick={() => alert("Create PR is not implemented in the daemon yet.")}
      >
        <span>Create PR</span>
        <svg width="8" height="8" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.7">
          <path d="m4 6 4 4 4-4" />
        </svg>
      </button>
    </div>
  );
}
