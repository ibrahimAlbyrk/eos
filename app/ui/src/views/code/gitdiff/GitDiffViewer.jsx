import { useCallback, useEffect, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { basename } from "../../../lib/path.js";
import { truncateBranch } from "../../../lib/branchDisplay.js";
import { useGitScopeChanges } from "../../../hooks/useGitScopeChanges.js";
import { scopeKeyOf } from "../../../state/gitDiffStore.js";
import { consumeStashFocus } from "../../../state/gitDiffIntent.js";
import { PanelShell } from "../panes/PanelShell.jsx";
import { GitDiffTree } from "./GitDiffTree.jsx";
import { GitDiffCommits } from "./GitDiffCommits.jsx";
import { GitDiffStashes } from "./GitDiffStashes.jsx";
import { GitDiffConflicts } from "./GitDiffConflicts.jsx";
import { GitDiffBody } from "./GitDiffBody.jsx";
import { GitDiffFileMenu } from "./GitDiffFileMenu.jsx";

// Above this many changed lines a diff counts as "large": every file starts
// collapsed and the hint row appears (DiffViewer's threshold).
const LARGE_DIFF_LINES = 1000;

// Git Diff docked panel — any repo dir's local changes (staged+unstaged+
// untracked vs HEAD) or one commit's scope, with a file-tree + commit-history
// sidebar. Read-only; worker-specific actions
// (discard/Try/Apply/verdict) live in the DiffViewer.
export function GitDiffViewer({ live }) {
  const ui = useUi();
  if (!ui.gitDiffViewer) return <PanelShell type="gitdiff" />;
  return <GitDiffViewerInner cwd={ui.gitDiffViewer.cwd} workerId={ui.gitDiffViewer.workerId} live={live} />;
}

function GitDiffViewerInner({ cwd, workerId, live }) {
  const ui = useUi();
  const [scope, setScope] = useState({ kind: "all" });
  // Opened via the composer stash chip → reveal the sidebar (where Stashes
  // lives) and flag the section to scroll itself into view once it renders.
  const focusStashes = useRef(consumeStashFocus());
  const [treeOpen, setTreeOpen] = useState(focusStashes.current);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [selectedPath, setSelectedPath] = useState(null);
  useEffect(() => { setScope({ kind: "all" }); setSelectedPath(null); }, [cwd]);

  const { changes, patches, loadPatch } = useGitScopeChanges(cwd, scope);

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

  // Right-click on a file row (tree or diff-card header) → shared file menu,
  // positioned at the cursor. Data carries cwd + the repo-relative path so the
  // menu can build the absolute path for Copy path / Open in.
  const onFileContextMenu = useCallback((e, path) => {
    e.preventDefault();
    ui.openPop("gitdiff-file-ctx", { x: e.clientX, y: e.clientY, data: { cwd, path } });
  }, [ui, cwd]);

  // "repo · branch" like the composer git ribbon (an arrow would falsely imply
  // a ref range — the "all" scope is now local changes vs HEAD).
  const repoLabel = changes?.repoLabel ?? basename(cwd);
  const headLabel = changes?.headLabel;

  const heading = (
    <>
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
        ) : (
          <>
            <span className="dv-crumb-ref">{repoLabel}</span>
            {headLabel && (
              <>
                <span className="gd-crumb-sep">·</span>
                <span className="dv-crumb-ref dv-crumb-head" title={headLabel}>{truncateBranch(headLabel)}</span>
              </>
            )}
          </>
        )}
      </span>
    </>
  );

  return (
    <PanelShell type="gitdiff" title={heading}>
      {isLargeDiff && (
        <div className="dv-hint">Files are collapsed for large diffs. Select a file to expand it.</div>
      )}
      <div className="gd-main">
        {treeOpen && (
          <div className="gd-side">
            <GitDiffTree files={changes?.files ?? []} selectedPath={selectedPath} onSelect={setSelectedPath} onFileContextMenu={onFileContextMenu} />
            <GitDiffStashes cwd={cwd} scope={scope} onScope={onScope} focusOnMount={focusStashes} />
            <GitDiffCommits cwd={cwd} scope={scope} onScope={onScope} />
          </div>
        )}
        <div className="gd-content">
          {workerId && scope.kind === "all" && <GitDiffConflicts workerId={workerId} live={live} />}
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
            onFileContextMenu={onFileContextMenu}
          />
        </div>
      </div>
      <GitDiffFileMenu />
    </PanelShell>
  );
}
