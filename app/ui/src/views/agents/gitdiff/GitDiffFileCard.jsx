import { memo, useCallback } from "react";
import { PatchBody } from "../messages/PatchBody.jsx";
import { GitDiffImage, isImagePath } from "./GitDiffImage.jsx";
import { EyeGlyph, OpenGlyph } from "./glyphs.jsx";

function splitPath(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

// One collapsible file card. The header row is sticky inside the panel's scroll
// container (.gd-list), so the card root must never gain overflow or
// containment. Header: toggle (path + counts), "viewed" (collapses it, GitHub
// style) and open-file. cardRef lets the body scroll a selected file into view.
export const GitDiffFileCard = memo(function GitDiffFileCard({
  file, isOpen, viewed, patch, onToggle, onViewed, onOpen, imageCtx, cardRef, onContextMenu, split, loadNewLines, onComment,
}) {
  const [dir, base] = splitPath(file.path);
  const loadLines = useCallback(() => loadNewLines(file), [loadNewLines, file]);
  const comment = useCallback((c) => onComment(file, c), [onComment, file]);
  return (
    <div className={"gd-file" + (isOpen ? " open" : "") + (viewed ? " is-viewed" : "")} ref={cardRef}>
      <div className="gd-row" onContextMenu={onContextMenu ? (e) => onContextMenu(e, file.path) : undefined}>
        <button type="button" className="gd-row__toggle" aria-expanded={isOpen} onClick={() => onToggle(file.path)}>
          <svg className="dv-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="m6 4 4 4-4 4" />
          </svg>
          <span className="dv-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : file.path}>
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
          <span className="dv-grow" />
        </button>
        <button type="button" className={"gd-icon" + (viewed ? " on" : "")} aria-pressed={viewed} title={viewed ? "Viewed — click to unmark" : "Mark as viewed"} aria-label="Viewed" onClick={() => onViewed(file.path)}>
          <EyeGlyph />
        </button>
        {onOpen && (
          <button type="button" className="gd-icon" title="Open file" aria-label="Open file" onClick={() => onOpen(file.path)}>
            <OpenGlyph />
          </button>
        )}
      </div>
      {isOpen && (isImagePath(file.path) ? (
        <GitDiffImage
          file={file}
          cwd={imageCtx.cwd}
          baseSha={imageCtx.baseSha}
          headSha={imageCtx.headSha}
          scope={imageCtx.scope}
        />
      ) : (
        <PatchBody
          file={file}
          patch={patch}
          split={split}
          loadNewLines={loadNewLines ? loadLines : null}
          onComment={onComment ? comment : null}
        />
      ))}
    </div>
  );
});
