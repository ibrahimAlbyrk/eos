import { useEffect, useState } from "react";
import { api } from "../../../api/client.js";
import { subscribeGitChange, STASH_KINDS, GIT_FALLBACK_POLL_MS } from "../../../state/gitChangeBus.js";
import { fmtTimeAgo } from "../../../lib/format.js";

// Sidebar stashes section (near History). Each row scopes the panel to that
// stash's diff via the commit-scope path (its sha diffs first-parent server
// side, so image before/after works unchanged). View-only — no apply/pop/drop.
// Hidden entirely when the repo has no stashes. Refreshes on the git-change
// bus "stash" kind with the shared poll backstop (CommitsViewer idiom).
export function GitDiffStashes({ cwd, scope, onScope }) {
  const [stashes, setStashes] = useState(null);

  useEffect(() => {
    setStashes(null);
    let cancelled = false;
    const refetch = async () => {
      const r = await api.getGitStashes(cwd);
      if (!cancelled) setStashes(r.stashes ?? []);
    };
    refetch();
    const t = setInterval(refetch, GIT_FALLBACK_POLL_MS);
    const unsub = subscribeGitChange(cwd, STASH_KINDS, refetch);
    return () => { cancelled = true; clearInterval(t); unsub(); };
  }, [cwd]);

  // Hidden until loaded and only when non-empty — the section shouldn't take
  // sidebar space in the common no-stash repo.
  if (!stashes || stashes.length === 0) return null;

  return (
    <div className="gd-commits">
      <div className="gd-commits-title">Stashes</div>
      <div className="gd-commits-list">
        {stashes.map((s) => (
          <button
            key={s.sha}
            className={"gd-commit" + (scope.kind === "commit" && scope.sha === s.sha ? " on" : "")}
            title={s.subject}
            onClick={() => onScope({ kind: "commit", sha: s.sha, subject: s.subject })}
          >
            <span className="gd-commit-subject">stash@{"{"}{s.index}{"}"} · {s.subject}</span>
            <span className="gd-commit-meta">{fmtTimeAgo(s.ts)}{s.branch ? ` · ${s.branch}` : ""}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
