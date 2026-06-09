import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { parsePatch } from "../../../lib/patch.js";
import { highlightToLines } from "../../../lib/codeHighlight.jsx";
import { gitAgentName } from "../../../lib/gitAgentName.js";
import { useWorkerVerdict } from "../../../hooks/useWorkerVerdict.js";

const REFRESH_DEBOUNCE_MS = 800;
// Let the 280ms grid-columns animation finish before laying out the list —
// rendering cards mid-transition janks every animation frame.
const SETTLE_MS = 300;
// Initial row budget per file; full diff renders only on explicit request.
const MAX_ROWS = 300;

const STATUS_LABEL = { M: "M", A: "A", D: "D", R: "R" };

function splitPath(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

export function DiffViewer({ live }) {
  const ui = useUi();
  // Mounted while anywhere in the panel stack (state survives a file viewer
  // pushed on top); visible only when on top.
  const open = Boolean(ui.diffViewer);
  return (
    <div className={"diff-viewer" + (ui.topPanelType === "diff" ? " dv-open" : "")}>
      {open && <DiffViewerInner workerId={ui.diffViewer.workerId} live={live} />}
    </div>
  );
}

function DiffViewerInner({ workerId, live }) {
  const ui = useUi();
  const [changes, setChanges] = useState(null);
  // Files are expanded by default; the set tracks what the user collapsed.
  const [collapsed, setCollapsed] = useState(() => new Set());
  const [patches, setPatches] = useState(() => new Map());
  const [settled, setSettled] = useState(false);
  const filesRef = useRef([]);
  const collapsedRef = useRef(collapsed);
  collapsedRef.current = collapsed;
  const patchesRef = useRef(patches);
  patchesRef.current = patches;

  useEffect(() => {
    const t = setTimeout(() => setSettled(true), SETTLE_MS);
    return () => clearTimeout(t);
  }, []);

  const loadPatch = useCallback(async (file) => {
    setPatches((prev) => new Map(prev).set(file.path, { loading: true }));
    try {
      const data = await api.getWorkerFileDiff(workerId, file.path, file.oldPath);
      setPatches((prev) => new Map(prev).set(file.path, { loading: false, data }));
    } catch (e) {
      setPatches((prev) => new Map(prev).set(file.path, { loading: false, error: e.message }));
    }
  }, [workerId]);

  const refresh = useCallback(async () => {
    const r = await api.getWorkerChanges(workerId);
    setChanges(r);
    // Refetch the patch of any expanded file whose counts moved.
    const prevByPath = new Map(filesRef.current.map((f) => [f.path, f]));
    filesRef.current = r.files;
    for (const f of r.files) {
      const old = prevByPath.get(f.path);
      const moved = old && (old.insertions !== f.insertions || old.deletions !== f.deletions);
      if (moved && !collapsedRef.current.has(f.path)) loadPatch(f);
    }
  }, [workerId, loadPatch]);

  useEffect(() => {
    setChanges(null);
    setCollapsed(new Set());
    setPatches(new Map());
    filesRef.current = [];
    refresh();
  }, [workerId, refresh]);

  // Load the patch of every open file that has none yet — covers the initial
  // list, files arriving via SSE refresh, and re-expanding after an error.
  useEffect(() => {
    for (const f of changes?.files ?? []) {
      if (collapsed.has(f.path)) continue;
      const p = patchesRef.current.get(f.path);
      if (!p?.data && !p?.loading) loadPatch(f);
    }
  }, [changes, collapsed, loadPatch]);

  const worker = live.workers.find((w) => w.id === workerId);
  const isolated = Boolean(worker?.worktree_from && worker?.branch);

  // Try state — defined BEFORE the SSE effect below that depends on it.
  // Apply hides while a try is ACTIVE (banner's Keep/Discard owns it) and
  // FOREVER once this worker's try was KEPT — the work is integrated; only
  // Discard ever brings Apply back.
  const [tryState, setTryState] = useState({ phase: "idle" });
  const [tryInfo, setTryInfo] = useState(null);
  useEffect(() => { setTryState({ phase: "idle" }); setTryInfo(null); }, [workerId]);

  const refreshTry = useCallback(async () => {
    if (!isolated) { setTryInfo(null); return; }
    setTryInfo(await api.getTryState(workerId));
  }, [workerId, isolated]);
  useEffect(() => { refreshTry(); }, [refreshTry]);
  const activeTry = tryInfo?.activeTry ?? null;
  const kept = Boolean(tryInfo?.kept);

  // SSE-driven refetch: worker:change fires per tool event, so debounce.
  // try_applied/kept/discarded stamp this worker's id too — refresh the try
  // state in the same breath so the Apply button tracks the banner.
  const timerRef = useRef(null);
  useEffect(() => {
    if (live.eventSignal.workerId !== workerId) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => { refresh(); refreshTry(); }, REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [live.eventSignal.tick, live.eventSignal.workerId, workerId, refresh, refreshTry]);

  // Stable identity so memoized FileCards don't re-render on sibling updates.
  const toggle = useCallback((file) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(file.path)) next.delete(file.path); else next.add(file.path);
      return next;
    });
  }, []);

  const files = changes?.files ?? [];
  const ready = settled && changes !== null;

  // Own verdict when this worker is selected (Messages publishes it);
  // otherwise derive from the worker's own transcript (hub opens children's
  // viewers without changing selection), with the report-parsed Handover as
  // the last fallback.
  const selectedVerdict = ui.verdict?.workerId === workerId ? ui.verdict : null;
  const derived = useWorkerVerdict(workerId, live, { enabled: !selectedVerdict });
  const verdict = selectedVerdict
    ?? (derived && derived.verdict !== "unverified" ? derived : null)
    ?? (ui.verdict?.children?.[workerId] ?? null);
  const showVerdict = verdict && verdict.verdict !== "unverified";
  const gitDir = worker?.worktree_dir ?? worker?.cwd ?? worker?.worktree_from ?? null;

  const openFile = useCallback((f) => {
    if (gitDir) ui.openFileViewer(gitDir + "/" + f.path);
  }, [gitDir, ui.openFileViewer]);

  // Apply is one click — tryApply re-validates everything server-side
  // (snapshot → virtual merge → conflict + dirty-file checks) and writes only
  // when all pass; failures come back as structured reasons with nothing
  // half-applied. Conflicts flip the button to the git-agent escalation.
  const applyTry = async () => {
    setTryState({ phase: "applying" });
    const r = await api.tryApply(workerId);
    if (r.ok) { setTryState({ phase: "idle" }); await refreshTry(); return; }
    const b = r.body ?? {};
    if (b.reason === "conflicts") { setTryState({ phase: "conflicts", count: b.files?.length ?? 0 }); return; }
    setTryState({
      phase: "error",
      msg: b.reason === "dirty-files"
        ? `your checkout has local edits in ${(b.files ?? []).slice(0, 3).join(", ")}${(b.files?.length ?? 0) > 3 ? "…" : ""}`
        : b.reason === "active-try"
          ? "a try is already active in this repo"
          : b.reason === "nothing-to-apply"
            ? "nothing to apply"
            : b.reason === "unsupported"
              ? "needs git >= 2.38"
              : b.error ?? b.detail ?? b.reason ?? "failed",
    });
  };

  const resolveWithGitAgent = async () => {
    if (!worker?.worktree_from || !worker?.branch) return;
    const prompt = `Merge branch ${worker.branch} into the current branch. Context: ${worker.branch} is a live Eos agent worktree branch — never check it out or delete it. Resolve any conflicts preserving both sides' intent.`;
    const r = await live.spawnGitAgent({
      cwd: worker.worktree_from,
      prompt,
      name: gitAgentName(worker.worktree_from, worker.branch, `merge ${worker.branch}`),
    });
    if (r?.ok && r.body?.id) ui.setSelectedId(r.body.id);
  };

  return (
    <>
      <div className="dv-head">
        <span className="dv-title">Changes</span>
        {changes && files.length > 0 && (
          <span className="dv-totals">
            <span className="dv-add">+{changes.insertions.toLocaleString()}</span>
            <span className="dv-del">−{changes.deletions.toLocaleString()}</span>
            <span className="dv-count">{files.length} {files.length === 1 ? "file" : "files"}</span>
          </span>
        )}
        {showVerdict && (
          <span className={"git-chip verdict-chip verdict-" + verdict.verdict} title={verdict.command ? `verified by: ${verdict.command}` : undefined}>
            <span className="lbl">{verdict.verdict}</span>
          </span>
        )}
        {isolated && (activeTry || kept) && (
          <span className="git-chip applied-chip" title={kept ? "These changes were applied to your checkout and kept" : "These changes are currently applied in your checkout (Keep/Discard in the banner)"}>
            <span className="lbl">applied</span>
          </span>
        )}
        <span className="dv-grow" />
        {isolated && !activeTry && !kept && tryState.phase === "idle" && (
          <button className="dv-act dv-act-apply" title="Apply these changes as unstaged edits in your checkout (Keep/Discard after testing)" onClick={applyTry}>
            Apply
          </button>
        )}
        {isolated && tryState.phase === "applying" && (
          <button className="dv-act dv-act-apply" disabled>Applying…</button>
        )}
        {isolated && !activeTry && tryState.phase === "conflicts" && (
          <button className="dv-act dv-act-conflict" title={`${tryState.count} file(s) would conflict — nothing was touched`} onClick={resolveWithGitAgent}>
            Resolve with git agent
          </button>
        )}
        {isolated && !activeTry && tryState.phase === "error" && (
          <button className="dv-act dv-act-err" title="Click to retry" onClick={applyTry}>
            {tryState.msg}
          </button>
        )}
        {gitDir && (
          <button
            className="fv-icon-btn"
            title="Reveal workspace in Finder"
            onClick={() => api.revealFile(gitDir)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
            </svg>
          </button>
        )}
        {gitDir && (
          <button
            className="fv-icon-btn"
            title="Copy workspace path"
            onClick={() => navigator.clipboard?.writeText(gitDir)}
          >
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4">
              <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
              <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
            </svg>
          </button>
        )}
        <button className="fv-icon-btn fv-close" onClick={ui.closeDiffViewer} title="Close">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="m4 4 8 8M12 4l-8 8" />
          </svg>
        </button>
      </div>
      <div className="dv-list">
        {!ready && <div className="dv-empty">Loading...</div>}
        {ready && files.length === 0 && <div className="dv-empty">Working tree clean</div>}
        {ready && files.map((f) => (
          <FileCard
            key={f.path}
            file={f}
            isOpen={!collapsed.has(f.path)}
            patch={patches.get(f.path)}
            onToggle={toggle}
            onOpenFile={gitDir ? openFile : undefined}
          />
        ))}
      </div>
    </>
  );
}

