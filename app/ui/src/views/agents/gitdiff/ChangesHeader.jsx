import { useRef, useState } from "react";
import { truncateBranch } from "../../../lib/branchDisplay.js";
import { AnchoredMenu } from "./AnchoredMenu.jsx";
import { ScopeMenu } from "./ScopeMenu.jsx";
import { BaseMenu } from "./BaseMenu.jsx";
import {
  ArrowRight, BranchGlyph, ChevronDown, CommitGlyph, InfoGlyph, MoreGlyph, NextGlyph, PrevGlyph,
  RefreshGlyph, ReviewGlyph, SplitGlyph, StashGlyph, TreeGlyph,
} from "./glyphs.jsx";

// The Changes panel's two header rows. Row one: what is compared (scope pill +
// totals) and the view tools (expand/collapse, refresh, split view, file tree).
// Row two: the refs behind it (head → base, pick another base) and, beside an
// agent, its review / commit actions. A pager strip follows for large diffs.

const COMMIT_ACTIONS = [
  { id: "commit-push", label: "Commit and push" },
  { id: "pr", label: "Create pull request" },
  { id: "draft-pr", label: "Create draft pull request" },
];

function scopeLabel(scope) {
  if (scope.kind === "branch") return "Branch";
  if (scope.kind === "all") return "Uncommitted";
  return scope.stash != null ? "Stash" : "Commit";
}

export function ChangesHeader({
  cwd, scope, changes, onScope, onStash, view, onView, onRefresh, onExpandAll, onCollapseAll, agent, pager,
}) {
  const scopeRef = useRef(null);
  const baseRef = useRef(null);
  const moreRef = useRef(null);
  const commitRef = useRef(null);
  const [menu, setMenu] = useState(null); // "scope" | "base" | "more" | "commit"
  const close = () => setMenu(null);
  const toggle = (m) => setMenu((cur) => (cur === m ? null : m));

  const ins = changes?.insertions ?? 0;
  const del = changes?.deletions ?? 0;
  const head = changes?.headLabel ?? "HEAD";

  return (
    <div className="cx-head">
      <div className="cx-row">
        <button ref={scopeRef} type="button" className={"cx-scope" + (menu === "scope" ? " on" : "")} aria-haspopup="menu" aria-expanded={menu === "scope"} onClick={() => toggle("scope")}>
          {scopeLabel(scope)}
          <ChevronDown />
          {(ins > 0 || del > 0) && (
            <span className="cx-stats"><span className="cx-add">+{ins.toLocaleString()}</span> <span className="cx-del">−{del.toLocaleString()}</span></span>
          )}
        </button>
        <span className="sp-spacer" />
        <div className="cx-tools" role="toolbar" aria-label="Diff view">
          <button ref={moreRef} type="button" className={"cx-tool" + (menu === "more" ? " on" : "")} aria-label="More" aria-haspopup="menu" aria-expanded={menu === "more"} onClick={() => toggle("more")}><MoreGlyph /></button>
          <button type="button" className="cx-tool" aria-label="Refresh" title="Refresh" onClick={onRefresh}><RefreshGlyph /></button>
          <button type="button" className={"cx-tool" + (view.split ? " on" : "")} aria-label="Side-by-side diff" title="Side-by-side diff" aria-pressed={view.split} onClick={() => onView({ split: !view.split })}><SplitGlyph /></button>
          <button type="button" className={"cx-tool cx-tool--tree" + (view.tree ? " on" : "")} aria-label="File tree" title="File tree" aria-pressed={view.tree} onClick={() => onView({ tree: !view.tree })}><TreeGlyph /></button>
        </div>
      </div>

      <div className="cx-row">
        {scope.kind === "branch" ? (
          <button ref={baseRef} type="button" className={"cx-ref" + (menu === "base" ? " on" : "")} title="Compare against another branch" aria-haspopup="menu" aria-expanded={menu === "base"} onClick={() => toggle("base")}>
            <BranchGlyph />
            <span className="cx-ref__name" title={head}>{truncateBranch(head)}</span>
            <ArrowRight />
            <span className="cx-ref__name">{changes?.baseLabel ?? (changes ? "HEAD" : "…")}</span>
            <ChevronDown />
          </button>
        ) : scope.kind === "all" ? (
          <span className="cx-ref cx-ref--static">
            <BranchGlyph />
            <span className="cx-ref__name" title={head}>{truncateBranch(head)}</span>
            <span className="cx-ref__muted">· uncommitted</span>
          </span>
        ) : (
          <span className="cx-ref cx-ref--static" title={scope.subject}>
            {scope.stash != null ? <StashGlyph /> : <CommitGlyph />}
            <span className="cx-ref__name">{scope.stash != null ? `stash@{${scope.stash}}` : scope.sha.slice(0, 7)}</span>
            <span className="cx-ref__muted cx-ref__subject">{scope.subject}</span>
          </span>
        )}
        <span className="sp-spacer" />
        {agent && (
          <button type="button" className="cx-review" onClick={agent.onReview} disabled={agent.busy}>
            <ReviewGlyph />Ask for review
          </button>
        )}
        {agent && scope.kind !== "commit" && (
          <span className="cx-commit-group">
            <button type="button" className="cx-commit" onClick={() => agent.onAction("commit")} disabled={agent.busy}>Commit</button>
            <button ref={commitRef} type="button" className="cx-commit cx-commit--more" aria-label="More commit actions" aria-haspopup="menu" aria-expanded={menu === "commit"} onClick={() => toggle("commit")} disabled={agent.busy}><ChevronDown /></button>
          </span>
        )}
      </div>

      {pager && (
        <div className="cx-pager">
          <InfoGlyph />
          <span>Large diff — showing one file at a time</span>
          <span className="sp-spacer" />
          <span className="cx-pager__count">{pager.index + 1} / {pager.count}</span>
          <button type="button" className="cx-tool" aria-label="Previous file" disabled={pager.index === 0} onClick={() => pager.go(pager.index - 1)}><PrevGlyph /></button>
          <button type="button" className="cx-tool" aria-label="Next file" disabled={pager.index >= pager.count - 1} onClick={() => pager.go(pager.index + 1)}><NextGlyph /></button>
        </div>
      )}

      {menu === "scope" && <ScopeMenu anchorRef={scopeRef} cwd={cwd} scope={scope} baseLabel={changes?.baseLabel} onScope={onScope} onStash={onStash} onClose={close} />}
      {menu === "base" && (
        <BaseMenu anchorRef={baseRef} cwd={cwd} base={scope.base ?? null} resolvedBase={changes?.baseLabel} onBase={(base) => onScope({ kind: "branch", base })} onClose={close} />
      )}
      {menu === "more" && (
        <AnchoredMenu anchorRef={moreRef} onClose={close} align="right" width={200}>
          <button type="button" role="menuitem" className="cx-menu__item" onClick={() => { onExpandAll(); close(); }}>Expand all files</button>
          <button type="button" role="menuitem" className="cx-menu__item" onClick={() => { onCollapseAll(); close(); }}>Collapse all files</button>
        </AnchoredMenu>
      )}
      {menu === "commit" && agent && (
        <AnchoredMenu anchorRef={commitRef} onClose={close} align="right" width={220}>
          {COMMIT_ACTIONS.map((a) => (
            <button key={a.id} type="button" role="menuitem" className="cx-menu__item" onClick={() => { agent.onAction(a.id); close(); }}>{a.label}</button>
          ))}
        </AnchoredMenu>
      )}
    </div>
  );
}
