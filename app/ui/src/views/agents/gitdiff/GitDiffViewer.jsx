import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { notify } from "../../../lib/notify.js";
import { workerGitDir } from "../../../lib/workerGitDir.js";
import { projectPathFor } from "../../../lib/breadcrumb.js";
import { useGitScopeChanges } from "../../../hooks/useGitScopeChanges.js";
import { consumeStashFocus } from "../../../state/gitDiffIntent.js";
import { PanelShell } from "../panes/PanelShell.jsx";
import { BranchConfirmDialog } from "../popovers/BranchConfirmDialog.jsx";
import { ChangesHeader } from "./ChangesHeader.jsx";
import { GitDiffTree } from "./GitDiffTree.jsx";
import { GitDiffConflicts } from "./GitDiffConflicts.jsx";
import { GitDiffBody } from "./GitDiffBody.jsx";
import { GitDiffFileMenu } from "./GitDiffFileMenu.jsx";

// Above this many changed lines a diff counts as "large": the panel pages
// through it one file at a time.
const LARGE_DIFF_LINES = 1000;
const VIEW_KEY = "cm:changesView";

function loadView() {
  try {
    const v = JSON.parse(globalThis.localStorage?.getItem(VIEW_KEY) ?? "null");
    return { split: v?.split === true, tree: v?.tree !== false };
  } catch {
    return { split: false, tree: true };
  }
}

function saveView(view) {
  try { globalThis.localStorage?.setItem(VIEW_KEY, JSON.stringify(view)); } catch { /* best-effort */ }
}

// Empty state on the shared recipe (check glyph + title + hint).
function ChangesEmpty({ title, hint }) {
  return (
    <div className="empty-state">
      <span className="empty-state__icon">
        <svg width="40" height="40" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"><circle cx="8" cy="8" r="6" /><path d="m5.4 8.2 1.8 1.8 3.5-3.7" /></svg>
      </span>
      <span className="empty-state__title">{title}</span>
      {hint && <span className="empty-state__subtitle">{hint}</span>}
    </div>
  );
}

// Changes tab — the selected agent's repo (or an explicit {cwd, workerId} when
// opened from a specific worktree, e.g. a WorktreeHub child): the branch
// against its base by default, or the uncommitted work, a commit, a stash.
// Header (scope + view tools, refs + agent actions), the diff with folds, split
// view and line comments that go to the agent, and a filterable file tree.
export function GitDiffViewer({ live }) {
  const ui = useUi();
  const d = ui.panelData?.review ?? null;
  const workerId = d?.workerId ?? ui.selectedId ?? null;
  const worker = workerId ? (live?.workers ?? []).find((w) => w.id === workerId) ?? null : null;
  const cwd = d?.cwd ?? workerGitDir(worker) ?? projectPathFor(live?.workers ?? [], workerId) ?? null;
  if (!cwd) {
    return (
      <PanelShell type="gitdiff">
        <ChangesEmpty title="Nothing to review" />
      </PanelShell>
    );
  }
  return <GitDiffViewerInner cwd={cwd} worker={worker} live={live} />;
}

