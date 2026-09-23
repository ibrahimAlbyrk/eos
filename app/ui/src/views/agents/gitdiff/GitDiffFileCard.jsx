import { memo } from "react";
import { PatchBody } from "../messages/PatchBody.jsx";
import { GitDiffImage, isImagePath } from "./GitDiffImage.jsx";

function splitPath(path) {
  const i = path.lastIndexOf("/");
  return i < 0 ? ["", path] : [path.slice(0, i + 1), path.slice(i + 1)];
}

// One collapsible file card — the DiffViewer FileCard idiom without the
// worker-only chrome (discard/Try/Apply/verdict). The header row is sticky
// inside the panel's scroll container (.gd-list), so the card root must never
// gain overflow or containment. cardRef lets the body scroll a selected file
// into view.
export const GitDiffFileCard = memo(function GitDiffFileCard({ file, isOpen, patch, onToggle, imageCtx, cardRef, onContextMenu }) {
  const [dir, base] = splitPath(file.path);
  return (
    <div className={"gd-file" + (isOpen ? " open" : "")} ref={cardRef}>
      <button
        className="gd-row"
        onClick={() => onToggle(file.path)}
        onContextMenu={onContextMenu ? (e) => onContextMenu(e, file.path) : undefined}
      >
        <svg className="dv-chev" width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="m6 4 4 4-4 4" />
        </svg>
        <span className="dv-path" title={file.oldPath ? `${file.oldPath} → ${file.path}` : undefined}>
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
      {isOpen && (isImagePath(file.path) ? (
        <GitDiffImage
          file={file}
          cwd={imageCtx.cwd}
          baseSha={imageCtx.baseSha}
          headSha={imageCtx.headSha}
          scope={imageCtx.scope}
        />
      ) : (
        <PatchBody file={file} patch={patch} />
      ))}
    </div>
  );
});
