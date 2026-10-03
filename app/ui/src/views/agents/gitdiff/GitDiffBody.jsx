import { useEffect, useMemo, useRef } from "react";
import { GitDiffFileCard } from "./GitDiffFileCard.jsx";
import { isImagePath } from "./GitDiffImage.jsx";

// The panel's scrollable card list — every file, or just `files[single]` when a
// large diff pages one file at a time. Auto-loads the patch of every open text
// file that has none yet (embedded ?patches=1 responses may truncate past the
// payload budget; the per-file fetch covers the rest), and answers a tree
// selection by expanding + scrolling the file's card into view.
export function GitDiffBody({
  files, patches, collapsed, viewed, onToggle, onViewed, onOpen, loadPatch, selectedPath, cwd, baseSha, headSha, scope,
  onFileContextMenu, single, split, loadNewLines, onComment,
}) {
  const rowRefs = useRef(new Map());
  const shown = useMemo(() => (files && single != null ? files.slice(single, single + 1) : files), [files, single]);

  useEffect(() => {
    for (const f of shown ?? []) {
      if (collapsed.has(f.path) || isImagePath(f.path)) continue;
      const p = patches.get(f.path);
      if (!p?.data && !p?.loading) loadPatch(f);
    }
  }, [shown, collapsed, patches, loadPatch]);

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
      {(shown ?? []).map((f) => (
        <GitDiffFileCard
          key={f.path}
          file={f}
          isOpen={!collapsed.has(f.path)}
          viewed={viewed.has(f.path)}
          patch={patches.get(f.path)}
          onToggle={onToggle}
          onViewed={onViewed}
          onOpen={onOpen}
          imageCtx={imageCtx}
          onContextMenu={onFileContextMenu}
          split={split}
          loadNewLines={loadNewLines}
          onComment={onComment}
          cardRef={(el) => {
            if (el) rowRefs.current.set(f.path, el);
            else rowRefs.current.delete(f.path);
          }}
        />
      ))}
    </div>
  );
}