const FileCard = memo(function FileCard({ file, isOpen, patch, onToggle, onOpenFile }) {
  const [dir, base] = splitPath(file.path);
  // Deleted files have nothing on disk to open.
  const openable = Boolean(onOpenFile) && file.status !== "D";
  return (
    <div className={"dv-file" + (isOpen ? " open" : "")}>
      <button className="dv-row" onClick={() => onToggle(file)}>
        <svg className="dv-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 4 4 4-4 4" />
        </svg>
        <span className={"dv-st dv-st-" + file.status.toLowerCase()} title={file.oldPath ? `${file.oldPath} → ${file.path}` : undefined}>
          {STATUS_LABEL[file.status]}
        </span>
        <span
          className={"dv-path" + (openable ? " dv-openable" : "")}
          title={openable ? "Open file" : undefined}
          onClick={openable ? (e) => { e.stopPropagation(); onOpenFile(file); } : undefined}
        >
          {dir && <span className="dv-dir">{dir}</span>}
          <span className="dv-base">{base}</span>
        </span>
        <span className="dv-grow" />
        <span className="dv-counts">
          {file.untracked ? (
            <span className="dv-new">new</span>
          ) : file.insertions === null ? (
            <span className="dv-bin">bin</span>
          ) : (
            <>
              {file.insertions > 0 && <span className="dv-add">+{file.insertions}</span>}
              {file.deletions > 0 && <span className="dv-del">−{file.deletions}</span>}
            </>
          )}
        </span>
      </button>
      {isOpen && <PatchBody file={file} patch={patch} />}
    </div>
  );
});

