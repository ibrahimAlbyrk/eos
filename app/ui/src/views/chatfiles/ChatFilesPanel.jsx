import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { useUi } from "../../state/ui.jsx";
import { api } from "../../api/client.js";
import { PanelShell } from "../code/panes/PanelShell.jsx";
import { ImageLightbox } from "../code/ImageLightbox.jsx";
import { subscribe, getSnapshot, attach } from "../../state/chatAttachmentsStore.js";
import { requestReveal } from "../../state/transcriptReveal.js";

// Videos arrive from the parser as kind "file" (there is no "video" kind); we
// group common video extensions into their own section for a clearer list, but
// they still render with an icon — only images get real thumbnails.
const VIDEO_EXTS = new Set(["mp4", "mov", "webm", "mkv", "avi", "m4v"]);

function basename(path) {
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  return p.split("/").pop() || p;
}
function dirname(path) {
  const p = path.endsWith("/") ? path.slice(0, -1) : path;
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "/";
}
function extOf(path) {
  return path.split(".").pop()?.toLowerCase() ?? "";
}

function FolderIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M2 5a1 1 0 0 1 1-1h3l2 2h5a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5z" />
    </svg>
  );
}
function FileIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2">
      <path d="M4 2h6l3 3v9H4z" /><path d="M10 2v3h3" />
    </svg>
  );
}
function VideoIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinejoin="round">
      <rect x="2" y="4" width="12" height="8" rx="1" /><path d="M7 6.5l3 1.5-3 1.5z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function iconFor(section) {
  if (section === "folder") return <FolderIcon />;
  if (section === "video") return <VideoIcon />;
  return <FileIcon />;
}

function FileRow({ att, section, workerId, gallery, galleryIndex }) {
  const ui = useUi();
  const [broken, setBroken] = useState(false);
  const name = basename(att.path);
  const showThumb = section === "image" && !broken;

  const open = useCallback(() => {
    if (att.kind === "folder") ui.openFilesViewer(att.path);
    else ui.openFileViewer(att.path);
  }, [att.kind, att.path, ui]);

  const inner = (
    <>
      <span className={"chatfiles-thumb" + (showThumb ? " is-image" : "")}>
        {showThumb
          ? <img src={api.imageUrl(att.path)} alt={name} onError={() => setBroken(true)} />
          : iconFor(section)}
      </span>
      <span className="chatfiles-meta">
        <span className="chatfiles-name" title={att.path}>{name}</span>
        <span className="chatfiles-sub" title={att.path}>{dirname(att.path)}</span>
      </span>
    </>
  );

  return (
    <div className="chatfiles-row">
      {section === "image" && !broken ? (
        <ImageLightbox gallery={gallery} index={galleryIndex}>
          <span className="chatfiles-main">{inner}</span>
        </ImageLightbox>
      ) : (
        <button className="chatfiles-main" onClick={open} title={`Open ${name}`}>{inner}</button>
      )}
      <button
        className="chatfiles-jump"
        onClick={() => requestReveal(workerId, att.path)}
        title="Jump to message"
        aria-label="Jump to message in chat"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M6 3h5a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6l-3 2.5V5a2 2 0 0 1 2-2z" />
        </svg>
      </button>
    </div>
  );
}

function Section({ title, section, items, workerId, gallery }) {
  if (!items.length) return null;
  return (
    <div className="chatfiles-section">
      <div className="chatfiles-section-head">
        <span className="chatfiles-section-title">{title}</span>
        <span className="chatfiles-section-count">{items.length}</span>
      </div>
      {items.map((att) => (
        <FileRow
          key={att.path}
          att={att}
          section={section}
          workerId={workerId}
          gallery={gallery}
          galleryIndex={section === "image" ? gallery.findIndex((g) => g.path === att.path) : 0}
        />
      ))}
    </div>
  );
}

export function ChatFilesPanel() {
  const ui = useUi();
  const workerId = ui.chatFilesViewer?.workerId ?? null;

  const snap = useSyncExternalStore(
    useCallback((cb) => (workerId ? subscribe(workerId, cb) : () => {}), [workerId]),
    useCallback(() => getSnapshot(workerId), [workerId]),
  );

  useEffect(() => {
    if (!workerId) return;
    return attach(workerId);
  }, [workerId]);

  const attachments = snap.attachments;
  const images = attachments.filter((a) => a.kind === "image");
  const folders = attachments.filter((a) => a.kind === "folder");
  const videos = attachments.filter((a) => a.kind === "file" && VIDEO_EXTS.has(extOf(a.path)));
  const documents = attachments.filter((a) => a.kind === "file" && !VIDEO_EXTS.has(extOf(a.path)));

  const gallery = images.map((a) => ({
    path: a.path,
    src: api.imageUrl(a.path),
    alt: basename(a.path),
    title: basename(a.path),
  }));

  const empty = attachments.length === 0;

  return (
    <PanelShell type="chatfiles">
      <div className="chatfiles-body">
        {empty ? (
          <div className="chatfiles-empty">No files attached to this chat yet.</div>
        ) : (
          <>
            <Section title="Images" section="image" items={images} workerId={workerId} gallery={gallery} />
            <Section title="Videos" section="video" items={videos} workerId={workerId} gallery={gallery} />
            <Section title="Documents" section="file" items={documents} workerId={workerId} gallery={gallery} />
            <Section title="Folders" section="folder" items={folders} workerId={workerId} gallery={gallery} />
          </>
        )}
      </div>
    </PanelShell>
  );
}
