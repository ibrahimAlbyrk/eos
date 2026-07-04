import { useEffect, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { subscribeGitChange, COMMITS_KINDS, GIT_FALLBACK_POLL_MS } from "../../../state/gitChangeBus.js";
import { PanelCloseButton } from "./PanelCloseButton.jsx";

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
    <div className="commits-viewer cv-open">
      {open && <CommitsViewerInner cwd={ui.commitsViewer.cwd} />}
    </div>
  );
}

function CommitsViewerInner({ cwd }) {
  const ui = useUi();
  const [commits, setCommits] = useState(null);
  // Commits are expanded by default; the set tracks what the user collapsed.
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [details, setDetails] = useState(() => new Map());

  useEffect(() => {
    setCommits(null);
    setCollapsed(new Set());
    setDetails(new Map());
    let cancelled = false;
    const fetchOnce = async () => {
      const r = await api.getUnpushedCommits(cwd);
      if (!cancelled) setCommits(r.commits ?? []);
    };
    fetchOnce();
    // Push path: a commit/push/reset in this repo (any source) refetches at once.
    // The interval is just the backstop now (was the only signal — SSE-blind).
    const t = setInterval(fetchOnce, GIT_FALLBACK_POLL_MS);
    const unsub = subscribeGitChange(cwd, COMMITS_KINDS, fetchOnce);
    return () => { cancelled = true; clearInterval(t); unsub(); };
  }, [cwd]);

  // Load the detail of every open commit that has none yet — covers the
  // initial list and re-expanding after a collapse.
  useEffect(() => {
    for (const c of commits ?? []) {
      if (collapsed.has(c.sha) || details.has(c.sha)) continue;
      setDetails((prev) => new Map(prev).set(c.sha, { loading: true }));
      api.getCommitDetail(cwd, c.sha)
        .then((data) => setDetails((prev) => new Map(prev).set(c.sha, { loading: false, data })))
        .catch((e) => setDetails((prev) => new Map(prev).set(c.sha, { loading: false, error: e.message })));
    }
  }, [commits, collapsed, details, cwd]);

  const toggle = (sha) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(sha)) next.delete(sha); else next.add(sha);
      return next;
    });
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
        <PanelCloseButton onClose={ui.closeCommitsViewer} />
      </div>
      <div className="cv-list">
        {commits === null && <div className="dv-empty">Loading...</div>}
        {commits !== null && commits.length === 0 && <div className="dv-empty">Nothing to push</div>}
        {commits !== null && commits.map((c) => (
          <div className={"cv-commit" + (collapsed.has(c.sha) ? "" : " open")} key={c.sha}>
            <button className="cv-row" onClick={() => toggle(c.sha)}>
              <svg className="cv-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="m6 4 4 4-4 4" />
              </svg>
              <span className="cv-sha">{c.sha}</span>
              <span className="cv-subject" title={c.subject}>{c.subject}</span>
              <span className="cv-meta">{c.author} · {ago(c.ts)}</span>
            </button>
            {!collapsed.has(c.sha) && (
              <CommitDetail
                detail={details.get(c.sha)}
                onOpenFile={(f) => ui.openFileViewer(cwd + "/" + f.path)}
              />
            )}
          </div>
        ))}
      </div>
    </>
  );
}

function CommitDetail({ detail, onOpenFile }) {
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
        {d.files.map((f) => {
          // Files this commit deleted have nothing on disk to open.
          const openable = f.status !== "D";
          return (
          <div className="cv-file" key={f.path}>
            <span className={"dv-st dv-st-" + f.status.toLowerCase()} title={f.oldPath ? `${f.oldPath} → ${f.path}` : undefined}>
              {STATUS_LABEL[f.status]}
            </span>
            <span
              className={"cv-file-path" + (openable ? " dv-openable" : "")}
              title={f.path}
              onClick={openable ? () => onOpenFile(f) : undefined}
            >
              {f.path}
            </span>
            <span className="cv-file-counts">
              {f.insertions !== null && f.insertions > 0 && <span className="dv-add">+{f.insertions}</span>}
              {f.deletions !== null && f.deletions > 0 && <span className="dv-del">−{f.deletions}</span>}
              {f.insertions === null && <span className="dv-bin">bin</span>}
            </span>
          </div>
          );
        })}
      </div>
    </div>
  );
}
