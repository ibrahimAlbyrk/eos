import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Right panel listing committed-but-unpushed commits (@{u}..HEAD) for the
// repo behind the sync chip the user clicked. Read-only; pushing stays an
// agent action.
export function CommitsViewer() {
  const ui = useUi();
  const open = Boolean(ui.commitsViewer);
  return (
    <div className={"commits-viewer" + (open ? " cv-open" : "")}>
      {open && <CommitsViewerInner cwd={ui.commitsViewer.cwd} />}
    </div>
  );
}

function CommitsViewerInner({ cwd }) {
  const ui = useUi();
  const [commits, setCommits] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = async () => {
      const r = await api.getUnpushedCommits(cwd);
      if (!cancelled) setCommits(r.commits ?? []);
    };
    fetchOnce();
    const t = setInterval(fetchOnce, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, [cwd]);

  return (
    <>
      <div className="dv-head">
        <span className="dv-title">Unpushed commits</span>
        {commits && commits.length > 0 && (
          <span className="dv-totals">
            <span className="dv-count">{commits.length} commit{commits.length === 1 ? "" : "s"}</span>
          </span>
        )}
        <span className="dv-grow" />
        <button className="fv-icon-btn fv-close" onClick={ui.closeCommitsViewer} title="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="cv-list">
        {commits === null && <div className="dv-empty">Loading...</div>}
        {commits !== null && commits.length === 0 && <div className="dv-empty">Nothing to push</div>}
        {commits !== null && commits.map((c) => (
          <div className="cv-row" key={c.sha}>
            <span className="cv-sha">{c.sha}</span>
            <span className="cv-subject" title={c.subject}>{c.subject}</span>
            <span className="cv-meta">{c.author} · {ago(c.ts)}</span>
          </div>
        ))}
      </div>
    </>
  );
}
