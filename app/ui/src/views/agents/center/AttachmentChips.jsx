import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { ImageLightbox } from "../ImageLightbox.jsx";
import { labelTitle, elementSummary } from "../../../lib/attachmentTokens.js";

function basename(path) {
  return path.split("/").pop() || path;
}

function extOf(path) {
  return /\.([a-z0-9]{1,4})$/i.exec(path ?? "")?.[1].toUpperCase() ?? null;
}

// The two folders above the path ("views/agents") — tells same-named files
// apart. Pasted/dropped uploads sit in a throwaway temp dir, so they get none.
function parentLabel(path) {
  const dirs = (path ?? "").split("/").filter(Boolean).slice(0, -1);
  if (!dirs.length || dirs.at(-1).startsWith("eos-paste-")) return null;
  return dirs.slice(-2).join("/");
}

// Card text: the name matches the [label] token in the editor; the second line
// is the context that tells one attachment from another.
function describe(att, imageSize) {
  const title = labelTitle(att.label) ?? (att.path ? basename(att.path) : att.label);
  if (att.status === "uploading") return { name: title, meta: "Uploading…" };
  if (att.kind === "element") {
    // The picker's identity (tag + accessible name / locator) — the compact
    // payload rides in att.path (JSON).
    const s = elementSummary(att.path) ?? { tag: title ?? "element", detail: "" };
    return { name: s.tag, meta: s.detail };
  }
  if (att.kind === "image") return { name: title, meta: [extOf(att.path), imageSize].filter(Boolean).join(" · ") };
  return { name: title, meta: parentLabel(att.path) ?? (att.kind === "folder" ? "Folder" : "File") };
}

const ICON = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };

function ChipTile({ att, gallery, galleryIndex, onImageSize }) {
  if (att.status === "uploading") {
    return (
      <svg className="att-spinner" width="20" height="20" viewBox="0 0 20 20" fill="none">
        <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2" />
        <circle className="att-spinner-arc" cx="10" cy="10" r="7.5" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeDasharray="12 36" />
      </svg>
    );
  }
  if (att.kind === "image" && att.path) {
    return (
      <ImageLightbox gallery={gallery} index={galleryIndex}>
        <img
          src={api.imageUrl(att.path)}
          alt={basename(att.path)}
          className="att-thumb"
          onLoad={(e) => onImageSize(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
        />
      </ImageLightbox>
    );
  }
  if (att.kind === "element") {
    return (
      <svg {...ICON}>
        <rect x="3.5" y="3.5" width="11" height="11" rx="2" strokeDasharray="2.2 2.4" />
        <path d="M11.5 11.5l8.5 3-3.6 1.3-1.3 3.6z" />
      </svg>
    );
  }
  if (att.kind === "folder") {
    return (
      <svg {...ICON}>
        <path d="M3.5 7.5a2 2 0 0 1 2-2h3.7l2.1 2.2h7.2a2 2 0 0 1 2 2v7.8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      </svg>
    );
  }
  const ext = extOf(att.path);
  if (ext) return <span className="att-ext">{ext}</span>;
  return (
    <svg {...ICON}>
      <path d="M6.5 3.5h7l4 4v13h-11z" /><path d="M13.5 3.5v4h4" />
    </svg>
  );
}

function AttachmentChip({ att, gallery, galleryIndex, onRemove }) {
  const [imageSize, setImageSize] = useState(null);
  const { name, meta } = describe(att, imageSize);
  return (
    <div
      className={`att-chip att-${att.kind}${att.status === "uploading" ? " att-uploading" : ""}`}
      title={att.path ?? att.label}
    >
      <div className="att-tile">
        <ChipTile att={att} gallery={gallery} galleryIndex={galleryIndex} onImageSize={setImageSize} />
      </div>
      <div className="att-text">
        <span className="att-name">{name}</span>
        {meta && <span className="att-meta">{meta}</span>}
      </div>
      {onRemove && (
        <button
          className="att-remove"
          aria-label={`Remove ${name}`}
          onClick={(e) => { e.stopPropagation(); onRemove(att.label); }}
        >
          <svg width="8" height="8" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M2 2l6 6M8 2l-6 6" />
          </svg>
        </button>
      )}
    </div>
  );
}

// The row never wraps — it scrolls sideways — so fade whichever edge still
// hides cards ("start", "end" or both).
function useEdgeFade(ref, attachments) {
  const [fade, setFade] = useState("");
  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const start = el.scrollLeft > 1;
    const end = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setFade([start && "start", end && "end"].filter(Boolean).join(" "));
  }, [ref]);
  useEffect(() => {
    update();
    const ro = new ResizeObserver(update);
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref, update, attachments]);
  return [fade, update];
}

export function AttachmentChips({ attachments, onRemove }) {
  const rowRef = useRef(null);
  const [fade, onScroll] = useEdgeFade(rowRef, attachments);
  const images = attachments.filter((a) => a.kind === "image" && a.path);
  const gallery = images.map((a) => ({
    src: api.imageUrl(a.path),
    alt: basename(a.path),
    title: labelTitle(a.label),
  }));
  return (
    <div ref={rowRef} className="attachment-chips" data-fade={fade || undefined} onScroll={onScroll}>
      {attachments.map((att) => (
        <AttachmentChip
          key={att.label}
          att={att}
          gallery={gallery}
          galleryIndex={images.indexOf(att)}
          onRemove={onRemove}
        />
      ))}
    </div>
  );
}
