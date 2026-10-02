import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../../../api/client.js";
import { ImageLightbox } from "../ImageLightbox.jsx";
import { labelTitle, elementSummary } from "../../../lib/attachmentTokens.js";
import { fileKind } from "../../../lib/fileKind.js";

const PAGE_LINES = 24;

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

function titleOf(att) {
  return labelTitle(att.label) ?? (att.path ? basename(att.path) : att.label);
}

// Images show themselves and text/HTML files a page of their content; the rest
// (folders, picked elements, pdf/media, files still uploading) stay compact cards.
function previewKind(att) {
  if (att.kind === "image") return "image";
  if (att.kind !== "file" || !att.path) return null;
  const kind = fileKind(att.path);
  return kind === "image" || kind === "text" || kind === "html" ? kind : null;
}

// Compact card text: the name matches the [label] token in the editor; the
// second line is the context that tells one attachment from another.
function describe(att) {
  const title = titleOf(att);
  if (att.status === "uploading") return { name: title, meta: "Uploading…" };
  if (att.kind === "element") {
    // The picker's identity (tag + accessible name / locator) — the compact
    // payload rides in att.path (JSON).
    const s = elementSummary(att.path) ?? { tag: title ?? "element", detail: "" };
    return { name: s.tag, meta: s.detail };
  }
  return { name: title, meta: parentLabel(att.path) ?? (att.kind === "folder" ? "Folder" : "File") };
}

const ICON = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.6, strokeLinecap: "round", strokeLinejoin: "round" };

function Spinner() {
  return (
    <svg className="att-spinner" width="20" height="20" viewBox="0 0 20 20" fill="none">
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeOpacity="0.15" strokeWidth="2" />
      <circle className="att-spinner-arc" cx="10" cy="10" r="7.5" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeDasharray="12 36" />
    </svg>
  );
}

function DocIcon({ size = 18 }) {
  return (
    <svg {...ICON} width={size} height={size}>
      <path d="M6.5 3.5h7l4 4v13h-11z" /><path d="M13.5 3.5v4h4" />
    </svg>
  );
}

function GlobeIcon({ size = 18 }) {
  return (
    <svg {...ICON} width={size} height={size}>
      <circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.4 2.3 3.5 5.2 3.5 8.5s-1.1 6.2-3.5 8.5c-2.4-2.3-3.5-5.2-3.5-8.5s1.1-6.2 3.5-8.5z" />
    </svg>
  );
}

function CardTile({ att }) {
  if (att.status === "uploading") return <Spinner />;
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
  return ext ? <span className="att-ext">{ext}</span> : <DocIcon />;
}

function CardBody({ att }) {
  const { name, meta } = describe(att);
  return (
    <>
      <div className="att-tile"><CardTile att={att} /></div>
      <div className="att-text">
        <span className="att-name">{name}</span>
        {meta && <span className="att-meta">{meta}</span>}
      </div>
    </>
  );
}

function ImagePreview({ att, gallery, galleryIndex }) {
  return (
    <div className="att-frame">
      {att.path ? (
        <ImageLightbox gallery={gallery} index={galleryIndex}>
          <img src={api.imageUrl(att.path)} alt={basename(att.path)} className="att-shot" />
        </ImageLightbox>
      ) : <Spinner />}
    </div>
  );
}

// First lines of the file; "" when there is nothing to show (binary, too
// large, unreadable), null while loading.
function useFileHead(path) {
  const [head, setHead] = useState(null);
  useEffect(() => {
    let live = true;
    api.readFile(path)
      .then((r) => { if (live) setHead(r.content?.split("\n", PAGE_LINES).join("\n") ?? ""); })
      .catch(() => { if (live) setHead(""); });
    return () => { live = false; };
  }, [path]);
  return head;
}

function TextPage({ path }) {
  const head = useFileHead(path);
  if (head === "") return <div className="att-page-empty"><DocIcon size={22} /></div>;
  return <pre className="att-page-text">{head}</pre>;
}

// A still render of the page: no scripts, no input, scaled down to the tile.
function HtmlPage({ path }) {
  return (
    <iframe
      className="att-page-html"
      title={`Preview of ${basename(path)}`}
      src={api.rawUrl(path)}
      sandbox=""
      scrolling="no"
      loading="lazy"
      tabIndex={-1}
      aria-hidden="true"
    />
  );
}

function DocPreview({ att, kind }) {
  return (
    <div className="att-frame">
      <div className="att-page">
        {kind === "html" ? <HtmlPage path={att.path} /> : <TextPage path={att.path} />}
      </div>
      <div className="att-caption">
        {kind === "html" ? <GlobeIcon size={14} /> : <DocIcon size={14} />}
        <span className="att-name">{titleOf(att)}</span>
      </div>
    </div>
  );
}

function AttachmentChip({ att, gallery, galleryIndex, onRemove }) {
  const preview = previewKind(att);
  const classes = [
    "att-chip",
    `att-${att.kind}`,
    preview && "att-preview",
    preview && `att-preview--${preview === "image" ? "image" : "doc"}`,
    att.status === "uploading" && "att-uploading",
  ].filter(Boolean).join(" ");
  return (
    <div className={classes} title={att.path ?? att.label}>
      {preview === "image" ? <ImagePreview att={att} gallery={gallery} galleryIndex={galleryIndex} />
        : preview ? <DocPreview att={att} kind={preview} />
        : <CardBody att={att} />}
      {onRemove && (
        <button
          className="att-remove"
          aria-label={`Remove ${titleOf(att)}`}
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
  const images = attachments.filter((a) => previewKind(a) === "image" && a.path);
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
