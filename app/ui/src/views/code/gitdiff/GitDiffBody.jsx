import { useEffect, useMemo, useRef } from "react";
import { GitDiffFileCard } from "./GitDiffFileCard.jsx";
import { isImagePath } from "./GitDiffImage.jsx";

// The panel's scrollable card list. Auto-loads the patch of every open text
// file that has none yet (DiffViewer idiom — embedded ?patches=1 responses may
// truncate past the payload budget; the per-file fetch covers the rest), and
// answers a tree selection by expanding + scrolling the file's card into view.
export function GitDiffBody({ files, patches, collapsed, onToggle, loadPatch, selectedPath, cwd, baseSha, headSha, scope }) {
  const rowRefs = useRef(new Map());

  useEffect(() => {
    for (const f of files ?? []) {
      if (collapsed.has(f.path) || isImagePath(f.path)) continue;
      const p = patches.get(f.path);
      if (!p?.data && !p?.loading) loadPatch(f);
    }
  }, [files, collapsed, patches, loadPatch]);

  // Expand + scroll on selection change only — collapsed also mutating right
  // after (our own expand) must not re-trigger the scroll.
  const lastSel = useRef(null);
  useEffect(() => {
    if (!selectedPath || lastSel.current === selectedPath) return;
    lastSel.current = selectedPath;
    if (collapsed.has(selectedPath)) onToggle(selectedPath);
    rowRefs.current.get(selectedPath)?.scrollIntoView({ block: "start" });
  }, [selectedPath, collapsed, onToggle]);

  const imageCtx = useMemo(() => ({ cwd, baseSha, headSha, scope }), [cwd, baseSha, headSha, scope]);

  return (
    <div className="gd-list">
      {files === null && <div className="dv-empty">Loading...</div>}
      {files !== null && files.length === 0 && (
        <div className="dv-empty">{scope.kind === "commit" ? "No changes" : "Working tree clean"}</div>
      )}
      {(files ?? []).map((f) => (
        <GitDiffFileCard
          key={f.path}
          file={f}
          isOpen={!collapsed.has(f.path)}
          patch={patches.get(f.path)}
          onToggle={onToggle}
          imageCtx={imageCtx}
          cardRef={(el) => {
            if (el) rowRefs.current.set(f.path, el);
            else rowRefs.current.delete(f.path);
          }}
        />
      ))}
    </div>
  );
}
