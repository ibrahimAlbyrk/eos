import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";

const STATUS_LABEL = { M: "M", A: "A", D: "D", R: "R" };

function ago(ts) {
  const m = Math.floor((Date.now() - ts) / 60000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// Right panel listing committed-but-unpushed commits (@{u}..HEAD) for the
// repo behind the sync chip the user clicked. Each row expands to the full
// commit detail (message body + per-file change list). Read-only; pushing
// stays an agent action.
export function CommitsViewer() {
  const ui = useUi();
  const open = Boolean(ui.commitsViewer);
  return (
    <div className={"commits-viewer" + (ui.topPanelType === "commits" ? " cv-open" : "")}>
      {open && <CommitsViewerInner cwd={ui.commitsViewer.cwd} />}
    </div>
  );
}

function CommitsViewerInner({ cwd }) {
  const ui = useUi();
  const [commits, setCommits] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [details, setDetails] = useState(() => new Map());

  useEffect(() => {
    setCommits(null);
    setExpanded(new Set());
    setDetails(new Map());
    let cancelled = false;
    const fetchOnce = async () => {
      const r = await api.getUnpushedCommits(cwd);
      if (!cancelled) setCommits(r.commits ?? []);
    };
    fetchOnce();
    const t = setInterval(fetchOnce, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, [cwd]);

  const toggle = (sha) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha); else next.add(sha);
      return next;
    });
    if (!details.has(sha)) {
      setDetails((prev) => new Map(prev).set(sha, { loading: true }));
      api.getCommitDetail(cwd, sha)
        .then((data) => setDetails((prev) => new Map(prev).set(sha, { loading: false, data })))
        .catch((e) => setDetails((prev) => new Map(prev).set(sha, { loading: false, error: e.message })));
    }
  };

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
          <div className={"cv-commit" + (expanded.has(c.sha) ? " open" : "")} key={c.sha}>
            <button className="cv-row" onClick={() => toggle(c.sha)}>
              <svg className="cv-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 4 4 4-4 4" />
              </svg>
              <span className="cv-sha">{c.sha}</span>
              <span className="cv-subject" title={c.subject}>{c.subject}</span>
              <span className="cv-meta">{c.author} · {ago(c.ts)}</span>
            </button>
            {expanded.has(c.sha) && <CommitDetail detail={details.get(c.sha)} />}
          </div>
        ))}
      </div>
    </>
  );
}

function CommitDetail({ detail }) {
  if (!detail || detail.loading) return <div className="dv-patch-note">Loading...</div>;
  if (detail.error) return <div className="dv-patch-note dv-patch-err">{detail.error}</div>;
  const d = detail.data;
  return (
    <div className="cv-detail">
      {d.body && <pre className="cv-body">{d.body}</pre>}
      <div className="cv-stats">
        <span className="dv-add">+{d.insertions.toLocaleString()}</span>
        <span className="dv-del">−{d.deletions.toLocaleString()}</span>
        <span className="dv-count">{d.files.length} file{d.files.length === 1 ? "" : "s"} changed</span>
      </div>
      <div className="cv-files">
        {d.files.map((f) => (
          <div className="cv-file" key={f.path}>
            <span className={"dv-st dv-st-" + f.status.toLowerCase()} title={f.oldPath ? `${f.oldPath} → ${f.path}` : undefined}>
              {STATUS_LABEL[f.status]}
            </span>
            <span className="cv-file-path" title={f.path}>{f.path}</span>
            <span className="cv-file-counts">
              {f.insertions !== null && f.insertions > 0 && <span className="dv-add">+{f.insertions}</span>}
              {f.deletions !== null && f.deletions > 0 && <span className="dv-del">−{f.deletions}</span>}
              {f.insertions === null && <span className="dv-bin">bin</span>}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