// Parse + highlight once per fetched patch, not per render. Each hunk's old
// side (ctx+del) and new side (ctx+add) are highlighted as separate blocks so
// multi-line constructs keep their context within the hunk.
function buildHunkView(patch, filePath) {
  const hunks = parsePatch(patch);
  for (const h of hunks) {
    const oldRows = h.rows.filter((r) => r.type !== "add");
    const newRows = h.rows.filter((r) => r.type !== "del");
    const oldHL = highlightToLines(oldRows.map((r) => r.text).join("\n"), filePath);
    const newHL = highlightToLines(newRows.map((r) => r.text).join("\n"), filePath);
    let oi = 0, ni = 0;
    for (const r of h.rows) {
      if (r.type === "del") r.rich = oldHL?.[oi++];
      else if (r.type === "add") r.rich = newHL?.[ni++];
      else { r.rich = newHL?.[ni++]; oi++; }
    }
  }
  return hunks;
}

function PatchBody({ file, patch }) {
  const [showAll, setShowAll] = useState(false);
  const data = patch?.data;
  const hunks = useMemo(
    () => (data && !data.binary ? buildHunkView(data.patch, file.path) : []),
    [data, file.path],
  );

  if (!patch || patch.loading) return <div className="dv-patch-note">Loading diff...</div>;
  if (patch.error) return <div className="dv-patch-note dv-patch-err">{patch.error}</div>;
  if (data.binary) return <div className="dv-patch-note">Binary file</div>;
  if (hunks.length === 0) return <div className="dv-patch-note">No textual changes</div>;

  const totalRows = hunks.reduce((n, h) => n + h.rows.length, 0);
  let budget = showAll ? Infinity : MAX_ROWS;

  return (
    <div className="dv-patch edit-diff">
      {hunks.map((h, i) => {
        if (budget <= 0) return null;
        const rows = h.rows.length > budget ? h.rows.slice(0, budget) : h.rows;
        budget -= rows.length;
        return (
          <Fragment key={i}>
            <div className="dv-hunk">{h.header}</div>
            {rows.map((r, j) => (
              <div className={"ed-line ed-" + r.type} key={j}>
                <span className="ed-num">{r.num}</span>
                <span className="ed-sign">{r.type === "del" ? "-" : r.type === "add" ? "+" : " "}</span>
                <span className="ed-text">{r.rich ?? r.text}</span>
              </div>
            ))}
          </Fragment>
        );
      })}
      {!showAll && totalRows > MAX_ROWS && (
        <button className="dv-more" onClick={() => setShowAll(true)}>
          Show all {totalRows.toLocaleString()} lines
        </button>
      )}
      {data.truncated && <div className="dv-patch-note">Diff truncated</div>}
    </div>
  );
}
