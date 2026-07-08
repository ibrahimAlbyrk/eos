import { useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { subscribeGitChange, COMMITS_KINDS, GIT_FALLBACK_POLL_MS } from "../../../state/gitChangeBus.js";
import { fmtTimeAgo } from "../../../lib/format.js";

// /fs/log caps limit at 100 — refreshes clamp their window to it.
const PAGE = 30;
const LOG_LIMIT_MAX = 100;

const shortSha = (sha) => sha.slice(0, 7);

// Sidebar-bottom commit history. "All changes" restores the working-tree
// scope; a commit row scopes the panel to that single commit. New commits
// land via the git-change bus (head/refs) with the poll as backstop
// (CommitsViewer idiom); a refresh re-reads the already-loaded window so
// "show more" pages survive it.
export function GitDiffCommits({ cwd, scope, onScope }) {
  const [commits, setCommits] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [paging, setPaging] = useState(false);
  const countRef = useRef(0);

  useEffect(() => {
    setCommits(null);
    setHasMore(false);
    countRef.current = 0;
    let cancelled = false;
    const refetch = async () => {
      const limit = Math.min(Math.max(PAGE, countRef.current), LOG_LIMIT_MAX);
      const r = await api.getGitLog(cwd, { limit });
      if (cancelled) return;
      setCommits(r.commits ?? []);
      setHasMore(Boolean(r.hasMore));
      countRef.current = (r.commits ?? []).length;
    };
    refetch();
    const t = setInterval(refetch, GIT_FALLBACK_POLL_MS);
    const unsub = subscribeGitChange(cwd, COMMITS_KINDS, refetch);
    return () => { cancelled = true; clearInterval(t); unsub(); };
  }, [cwd]);

  const showMore = async () => {
    setPaging(true);
    try {
      const r = await api.getGitLog(cwd, { limit: PAGE, skip: countRef.current });
      setCommits((prev) => {
        const seen = new Set((prev ?? []).map((c) => c.sha));
        const merged = [...(prev ?? []), ...(r.commits ?? []).filter((c) => !seen.has(c.sha))];
        countRef.current = merged.length;
        return merged;
      });
      setHasMore(Boolean(r.hasMore));
    } finally {
      setPaging(false);
    }
  };

  return (
    <div className="gd-commits">
      <div className="gd-commits-title">History</div>
      <div className="gd-commits-list">
        <button
          className={"gd-commit" + (scope.kind !== "commit" ? " on" : "")}
          onClick={() => onScope({ kind: "all" })}
        >
          <span className="gd-commit-subject">All changes</span>
        </button>
        {commits === null && <div className="gd-commits-note">Loading...</div>}
        {commits !== null && commits.length === 0 && <div className="gd-commits-note">No commits</div>}
        {(commits ?? []).map((c) => (
          <button
            key={c.sha}
            className={"gd-commit" + (scope.kind === "commit" && scope.sha === c.sha ? " on" : "")}
            title={c.subject}
            onClick={() => onScope({ kind: "commit", sha: c.sha, subject: c.subject })}
          >
            <span className="gd-commit-subject">{c.subject}</span>
            <span className="gd-commit-meta">{shortSha(c.sha)} · {c.author} · {fmtTimeAgo(c.ts)}</span>
          </button>
        ))}
        {hasMore && (
          <button className="gd-commit gd-more" onClick={showMore} disabled={paging}>
            {paging ? "Loading..." : "Show more"}
          </button>
        )}
      </div>
    </div>
  );
}
