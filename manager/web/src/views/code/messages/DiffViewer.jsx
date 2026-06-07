import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUi } from "../../../state/ui.jsx";
import { api } from "../../../api/client.js";
import { parsePatch } from "../../../lib/patch.js";
import { highlightToLines } from "../../../lib/codeHighlight.jsx";

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
  const open = Boolean(ui.diffViewer);
  return (
    <div className={"diff-viewer" + (open ? " dv-open" : "")}>
      {open && <DiffViewerInner workerId={ui.diffViewer.workerId} live={live} />}
    </div>
  );
}

function DiffViewerInner({ workerId, live }) {
  const ui = useUi();
  const [changes, setChanges] = useState(null);
  const [expanded, setExpanded] = useState(() => new Set());
  const [patches, setPatches] = useState(() => new Map());
  const [settled, setSettled] = useState(false);
  const filesRef = useRef([]);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
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
      if (moved && expandedRef.current.has(f.path)) loadPatch(f);
    }
  }, [workerId, loadPatch]);

  useEffect(() => {
    setChanges(null);
    setExpanded(new Set());
    setPatches(new Map());
    filesRef.current = [];
    refresh();
  }, [workerId, refresh]);

  // SSE-driven refetch: worker:change fires per tool event, so debounce.
  const timerRef = useRef(null);
  useEffect(() => {
    if (live.eventSignal.workerId !== workerId) return;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(refresh, REFRESH_DEBOUNCE_MS);
    return () => clearTimeout(timerRef.current);
  }, [live.eventSignal.tick, live.eventSignal.workerId, workerId, refresh]);

  // Stable identity so memoized FileCards don't re-render on sibling updates.
  const toggle = useCallback((file) => {
    const isOpen = expandedRef.current.has(file.path);
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isOpen) next.delete(file.path); else next.add(file.path);
      return next;
    });
    if (!isOpen && !patchesRef.current.get(file.path)?.data) loadPatch(file);
  }, [loadPatch]);

  const files = changes?.files ?? [];
  const ready = settled && changes !== null;

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
        <span className="dv-grow" />
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
            isOpen={expanded.has(f.path)}
            patch={patches.get(f.path)}
            onToggle={toggle}
          />
        ))}
      </div>
    </>
  );
}

const FileCard = memo(function FileCard({ file, isOpen, patch, onToggle }) {
  const [dir, base] = splitPath(file.path);
  return (
    <div className={"dv-file" + (isOpen ? " open" : "")}>
      <button className="dv-row" onClick={() => onToggle(file)}>
        <svg className="dv-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 4 4 4-4 4" />
        </svg>
        <span className={"dv-st dv-st-" + file.status.toLowerCase()} title={file.oldPath ? `${file.oldPath} → ${file.path}` : undefined}>
          {STATUS_LABEL[file.status]}
        </span>
        <span className="dv-path">
          {dir && <span className="dv-dir">{dir}</span>}
          <span className="dv-base">{base}</span>
        </span>
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
