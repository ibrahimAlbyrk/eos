import { useGitLog, useGitStashes } from "../../../hooks/useGitHistory.js";
import { fmtTimeAgo } from "../../../lib/format.js";
import { AnchoredMenu } from "./AnchoredMenu.jsx";
import { BranchGlyph, CheckGlyph, EditGlyph, CommitGlyph, StashGlyph } from "./glyphs.jsx";

const shortSha = (sha) => sha.slice(0, 7);

// What the Changes panel compares: the branch against its base, the
// uncommitted work only, one commit from history, or a stash. Stash rows carry
// Apply / Delete (the delete confirm is the viewer's — it outlives this menu).
export function ScopeMenu({ anchorRef, cwd, scope, baseLabel, onScope, onStash, onClose }) {
  const { commits, hasMore, paging, showMore } = useGitLog(cwd, true);
  const { stashes } = useGitStashes(cwd, true);
  const pick = (next) => { onScope(next); onClose(); };
  const isSha = (sha) => scope.kind === "commit" && scope.sha === sha;

  return (
    <AnchoredMenu anchorRef={anchorRef} onClose={onClose} width={300} className="cx-scope-menu" keepOpenOn="[data-popover='branch-dd']">
      <div className="cx-menu__sec">Compare</div>
      <button type="button" role="menuitemradio" aria-checked={scope.kind === "branch"} className="cx-menu__item" onClick={() => pick({ kind: "branch", base: scope.base ?? null })}>
        <BranchGlyph />
        <span className="cx-menu__text"><span>Branch</span><span className="cx-menu__sub">{baseLabel ? `against ${baseLabel}` : "against its base"}</span></span>
        {scope.kind === "branch" && <CheckGlyph />}
      </button>
      <button type="button" role="menuitemradio" aria-checked={scope.kind === "all"} className="cx-menu__item" onClick={() => pick({ kind: "all" })}>
        <EditGlyph />
        <span className="cx-menu__text"><span>Uncommitted</span><span className="cx-menu__sub">working tree against HEAD</span></span>
        {scope.kind === "all" && <CheckGlyph />}
      </button>

      {stashes?.length > 0 && (
        <>
          <div className="cx-menu__sep" />
          <div className="cx-menu__sec">Stashes</div>
          {stashes.map((s) => (
            <div key={s.sha} className={"cx-menu__item cx-menu__item--row" + (isSha(s.sha) ? " on" : "")}>
              <button type="button" className="cx-menu__main" title={s.subject} onClick={() => pick({ kind: "commit", sha: s.sha, subject: s.subject, stash: s.index })}>
                <StashGlyph />
                <span className="cx-menu__text">
                  <span className="cx-menu__ellip">stash@{"{"}{s.index}{"}"} · {s.subject}</span>
                  <span className="cx-menu__sub">{fmtTimeAgo(s.ts)}{s.branch ? ` · ${s.branch}` : ""}</span>
                </span>
              </button>
              <button type="button" className="cx-menu__act" onClick={() => onStash("apply", s)}>Apply</button>
              <button type="button" className="cx-menu__act cx-menu__act--danger" onClick={() => onStash("drop", s)}>Delete</button>
            </div>
          ))}
        </>
      )}

      <div className="cx-menu__sep" />
      <div className="cx-menu__sec">History</div>
      <div className="cx-menu__scroll">
        {commits === null && <div className="cx-menu__note">Loading…</div>}
        {commits?.length === 0 && <div className="cx-menu__note">No commits</div>}
        {(commits ?? []).map((c) => (
          <button key={c.sha} type="button" role="menuitemradio" aria-checked={isSha(c.sha)} className={"cx-menu__item" + (isSha(c.sha) ? " on" : "")} title={c.subject} onClick={() => pick({ kind: "commit", sha: c.sha, subject: c.subject })}>
            <CommitGlyph />
            <span className="cx-menu__text">
              <span className="cx-menu__ellip">{c.subject}</span>
              <span className="cx-menu__sub">{shortSha(c.sha)} · {c.author} · {fmtTimeAgo(c.ts)}</span>
            </span>
          </button>
        ))}
        {hasMore && (
          <button type="button" className="cx-menu__item cx-menu__more" onClick={showMore} disabled={paging}>
            {paging ? "Loading…" : "Show more"}
          </button>
        )}
      </div>
    </AnchoredMenu>
  );
}
