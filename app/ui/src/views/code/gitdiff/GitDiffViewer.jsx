import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { useUi } from "../../../state/ui.jsx";
import { useGitScopeChanges } from "../../../hooks/useGitScopeChanges.js";
import { scopeKeyOf } from "../../../state/gitDiffStore.js";
import { subscribe as subscribeDockFullscreen, isDockFullscreen, setDockFullscreen } from "../../../state/dockFullscreenStore.js";
import { PanelCloseButton } from "../messages/PanelCloseButton.jsx";
import { GitDiffTree } from "./GitDiffTree.jsx";
import { GitDiffCommits } from "./GitDiffCommits.jsx";
import { GitDiffBody } from "./GitDiffBody.jsx";

// Above this many changed lines a diff counts as "large": every file starts
// collapsed and the hint row appears (DiffViewer's threshold).
const LARGE_DIFF_LINES = 1000;

// Git Diff docked panel — any repo dir's changes at the working-tree scope
// (vs the merge-base with the default branch) or one commit's scope, with a
// file-tree + commit-history sidebar. Read-only; worker-specific actions
// (discard/Try/Apply/verdict) live in the DiffViewer.
export function GitDiffViewer() {
  const ui = useUi();
  const open = Boolean(ui.gitDiffViewer);
  return (
    <div className="gitdiff-viewer gdv-open">
      {open && <GitDiffViewerInner cwd={ui.gitDiffViewer.cwd} paneId={ui.paneId} />}
    </div>
  );
}

function GitDiffViewerInner({ cwd, paneId }) {
  const ui = useUi();
  const [scope, setScope] = useState({ kind: "all" });
  const [treeOpen, setTreeOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [selectedPath, setSelectedPath] = useState(null);
  useEffect(() => { setScope({ kind: "all" }); setSelectedPath(null); }, [cwd]);

  const { changes, patches, loadPatch } = useGitScopeChanges(cwd, scope);

  const fullscreen = useSyncExternalStore(
    useCallback((cb) => subscribeDockFullscreen(paneId, cb), [paneId]),
    useCallback(() => isDockFullscreen(paneId), [paneId]),
  );

  const totalChanged = (changes?.insertions || 0) + (changes?.deletions || 0);
  const isLargeDiff = totalChanged >= LARGE_DIFF_LINES;

  // Once the first snapshot for a cwd+scope arrives, collapse every file when
  // the diff is large. Keyed so later SSE refreshes keep the user's manual
  // expand/collapse state instead of re-collapsing.
  const initKey = `${cwd} ${scopeKeyOf(scope)}`;
  const initedFor = useRef(null);
  useEffect(() => {
    if (!changes || initedFor.current === initKey) return;
    initedFor.current = initKey;
    setCollapsed(isLargeDiff ? new Set((changes.files ?? []).map((f) => f.path)) : new Set());
  }, [changes, initKey, isLargeDiff]);

  const toggle = useCallback((path) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);

  const onScope = useCallback((next) => {
    setScope(next);
    setSelectedPath(null);
  }, []);

  const baseLabel = changes?.baseLabel;
  const headLabel = changes?.headLabel;

  return (
    <>
      <div className="dv-head">
        <button
          className={"fv-icon-btn gd-tree-btn" + (treeOpen ? " on" : "")}
          title={treeOpen ? "Hide file tree" : "Show file tree"}
          aria-pressed={treeOpen}
          onClick={() => setTreeOpen((v) => !v)}
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
            <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
          </svg>
        </button>
        <span className="dv-crumb" title={cwd}>
          {scope.kind === "commit" ? (
            <>
              <span className="dv-crumb-ref">{scope.sha.slice(0, 7)}</span>
              <span className="dv-crumb-ref dv-crumb-head">{scope.subject}</span>
            </>
          ) : baseLabel ? (
            <>
              <span className="dv-crumb-ref">{baseLabel}</span>
              <span className="dv-crumb-arrow">→</span>
              <span className="dv-crumb-ref dv-crumb-head">{headLabel}</span>
            </>
          ) : (
            <span className="dv-crumb-ref">{headLabel ?? "Changes"}</span>
          )}
        </span>
        <span className="dv-grow" />
        <button
          className="fv-icon-btn"
          title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
          aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen git diff"}
          onClick={() => setDockFullscreen(paneId, !fullscreen)}
        >
          {fullscreen ? (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M13 7H9V3M7 13V9H3M9 7l5-5M7 9l-5 5" />
            </svg>
          ) : (
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 3h4v4M7 13H3V9M8 8l5-5M8 8l-5 5" />
            </svg>
          )}
        </button>
        <PanelCloseButton onClose={ui.closeGitDiffViewer} />
      </div>
      {isLargeDiff && (
        <div className="dv-hint">Files are collapsed for large diffs. Select a file to expand it.</div>
      )}
      <div className="gd-main">
        {treeOpen && (
          <div className="gd-side">
            <GitDiffTree files={changes?.files ?? []} selectedPath={selectedPath} onSelect={setSelectedPath} />
            <GitDiffCommits cwd={cwd} scope={scope} onScope={onScope} />
          </div>
        )}
        <GitDiffBody
          files={changes?.files ?? (changes ? [] : null)}
          patches={patches}
          collapsed={collapsed}
          onToggle={toggle}
          loadPatch={loadPatch}
          selectedPath={selectedPath}
          cwd={cwd}
          baseSha={changes?.baseSha ?? null}
          headSha={changes?.headSha ?? null}
          scope={scope}
        />
      </div>
    </>
  );
}