function GitDiffViewerInner({ cwd, worker, live }) {
  const ui = useUi();
  const workerId = worker?.id ?? null;
  const [scope, setScope] = useState({ kind: "branch", base: null });
  const [view, setView] = useState(loadView);
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [viewed, setViewed] = useState(() => new Set());
  const [selectedPath, setSelectedPath] = useState(null);
  const [page, setPage] = useState(0);
  const [dropping, setDropping] = useState(null); // stash pending a delete confirm
  const [acting, setActing] = useState(false);

  const resetFor = useCallback((next) => {
    setScope(next);
    setSelectedPath(null);
    setPage(0);
    setViewed(new Set());
    setCollapsed(new Set());
  }, []);
  useEffect(() => { resetFor({ kind: "branch", base: null }); }, [cwd, resetFor]);

  // Opened via the composer stash chip: show the newest stash.
  const stashFocus = useRef(consumeStashFocus());
  useEffect(() => {
    if (!stashFocus.current) return;
    stashFocus.current = false;
    api.getGitStashes(cwd).then((r) => {
      const top = r.stashes?.[0];
      if (top) resetFor({ kind: "commit", sha: top.sha, subject: top.subject, stash: top.index });
    });
  }, [cwd, resetFor]);

  const { changes, patches, loadPatch, refresh } = useGitScopeChanges(cwd, scope);
  const files = useMemo(() => changes?.files ?? (changes ? [] : null), [changes]);
  const isLarge = (changes?.insertions || 0) + (changes?.deletions || 0) >= LARGE_DIFF_LINES && (files?.length ?? 0) > 1;
  const pageIndex = files ? Math.min(page, Math.max(0, files.length - 1)) : 0;

  const onView = useCallback((patch) => setView((v) => { const next = { ...v, ...patch }; saveView(next); return next; }), []);
  const toggle = useCallback((path) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path); else next.add(path);
      return next;
    });
  }, []);
  // A viewed file folds away; un-marking it opens it again.
  const toggleViewed = useCallback((path) => {
    const nowViewed = !viewed.has(path);
    const flip = (prev) => {
      const next = new Set(prev);
      if (nowViewed) next.add(path); else next.delete(path);
      return next;
    };
    setViewed(flip);
    setCollapsed(flip);
  }, [viewed]);
  const select = useCallback((path) => {
    setSelectedPath(path);
    if (isLarge && files) setPage(Math.max(0, files.findIndex((f) => f.path === path)));
  }, [isLarge, files]);

  const onFileContextMenu = useCallback((e, path) => {
    e.preventDefault();
    ui.openPop("gitdiff-file-ctx", { x: e.clientX, y: e.clientY, data: { cwd, path } });
  }, [ui, cwd]);
  const openFile = useCallback((path) => ui.openFile(`${cwd}/${path}`), [ui, cwd]);

  // The file's new side, for opening folds: the working tree, or the commit's blob.
  const headSha = changes?.headSha ?? null;
  const loadNewLines = useCallback(async (file) => {
    if (scope.kind === "commit") {
      if (!headSha) return null;
      const r = await fetch(api.gitBlobUrl(cwd, headSha, file.path));
      return r.ok ? (await r.text()).split("\n") : null;
    }
    const r = await api.readFile(`${cwd}/${file.path}`);
    return typeof r.content === "string" ? r.content.split("\n") : null;
  }, [cwd, scope.kind, headSha]);

  const sendToAgent = useCallback(async (text) => {
    const r = await live.sendToAgent(workerId, text, { queueWhenBusy: true });
    if (r?.ok === false) notify.error(`Couldn't reach the agent: ${r.body?.error ?? r.status}`);
    return r?.ok !== false;
  }, [live, workerId]);
  const comment = useCallback((file, { row, text }) => {
    const where = row.type === "del" ? `removed line ${row.num}` : `line ${row.num}`;
    return sendToAgent(`Feedback on \`${file.path}\` ${where}:\n> ${row.text.trim()}\n\n${text}`);
  }, [sendToAgent]);
  const runAction = useCallback(async (action) => {
    setActing(true);
    const r = await api.sendWorkerAction(workerId, action);
    setActing(false);
    if (!r.ok) notify.error(r.body?.error ?? `${action} failed`);
  }, [workerId]);

  const onStash = useCallback(async (kind, stash) => {
    if (kind === "drop") { setDropping(stash); return; }
    const r = await api.stashApply(cwd, stash.index);
    if (!r.ok) notify.error(r.body?.error ?? "Apply failed");
    refresh();
  }, [cwd, refresh]);
  const drop = async () => {
    const r = await api.stashDrop(cwd, dropping.index);
    if (!r.ok) notify.error(r.body?.error ?? "Delete failed");
    if (scope.kind === "commit" && scope.sha === dropping.sha) resetFor({ kind: "branch", base: null });
    setDropping(null);
  };

  const agent = workerId && live?.sendToAgent
    ? { onReview: () => runAction("review"), onAction: runAction, busy: acting }
    : null;
  const empty = files && files.length === 0;

  return (
    <PanelShell type="gitdiff">
      <ChangesHeader
        cwd={cwd}
        scope={scope}
        changes={changes}
        onScope={resetFor}
        onStash={onStash}
        view={view}
        onView={onView}
        onRefresh={refresh}
        onExpandAll={() => setCollapsed(new Set())}
        onCollapseAll={() => setCollapsed(new Set((files ?? []).map((f) => f.path)))}
        agent={agent}
        pager={isLarge ? { index: pageIndex, count: files.length, go: (i) => { setPage(i); setSelectedPath(files[i]?.path ?? null); } } : null}
      />
      <div className="gd-main">
        <div className="gd-content">
          {workerId && scope.kind !== "commit" && <GitDiffConflicts workerId={workerId} live={live} />}
          {empty ? (
            <ChangesEmpty
              title={scope.kind === "all" ? "Working tree clean" : "No changes"}
              hint={scope.kind === "all" ? "Switch to Branch to see what this branch committed." : null}
            />
          ) : (
            <GitDiffBody
              files={files}
              patches={patches}
              collapsed={collapsed}
              viewed={viewed}
              onToggle={toggle}
              onViewed={toggleViewed}
              onOpen={scope.kind === "commit" ? null : openFile}
              loadPatch={loadPatch}
              selectedPath={selectedPath}
              cwd={cwd}
              baseSha={changes?.baseSha ?? null}
              headSha={headSha}
              scope={scope}
              onFileContextMenu={onFileContextMenu}
              single={isLarge ? pageIndex : null}
              split={view.split}
              loadNewLines={loadNewLines}
              onComment={agent ? comment : null}
            />
          )}
        </div>
        {view.tree && !empty && (
          <aside className="gd-side" aria-label="Changed files">
            <GitDiffTree files={files ?? []} selectedPath={selectedPath} onSelect={select} onFileContextMenu={onFileContextMenu} />
          </aside>
        )}
      </div>
      <GitDiffFileMenu />
      {dropping && (
        <BranchConfirmDialog
          message={`Delete stash@{${dropping.index}}${dropping.subject ? ` — “${dropping.subject}”` : ""}? This can't be undone.`}
          confirmLabel="Delete stash"
          danger
          onConfirm={drop}
          onCancel={() => setDropping(null)}
        />
      )}
    </PanelShell>
  );
}
